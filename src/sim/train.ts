import { z } from "zod";
import type { Signal } from "../model/index.ts";
import type { AuthoritativeState, PointsState, SimWorld } from "./state.ts";

/**
 * Trains and derived occupancy (ADR 0001 "Trains, movement and occupancy", D-032).
 *
 * A train is a minimal directed path of edges from rear to head, a head offset along the head
 * edge, and a length. Distances are integer millimetres; an edge's length is its OSM-derived
 * `lengthM` in mm, and an edge without one has no known footprint, so no train may use it.
 * Occupancy is derived from train paths and never set directly.
 *
 * These are the game's simulation rules. They do not reproduce, certify or prove the behaviour
 * of any real railway or interlocking.
 */

const SafeInt = (min: number) => z.number().int().min(min).max(Number.MAX_SAFE_INTEGER);

export const TrainStep = z.object({
  edgeId: z.string().min(1),
  /** The end of the edge the train is travelling towards. */
  towardsNodeId: z.string().min(1),
});
export type TrainStep = z.infer<typeof TrainStep>;

/** A train as placed in the initial state. Test or session data, never timetable data (P3). */
export const TrainSpec = z.object({
  id: z.string().min(1),
  lengthMm: SafeInt(1),
  speedMmPerS: SafeInt(0),
  /** Edges the train covers, rear first, head last. */
  path: z.array(TrainStep).min(1),
  /** Distance of the head along the head edge from the node it entered by: 1..edge length. */
  headOffsetMm: SafeInt(1),
});
export type TrainSpec = z.infer<typeof TrainSpec>;

/** Why a train stopped short of the distance its speed allowed this tick. */
export const STOP_CODES = [
  "NO_AUTHORITY",
  "AUTHORITY_WITHDRAWN",
  "ROUTE_NOT_ESTABLISHED",
  "SIGNAL_AT_DANGER",
  "DISCONNECTED_PATH",
  "PASSAGE_NOT_PERMITTED",
  "POINTS_NOT_PROVEN",
  "POINTS_NOT_LOCKED",
  "EDGE_LENGTH_UNKNOWN",
  "TRACK_OCCUPIED",
  "TRACK_NOT_PROVEN_CLEAR",
  "MOVEMENT_OVERFLOW",
  "ROUTE_NOT_PLANNED",
] as const;
export type StopCode = (typeof STOP_CODES)[number];

export interface TrainState {
  id: string;
  lengthMm: number;
  speedMmPerS: number;
  path: readonly Readonly<TrainStep>[];
  headOffsetMm: number;
  /** Sub-millimetre progress carried between ticks, in mm x ms / 1000 units: 0..999. */
  residue: number;
  /** Routes the train has taken, oldest first; each is set and `takenBy` this train. */
  authority: readonly string[];
  /** Why the train last stopped, or null while it is free to move. */
  stopped: { code: StopCode; at: string; reason: string } | null;
  /**
   * (P5, D-035) The timetable service the train runs as, if it entered play from the plan.
   * Absent for trains placed at session setup, which never leave play.
   */
  service?: { serviceId: string; headcode: string | null };
}

/** Why a train placement or a train in a given state is impossible. */
export const TRAIN_ISSUE_CODES = [
  "MALFORMED",
  "DUPLICATE_TRAIN",
  "UNKNOWN_EDGE",
  "DISCONNECTED_PATH",
  "EDGE_LENGTH_UNKNOWN",
  "HEAD_OUTSIDE_EDGE",
  "TRAIN_LONGER_THAN_PATH",
  "PATH_LONGER_THAN_TRAIN",
  "PASSAGE_NOT_PERMITTED",
  "POINTS_NOT_PROVEN",
  "SIGNAL_INSIDE_TRAIN",
  "TRACK_OCCUPIED",
  "AUTHORITY_INVALID",
] as const;
export type TrainIssueCode = (typeof TRAIN_ISSUE_CODES)[number];
export interface TrainIssue {
  trainId: string;
  code: TrainIssueCode;
  reason: string;
}

/** Edge length in whole millimetres, or null when the footprint is unknown (policy). */
export function edgeLengthMm(world: SimWorld, edgeId: string): number | null {
  const m = world.graph.edge(edgeId)?.lengthM;
  if (m === undefined) return null;
  const mm = Math.round(m * 1000);
  return mm >= 1 ? mm : null;
}

/** The other end of `edgeId` from `node`, or null if the edge does not touch `node`. */
export function otherEnd(world: SimWorld, edgeId: string, node: string): string | null {
  const e = world.graph.edge(edgeId);
  if (!e) return null;
  if (e.from === node) return e.to;
  if (e.to === node) return e.from;
  return null;
}

/**
 * How a signal affects a train's movement, by its source-derived `function` (policy
 * `signalAtOn: "stop_by_function"`, P3.1, D-033):
 * - worked_stop:  main and shunting signals. A train stops at one facing it, unless it is the
 *                 entry signal of the route the train takes as it passes, and is `off`. Only
 *                 these may be the entry signal of a route a train can take.
 * - no_stop:      distant signals and repeaters (e.g. banner repeaters). They show no stop
 *                 indication: a train passes them whatever their state, and they never
 *                 authorise a movement.
 * - always_stop:  stop boards, and signals of `other` or `unknown` function. Nothing clears
 *                 them, so a train never passes one facing it, and they never authorise one.
 * Shunting signals that may be passed at danger for some movements are not modelled.
 */
export type SignalMovementRole = "worked_stop" | "no_stop" | "always_stop";

export const SIGNAL_MOVEMENT_ROLE: Readonly<Record<Signal["function"], SignalMovementRole>> =
  Object.freeze({
    main: "worked_stop",
    shunting: "worked_stop",
    distant: "no_stop",
    repeater: "no_stop",
    stop_board: "always_stop",
    other: "always_stop",
    unknown: "always_stop",
  });

export const signalMovementRole = (s: Signal): SignalMovementRole =>
  SIGNAL_MOVEMENT_ROLE[s.function] ?? "always_stop";

/** Signals at `node` that govern a movement leaving it towards `towards`; unknown facing counts. */
export function signalsFacing(world: SimWorld, node: string, towards: string): Signal[] {
  return world.infrastructure.signals.filter(
    (s) =>
      s.trackNodeId === node &&
      (s.facingTowardsNodeId.value === null || s.facingTowardsNodeId.value === towards),
  );
}

/**
 * Whether the movement `from` -> `node` -> `to` may be made with the current points, using the
 * canonical resolver (TrackGraph.switchPassage with the world's valid game rules). With
 * `lockedBy`, points must also be locked by one of those set routes.
 */
export function passageProblem(
  world: SimWorld,
  points: Readonly<Record<string, Readonly<PointsState>>>,
  from: string,
  node: string,
  to: string,
  lockedBy?: { routes: AuthoritativeState["routes"]; routeIds: readonly string[] },
): {
  code: "PASSAGE_NOT_PERMITTED" | "POINTS_NOT_PROVEN" | "POINTS_NOT_LOCKED";
  reason: string;
} | null {
  const p = world.graph.switchPassage(from, node, to, world.pointsRules);
  if (p.status === "through") return null;
  if (p.status === "leg_to_leg")
    return {
      code: "PASSAGE_NOT_PERMITTED",
      reason: `${from} -> ${node} -> ${to} runs leg to leg through points ${p.points.id}`,
    };
  if (p.status === "unresolved")
    return {
      code: "PASSAGE_NOT_PERMITTED",
      reason: `${from} -> ${node} -> ${to} cannot be resolved: ${p.why}`,
    };
  const now = points[p.points.id];
  if (!now || !now.detected || now.position !== p.position)
    return {
      code: "POINTS_NOT_PROVEN",
      reason: `points ${p.points.id} are not detected ${p.position} (${now?.position ?? "unknown"}, ${now?.detected ? "detected" : "not detected"})`,
    };
  if (
    lockedBy &&
    !lockedBy.routeIds.some((r) => lockedBy.routes[r]?.lockedPointsIds.includes(p.points.id))
  )
    return {
      code: "POINTS_NOT_LOCKED",
      reason: `points ${p.points.id} are not locked by any route the train holds`,
    };
  return null;
}

/** Length of path that lies behind the head, excluding the rear edge: what remains if it goes. */
function coverWithoutRear(world: SimWorld, path: readonly TrainStep[], headOffsetMm: number) {
  let sum = headOffsetMm;
  for (let i = 1; i < path.length - 1; i++) sum += edgeLengthMm(world, path[i]!.edgeId)!;
  return sum;
}

/** Drop rear edges the train no longer covers, so the rear edge always holds part of it. */
export function trimPath(
  world: SimWorld,
  path: readonly TrainStep[],
  headOffsetMm: number,
  lengthMm: number,
): TrainStep[] {
  const out = [...path];
  while (out.length > 1 && coverWithoutRear(world, out, headOffsetMm) >= lengthMm) out.shift();
  return out;
}

/**
 * Derived occupancy: an edge in any train's path is occupied; every other edge has its
 * trackStatus (what is known apart from simulated trains). Edge order follows trackStatus.
 */
export function deriveOccupancy(
  trackStatus: AuthoritativeState["trackStatus"],
  trains: AuthoritativeState["trains"],
): Record<string, "clear" | "occupied" | "unknown"> {
  const covered = new Set(Object.values(trains).flatMap((t) => t.path.map((s) => s.edgeId)));
  return Object.fromEntries(
    Object.entries(trackStatus).map(([e, s]) => [e, covered.has(e) ? "occupied" : s]),
  );
}

/** Throws unless `state.occupancy` is exactly the derived occupancy. */
export function assertOccupancyDerived(state: AuthoritativeState): void {
  const derived = deriveOccupancy(state.trackStatus, state.trains);
  const keys = Object.keys(derived);
  const actual = Object.keys(state.occupancy);
  if (
    keys.length !== actual.length ||
    keys.some((k, i) => actual[i] !== k || state.occupancy[k] !== derived[k])
  )
    throw new Error("occupancy is not derived from trackStatus and train paths");
}

/** Geometry checks shared by placement and by state validation. */
function geometryIssues(world: SimWorld, t: TrainSpec): TrainIssue[] {
  const issue = (code: TrainIssueCode, reason: string): TrainIssue[] => [
    { trainId: t.id, code, reason },
  ];
  const seen = new Set<string>();
  for (let i = 0; i < t.path.length; i++) {
    const s = t.path[i]!;
    const e = world.graph.edge(s.edgeId);
    if (!e) return issue("UNKNOWN_EDGE", `no edge ${s.edgeId}`);
    if (e.from !== s.towardsNodeId && e.to !== s.towardsNodeId)
      return issue("DISCONNECTED_PATH", `edge ${s.edgeId} does not lead to ${s.towardsNodeId}`);
    if (seen.has(s.edgeId)) return issue("DISCONNECTED_PATH", `path revisits edge ${s.edgeId}`);
    seen.add(s.edgeId);
    if (i > 0) {
      const prev = t.path[i - 1]!;
      if (otherEnd(world, s.edgeId, prev.towardsNodeId) !== s.towardsNodeId)
        return issue(
          "DISCONNECTED_PATH",
          `edge ${s.edgeId} does not continue from ${prev.towardsNodeId} towards ${s.towardsNodeId}`,
        );
    }
    if (edgeLengthMm(world, s.edgeId) === null)
      return issue("EDGE_LENGTH_UNKNOWN", `edge ${s.edgeId} has no known length`);
  }
  const headLen = edgeLengthMm(world, t.path.at(-1)!.edgeId)!;
  if (t.headOffsetMm > headLen)
    return issue(
      "HEAD_OUTSIDE_EDGE",
      `head offset ${t.headOffsetMm} mm exceeds head edge length ${headLen} mm`,
    );
  const total =
    t.headOffsetMm + t.path.slice(0, -1).reduce((a, s) => a + edgeLengthMm(world, s.edgeId)!, 0);
  if (total < t.lengthMm)
    return issue(
      "TRAIN_LONGER_THAN_PATH",
      `path holds ${total} mm behind the head; the train is ${t.lengthMm} mm`,
    );
  if (t.path.length > 1 && coverWithoutRear(world, t.path, t.headOffsetMm) >= t.lengthMm)
    return issue(
      "PATH_LONGER_THAN_TRAIN",
      `rear edge ${t.path[0]!.edgeId} holds no part of the train`,
    );
  return [];
}

function passageIssues(
  world: SimWorld,
  t: TrainSpec,
  points: Readonly<Record<string, Readonly<PointsState>>>,
): TrainIssue[] {
  for (let i = 1; i < t.path.length; i++) {
    const node = t.path[i - 1]!.towardsNodeId;
    const from = otherEnd(world, t.path[i - 1]!.edgeId, node)!;
    const p = passageProblem(world, points, from, node, t.path[i]!.towardsNodeId);
    if (p && p.code !== "POINTS_NOT_LOCKED")
      return [{ trainId: t.id, code: p.code, reason: `train covers ${node}: ${p.reason}` }];
  }
  return [];
}

function overlapIssues(
  trains: readonly TrainSpec[],
  trackStatus: AuthoritativeState["trackStatus"],
): TrainIssue[] {
  const issues: TrainIssue[] = [];
  const owner = new Map<string, string>();
  for (const t of [...trains].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
    for (const s of t.path) {
      const other = owner.get(s.edgeId);
      if (other !== undefined)
        issues.push({
          trainId: t.id,
          code: "TRACK_OCCUPIED",
          reason: `edge ${s.edgeId} is already covered by train ${other}`,
        });
      else owner.set(s.edgeId, t.id);
      if (trackStatus[s.edgeId] === "occupied")
        issues.push({
          trainId: t.id,
          code: "TRACK_OCCUPIED",
          reason: `edge ${s.edgeId} is occupied by something other than a simulated train`,
        });
    }
  return issues;
}

/**
 * Problems with placing `raw` trains in a new session: malformed specs, impossible geometry,
 * passages the points do not permit, signals that can stop a train which it would already have
 * passed at danger (a new train has no authority), and overlaps.
 */
export function placementIssues(
  world: SimWorld,
  raw: readonly unknown[],
  points: Readonly<Record<string, Readonly<PointsState>>>,
  trackStatus: AuthoritativeState["trackStatus"],
): TrainIssue[] {
  const issues: TrainIssue[] = [];
  const valid: TrainSpec[] = [];
  const ids = new Set<string>();
  raw.forEach((r, i) => {
    const parsed = TrainSpec.safeParse(r);
    if (!parsed.success) {
      const id = (r as { id?: unknown })?.id;
      issues.push({
        trainId: typeof id === "string" ? id : `(train ${i})`,
        code: "MALFORMED",
        reason: parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; "),
      });
      return;
    }
    const t = parsed.data;
    if (ids.has(t.id)) {
      issues.push({ trainId: t.id, code: "DUPLICATE_TRAIN", reason: `train id ${t.id} repeats` });
      return;
    }
    ids.add(t.id);
    const own = [...geometryIssues(world, t)];
    if (own.length === 0) own.push(...passageIssues(world, t, points));
    if (own.length === 0)
      for (let k = 1; k < t.path.length; k++) {
        const node = t.path[k - 1]!.towardsNodeId;
        const passed = signalsFacing(world, node, t.path[k]!.towardsNodeId).filter(
          (s) => signalMovementRole(s) !== "no_stop",
        );
        if (passed.length > 0) {
          own.push({
            trainId: t.id,
            code: "SIGNAL_INSIDE_TRAIN",
            reason: `a new train has no authority, but it already stands past signal ${passed.map((x) => x.id).join(", ")} at ${node}`,
          });
          break;
        }
      }
    issues.push(...own);
    if (own.length === 0) valid.push(t);
  });
  return [...issues, ...overlapIssues(valid, trackStatus)];
}

/** New train state from a validated spec: no authority, not stopped. */
export function newTrain(spec: TrainSpec): TrainState {
  return { ...structuredClone(spec), residue: 0, authority: [], stopped: null };
}

/**
 * Problems with the trains of an existing state (the CommandStore checks every state it is
 * given): geometry, passages, overlaps, residue, and authority that is not a set route taken
 * by the train.
 */
export function stateTrainIssues(world: SimWorld, state: AuthoritativeState): TrainIssue[] {
  const issues: TrainIssue[] = [];
  const specs: TrainSpec[] = [];
  for (const [key, t] of Object.entries(state.trains)) {
    const parsed = TrainSpec.safeParse(t);
    if (
      !parsed.success ||
      key !== t.id ||
      !Number.isSafeInteger(t.residue) ||
      t.residue < 0 ||
      t.residue >= 1000
    ) {
      issues.push({
        trainId: key,
        code: "MALFORMED",
        reason: `train ${key} is not a valid train state`,
      });
      continue;
    }
    const own = [...geometryIssues(world, parsed.data)];
    if (own.length === 0) own.push(...passageIssues(world, parsed.data, state.points));
    for (const r of t.authority)
      if (state.routes[r]?.takenBy !== t.id)
        own.push({
          trainId: t.id,
          code: "AUTHORITY_INVALID",
          reason: `route ${r} is not set and taken by train ${t.id}`,
        });
    issues.push(...own);
    if (own.length === 0) specs.push(parsed.data);
  }
  return [...issues, ...overlapIssues(specs, state.trackStatus)];
}

/**
 * Route state, train allocation, approach locking and signal aspect agree (P3.1, D-033; P4,
 * D-034). A set route is offered, allocated to an existing train (`takenBy`), or approach
 * locked (`approachLock`), never two of these. A signal is `off` exactly while it is the entry
 * signal of one offered route, and only a worked stop signal is ever `off`. No train stands on
 * an approach-locked route, and its lock started at a valid time not after the clock.
 * Movement authority is `TrainState.authority` (checked by stateTrainIssues): an aspect alone
 * never grants it.
 */
export function routeSignalIssues(world: SimWorld, state: AuthoritativeState): string[] {
  const issues: string[] = [];
  const offered = new Map<string, string[]>();
  for (const set of Object.values(state.routes)) {
    const route = world.routes.get(set.routeId);
    if (!route) {
      issues.push(`set route ${set.routeId} does not exist`);
      continue;
    }
    if (set.takenBy !== undefined && !state.trains[set.takenBy])
      issues.push(`route ${set.routeId} is taken by train ${set.takenBy}, which does not exist`);
    if (set.approachLock !== undefined) {
      const { lockedAtMs } = set.approachLock;
      if (set.takenBy !== undefined)
        issues.push(`route ${set.routeId} is both taken and approach locked`);
      if (!Number.isSafeInteger(lockedAtMs) || lockedAtMs < 0 || lockedAtMs > state.clock.timeMs)
        issues.push(`route ${set.routeId} has an invalid approach lock time ${lockedAtMs}`);
      const on = Object.values(state.trains).find((t) =>
        t.path.some((s) => set.edgeIds.includes(s.edgeId)),
      );
      if (on) issues.push(`approach-locked route ${set.routeId} is occupied by train ${on.id}`);
    }
    if (route.entrySignalId !== null && set.takenBy === undefined && set.approachLock === undefined)
      offered.set(route.entrySignalId, [...(offered.get(route.entrySignalId) ?? []), route.id]);
  }
  for (const s of world.infrastructure.signals) {
    const routes = offered.get(s.id) ?? [];
    const off = state.signals[s.id] === "off";
    if (off && signalMovementRole(s) !== "worked_stop")
      issues.push(`signal ${s.id} (${s.function}) is off, but only a worked stop signal clears`);
    if (off !== routes.length > 0)
      issues.push(
        `signal ${s.id} is ${state.signals[s.id] ?? "missing"} with ${routes.length} offered route(s) from it`,
      );
    if (routes.length > 1)
      issues.push(`signal ${s.id} is off for several routes at once: ${routes.join(", ")}`);
  }
  return issues;
}

/** Throws unless routeSignalIssues finds nothing. */
export function assertRoutesAndSignalsConsistent(world: SimWorld, state: AuthoritativeState): void {
  const issues = routeSignalIssues(world, state);
  if (issues.length > 0) throw new Error(`routes and signals disagree: ${issues.join("; ")}`);
}

export const describeIssues = (issues: readonly TrainIssue[]) =>
  issues.map((i) => `${i.code} (train ${i.trainId}): ${i.reason}`).join("; ");
