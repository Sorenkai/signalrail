import { routePhase, type AuthoritativeState, type SetRoute, type SimWorld } from "./state.ts";
import type { TickStage } from "./tick.ts";

/**
 * Route release and approach locking (P4, ADR 0001 "Route lifecycle", D-034). Pure and
 * deterministic: every choice is made in ascending id order, and time is the simulation clock.
 *
 * These are the game's simulation rules. Approach locking here is a GAME ABSTRACTION over the
 * track graph (policy `approachLocking: "approach_edge"`), not a real approach-locking distance,
 * and nothing here reproduces, certifies or proves the behaviour of any real interlocking.
 */

const sortedIds = (o: object) => Object.keys(o).sort();

/**
 * Why route `routeId` counts as approached, or [] when nothing approaches it. The approach
 * edges are the edges meeting the route's start node (entry signal node, or fringe entry
 * outside node) other than the route's first edge. Something approaches when:
 * - a train's head is on an approach edge, travelling towards the start node; or
 * - an approach edge's occupancy apart from trains (trackStatus) is not proven clear.
 * A route whose start node is not known is always treated as approached.
 */
export function approachReasons(world: SimWorld, state: AuthoritativeState, routeId: string) {
  const route = world.routes.get(routeId);
  const start = world.routeStart.get(routeId);
  if (!route || start === undefined) return [`route ${routeId} has no known start node`];
  const approach = world.graph
    .incident(start)
    .map((i) => i.edgeId)
    .filter((e) => e !== route.edgeIds[0]);
  const reasons: string[] = [];
  for (const id of sortedIds(state.trains)) {
    const head = state.trains[id]!.path.at(-1)!;
    if (head.towardsNodeId === start && approach.includes(head.edgeId))
      reasons.push(`train ${id} approaching on ${head.edgeId}`);
  }
  for (const e of [...new Set(approach)].sort())
    if (state.trackStatus[e] !== "clear")
      reasons.push(`approach edge ${e} is ${state.trackStatus[e] ?? "unknown"}`);
  return reasons;
}

/**
 * Why taken route `set` is still held, or null once it may be released. It is held while:
 * - any train lists it in its authority; or
 * - any train covers one of the route's own edges (head to tail; a stopped train included); or
 * - any train covers one of its overlap edges without holding an onward route over that edge.
 */
export function takenRouteHold(
  world: SimWorld,
  state: AuthoritativeState,
  set: SetRoute,
): string | null {
  const own = new Set(world.routes.get(set.routeId)?.edgeIds ?? set.edgeIds);
  const overlap = set.edgeIds.filter((e) => !own.has(e));
  for (const id of sortedIds(state.trains)) {
    const t = state.trains[id]!;
    if (t.authority.includes(set.routeId)) return `train ${id} holds it`;
    const covered = t.path.map((s) => s.edgeId);
    const onRoute = covered.find((e) => own.has(e));
    if (onRoute !== undefined) return `train ${id} occupies ${onRoute}`;
    const onOverlap = covered.find(
      (e) =>
        overlap.includes(e) && !t.authority.some((r) => world.routes.get(r)?.edgeIds.includes(e)),
    );
    if (onOverlap !== undefined)
      return `train ${id} occupies overlap edge ${onOverlap} without an onward route`;
  }
  return null;
}

/**
 * Why the approach lock of `set` must still be kept, or null once it may be released: the
 * lock releases when the release time has elapsed since the cancel, or when nothing
 * approaches the route any more (approachReasons), whichever comes first.
 */
export function approachLockHold(
  world: SimWorld,
  state: AuthoritativeState,
  set: SetRoute,
): string | null {
  const lock = set.approachLock!;
  const elapsed = state.clock.timeMs - lock.lockedAtMs;
  if (elapsed >= world.policy.approachLockReleaseMs) return null;
  const reasons = approachReasons(world, state, set.routeId);
  return reasons.length > 0 ? reasons.join("; ") : null;
}

/**
 * The P4 tick stage, run after train movement: releases every taken route its train has
 * cleared and every approach lock whose release condition is met, in ascending route id
 * order. It writes only `routes`: release never changes a signal, a train or the points.
 */
export const routeReleaseStage: TickStage = Object.freeze({
  name: "route-release",
  writes: Object.freeze(["routes"] as const),
  run(world: SimWorld, state: AuthoritativeState) {
    const changes: string[] = [];
    const released: string[] = [];
    for (const id of sortedIds(state.routes)) {
      const set = state.routes[id]!;
      const phase = routePhase(set);
      if (phase === "taken" && takenRouteHold(world, state, set) === null) {
        released.push(id);
        changes.push(`route ${id} released: train ${set.takenBy} has cleared it`);
      } else if (phase === "approach_locked" && approachLockHold(world, state, set) === null) {
        released.push(id);
        const elapsed = state.clock.timeMs - set.approachLock!.lockedAtMs;
        changes.push(
          elapsed >= world.policy.approachLockReleaseMs
            ? `route ${id} approach lock released: ${elapsed} ms since cancellation`
            : `route ${id} approach lock released: nothing approaching`,
        );
      }
    }
    if (released.length === 0) return { state, changes };
    const routes = { ...state.routes };
    for (const id of released) delete routes[id];
    return { state: { ...state, routes }, changes };
  },
});
