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
   * A route may be cancelled only while all its track (and overlap) is proven clear. Approach
   * locking and time-of-operation release are not modelled; they need train movement.
   */
  cancelRequiresClearTrack: z.literal(true),
});
export type SimulationPolicy = z.infer<typeof SimulationPolicy>;

export const DEFAULT_POLICY: SimulationPolicy = Object.freeze({
  allowedRouteStatuses: ["evidenced", "game_rule"] as ("evidenced" | "game_rule")[],
  routeSettingMovesPoints: false,
  unknownOccupancy: "treat_as_occupied",
  occupancyGranularity: "edge",
  pointsMoveInstantly: true,
  cancelRequiresClearTrack: true,
}) as SimulationPolicy;
