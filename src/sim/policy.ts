import { z } from "zod";

/**
 * Simulation policy: the game's explicit rules where the real interlocking is not modelled
 * (ADR 0001, D-028). Every field is a SIMULATION ASSUMPTION, not a statement about any real
 * interlocking. Fail-safe rules are literal types, so no policy can switch a safety constraint
 * off; only choices that keep or tighten safety are configurable.
 */
export const SimulationPolicy = z.object({
  /**
   * Route data statuses (R2 assessInterlocking) a session may clear. `invalid` and
   * `insufficient_evidence` can never be allowed. Owner decision: evidenced and game_rule.
   */
  allowedRouteStatuses: z.array(z.enum(["evidenced", "game_rule"])).min(1),
  /**
   * Owner decision: set_route never moves points; operators move them first with
   * move_points, and set_route checks they are detected in the required position.
   */
  routeSettingMovesPoints: z.literal(false),
  /** Unknown occupancy is treated as occupied: a route or points move needs proven-clear track. */
  unknownOccupancy: z.literal("treat_as_occupied"),
  /**
   * Occupancy is held per track edge: no dataset has track circuits or axle counters, so this
   * is a simplification of real train detection.
   */
  occupancyGranularity: z.literal("edge"),
  /**
   * A points move takes effect at once and is detected at once: point swing time and detection
   * delay are not modelled.
   */
  pointsMoveInstantly: z.literal(true),
  /**
   * A route may be cancelled only while all its track (and overlap) is proven clear. Since P4
   * (D-034) a cancelled route with a train approaching it stays approach locked; a route a
   * train has taken is released automatically instead (`routeRelease`).
   */
  cancelRequiresClearTrack: z.literal(true),
  /**
   * (P4, D-034) When a cancelled offered route keeps its protection. A GAME ABSTRACTION, not a
   * real approach-locking distance (no dataset has one): a train is approaching when its head
   * is on an edge that meets the route's start node, other than the route's first edge, and it
   * travels towards that node. Approach track whose occupancy apart from trains is not proven
   * clear counts as approaching (unknown is treated as occupied).
   */
  approachLocking: z.literal("approach_edge"),
  /**
   * (P4, D-034) Time release of an approach lock, in simulation milliseconds from the cancel.
   * The lock also releases as soon as no train is approaching. A game setting, not a sourced
   * value for any real signal.
   */
  approachLockReleaseMs: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  /**
   * (P4, D-034) A taken route is released whole, with its overlap, at the end of the first tick
   * in which no train holds it or covers its track (overlap track is allowed only under an
   * onward route the covering train holds). No sectional release. Release never clears a signal.
   */
  routeRelease: z.literal("on_train_clearance"),
  /**
   * (P3.1, D-033) What a signal facing a train does, by its source-derived function
   * (SIGNAL_MOVEMENT_ROLE in train.ts): main and shunting signals stop it unless they are the
   * `off` entry signal of the route it takes there; distants and repeaters show no stop
   * indication and are passed; stop boards and `other`/`unknown` functions are never passed and
   * never authorise a movement. A signal whose facing is unknown is treated as facing the train.
   */
  signalAtOn: z.literal("stop_by_function"),
  /** (P3) A train passing a route's entry signal returns it to on; a route serves one train. */
  signalReplacement: z.literal("on_passing"),
  /**
   * (P3) Trains stop instantly at the limit of their authority: no braking curves. The P4
   * approach zone (`approachLocking`) is one edge only because of this; a braking model must
   * widen the zone to cover braking distance in the same change.
   */
  trainStopping: z.literal("instant"),
  /** (P3) Track with no known length has no known footprint, so no train may enter it. */
  unknownEdgeLength: z.literal("impassable"),
  /**
   * (P6) A timetable service train takes only routes of its planned chain (its service
   * pattern's routes). Offered any other route, it waits at the signal (`ROUTE_NOT_PLANNED`),
   * so it can never be run to a cut that is not its exit, where it could never leave play. A
   * game rule, not a claim about how drivers or signallers deal with a wrong route.
   */
  serviceRouting: z.literal("planned_chain_only"),
});
export type SimulationPolicy = z.infer<typeof SimulationPolicy>;

export const DEFAULT_POLICY: SimulationPolicy = Object.freeze({
  allowedRouteStatuses: ["evidenced", "game_rule"] as ("evidenced" | "game_rule")[],
  routeSettingMovesPoints: false,
  unknownOccupancy: "treat_as_occupied",
  occupancyGranularity: "edge",
  pointsMoveInstantly: true,
  cancelRequiresClearTrack: true,
  approachLocking: "approach_edge",
  approachLockReleaseMs: 120_000,
  routeRelease: "on_train_clearance",
  signalAtOn: "stop_by_function",
  signalReplacement: "on_passing",
  trainStopping: "instant",
  unknownEdgeLength: "impassable",
  serviceRouting: "planned_chain_only",
}) as SimulationPolicy;
