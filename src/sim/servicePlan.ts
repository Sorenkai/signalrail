import { z } from "zod";
import {
  IsoDate,
  type Call,
  type PatternCall,
  type Service,
  type ServicePattern,
  type ServicePatternsFile,
  type TimetableSnapshot,
} from "../model/index.ts";
import type { GameRuleContext } from "../validation/gameRules.ts";
import { deferredAreaCuts, validateServicePatterns } from "../validation/servicePatterns.ts";
import { validateTimetables } from "../validation/timetable.ts";
import {
  RAILWAY_TIME_ZONE,
  cifTimeMs,
  localToSimTime,
  railwayTimeBase,
  simTimeToLocal,
  type RailwayTimeBase,
} from "./railwayTime.ts";
import type { SimWorld } from "./state.ts";
import {
  edgeLengthMm,
  otherEnd,
  signalMovementRole,
  signalsFacing,
  type TrainStep,
} from "./train.ts";

/**
 * The timetable service plan (P5, ADR 0001 "Timetable services", D-035): which services of one
 * dated snapshot a session can run, decided once at session setup and frozen in the world.
 * Pure and deterministic. A service is
 * - representable: its timing points around play match one valid service pattern exactly, so
 *   it enters, runs and leaves over the pattern's routes on sourced timetable evidence;
 * - approximated: as representable, but the game leaves out something the schedule states
 *   (a timetabled stop inside play: trains stop only at signals);
 * - unsupported: no pattern fits, the fit is ambiguous, a time cannot be resolved, or the
 *   train cannot be placed or leave; it never runs and is reported with its reason;
 * - invalid: the snapshot's own checks reject it (quarantined, never repaired).
 * Every runnable service also uses the session's train length and speed: the snapshot holds
 * neither, so both are labelled game settings (`characteristics: "session_default"`).
 */

const SafeInt = (min: number) => z.number().int().min(min).max(Number.MAX_SAFE_INTEGER);

export const TimetableSessionConfig = z.object({
  /** The operating date: must equal the snapshot's date. */
  operatingDate: IsoDate,
  timeZone: z.literal(RAILWAY_TIME_ZONE),
  /** GAME SETTING applied to every service train: the snapshot holds no train length. */
  trainLengthMm: SafeInt(1),
  /** GAME SETTING: constant running speed of every service train (CIF speed is not imported). */
  trainSpeedMmPerS: SafeInt(1),
  /** A service is due at its entry fringe from its time at the timing point before play. */
  entryTime: z.literal("previous_timing_point"),
  /** Timetabled stops inside play are not enacted: trains stop only at signals. */
  stationCalls: z.literal("not_simulated"),
});
export type TimetableSessionConfig = z.infer<typeof TimetableSessionConfig>;

/** Session defaults for `operatingDate`. 200 m and 20 m/s are game settings, not sourced values. */
export function timetableSessionConfig(
  operatingDate: string,
  o: Partial<TimetableSessionConfig> = {},
): TimetableSessionConfig {
  return TimetableSessionConfig.parse({
    operatingDate,
    timeZone: RAILWAY_TIME_ZONE,
    trainLengthMm: 200_000,
    trainSpeedMmPerS: 20_000,
    entryTime: "previous_timing_point",
    stationCalls: "not_simulated",
    ...o,
  });
}

export interface TimetableInput {
  snapshot: TimetableSnapshot;
  patterns: ServicePatternsFile;
  config: TimetableSessionConfig;
  /** Play-area and deferred TIPLOCs; the snapshot's own import lists are used when present. */
  areaTiplocs?: readonly string[];
  deferredTiplocs?: readonly string[];
}

export const SERVICE_PLAN_CODES = [
  "TIMETABLE_INVALID",
  "DUPLICATE_SERVICE_ID",
  "BANK_HOLIDAY_UNRESOLVED",
  "NO_PATTERN",
  "PATTERN_FIELD_MISMATCH",
  "PATTERN_AMBIGUOUS",
  "TIME_NONEXISTENT",
  "TIME_AMBIGUOUS",
  "ROUTE_NOT_ESTABLISHED",
  "ROUTE_CHAIN_BLOCKED",
  "ENTRY_PLACEMENT",
  "EXIT_TOO_SHORT",
  "STATION_CALL_NOT_SIMULATED",
] as const;
export type ServicePlanCode = (typeof SERVICE_PLAN_CODES)[number];

export type ServiceClass = "representable" | "approximated" | "unsupported" | "invalid";

/** How a runnable service enters, runs and leaves play. */
export interface ServiceRun {
  trainId: string;
  /** Simulation time from which the service may enter play (negative: before time 0). */
  dueAtMs: number;
  /** Europe/London wall time of `dueAtMs`, and the timing point it is taken from. */
  dueLocal: string;
  dueTiploc: string;
  routeIds: readonly string[];
  entryFringeId: string;
  exitFringeId: string;
  lengthMm: number;
  speedMmPerS: number;
  characteristics: "session_default";
  /** Where the train is placed on entry: its rear at the entry fringe's outside node. */
  entryPath: readonly TrainStep[];
  entryHeadOffsetMm: number;
}

export interface ServicePlanEntry {
  serviceId: string;
  uid: string;
  runDate: string;
  headcode: string | null;
  category: string | null;
  classification: ServiceClass;
  reasons: readonly { code: ServicePlanCode; detail: string }[];
  patternId: string | null;
  /** Timing points around and through play as the schedule gives them, for reports. */
  observedPath: string;
  run: ServiceRun | null;
}

export interface TimetablePlan {
  snapshotId: string;
  config: TimetableSessionConfig;
  base: RailwayTimeBase;
  /** Runnable services by (dueAtMs, serviceId), then the rest by serviceId. */
  entries: readonly ServicePlanEntry[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const isRunnable = (e: ServicePlanEntry) =>
  e.classification === "representable" || e.classification === "approximated";

export const runnableServices = (plan: TimetablePlan | null) =>
  (plan?.entries ?? []).filter(isRunnable);

/** Train id of a service instance: deterministic, and never reused by another instance. */
export const serviceTrainId = (s: Pick<Service, "uid" | "runDate">) =>
  `svc-${s.uid.replace(/ /g, "_")}-${s.runDate}`;

const describeCall = (c: Call) =>
  `${c.tiploc}${c.platform ? `(${c.platform})` : ""}${c.line ? `[${c.line}]` : ""}`;

function callMismatch(want: PatternCall, c: Call): string | null {
  if (want.platform !== undefined && c.platform !== want.platform)
    return `${c.tiploc} platform ${c.platform ?? "(blank)"}; pattern needs ${want.platform ?? "(blank)"}`;
  if (want.lines !== undefined && !want.lines.includes(c.line))
    return `${c.tiploc} line ${c.line ?? "(blank)"}; pattern accepts ${want.lines.map((l) => l ?? "(blank)").join(", ")}`;
  return null;
}

/** Simulation-relevant time (ms after midnight, day offset) at which a call is left. */
function leavingTime(c: Call): { ms: number; day: number } | null {
  let day = c.dayOffset ?? 0;
  let prev: number | null = null;
  let last: { ms: number; day: number } | null = null;
  for (const t of [c.arrival, c.pass, c.departure]) {
    if (t === null) continue;
    const ms = cifTimeMs(t);
    if (prev !== null && ms < prev) day++;
    prev = ms;
    last = { ms, day };
  }
  return last;
}

/** Rear at the route's start node, head `lengthMm` along its edges; null if impossible. */
function entryPlacement(
  world: Omit<SimWorld, "timetable">,
  routeId: string,
  lengthMm: number,
): { path: TrainStep[]; headOffsetMm: number } | string {
  let node = world.routeStart.get(routeId);
  if (node === undefined) return `route ${routeId} has no known start node`;
  const path: TrainStep[] = [];
  let behind = 0;
  for (const edgeId of world.routes.get(routeId)!.edgeIds) {
    const len = edgeLengthMm(world as SimWorld, edgeId);
    if (len === null) return `edge ${edgeId} has no known length`;
    const to = otherEnd(world as SimWorld, edgeId, node);
    if (to === null) return `route ${routeId} does not continue from ${node}`;
    path.push({ edgeId, towardsNodeId: to });
    if (behind + len >= lengthMm) return { path, headOffsetMm: lengthMm - behind };
    behind += len;
    node = to;
  }
  return `the ${lengthMm} mm train is longer than entry route ${routeId} (${behind} mm)`;
}

/**
 * (P6) Signals that would halt a train running `routeIds` in order, judged statically by the
 * movement roles (D-033) that `crossingProblem` applies at run time: within each route, every
 * signal facing the direction of travel is a blocker unless it is a no_stop signal, or the
 * route's own entry signal at its start node. A signal of unknown facing counts as facing.
 * A chain with a blocker can be set but never run through, so a service on it is unsupported
 * rather than counted as runnable. Pure; reads only the frozen world.
 */
export function routeChainBlockers(
  world: Omit<SimWorld, "timetable">,
  routeIds: readonly string[],
): string[] {
  const out: string[] = [];
  for (const id of routeIds) {
    const route = world.routes.get(id);
    let node = world.routeStart.get(id);
    if (!route || node === undefined) {
      out.push(`route ${id} has no known start node`);
      continue;
    }
    for (const [i, edgeId] of route.edgeIds.entries()) {
      const to = otherEnd(world as SimWorld, edgeId, node);
      if (to === null) {
        out.push(`route ${id} does not continue from ${node}`);
        break;
      }
      for (const s of signalsFacing(world as SimWorld, node, to)) {
        const role = signalMovementRole(s);
        if (role === "no_stop") continue;
        if (i === 0 && role === "worked_stop" && s.id === route.entrySignalId) continue;
        out.push(
          `signal ${s.ref ?? s.id} (${s.function}) at ${node} faces the movement inside route ${id}; ` +
            (role === "worked_stop"
              ? "it is not the route's entry signal, so no route clears it for this movement"
              : "a signal of this function is never passed"),
        );
      }
      node = to;
    }
  }
  return out;
}

export function buildServicePlan(
  world: Omit<SimWorld, "timetable">,
  fringes: GameRuleContext["fringes"],
  input: TimetableInput,
): TimetablePlan {
  const config = TimetableSessionConfig.parse(input.config);
  const t = input.snapshot;
  if (t.date !== config.operatingDate)
    throw new Error(
      `snapshot ${t.id} is for ${t.date}, not operating date ${config.operatingDate}`,
    );
  if (!t.convention)
    throw new Error(
      `snapshot ${t.id} has no operating-day convention (D-026): its window cannot be placed in time`,
    );
  const base = railwayTimeBase(config.operatingDate, t.convention.windowStart);

  const area = new Set(t.import?.areaTiplocs ?? input.areaTiplocs ?? []);
  const deferred = new Set(t.import?.deferredTiplocs ?? input.deferredTiplocs ?? []);
  const inArea = (tiploc: string) => area.has(tiploc) || deferred.has(tiploc);

  const checks = validateTimetables([t], { area: area.size > 0 ? area : null, deferred });
  const snapshotErrors = checks.filter((i) => i.severity === "error" && i.ids?.includes(t.id));
  if (snapshotErrors.length > 0)
    throw new Error(`snapshot ${t.id} has errors: ${snapshotErrors.map((i) => i.code).join(", ")}`);
  const perService = (sid: string, severity: "error" | "warning") =>
    checks.filter((i) => i.severity === severity && i.ids?.includes(sid));

  const patternCheck = validateServicePatterns(
    input.patterns,
    world.signalling,
    fringes,
    { area: area.size > 0 ? area : null, deferred },
    deferredAreaCuts(world.control),
  );
  const patterns = input.patterns.patterns.filter((p) => !patternCheck.invalid.has(p.id));

  const idCount = new Map<string, number>();
  for (const s of t.services) idCount.set(s.id, (idCount.get(s.id) ?? 0) + 1);

  const entries = t.services.map((s): ServicePlanEntry => {
    const reasons: { code: ServicePlanCode; detail: string }[] = [];
    const blockStart = s.calls.findIndex((c) => inArea(c.tiploc));
    let blockEnd = blockStart;
    while (blockEnd + 1 < s.calls.length && inArea(s.calls[blockEnd + 1]!.tiploc)) blockEnd++;
    const window = s.calls.slice(Math.max(0, blockStart - 1), blockEnd + 2);
    const entry = (
      classification: ServiceClass,
      patternId: string | null = null,
    ): ServicePlanEntry => ({
      serviceId: s.id,
      uid: s.uid,
      runDate: s.runDate,
      headcode: s.headcode,
      category: s.category,
      classification,
      reasons,
      patternId,
      observedPath: window.map(describeCall).join(" > "),
      run: null,
    });

    if ((idCount.get(s.id) ?? 0) > 1)
      reasons.push({ code: "DUPLICATE_SERVICE_ID", detail: `${s.id} appears more than once` });
    for (const i of perService(s.id, "error"))
      reasons.push({ code: "TIMETABLE_INVALID", detail: `${i.code}: ${i.message}` });
    if (reasons.length > 0) return entry("invalid");
    for (const i of perService(s.id, "warning"))
      if (i.code === "BANK_HOLIDAY_UNRESOLVED")
        reasons.push({ code: "BANK_HOLIDAY_UNRESOLVED", detail: i.message });
    if (reasons.length > 0) return entry("unsupported");

    // The service's area calls must be one contiguous block with a call before it, and a call
    // after it unless the pattern ends the journey in a deferred area beyond play (P7, D-037;
    // the validator ensures the pattern's last call is deferred and its exit leads there).
    const block = s.calls.slice(blockStart, blockEnd + 1);
    const endsInBlock = blockEnd + 1 === s.calls.length;
    const contiguous = blockStart > 0 && !s.calls.slice(blockEnd + 1).some((c) => inArea(c.tiploc));
    const before = s.calls[blockStart - 1];
    const after = s.calls[blockEnd + 1];
    const sameStops = (p: ServicePattern) =>
      contiguous &&
      p.before.tiploc === before!.tiploc &&
      (p.after === null ? endsInBlock : !endsInBlock && p.after.tiploc === after!.tiploc) &&
      p.through.length === block.length &&
      p.through.every((c, i) => c.tiploc === block[i]!.tiploc);
    /** The pattern's calls paired with the service's, the absent `after` left out. */
    const pairs = (p: ServicePattern): [PatternCall, Call][] => [
      [p.before, before!],
      ...p.through.map((c, i): [PatternCall, Call] => [c, block[i]!]),
      ...(p.after === null ? [] : [[p.after, after!] as [PatternCall, Call]]),
    ];
    const candidates = patterns.filter(sameStops);
    if (candidates.length === 0) {
      reasons.push({
        code: "NO_PATTERN",
        detail: "its timing points around play match no pattern",
      });
      return entry("unsupported");
    }
    const fits = candidates.filter((p) =>
      pairs(p).every(([want, c]) => callMismatch(want, c) === null),
    );
    if (fits.length === 0) {
      const p = candidates[0]!;
      const why = pairs(p)
        .map(([want, c]) => callMismatch(want, c))
        .filter((x): x is string => x !== null);
      reasons.push({ code: "PATTERN_FIELD_MISMATCH", detail: `${p.id}: ${why.join("; ")}` });
      return entry("unsupported");
    }
    if (fits.length > 1) {
      reasons.push({
        code: "PATTERN_AMBIGUOUS",
        detail: `matches ${fits.map((p) => p.id).join(", ")}`,
      });
      return entry("unsupported");
    }
    const p = fits[0]!;

    const leave = leavingTime(before!);
    const due = leave ? localToSimTime(base, s.runDate, leave.ms, leave.day) : null;
    if (!due || due.kind !== "ok") {
      reasons.push({
        code: due?.kind === "ambiguous" ? "TIME_AMBIGUOUS" : "TIME_NONEXISTENT",
        detail: `${before!.tiploc} time ${leave ? "falls in a UK clock change" : "is missing"}`,
      });
      return entry("unsupported", p.id);
    }

    for (const id of p.routeIds) {
      const route = world.routes.get(id)!;
      for (const x of [id, ...(route.overlapId ? [route.overlapId] : [])]) {
        const status = world.status.get(x);
        if (!status || !(world.policy.allowedRouteStatuses as string[]).includes(status))
          reasons.push({
            code: "ROUTE_NOT_ESTABLISHED",
            detail: `${x} has data status ${status ?? "unassessed"}`,
          });
      }
    }
    for (const why of routeChainBlockers(world, p.routeIds))
      reasons.push({ code: "ROUTE_CHAIN_BLOCKED", detail: why });
    const first = world.routes.get(p.routeIds[0]!)!;
    const placement =
      first.entrySignalId === null
        ? entryPlacement(world, first.id, config.trainLengthMm)
        : `entry route ${first.id} starts at a signal, not a fringe`;
    if (typeof placement === "string") reasons.push({ code: "ENTRY_PLACEMENT", detail: placement });
    const exitCut = fringes.get(p.exitFringeId)?.cut;
    const exitLen = exitCut ? edgeLengthMm(world as SimWorld, exitCut.edgeId) : null;
    const last = world.routes.get(p.routeIds.at(-1)!)!;
    if (!exitCut || exitLen === null || last.edgeIds.at(-1) !== exitCut.edgeId)
      reasons.push({ code: "EXIT_TOO_SHORT", detail: "the exit cut edge has no known length" });
    else if (exitLen < config.trainLengthMm)
      reasons.push({
        code: "EXIT_TOO_SHORT",
        detail: `the ${config.trainLengthMm} mm train cannot stand wholly on exit cut edge ${exitCut.edgeId} (${exitLen} mm)`,
      });
    if (reasons.length > 0 || typeof placement === "string") return entry("unsupported", p.id);

    const stops = block.filter((c) => area.has(c.tiploc) && (c.arrival || c.departure));
    for (const c of stops)
      reasons.push({
        code: "STATION_CALL_NOT_SIMULATED",
        detail: `timetabled stop at ${c.tiploc} (${c.arrival ?? "-"}/${c.departure ?? "-"}) is not enacted`,
      });
    const run: ServiceRun = {
      trainId: serviceTrainId(s),
      dueAtMs: due.simMs,
      dueLocal: simTimeToLocal(base, due.simMs).wallTime,
      dueTiploc: before!.tiploc,
      routeIds: [...p.routeIds],
      entryFringeId: p.entryFringeId,
      exitFringeId: p.exitFringeId,
      lengthMm: config.trainLengthMm,
      speedMmPerS: config.trainSpeedMmPerS,
      characteristics: "session_default",
      entryPath: placement.path,
      entryHeadOffsetMm: placement.headOffsetMm,
    };
    return {
      ...entry(stops.length > 0 ? "approximated" : "representable", p.id),
      run,
    };
  });

  const runnable = entries
    .filter(isRunnable)
    .sort((a, b) => a.run!.dueAtMs - b.run!.dueAtMs || cmp(a.serviceId, b.serviceId));
  const rest = entries.filter((e) => !isRunnable(e)).sort((a, b) => cmp(a.serviceId, b.serviceId));
  return { snapshotId: t.id, config, base, entries: [...runnable, ...rest] };
}

/** Counts by classification and by reason code, for reports and documentation. */
export function summarisePlan(plan: TimetablePlan) {
  const byClass: Record<ServiceClass, number> = {
    representable: 0,
    approximated: 0,
    unsupported: 0,
    invalid: 0,
  };
  const byCode: Partial<Record<ServicePlanCode, number>> = {};
  for (const e of plan.entries) {
    byClass[e.classification]++;
    for (const c of new Set(e.reasons.map((r) => r.code))) byCode[c] = (byCode[c] ?? 0) + 1;
  }
  return { total: plan.entries.length, byClass, byCode };
}
