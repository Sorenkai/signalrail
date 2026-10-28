import type {
  Control,
  GameRules,
  PointsGameRule,
  Infrastructure,
  PlayableArea,
  Route,
  Signalling,
  SourceRegistry,
} from "../model/index.ts";
import { TrackGraph } from "../graph/trackGraph.ts";
import { assessInterlocking, type InterlockingStatus } from "../validation/interlocking.ts";
import { resolveGameRules } from "../validation/gameRules.ts";
import { DEFAULT_CLOCK, startClock, type ClockConfig, type ClockState } from "./clock.ts";
import type { SimulationPolicy } from "./policy.ts";
import { buildServicePlan, type TimetableInput, type TimetablePlan } from "./servicePlan.ts";
import { initialServices, type ServiceState } from "./services.ts";
import {
  deriveOccupancy,
  describeIssues,
  newTrain,
  placementIssues,
  TrainSpec,
  type TrainState,
} from "./train.ts";

/**
 * Runtime simulation state (layer 4): owned by the server, changed only by the command
 * pipeline, and always deeply frozen so no holder of a reference can mutate it.
 */
export interface PointsState {
  position: "normal" | "reverse" | "unknown";
  detected: boolean;
}

export interface SetRoute {
  routeId: string;
  /** Points held by the route (path, flank and overlap requirements). */
  lockedPointsIds: string[];
  /** Track the route and its overlap occupy. */
  edgeIds: string[];
  setBy: string;
  commandId: string;
  /**
   * The train the route is allocated to (P3, D-032). Absent while the route is offered: its
   * entry signal is then `off`. Set when a train passes the route's start, which returns the
   * signal to `on`. The route is never offered again: it is released automatically once the
   * train has cleared it (P4, D-034) and must then be set anew. The train's own `authority`
   * lists only the taken routes it still covers.
   */
  takenBy?: string;
  /**
   * (P4, D-034) Present once an offered route was cancelled while a train was approaching it:
   * its entry signal is back `on`, but the route keeps its points locked and its track reserved
   * until the route-release stage frees it. Never present together with `takenBy`.
   */
  approachLock?: {
    /** The cancel_route command that started the lock. */
    commandId: string;
    /** Simulation time of that command; the time release counts from here. */
    lockedAtMs: number;
  };
}

/**
 * Where a set route is in its lifecycle (P4, D-034), derived from its fields, never stored:
 * - offered:          set, no train has taken it; its entry signal is `off`.
 * - taken:            allocated to `takenBy`; its entry signal was replaced on passing.
 * - approach_locked:  cancelled with a train approaching; signal `on`, protection kept.
 * A released or cancelled route is not in `routes` at all.
 */
export type RoutePhase = "offered" | "taken" | "approach_locked";

export function routePhase(set: SetRoute): RoutePhase {
  if (set.takenBy !== undefined) return "taken";
  if (set.approachLock !== undefined) return "approach_locked";
  return "offered";
}

export interface AuthoritativeState {
  /** Increases by one on every accepted command or tick; unchanged by rejections. */
  version: number;
  /** Simulation time (D-031). Only ticks change it; commands apply at the current time. */
  clock: Readonly<ClockState>;
  points: Readonly<Record<string, Readonly<PointsState>>>;
  routes: Readonly<Record<string, Readonly<SetRoute>>>;
  /**
   * Signal aspects in the simplest form: "off" exactly while an offered (set, untaken) route
   * starts at the signal (routeSignalIssues). An aspect is not movement authority.
   */
  signals: Readonly<Record<string, "on" | "off">>;
  /**
   * What is known of each edge apart from simulated trains (P3, D-032): `clear` only where
   * proven at session setup. Nothing changes it in P3.
   */
  trackStatus: Readonly<Record<string, "clear" | "occupied" | "unknown">>;
  /**
   * Per-edge occupancy (policy: edge granularity), DERIVED: occupied where any train's path
   * covers the edge, otherwise trackStatus. Only deriveOccupancy produces it.
   */
  occupancy: Readonly<Record<string, "clear" | "occupied" | "unknown">>;
  /** Simulated trains by id (P3). */
  trains: Readonly<Record<string, Readonly<TrainState>>>;
  /**
   * (P5, D-035) Every runnable timetable service of the session's plan, by service id; empty
   * without a timetable. Only the service tick stages change it.
   */
  services: Readonly<Record<string, Readonly<ServiceState>>>;
}

/** Static, validated data the pipeline checks commands against. Never changes in a session. */
export interface SimWorld {
  infrastructure: Infrastructure;
  signalling: Signalling;
  control: Control;
  graph: TrackGraph;
  policy: SimulationPolicy;
  /** R2 data status of every route and overlap. */
  status: ReadonlyMap<string, InterlockingStatus>;
  routes: ReadonlyMap<string, Route>;
  /** Cut id of every valid fringe endpoint (game-rules.json, D-029), by endpoint id. */
  fringeCuts: ReadonlyMap<string, string>;
  /** The cut geometry of every valid fringe endpoint, by endpoint id (P5: entry and exit). */
  fringes: ReadonlyMap<
    string,
    { cutId: string; edgeId: string; insideNodeId: string; outsideNodeId: string }
  >;
  /** Valid points game rules by Points id, for TrackGraph.switchPassage (D-029, D-032). */
  pointsRules: ReadonlyMap<string, PointsGameRule>;
  /** Start node of every route: its entry signal's node, or its fringe entry's outside node. */
  routeStart: ReadonlyMap<string, string>;
  /** Which control areas each operator id may act in (session configuration). */
  assignments: Readonly<Record<string, readonly string[]>>;
  /** (P5, D-035) The session's timetable service plan, or null for a session without one. */
  timetable: TimetablePlan | null;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const v of Object.values(value as object)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export function createWorld(
  data: {
    infrastructure: Infrastructure;
    signalling: Signalling;
    control: Control;
    sources: SourceRegistry;
    /** Game rules and the playable area they refer to (D-029); both optional. */
    gameRules?: GameRules;
    playableArea?: PlayableArea;
    /** A dated timetable snapshot with its service patterns and session settings (P5). */
    timetable?: TimetableInput;
  },
  policy: SimulationPolicy,
  assignments: Record<string, string[]>,
): SimWorld {
  // A private copy: freezing the world must not freeze the caller's data.
  const own = structuredClone(data);
  const graph = new TrackGraph(own.infrastructure);
  // Only valid game rules are used; invalid ones leave their points unresolved (fail-safe).
  const rules = resolveGameRules(
    own.infrastructure,
    graph,
    own.gameRules,
    own.playableArea,
  ).context;
  const { assessments } = assessInterlocking(
    own.infrastructure,
    own.signalling,
    own.sources,
    graph,
    rules,
  );
  const { timetable: timetableInput, ...layers } = own;
  const world: Omit<SimWorld, "timetable"> = {
    ...layers,
    graph,
    policy: structuredClone(policy),
    status: new Map(assessments.map((a) => [a.id, a.status])),
    routes: new Map(own.signalling.routes.map((r) => [r.id, r])),
    fringeCuts: new Map([...rules.fringes].map(([id, f]) => [id, f.cut.id])),
    fringes: new Map(
      [...rules.fringes].map(([id, f]) => [
        id,
        {
          cutId: f.cut.id,
          edgeId: f.cut.edgeId,
          insideNodeId: f.cut.insideNodeId,
          outsideNodeId: f.cut.outsideNodeId,
        },
      ]),
    ),
    pointsRules: rules.points,
    routeStart: new Map(
      own.signalling.routes.flatMap((r) => {
        const signal = own.infrastructure.signals.find((s) => s.id === r.entrySignalId);
        const start = r.entryFringeId
          ? rules.fringes.get(r.entryFringeId)?.cut.outsideNodeId
          : signal?.trackNodeId;
        return start ? [[r.id, start] as const] : [];
      }),
    ),
    assignments: structuredClone(assignments),
  };
  const timetable = timetableInput ? buildServicePlan(world, rules.fringes, timetableInput) : null;
  return deepFreeze({ ...world, timetable }) as SimWorld;
}

/**
 * The starting state. Fail-safe defaults: points unknown and undetected, occupancy unknown,
 * every signal on, no route set. Tests and future simulation supply proven values explicitly.
 * The clock starts at tick 0 from `known.clock`, or DEFAULT_CLOCK; an invalid one throws.
 * `known.occupancy` is the trackStatus: what is known of each edge apart from simulated trains.
 * `known.trains` places trains (P3, D-032); an impossible placement throws.
 */
export function initialState(
  world: SimWorld,
  known: {
    points?: Record<string, PointsState>;
    occupancy?: Record<string, "clear" | "occupied" | "unknown">;
    clock?: ClockConfig;
    trains?: readonly (TrainSpec | unknown)[];
  } = {},
): AuthoritativeState {
  const infra = world.infrastructure;
  const points = Object.fromEntries(
    infra.points.map((p) => [
      p.id,
      known.points?.[p.id] ?? { position: "unknown" as const, detected: false },
    ]),
  );
  const trackStatus = Object.fromEntries(
    infra.edges.map((e) => [e.id, known.occupancy?.[e.id] ?? ("unknown" as const)]),
  );
  const issues = placementIssues(world, known.trains ?? [], points, trackStatus);
  if (issues.length > 0) throw new Error(`invalid train placement: ${describeIssues(issues)}`);
  const trains = Object.fromEntries(
    (known.trains ?? []).map((t) => {
      const train = newTrain(TrainSpec.parse(t));
      return [train.id, train];
    }),
  );
  const services = initialServices(world);
  const taken = Object.values(services).find((s) => trains[s.trainId]);
  if (taken)
    throw new Error(`train id ${taken.trainId} is reserved for service ${taken.serviceId}`);
  return deepFreeze({
    version: 0,
    clock: startClock(known.clock ?? DEFAULT_CLOCK),
    points,
    routes: {},
    signals: Object.fromEntries(infra.signals.map((s) => [s.id, "on" as const])),
    trackStatus,
    occupancy: deriveOccupancy(trackStatus, trains),
    trains,
    services,
  });
}
