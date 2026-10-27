import type { Route } from "../model/index.ts";
import { CommandEnvelope, type Command, type OperatorRef, type RejectionCode } from "./commands.ts";
import { deepFreeze, type AuthoritativeState, type SetRoute, type SimWorld } from "./state.ts";

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
 * These checks enforce the game's simulation policy over the project's data. They do not
 * reproduce, certify or prove the safety of any real railway interlocking.
 */

export type Decision =
  | { accepted: true; state: AuthoritativeState; changes: string[] }
  | { accepted: false; code: RejectionCode; reason: string };

export interface CommandEvent {
  seq: number;
  /** State version after this event. */
  version: number;
  commandId: string;
  operator: OperatorRef | null;
  outcome: "accepted" | "rejected" | "duplicate";
  command: Command | null;
  code?: RejectionCode;
  reason?: string;
  changes?: string[];
}

export interface StateUpdate {
  version: number;
  state: AuthoritativeState;
  event: CommandEvent;
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

/** Whether `a` and `b` conflict: declared either way, shared track, or opposed points. */
function conflicts(world: SimWorld, a: Route, b: Route): string | null {
  if (a.conflictsWith.includes(b.id) || b.conflictsWith.includes(a.id)) return "declared";
  const ra = requirements(world, a);
  const rb = requirements(world, b);
  const shared = ra.edges.filter((e) => rb.edges.includes(e));
  if (shared.length > 0) return `shared track ${shared.join(", ")}`;
  for (const p of ra.points) {
    const q = rb.points.find((x) => x.pointsId === p.pointsId);
    if (q && q.position !== p.position) return `opposed points ${p.pointsId}`;
  }
  return null;
}

function authorised(
  world: SimWorld,
  envelope: CommandEnvelope,
  signalIds: string[],
  pointsIds: string[],
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
  const outside = [
    ...signalIds.filter((s) => !area.signalIds.includes(s)),
    ...pointsIds.filter((p) => !area.pointsIds.includes(p)),
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
    const denied = authorised(world, envelope, [route.entrySignalId], []);
    if (denied) return denied;
    const track = trackCheck(state, set.edgeIds, `cancelling route ${route.id}`);
    if (track) return track;
    const routes = { ...state.routes };
    delete routes[route.id];
    return {
      accepted: true,
      changes: [`route ${route.id} cancelled`, `signal ${route.entrySignalId} on`],
      state: {
        ...state,
        version: state.version + 1,
        routes,
        signals: { ...state.signals, [route.entrySignalId]: "on" },
      },
    };
  }

  // set_route
  const denied = authorised(
    world,
    envelope,
    [route.entrySignalId],
    req.points.map((p) => p.pointsId),
  );
  if (denied) return denied;
  if (state.routes[route.id])
    return reject("ROUTE_ALREADY_SET", `route ${route.id} is already set`);
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
    const why = conflicts(world, route, world.routes.get(other.routeId)!);
    if (why)
      return reject(
        "ROUTE_CONFLICT",
        `route ${route.id} conflicts with set route ${other.routeId} (${why})`,
      );
  }
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
      `signal ${route.entrySignalId} off`,
    ],
    state: {
      ...state,
      version: state.version + 1,
      routes: { ...state.routes, [route.id]: set },
      signals: { ...state.signals, [route.entrySignalId]: "off" },
    },
  };
}

/** The result a submitter receives. */
export type SubmitResult =
  | { outcome: "accepted"; version: number; changes: string[] }
  | { outcome: "rejected"; version: number; code: RejectionCode; reason: string }
  | { outcome: "duplicate"; version: number; original: SubmitResult };

/**
 * Owner of authoritative state. `submit` is the only way to change it; `view` hands out the
 * current frozen state. The event log records every submission, including rejections.
 */
export class CommandStore {
  private current: AuthoritativeState;
  private readonly events: CommandEvent[] = [];
  private readonly processed = new Map<string, { payload: string; result: SubmitResult }>();

  constructor(
    private readonly world: SimWorld,
    initial: AuthoritativeState,
    private readonly publisher: StatePublisher | null = null,
  ) {
    this.current = deepFreeze(initial);
  }

  view(): AuthoritativeState {
    return this.current;
  }

  log(): readonly CommandEvent[] {
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
    this.current = deepFreeze(d.state);
    return { outcome: "accepted", version: this.current.version, changes: d.changes };
  }

  private record(
    commandId: string,
    operator: OperatorRef | null,
    command: Command | null,
    result: SubmitResult,
  ): SubmitResult {
    const event: CommandEvent = deepFreeze({
      seq: this.events.length + 1,
      version: this.current.version,
      commandId,
      operator,
      outcome: result.outcome,
      command,
      ...(result.outcome === "rejected" ? { code: result.code, reason: result.reason } : {}),
      ...(result.outcome === "accepted" ? { changes: result.changes } : {}),
    });
    this.events.push(event);
    this.publisher?.publish({ version: this.current.version, state: this.current, event });
    return deepFreeze(result);
  }
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
