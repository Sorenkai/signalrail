import { routePhase, type AuthoritativeState, type SimWorld } from "./state.ts";
import type { TickStage } from "./tick.ts";
import {
  deriveOccupancy,
  edgeLengthMm,
  otherEnd,
  passageProblem,
  signalMovementRole,
  signalsFacing,
  trimPath,
  type StopCode,
  type TrainState,
  type TrainStep,
} from "./train.ts";

/**
 * Train movement (ADR 0001 "Trains, movement and occupancy", D-032). Pure and deterministic:
 * trains move one at a time in ascending id order, each against the state the previous one
 * left, only along routes they have taken, and stop at the first point they may not pass.
 *
 * These are the game's simulation rules. They do not reproduce, certify or prove the behaviour
 * of any real railway or interlocking.
 */

type Stop = { code: StopCode; at: string; reason: string };
type Next = { step: TrainStep; take: string | null } | { stop: Stop };

const stop = (code: StopCode, at: string, reason: string): { stop: Stop } => ({
  stop: { code, at, reason },
});

/** Route ids, ascending, so every choice below is independent of insertion order. */
const sortedIds = (o: object) => Object.keys(o).sort();

/** The edge the head must enter next from the node it stands at, and the route it takes, if any. */
function nextStep(
  world: SimWorld,
  state: AuthoritativeState,
  train: TrainState,
  authority: readonly string[],
): Next {
  const head = train.path.at(-1)!;
  const node = head.towardsNodeId;
  const flat = authority.flatMap((r) => world.routes.get(r)!.edgeIds);
  const i = flat.lastIndexOf(head.edgeId);
  if (i >= 0 && i < flat.length - 1) {
    const edgeId = flat[i + 1]!;
    const to = otherEnd(world, edgeId, node);
    if (to === null || edgeId === head.edgeId)
      return stop(
        "DISCONNECTED_PATH",
        node,
        `authority edge ${edgeId} does not continue from ${node}`,
      );
    return { step: { edgeId, towardsNodeId: to }, take: null };
  }
  // At the end of its authority (or with none): take a set route starting here, if one may be.
  const from = otherEnd(world, head.edgeId, node)!;
  const candidates = sortedIds(state.routes).filter(
    (r) =>
      world.routeStart.get(r) === node &&
      world.routes.get(r)!.edgeIds[0] !== head.edgeId &&
      otherEnd(world, world.routes.get(r)!.edgeIds[0]!, node) !== from,
  );
  // Only an offered route may be taken: never a taken or an approach-locked one (D-034).
  const offered = candidates.filter((r) => routePhase(state.routes[r]!) === "offered");
  // (P6) A service train takes only routes of its planned chain (`serviceRouting`).
  const planned = train.service
    ? world.timetable?.entries.find((e) => e.serviceId === train.service!.serviceId)?.run?.routeIds
    : undefined;
  const free = train.service ? offered.filter((r) => planned?.includes(r) === true) : offered;
  if (free.length === 0 && offered.length > 0)
    return stop(
      "ROUTE_NOT_PLANNED",
      node,
      `route ${offered.join(", ")} at ${node} is not on the planned path of service ${train.service!.serviceId}`,
    );
  if (free.length === 0) {
    const danger = world.infrastructure.signals.filter(
      (s) =>
        s.trackNodeId === node &&
        s.facingTowardsNodeId.value !== from &&
        signalMovementRole(s) !== "no_stop" &&
        state.signals[s.id] !== "off",
    );
    if (danger.length > 0)
      return stop(
        "SIGNAL_AT_DANGER",
        danger[0]!.id,
        `signal ${danger.map((s) => s.id).join(", ")} at ${node} is on and no free set route starts there`,
      );
    return stop("NO_AUTHORITY", node, `no set route the train may take starts at ${node}`);
  }
  const routeId = free[0]!;
  const route = world.routes.get(routeId)!;
  const set = state.routes[routeId]!;
  for (const id of [routeId, ...(route.overlapId ? [route.overlapId] : [])]) {
    const status = world.status.get(id);
    if (!status || !(world.policy.allowedRouteStatuses as string[]).includes(status))
      return stop(
        "ROUTE_NOT_ESTABLISHED",
        node,
        `${id} has data status ${status ?? "unassessed"}, which the policy does not allow`,
      );
  }
  const entry =
    route.entrySignalId === null
      ? null
      : world.infrastructure.signals.find((s) => s.id === route.entrySignalId);
  // Only a worked stop signal can authorise a movement; any other entry is never taken.
  if (entry !== null && (entry === undefined || signalMovementRole(entry) !== "worked_stop"))
    return stop(
      "ROUTE_NOT_ESTABLISHED",
      route.entrySignalId!,
      `entry signal ${route.entrySignalId} of route ${routeId} has function ${entry?.function ?? "(missing)"}, which cannot authorise a movement`,
    );
  if (route.entrySignalId !== null && state.signals[route.entrySignalId] !== "off")
    return stop(
      "SIGNAL_AT_DANGER",
      route.entrySignalId,
      `entry signal ${route.entrySignalId} of route ${routeId} is on`,
    );
  const overlap = route.overlapId
    ? world.signalling.overlaps.find((o) => o.id === route.overlapId)
    : undefined;
  for (const q of [...route.pointsRequired, ...(overlap?.pointsRequired ?? [])]) {
    const now = state.points[q.pointsId];
    if (!now || !now.detected || now.position !== q.position)
      return stop(
        "POINTS_NOT_PROVEN",
        q.pointsId,
        `route ${routeId} needs points ${q.pointsId} detected ${q.position}`,
      );
    if (!set.lockedPointsIds.includes(q.pointsId))
      return stop(
        "POINTS_NOT_LOCKED",
        q.pointsId,
        `route ${routeId} does not lock points ${q.pointsId}`,
      );
  }
  const edgeId = route.edgeIds[0]!;
  return { step: { edgeId, towardsNodeId: otherEnd(world, edgeId, node)! }, take: routeId };
}

/**
 * Checks for the head crossing its node onto `step`, against the current state. `take` is the
 * route the train takes by this crossing, if any.
 */
function crossingProblem(
  world: SimWorld,
  state: AuthoritativeState,
  train: TrainState,
  step: TrainStep,
  routeIds: readonly string[],
  take: string | null,
): Stop | null {
  const head = train.path.at(-1)!;
  const node = head.towardsNodeId;
  const from = otherEnd(world, head.edgeId, node)!;
  const to = step.towardsNodeId;
  const p = passageProblem(world, state.points, from, node, to, {
    routes: state.routes,
    routeIds,
  });
  if (p) return { code: p.code, at: node, reason: p.reason };
  // By function (D-033): a worked stop signal is passed only as the `off` entry signal of the
  // route taken here, so an aspect alone never grants authority; no_stop signals are passed.
  const entrySignalId = take === null ? null : world.routes.get(take)!.entrySignalId;
  for (const s of signalsFacing(world, node, to)) {
    const role = signalMovementRole(s);
    if (role === "no_stop") continue;
    if (role === "worked_stop" && s.id === entrySignalId && state.signals[s.id] === "off") continue;
    if (role === "worked_stop" && state.signals[s.id] === "off")
      return {
        code: "NO_AUTHORITY",
        at: s.id,
        reason: `signal ${s.id} at ${node} is off, but not for a route train ${train.id} takes here`,
      };
    return {
      code: "SIGNAL_AT_DANGER",
      at: s.id,
      reason:
        role === "worked_stop"
          ? `signal ${s.id} at ${node} facing ${to} is on`
          : `signal ${s.id} at ${node} facing ${to} has function ${s.function}, which is never cleared`,
    };
  }
  if (edgeLengthMm(world, step.edgeId) === null)
    return {
      code: "EDGE_LENGTH_UNKNOWN",
      at: step.edgeId,
      reason: `edge ${step.edgeId} has no known length, so its footprint is unknown`,
    };
  const holder = sortedIds(state.trains).find(
    (id) => id !== train.id && state.trains[id]!.path.some((s) => s.edgeId === step.edgeId),
  );
  if (holder !== undefined || train.path.some((s) => s.edgeId === step.edgeId))
    return {
      code: "TRACK_OCCUPIED",
      at: step.edgeId,
      reason: `edge ${step.edgeId} is occupied by train ${holder ?? train.id}`,
    };
  const status = state.trackStatus[step.edgeId];
  if (status === "occupied")
    return {
      code: "TRACK_OCCUPIED",
      at: step.edgeId,
      reason: `edge ${step.edgeId} is occupied by something other than a simulated train`,
    };
  if (status !== "clear")
    return {
      code: "TRACK_NOT_PROVEN_CLEAR",
      at: step.edgeId,
      reason: `occupancy of edge ${step.edgeId} is unknown, which the policy treats as occupied`,
    };
  return null;
}

/** Move one train for one tick. Returns the new state (occupancy re-derived) and change lines. */
export function moveTrain(
  world: SimWorld,
  state: AuthoritativeState,
  trainId: string,
): { state: AuthoritativeState; changes: string[] } {
  const before = state.trains[trainId]!;
  const total = before.speedMmPerS * state.clock.tickDurationMs + before.residue;
  let budget = Math.floor(total / 1000);
  let residue = total % 1000;
  let train: TrainState = { ...before };
  let routes = state.routes;
  let signals = state.signals;
  const changes: string[] = [];
  let halted: Stop | null = null;
  let moved = 0;

  if (!Number.isSafeInteger(total)) {
    halted = {
      code: "MOVEMENT_OVERFLOW",
      at: before.path.at(-1)!.edgeId,
      reason: "speed x tick duration leaves the safe-integer range",
    };
    budget = 0;
  }

  // Stale authority: every route the train holds must still be set and taken by it.
  const withdrawn = train.authority.find((r) => routes[r]?.takenBy !== train.id);
  if (!halted && withdrawn !== undefined) {
    halted = {
      code: "AUTHORITY_WITHDRAWN",
      at: withdrawn,
      reason: `route ${withdrawn} is no longer set for train ${train.id}`,
    };
    budget = 0;
  }

  while (budget > 0) {
    const head = train.path.at(-1)!;
    const len = edgeLengthMm(world, head.edgeId)!;
    if (train.headOffsetMm < len) {
      // Moving within the head edge needs authority over it.
      const held = train.authority.some((r) => world.routes.get(r)!.edgeIds.includes(head.edgeId));
      if (!held) {
        halted = {
          code: "NO_AUTHORITY",
          at: head.edgeId,
          reason: `train holds no route over edge ${head.edgeId}`,
        };
        break;
      }
      const step = Math.min(len - train.headOffsetMm, budget);
      train = { ...train, headOffsetMm: train.headOffsetMm + step };
      budget -= step;
      moved += step;
      continue;
    }
    const current: AuthoritativeState = { ...state, routes, signals };
    const next = nextStep(world, current, train, train.authority);
    if ("stop" in next) {
      halted = next.stop;
      break;
    }
    const holding = next.take ? [...train.authority, next.take] : train.authority;
    const problem = crossingProblem(world, current, train, next.step, holding, next.take);
    if (problem) {
      halted = problem;
      break;
    }
    if (next.take) {
      const route = world.routes.get(next.take)!;
      routes = { ...routes, [next.take]: { ...routes[next.take]!, takenBy: train.id } };
      // Replacement on passing (policy): a following train sees the signal at danger.
      if (route.entrySignalId !== null) signals = { ...signals, [route.entrySignalId]: "on" };
      changes.push(
        `train ${train.id} took route ${next.take}` +
          (route.entrySignalId !== null ? `; signal ${route.entrySignalId} on` : ""),
      );
    }
    train = { ...train, authority: holding, path: [...train.path, next.step], headOffsetMm: 0 };
    // The new head edge has a length of at least 1 mm and budget > 0, so the head moves at once.
  }

  if (halted) residue = 0;
  const path = trimPath(world, train.path, train.headOffsetMm, train.lengthMm);
  const covered = new Set(path.map((s) => s.edgeId));
  const authority = [...train.authority];
  // Routes the tail has left fully are no longer held; the route-release stage frees them.
  while (
    authority.length > 0 &&
    !world.routes.get(authority[0]!)!.edgeIds.some((e) => covered.has(e))
  )
    authority.shift();

  const sameStop =
    (halted === null && before.stopped === null) ||
    (halted !== null &&
      before.stopped !== null &&
      halted.code === before.stopped.code &&
      halted.at === before.stopped.at);
  if (moved > 0)
    changes.push(
      `train ${train.id} moved ${moved} mm; head ${path.at(-1)!.edgeId} at ${train.headOffsetMm} mm`,
    );
  if (halted && !sameStop)
    changes.push(`train ${train.id} stopped: ${halted.code} at ${halted.at} (${halted.reason})`);

  const after: TrainState = {
    ...train,
    path,
    authority,
    residue,
    stopped: sameStop ? before.stopped : halted,
  };
  const unchanged =
    moved === 0 &&
    residue === before.residue &&
    sameStop &&
    routes === state.routes &&
    authority.length === before.authority.length;
  if (unchanged) return { state, changes: [] };
  const trains = { ...state.trains, [train.id]: after };
  return {
    state: {
      ...state,
      routes,
      signals,
      trains,
      occupancy: deriveOccupancy(state.trackStatus, trains),
    },
    changes,
  };
}

/** The P3 tick stage: every train moves once, in ascending id order. */
export const trainMovementStage: TickStage = Object.freeze({
  name: "train-movement",
  writes: Object.freeze(["trains", "occupancy", "routes", "signals"] as const),
  run(world: SimWorld, state: AuthoritativeState) {
    let s = state;
    const changes: string[] = [];
    for (const id of sortedIds(state.trains)) {
      const r = moveTrain(world, s, id);
      s = r.state;
      changes.push(...r.changes);
    }
    return { state: s, changes };
  },
});
