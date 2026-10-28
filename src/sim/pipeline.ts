import type { Route } from "../model/index.ts";
import { CommandEnvelope, type Command, type OperatorRef, type RejectionCode } from "./commands.ts";
import { assertClock } from "./clock.ts";
import { approachReasons } from "./routeLifecycle.ts";
import {
  deepFreeze,
  routePhase,
  type AuthoritativeState,
  type SetRoute,
  type SimWorld,
} from "./state.ts";
import { assertServicesConsistent } from "./services.ts";
import { TickRequest, decideTick, type TickRejectionCode } from "./tick.ts";
import {
  assertOccupancyDerived,
  assertRoutesAndSignalsConsistent,
  describeIssues,
  signalMovementRole,
  stateTrainIssues,
} from "./train.ts";

/**
 * The authoritative command pipeline (ADR 0001, D-028). One write path for every operator:
 *
 *   submit -> parse -> duplicate/stale check -> decide (authority, data status, points,
 *   conflicts, occupancy, locking) -> apply (pure) -> record -> publish
 *
 * `decide` is a pure function of (world, state, command): it never reads the operator's kind,
 * so a human and an AI issuing the same command against the same state get the same outcome.
 * A rejection returns the same frozen state object, so nothing can be partly changed.
 *
 * Ticks (src/sim/tick.ts, D-031) share the store: `submit` and `tick` are the only write paths,
 * run one at a time in call order, and write to one event log with one sequence.
 *
 * These checks enforce the game's simulation policy over the project's data. They do not
 * reproduce, certify or prove the safety of any real railway interlocking.
 */

export type Decision =
  | { accepted: true; state: AuthoritativeState; changes: string[] }
  | { accepted: false; code: RejectionCode; reason: string };

export interface CommandEvent {
  kind: "command";
  seq: number;
  /** State version after this event. */
  version: number;
  /** Simulation time at which the command was decided (commands never change it). */
  timeMs: number;
  commandId: string;
  operator: OperatorRef | null;
  outcome: "accepted" | "rejected" | "duplicate";
  command: Command | null;
  code?: RejectionCode;
  reason?: string;
  changes?: string[];
}

export interface TickEvent {
  kind: "tick";
  seq: number;
  /** State version after this event. */
  version: number;
  /** Simulation time after this event. */
  timeMs: number;
  /** The requested tick number, or null when the request did not parse. */
  tick: number | null;
  outcome: "accepted" | "rejected" | "duplicate";
  code?: TickRejectionCode;
  reason?: string;
  changes?: string[];
}

/** One entry of the store's log, in the order inputs were applied. */
export type SimEvent = CommandEvent | TickEvent;

export interface StateUpdate {
  version: number;
  state: AuthoritativeState;
  event: SimEvent;
}

/** How clients will receive authoritative results. Socket.IO is a later implementation. */
export interface StatePublisher {
  publish(update: StateUpdate): void;
}

const reject = (code: RejectionCode, reason: string): Decision => ({
  accepted: false,
  code,
  reason,
});

/** Every points requirement of a route and its overlap. */
function requirements(world: SimWorld, route: Route) {
  const overlap = route.overlapId
    ? world.signalling.overlaps.find((o) => o.id === route.overlapId)
    : undefined;
  return {
    points: [...route.pointsRequired, ...(overlap?.pointsRequired ?? [])],
    edges: [...route.edgeIds, ...(overlap?.edgeIds ?? [])],
    overlapId: overlap?.id ?? null,
  };
}

/** Fail-safe track check: occupied blocks; unknown is treated as occupied (policy). */
function trackCheck(state: AuthoritativeState, edgeIds: string[], what: string): Decision | null {
  const occupied = edgeIds.filter((e) => state.occupancy[e] === "occupied");
  if (occupied.length > 0)
    return reject("TRACK_OCCUPIED", `${what}: track ${occupied.join(", ")} is occupied`);
  const unknown = edgeIds.filter((e) => state.occupancy[e] !== "clear");
  if (unknown.length > 0)
    return reject(
      "TRACK_NOT_PROVEN_CLEAR",
      `${what}: occupancy of ${unknown.join(", ")} is unknown, which the policy treats as occupied`,
    );
  return null;
}

/**
 * Whether edge `e` is shared only because `onward` starts at `route`'s exit signal and runs
 * over `route`'s overlap (P4, D-034): the overlap is the margin beyond that signal, and the
 * onward route continues over it in the same direction, so that is not a conflict.
 *
 * Fail closed (P5 audit, D-035): the relationship is established here, not assumed from the
 * validator. The overlap must belong to `route`'s exit signal, and `e` must lie in the leading
 * run of edges that the overlap and the onward route share in order from that signal. Any other
 * shared edge, including one the onward route reaches by another path, still conflicts.
 */
function onwardOverOverlap(world: SimWorld, onward: Route, route: Route, e: string): boolean {
  if (onward.entrySignalId === null || onward.entrySignalId !== route.exitSignalId) return false;
  const overlap = route.overlapId
    ? world.signalling.overlaps.find((o) => o.id === route.overlapId)
    : undefined;
  if (!overlap || overlap.signalId !== route.exitSignalId || route.edgeIds.includes(e))
    return false;
  let run = 0;
  while (
    run < overlap.edgeIds.length &&
    run < onward.edgeIds.length &&
    overlap.edgeIds[run] === onward.edgeIds[run]
  )
    run++;
  return overlap.edgeIds.slice(0, run).includes(e);
}

/**
 * Whether `a` and `b` conflict: declared either way, shared track, or opposed points. Track an
 * onward route shares only with the overlap of the route it continues is exempt; opposed points
 * there still conflict (swinging overlaps are not modelled). Exported for the P4 audit tests.
 */
export function routeConflict(world: SimWorld, a: Route, b: Route): string | null {
  if (a.conflictsWith.includes(b.id) || b.conflictsWith.includes(a.id)) return "declared";
  const ra = requirements(world, a);
  const rb = requirements(world, b);
  const shared = ra.edges.filter(
    (e) =>
      rb.edges.includes(e) &&
      !onwardOverOverlap(world, a, b, e) &&
      !onwardOverOverlap(world, b, a, e),
  );
  if (shared.length > 0) return `shared track ${shared.join(", ")}`;
  for (const p of ra.points) {
    const q = rb.points.find((x) => x.pointsId === p.pointsId);
    if (q && q.position !== p.position) return `opposed points ${p.pointsId}`;
  }
  return null;
}

/** The ends of a route: its signals and its fringe endpoints (D-029). */
const ends = (route: Route) => ({
  signals: [route.entrySignalId].filter((s): s is string => s !== null),
  fringes: [route.entryFringeId, route.exitFringeId].filter((f): f is string => f !== undefined),
});

function authorised(
  world: SimWorld,
  envelope: CommandEnvelope,
  signalIds: string[],
  pointsIds: string[],
  fringeIds: string[] = [],
): Decision | null {
  const assigned = world.assignments[envelope.operator.id] ?? [];
  if (!assigned.includes(envelope.controlAreaId))
    return reject(
      "NOT_AUTHORISED",
      `operator ${envelope.operator.id} is not assigned control area ${envelope.controlAreaId}`,
    );
  const area = world.control.areas.find((a) => a.id === envelope.controlAreaId);
  if (!area)
    return reject("NOT_AUTHORISED", `control area ${envelope.controlAreaId} does not exist`);
  // A fringe endpoint belongs to an area only through that area's boundary at the same cut.
  const ownsFringe = (f: string) => {
    const cut = world.fringeCuts.get(f);
    return (
      cut !== undefined &&
      world.control.boundaries.some((b) => b.cutId === cut && b.fromAreaId === area.id)
    );
  };
  const outside = [
    ...signalIds.filter((s) => !area.signalIds.includes(s)),
    ...pointsIds.filter((p) => !area.pointsIds.includes(p)),
    ...fringeIds.filter((f) => !ownsFringe(f)),
  ];
  if (outside.length > 0)
    return reject(
      "NOT_AUTHORISED",
      `control area ${area.id} does not control ${outside.join(", ")}`,
    );
  return null;
}

/** Pure decision. Never reads envelope.operator.kind: human and AI are treated alike. */
export function decide(
  world: SimWorld,
  state: AuthoritativeState,
  envelope: CommandEnvelope,
): Decision {
  const c = envelope.command;
  if (c.type === "move_points") {
    const p = world.infrastructure.points.find((x) => x.id === c.pointsId);
    if (!p) return reject("UNKNOWN_ELEMENT", `no points ${c.pointsId}`);
    const denied = authorised(world, envelope, [], [p.id]);
    if (denied) return denied;
    // (P7, D-037) Points on an incomplete junction are never treated as working points: with a
    // leg missing from the data, a "detected" position would claim more than the model knows.
    const junction = world.graph.junction(p.trackNodeId);
    if (junction.cls === "incomplete")
      return reject(
        "POINTS_TOPOLOGY_INCOMPLETE",
        `points ${p.id} stand on ${p.trackNodeId}, a junction the data does not fully map (${junction.reason}, ${junction.degree} edges); they cannot be worked`,
      );
    const holder = Object.values(state.routes).find((r) => r.lockedPointsIds.includes(p.id));
    if (holder)
      return reject("POINTS_LOCKED", `points ${p.id} are locked by set route ${holder.routeId}`);
    const now = state.points[p.id]!;
    if (now.detected && now.position === c.position)
      return reject("POINTS_ALREADY_IN_POSITION", `points ${p.id} are already ${c.position}`);
    const track = trackCheck(
      state,
      world.graph.incident(p.trackNodeId).map((i) => i.edgeId),
      `points ${p.id}`,
    );
    if (track) return track;
    return {
      accepted: true,
      changes: [`points ${p.id} ${now.position} -> ${c.position} (detected)`],
      state: {
        ...state,
        version: state.version + 1,
        points: { ...state.points, [p.id]: { position: c.position, detected: true } },
      },
    };
  }

  const route = world.routes.get(c.routeId);
  if (!route) return reject("UNKNOWN_ELEMENT", `no route ${c.routeId}`);
  const req = requirements(world, route);

  if (c.type === "cancel_route") {
    const set = state.routes[route.id];
    if (!set) return reject("ROUTE_NOT_SET", `route ${route.id} is not set`);
    const { signals, fringes } = ends(route);
    const denied = authorised(world, envelope, signals, [], fringes);
    if (denied) return denied;
    const phase = routePhase(set);
    // Cancelled already: the lock releases on its own (route-release stage, D-034).
    if (phase === "approach_locked")
      return reject(
        "ROUTE_APPROACH_LOCKED",
        `route ${route.id} is already cancelled and approach locked until its release condition is met`,
      );
    // A taken route is never cancelled while a train is on it: it is released automatically.
    const track = trackCheck(state, set.edgeIds, `cancelling route ${route.id}`);
    if (track) return track;
    // A taken route's entry signal is already on (replaced on passing); it may since have been
    // cleared for another route, so only an offered route's signal is put back (D-033).
    const replaced = phase === "offered" ? signals : [];
    const signalsOn = {
      ...state.signals,
      ...Object.fromEntries(replaced.map((s) => [s, "on" as const])),
    };
    const approaching = phase === "offered" ? approachReasons(world, state, route.id) : [];
    if (approaching.length > 0)
      // The signal goes back to danger now; points, track and conflicts stay protected.
      return {
        accepted: true,
        changes: [
          `route ${route.id} cancelled: approach locked (${approaching.join("; ")})`,
          ...replaced.map((s) => `signal ${s} on`),
        ],
        state: {
          ...state,
          version: state.version + 1,
          routes: {
            ...state.routes,
            [route.id]: {
              ...set,
              approachLock: { commandId: envelope.commandId, lockedAtMs: state.clock.timeMs },
            },
          },
          signals: signalsOn,
        },
      };
    const routes = { ...state.routes };
    delete routes[route.id];
    return {
      accepted: true,
      changes: [`route ${route.id} cancelled`, ...replaced.map((s) => `signal ${s} on`)],
      state: {
        ...state,
        version: state.version + 1,
        routes,
        signals: signalsOn,
      },
    };
  }

  // set_route
  const { signals, fringes } = ends(route);
  const denied = authorised(
    world,
    envelope,
    signals,
    req.points.map((p) => p.pointsId),
    fringes,
  );
  if (denied) return denied;
  const existing = state.routes[route.id];
  if (existing && routePhase(existing) === "approach_locked")
    return reject(
      "ROUTE_APPROACH_LOCKED",
      `route ${route.id} is cancelled and approach locked; it can be set again once released`,
    );
  if (existing) return reject("ROUTE_ALREADY_SET", `route ${route.id} is already set`);
  for (const [kind, id] of [
    ["route", route.id],
    ...(req.overlapId ? [["overlap", req.overlapId] as const] : []),
  ] as const) {
    const status = world.status.get(id);
    if (!status || !(world.policy.allowedRouteStatuses as string[]).includes(status))
      return reject(
        "ROUTE_NOT_ESTABLISHED",
        `${kind} ${id} has data status ${status ?? "unassessed"}; the policy allows ${world.policy.allowedRouteStatuses.join(", ")}`,
      );
  }
  if (route.entrySignalId !== null) {
    // Only a worked stop signal can authorise a movement (D-033): never an unknown function.
    const entry = world.infrastructure.signals.find((s) => s.id === route.entrySignalId);
    if (!entry || signalMovementRole(entry) !== "worked_stop")
      return reject(
        "ROUTE_NOT_ESTABLISHED",
        `entry signal ${route.entrySignalId} has function ${entry?.function ?? "(missing)"}, which cannot authorise a movement`,
      );
  }
  for (const q of req.points) {
    const now = state.points[q.pointsId];
    if (!now || !now.detected || now.position === "unknown")
      return reject(
        "POINTS_NOT_PROVEN",
        `points ${q.pointsId} are not detected in a known position (required ${q.position})`,
      );
    if (now.position !== q.position)
      return reject(
        "POINTS_WRONG_POSITION",
        `points ${q.pointsId} are ${now.position}; route ${route.id} needs ${q.position}`,
      );
  }
  for (const other of Object.values(state.routes)) {
    const why = routeConflict(world, route, world.routes.get(other.routeId)!);
    if (why)
      return reject(
        "ROUTE_CONFLICT",
        `route ${route.id} conflicts with set route ${other.routeId} (${why})`,
      );
  }
  // A signal is off for at most one offered route at a time (D-033).
  const offered = Object.values(state.routes).find(
    (r) =>
      routePhase(r) === "offered" &&
      route.entrySignalId !== null &&
      world.routes.get(r.routeId)!.entrySignalId === route.entrySignalId,
  );
  if (offered)
    return reject(
      "ROUTE_CONFLICT",
      `signal ${route.entrySignalId} is already off for set route ${offered.routeId}`,
    );
  const track = trackCheck(state, req.edges, `route ${route.id}`);
  if (track) return track;
  const set: SetRoute = {
    routeId: route.id,
    lockedPointsIds: [...new Set(req.points.map((p) => p.pointsId))],
    edgeIds: req.edges,
    setBy: envelope.operator.id,
    commandId: envelope.commandId,
  };
  return {
    accepted: true,
    changes: [
      `route ${route.id} set`,
      ...set.lockedPointsIds.map((p) => `points ${p} locked`),
      // A route from a fringe endpoint has no entry signal to clear.
      ...signals.map((s) => `signal ${s} off`),
    ],
    state: {
      ...state,
      version: state.version + 1,
      routes: { ...state.routes, [route.id]: set },
      signals: { ...state.signals, ...Object.fromEntries(signals.map((s) => [s, "off" as const])) },
    },
  };
}

/** The result a submitter receives. */
export type SubmitResult =
  | { outcome: "accepted"; version: number; changes: string[] }
  | { outcome: "rejected"; version: number; code: RejectionCode; reason: string }
  | { outcome: "duplicate"; version: number; original: SubmitResult };

/** The result the session's tick driver receives. Every outcome reports the clock after it. */
export type TickResult =
  | { outcome: "accepted"; version: number; tick: number; timeMs: number; changes: string[] }
  | {
      outcome: "rejected";
      version: number;
      tick: number;
      timeMs: number;
      code: TickRejectionCode;
      reason: string;
    }
  | { outcome: "duplicate"; version: number; tick: number; timeMs: number };

/** One input to the store, in a form that can be stored and replayed. */
export type SimInput = { kind: "command"; envelope: unknown } | { kind: "tick"; request: unknown };

/**
 * Owner of authoritative state. `submit` (operator commands) and `tick` (simulation time) are
 * the only ways to change it; `view` hands out the current frozen state. Both run to
 * completion before the next call, so inputs are serialized in call order. The event log
 * records every input, including rejections and duplicates.
 */
export class CommandStore {
  private current: AuthoritativeState;
  private readonly events: SimEvent[] = [];
  private readonly processed = new Map<string, { payload: string; result: SubmitResult }>();

  constructor(
    private readonly world: SimWorld,
    initial: AuthoritativeState,
    private readonly publisher: StatePublisher | null = null,
  ) {
    assertClock(initial.clock);
    const issues = stateTrainIssues(world, initial);
    if (issues.length > 0) throw new Error(`invalid trains: ${describeIssues(issues)}`);
    assertOccupancyDerived(initial);
    assertRoutesAndSignalsConsistent(world, initial);
    assertServicesConsistent(world, initial);
    this.current = deepFreeze(initial);
  }

  view(): AuthoritativeState {
    return this.current;
  }

  log(): readonly SimEvent[] {
    return Object.freeze([...this.events]);
  }

  submit(raw: unknown): SubmitResult {
    const parsed = CommandEnvelope.safeParse(raw);
    if (!parsed.success) {
      const id = (raw as { commandId?: unknown })?.commandId;
      return this.record(typeof id === "string" ? id : "(none)", null, null, {
        outcome: "rejected",
        version: this.current.version,
        code: "MALFORMED",
        reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const env = parsed.data;
    const payload = JSON.stringify(env);
    const seen = this.processed.get(env.commandId);
    if (seen) {
      if (seen.payload !== payload)
        return this.record(env.commandId, env.operator, env.command, {
          outcome: "rejected",
          version: this.current.version,
          code: "COMMAND_ID_REUSED",
          reason: `command id ${env.commandId} was already used for a different command`,
        });
      return this.record(env.commandId, env.operator, env.command, {
        outcome: "duplicate",
        version: this.current.version,
        original: seen.result,
      });
    }
    const result: SubmitResult =
      env.expectedVersion !== this.current.version
        ? {
            outcome: "rejected",
            version: this.current.version,
            code: "STALE",
            reason: `based on version ${env.expectedVersion}; the current version is ${this.current.version}`,
          }
        : this.apply(env);
    this.processed.set(env.commandId, { payload, result });
    return this.record(env.commandId, env.operator, env.command, result);
  }

  private apply(env: CommandEnvelope): SubmitResult {
    const d = decide(this.world, this.current, env);
    if (!d.accepted)
      return { outcome: "rejected", version: this.current.version, code: d.code, reason: d.reason };
    assertOccupancyDerived(d.state);
    assertRoutesAndSignalsConsistent(this.world, d.state);
    assertServicesConsistent(this.world, d.state);
    this.current = deepFreeze(d.state);
    return { outcome: "accepted", version: this.current.version, changes: d.changes };
  }

  /**
   * Advance simulation time by one tick (D-031). Called by the session, never by operators.
   * A tick number already applied is a duplicate and changes nothing; a skipped tick is
   * refused. If the transition throws, the state is unchanged and nothing is recorded.
   */
  tick(raw: unknown): TickResult {
    const parsed = TickRequest.safeParse(raw);
    if (!parsed.success) {
      const t = (raw as { tick?: unknown })?.tick;
      return this.recordTick(typeof t === "number" && Number.isFinite(t) ? t : null, {
        ...this.clockResult(),
        outcome: "rejected",
        code: "MALFORMED",
        reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const d = decideTick(this.world, this.current, parsed.data);
    if (d.outcome === "accepted") {
      assertOccupancyDerived(d.state);
      assertRoutesAndSignalsConsistent(this.world, d.state);
      assertServicesConsistent(this.world, d.state);
      this.current = deepFreeze(d.state);
      return this.recordTick(parsed.data.tick, {
        ...this.clockResult(),
        outcome: "accepted",
        changes: d.changes,
      });
    }
    if (d.outcome === "duplicate")
      return this.recordTick(parsed.data.tick, { ...this.clockResult(), outcome: "duplicate" });
    return this.recordTick(parsed.data.tick, {
      ...this.clockResult(),
      outcome: "rejected",
      code: d.code,
      reason: d.reason,
    });
  }

  private clockResult() {
    return {
      version: this.current.version,
      tick: this.current.clock.tick,
      timeMs: this.current.clock.timeMs,
    };
  }

  private recordTick(tick: number | null, result: TickResult): TickResult {
    this.publish({
      kind: "tick",
      seq: this.events.length + 1,
      version: this.current.version,
      timeMs: this.current.clock.timeMs,
      tick,
      outcome: result.outcome,
      ...(result.outcome === "rejected" ? { code: result.code, reason: result.reason } : {}),
      ...(result.outcome === "accepted" ? { changes: result.changes } : {}),
    });
    return deepFreeze(result);
  }

  private publish(event: SimEvent): void {
    const frozen = deepFreeze(event);
    this.events.push(frozen);
    this.publisher?.publish({ version: this.current.version, state: this.current, event: frozen });
  }

  private record(
    commandId: string,
    operator: OperatorRef | null,
    command: Command | null,
    result: SubmitResult,
  ): SubmitResult {
    this.publish({
      kind: "command",
      seq: this.events.length + 1,
      version: this.current.version,
      timeMs: this.current.clock.timeMs,
      commandId,
      operator,
      outcome: result.outcome,
      command,
      ...(result.outcome === "rejected" ? { code: result.code, reason: result.reason } : {}),
      ...(result.outcome === "accepted" ? { changes: result.changes } : {}),
    });
    return deepFreeze(result);
  }
}

/**
 * Deterministic replay (D-031): apply `inputs` in order to a fresh store. The same world,
 * initial state and inputs always give a deep-equal final state and an identical log.
 */
export function replay(
  world: SimWorld,
  initial: AuthoritativeState,
  inputs: readonly SimInput[],
): { state: AuthoritativeState; events: readonly SimEvent[] } {
  const store = new CommandStore(world, initial);
  for (const input of inputs) {
    if (input.kind === "command") store.submit(input.envelope);
    else store.tick(input.request);
  }
  return { state: store.view(), events: store.log() };
}

/**
 * What an operator, human client session or AI signaller, is given: a read-only view and the
 * shared submit path. Nothing else: there is no way to reach or replace the store's state.
 */
export interface OperatorHandle {
  readonly operator: OperatorRef;
  view(): AuthoritativeState;
  submit(controlAreaId: string, commandId: string, command: Command): SubmitResult;
}

export function operatorHandle(store: CommandStore, operator: OperatorRef): OperatorHandle {
  return Object.freeze({
    operator,
    view: () => store.view(),
    submit: (controlAreaId: string, commandId: string, command: Command) =>
      store.submit({
        commandId,
        operator,
        controlAreaId,
        expectedVersion: store.view().version,
        command,
      }),
  });
}
