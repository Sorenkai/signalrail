import { simTimeToLocal } from "./railwayTime.ts";
import { runnableServices, type ServicePlanEntry, type ServiceRun } from "./servicePlan.ts";
import { routePhase, type AuthoritativeState, type SimWorld } from "./state.ts";
import type { TickStage } from "./tick.ts";
import {
  deriveOccupancy,
  describeIssues,
  edgeLengthMm,
  newTrain,
  placementIssues,
  type TrainSpec,
  type TrainState,
} from "./train.ts";

/**
 * Timetable service lifecycle (P5, ADR 0001 "Timetable services", D-035). Pure and
 * deterministic. Services come only from the world's frozen plan (servicePlan.ts); operators
 * cannot create, spawn or remove one. Two tick stages change them:
 *
 * - service-exit (after movement): a service train whose whole length stands on its exit
 *   fringe's cut edge, head at the cut's outside node, has left play. It is removed, the routes
 *   it had taken are released, and the service is `departed`. Nothing beyond the cut is
 *   simulated.
 * - service-entry (last): from its due time, a service enters play only when the signaller has
 *   accepted it by setting its entry fringe route (offered, its points detected and locked) and
 *   the entry track is proven clear. The train is placed rear at the fringe's outside node and
 *   takes that route. Otherwise it is `pending`, with the reason shown; it never enters
 *   occupied or unproven track and is never dropped or rerouted.
 *
 * These are game rules over the project's data. They reproduce no real train describer,
 * acceptance or fringe-box procedure.
 */

/**
 * - scheduled: before its due time (or due, before the next tick has looked at it).
 * - pending:   due, but not yet able to enter (`waiting` says why).
 * - active:    in play as train `trainId`.
 * - departed:  has left play at its exit fringe. Never re-enters.
 * Unsupported and invalid services never reach the state: they stay in the plan.
 */
export type ServiceStatus = "scheduled" | "pending" | "active" | "departed";

export interface ServiceState {
  serviceId: string;
  trainId: string;
  dueAtMs: number;
  status: ServiceStatus;
  waiting: string | null;
  enteredAtMs: number | null;
  departedAtMs: number | null;
}

/** The services of a new session: every runnable service, scheduled. */
export function initialServices(world: SimWorld): Record<string, ServiceState> {
  return Object.fromEntries(
    runnableServices(world.timetable).map((e) => [
      e.serviceId,
      {
        serviceId: e.serviceId,
        trainId: e.run!.trainId,
        dueAtMs: e.run!.dueAtMs,
        status: "scheduled" as const,
        waiting: null,
        enteredAtMs: null,
        departedAtMs: null,
      },
    ]),
  );
}

const planOf = (world: SimWorld) =>
  new Map(runnableServices(world.timetable).map((e) => [e.serviceId, e]));

const label = (e: ServicePlanEntry) => `service ${e.serviceId} (${e.headcode ?? "no headcode"})`;

function entrySpec(run: ServiceRun): TrainSpec {
  return {
    id: run.trainId,
    lengthMm: run.lengthMm,
    speedMmPerS: run.speedMmPerS,
    path: run.entryPath.map((s) => ({ ...s })),
    headOffsetMm: run.entryHeadOffsetMm,
  };
}

/** Why `run` cannot enter play now, or null if it may. */
export function entryBlocker(
  world: SimWorld,
  state: AuthoritativeState,
  run: ServiceRun,
): string | null {
  const routeId = run.routeIds[0]!;
  const set = state.routes[routeId];
  if (!set) return `entry route ${routeId} is not set`;
  const phase = routePhase(set);
  if (phase === "taken") return `entry route ${routeId} is taken by train ${set.takenBy}`;
  if (phase === "approach_locked") return `entry route ${routeId} is approach locked`;
  // The same checks as a train taking a route (movement.ts), against the current state.
  const route = world.routes.get(routeId)!;
  for (const id of [routeId, ...(route.overlapId ? [route.overlapId] : [])]) {
    const status = world.status.get(id);
    if (!status || !(world.policy.allowedRouteStatuses as string[]).includes(status))
      return `${id} has data status ${status ?? "unassessed"}, which the policy does not allow`;
  }
  const overlap = route.overlapId
    ? world.signalling.overlaps.find((o) => o.id === route.overlapId)
    : undefined;
  for (const q of [...route.pointsRequired, ...(overlap?.pointsRequired ?? [])]) {
    const now = state.points[q.pointsId];
    if (!now || !now.detected || now.position !== q.position)
      return `points ${q.pointsId} are not detected ${q.position}`;
    if (!set.lockedPointsIds.includes(q.pointsId))
      return `entry route ${routeId} does not lock points ${q.pointsId}`;
  }
  for (const s of run.entryPath) {
    const o = state.occupancy[s.edgeId];
    if (o === "occupied") return `entry track ${s.edgeId} is occupied`;
    if (o !== "clear") return `entry track ${s.edgeId} is not proven clear`;
  }
  const issues = placementIssues(world, [entrySpec(run)], state.points, state.trackStatus);
  return issues.length > 0 ? describeIssues(issues) : null;
}

/** Whether service train `t` has left play at the exit of `run` (see the stage below). */
export function hasLeftPlay(world: SimWorld, t: TrainState, run: ServiceRun): boolean {
  const cut = world.fringes.get(run.exitFringeId);
  const exitRoute = run.routeIds.at(-1)!;
  if (!cut || !t.authority.includes(exitRoute)) return false;
  const head = t.path.at(-1)!;
  return (
    t.path.length === 1 &&
    head.edgeId === cut.edgeId &&
    head.towardsNodeId === cut.outsideNodeId &&
    t.headOffsetMm === edgeLengthMm(world, cut.edgeId)
  );
}

export const serviceExitStage: TickStage = Object.freeze({
  name: "service-exit",
  writes: Object.freeze(["trains", "occupancy", "routes", "services"] as const),
  run(world: SimWorld, state: AuthoritativeState) {
    const plan = planOf(world);
    const changes: string[] = [];
    let trains: Record<string, Readonly<TrainState>> = state.trains;
    let routes: Record<string, AuthoritativeState["routes"][string]> = state.routes;
    let services = state.services;
    for (const id of Object.keys(state.trains).sort()) {
      const t = state.trains[id]!;
      const e = t.service ? plan.get(t.service.serviceId) : undefined;
      if (!e || !hasLeftPlay(world, t, e.run!)) continue;
      changes.push(`${label(e)} left play at fringe ${e.run!.exitFringeId} as train ${id}`);
      trains = { ...trains };
      delete trains[id];
      routes = { ...routes };
      for (const r of Object.keys(routes).sort())
        if (routes[r]!.takenBy === id) {
          delete routes[r];
          changes.push(`route ${r} released: train ${id} has left play`);
        }
      services = {
        ...services,
        [e.serviceId]: {
          ...services[e.serviceId]!,
          status: "departed",
          departedAtMs: state.clock.timeMs,
        },
      };
    }
    if (trains === state.trains) return { state, changes };
    return {
      state: {
        ...state,
        trains,
        routes,
        services,
        occupancy: deriveOccupancy(state.trackStatus, trains),
      },
      changes,
    };
  },
});

export const serviceEntryStage: TickStage = Object.freeze({
  name: "service-entry",
  writes: Object.freeze(["trains", "occupancy", "routes", "services"] as const),
  run(world: SimWorld, state: AuthoritativeState) {
    const now = state.clock.timeMs;
    const changes: string[] = [];
    let s = state;
    // Plan order: due time, then service id. At one fringe the earlier service enters first.
    for (const e of runnableServices(world.timetable)) {
      const svc = s.services[e.serviceId]!;
      if (svc.status !== "scheduled" && svc.status !== "pending") continue;
      if (now < svc.dueAtMs) continue;
      const run = e.run!;
      const why = entryBlocker(world, s, run);
      if (why !== null) {
        if (svc.status === "pending" && svc.waiting === why) continue;
        changes.push(
          svc.status === "scheduled"
            ? `${label(e)} due at ${simTimeToLocal(world.timetable!.base, svc.dueAtMs).wallTime} (${run.dueTiploc}): waiting, ${why}`
            : `${label(e)} waiting: ${why}`,
        );
        s = {
          ...s,
          services: { ...s.services, [e.serviceId]: { ...svc, status: "pending", waiting: why } },
        };
        continue;
      }
      const routeId = run.routeIds[0]!;
      const train: TrainState = {
        ...newTrain(entrySpec(run)),
        authority: [routeId],
        service: { serviceId: e.serviceId, headcode: e.headcode },
      };
      const trains = { ...s.trains, [train.id]: train };
      s = {
        ...s,
        trains,
        occupancy: deriveOccupancy(s.trackStatus, trains),
        routes: { ...s.routes, [routeId]: { ...s.routes[routeId]!, takenBy: train.id } },
        services: {
          ...s.services,
          [e.serviceId]: { ...svc, status: "active", waiting: null, enteredAtMs: now },
        },
      };
      changes.push(
        `${label(e)} entered play at fringe ${run.entryFringeId} as train ${train.id}, taking route ${routeId} (${now - svc.dueAtMs} ms after due)`,
      );
    }
    return { state: s, changes };
  },
});

/**
 * Service records, plan and trains agree (checked on every state the store accepts): exactly
 * the runnable plan services exist; an active service has its train, and only it; every other
 * service has none; times are ordered and not after the clock.
 */
export function serviceIssues(world: SimWorld, state: AuthoritativeState): string[] {
  const issues: string[] = [];
  const plan = planOf(world);
  const ids = Object.keys(state.services);
  if (ids.length !== plan.size || ids.some((id) => !plan.has(id)))
    issues.push("the services are not exactly the runnable services of the plan");
  const now = state.clock.timeMs;
  const okTime = (t: number | null) => t !== null && Number.isSafeInteger(t) && t <= now;
  for (const id of ids) {
    const svc = state.services[id]!;
    const e = plan.get(id);
    if (!e) continue;
    if (svc.serviceId !== id || svc.trainId !== e.run!.trainId || svc.dueAtMs !== e.run!.dueAtMs)
      issues.push(`service ${id} does not match its plan entry`);
    const train = state.trains[svc.trainId];
    switch (svc.status) {
      case "active":
        if (train?.service?.serviceId !== id)
          issues.push(`active service ${id} has no train ${svc.trainId}`);
        if (!okTime(svc.enteredAtMs) || svc.departedAtMs !== null || svc.waiting !== null)
          issues.push(`active service ${id} has inconsistent times`);
        break;
      case "departed":
        if (train) issues.push(`departed service ${id} still has train ${svc.trainId}`);
        if (
          !okTime(svc.enteredAtMs) ||
          !okTime(svc.departedAtMs) ||
          svc.departedAtMs! < svc.enteredAtMs! ||
          svc.waiting !== null
        )
          issues.push(`departed service ${id} has inconsistent times`);
        break;
      case "scheduled":
      case "pending":
        if (train) issues.push(`${svc.status} service ${id} already has train ${svc.trainId}`);
        if (svc.enteredAtMs !== null || svc.departedAtMs !== null)
          issues.push(`${svc.status} service ${id} has entry or departure times`);
        if (svc.status === "pending" && (svc.waiting === null || now < svc.dueAtMs))
          issues.push(`pending service ${id} is not due or gives no reason`);
        if (svc.status === "scheduled" && svc.waiting !== null)
          issues.push(`scheduled service ${id} has a waiting reason`);
        break;
      default:
        issues.push(`service ${id} has an unknown status`);
    }
  }
  const serviceTrainIds = new Set([...plan.values()].map((e) => e.run!.trainId));
  for (const t of Object.values(state.trains)) {
    if (t.service === undefined) {
      if (serviceTrainIds.has(t.id)) issues.push(`train ${t.id} uses a service train id`);
      continue;
    }
    const svc = state.services[t.service.serviceId];
    if (svc?.status !== "active" || svc.trainId !== t.id)
      issues.push(`train ${t.id} claims service ${t.service.serviceId}, which is not active as it`);
  }
  return issues;
}

/** Throws unless serviceIssues finds nothing. */
export function assertServicesConsistent(world: SimWorld, state: AuthoritativeState): void {
  const issues = serviceIssues(world, state);
  if (issues.length > 0) throw new Error(`services are inconsistent: ${issues.join("; ")}`);
}
