import { z } from "zod";
import { nextClock } from "./clock.ts";
import { trainMovementStage } from "./movement.ts";
import { routeReleaseStage } from "./routeLifecycle.ts";
import { serviceEntryStage, serviceExitStage } from "./services.ts";
import type { AuthoritativeState, SimWorld } from "./state.ts";
import { assertOccupancyDerived } from "./train.ts";

/**
 * Tick transitions (ADR 0001 "Simulation clock and ticks", D-031). A tick is identified by its
 * number: tick n moves the clock from tick n - 1 to n. Ticks are requested by the session that
 * owns the store, never by operators; OperatorHandle has no way to issue one.
 */

export const TickRequest = z.object({
  /** The tick to apply: the current tick + 1. */
  tick: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type TickRequest = z.infer<typeof TickRequest>;

/**
 * Why a tick was refused. Every code means "nothing changed".
 * - MALFORMED: the request does not parse (not a positive safe integer tick number).
 * - TICK_OUT_OF_SEQUENCE: the request skips one or more ticks.
 * - TIME_OVERFLOW: the next simulation time would leave the safe-integer range.
 */
export const TICK_REJECTION_CODES = ["MALFORMED", "TICK_OUT_OF_SEQUENCE", "TIME_OVERFLOW"] as const;
export type TickRejectionCode = (typeof TICK_REJECTION_CODES)[number];

export type TickDecision =
  | { outcome: "accepted"; state: AuthoritativeState; changes: string[] }
  | { outcome: "duplicate" }
  | { outcome: "rejected"; code: TickRejectionCode; reason: string };

/** State fields a tick stage may be allowed to replace. Never `version` or `clock`. */
export type StageField = Exclude<keyof AuthoritativeState, "version" | "clock">;

/**
 * The extension point for tick-driven change (P2 contract, made explicit in P3, D-032). A
 * stage gets the state with the clock already advanced and returns the next state and what it
 * changed. It must be pure, may replace only the fields it lists in `writes`, must never
 * change `version` or `clock`, and must throw rather than quietly repair a broken safety
 * invariant. decideTick enforces the field rules and derived occupancy after every stage. The
 * safety expectations every stage must keep are listed in ADR 0001.
 */
export interface TickStage {
  readonly name: string;
  readonly writes: readonly StageField[];
  run(world: SimWorld, state: AuthoritativeState): { state: AuthoritativeState; changes: string[] };
}

/**
 * P3: trains move. P5 (D-035): service trains wholly on their exit cut edge leave play. P4
 * (D-034): cleared routes and expired approach locks are released, against the positions
 * movement has just left. P5: due timetable services enter play where they have been accepted.
 */
export const TICK_STAGES: readonly TickStage[] = Object.freeze([
  trainMovementStage,
  serviceExitStage,
  routeReleaseStage,
  serviceEntryStage,
]);

/**
 * Pure tick decision. `stages` exists so the contract can be tested with synthetic stages;
 * the store always uses TICK_STAGES.
 */
export function decideTick(
  world: SimWorld,
  state: AuthoritativeState,
  request: TickRequest,
  stages: readonly TickStage[] = TICK_STAGES,
): TickDecision {
  const current = state.clock.tick;
  if (request.tick <= current) return { outcome: "duplicate" };
  if (request.tick !== current + 1)
    return {
      outcome: "rejected",
      code: "TICK_OUT_OF_SEQUENCE",
      reason: `tick ${request.tick} requested; the next tick is ${current + 1}`,
    };
  const clock = nextClock(state.clock);
  if (!clock)
    return {
      outcome: "rejected",
      code: "TIME_OVERFLOW",
      reason: `advancing ${state.clock.timeMs} ms by ${state.clock.tickDurationMs} ms leaves the safe-integer range`,
    };
  let next: AuthoritativeState = { ...state, version: state.version + 1, clock };
  const changes = [`clock tick ${clock.tick}: ${state.clock.timeMs} ms -> ${clock.timeMs} ms`];
  for (const stage of stages) {
    const r = stage.run(world, next);
    if (r.state.version !== next.version || r.state.clock !== next.clock)
      throw new Error("a tick stage must not change the state version or the clock");
    const keys = new Set([...Object.keys(next), ...Object.keys(r.state)]);
    for (const k of keys) {
      const field = k as keyof AuthoritativeState;
      if (field === "version" || field === "clock") continue;
      if (!(stage.writes as readonly string[]).includes(field) && r.state[field] !== next[field])
        throw new Error(`tick stage ${stage.name} changed ${field}, which it does not write`);
    }
    assertOccupancyDerived(r.state);
    next = r.state;
    changes.push(...r.changes);
  }
  return { outcome: "accepted", state: next, changes };
}
