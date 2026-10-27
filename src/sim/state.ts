import type { Control, Infrastructure, Route, Signalling, SourceRegistry } from "../model/index.ts";
import { TrackGraph } from "../graph/trackGraph.ts";
import { assessInterlocking, type InterlockingStatus } from "../validation/interlocking.ts";
import type { SimulationPolicy } from "./policy.ts";

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
}

export interface AuthoritativeState {
  /** Increases by one on every accepted command; unchanged by rejections. */
  version: number;
  points: Readonly<Record<string, Readonly<PointsState>>>;
  routes: Readonly<Record<string, Readonly<SetRoute>>>;
  /** Signal aspects in the simplest form: "off" only while a route from it is set. */
  signals: Readonly<Record<string, "on" | "off">>;
  /** Per-edge occupancy (policy: edge granularity). Injected; no train movement yet. */
  occupancy: Readonly<Record<string, "clear" | "occupied" | "unknown">>;
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
  /** Which control areas each operator id may act in (session configuration). */
  assignments: Readonly<Record<string, readonly string[]>>;
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
  },
  policy: SimulationPolicy,
  assignments: Record<string, string[]>,
): SimWorld {
  // A private copy: freezing the world must not freeze the caller's data.
  const own = structuredClone(data);
  const graph = new TrackGraph(own.infrastructure);
  const { assessments } = assessInterlocking(
    own.infrastructure,
    own.signalling,
    own.sources,
    graph,
  );
  return deepFreeze({
    ...own,
    graph,
    policy: structuredClone(policy),
    status: new Map(assessments.map((a) => [a.id, a.status])),
    routes: new Map(own.signalling.routes.map((r) => [r.id, r])),
    assignments: structuredClone(assignments),
  }) as SimWorld;
}

/**
 * The starting state. Fail-safe defaults: points unknown and undetected, occupancy unknown,
 * every signal on, no route set. Tests and future simulation supply proven values explicitly.
 */
export function initialState(
  world: SimWorld,
  known: {
    points?: Record<string, PointsState>;
    occupancy?: Record<string, "clear" | "occupied" | "unknown">;
  } = {},
): AuthoritativeState {
  const infra = world.infrastructure;
  return deepFreeze({
    version: 0,
    points: Object.fromEntries(
      infra.points.map((p) => [
        p.id,
        known.points?.[p.id] ?? { position: "unknown" as const, detected: false },
      ]),
    ),
    routes: {},
    signals: Object.fromEntries(infra.signals.map((s) => [s.id, "on" as const])),
    occupancy: Object.fromEntries(
      infra.edges.map((e) => [e.id, known.occupancy?.[e.id] ?? ("unknown" as const)]),
    ),
  });
}
