import { z } from "zod";

/**
 * Simulation clock (ADR 0001 "Simulation clock and ticks", D-031). Simulation time is an
 * integer count of milliseconds on the session timeline, separate from wall-clock time:
 * nothing here reads system time, timers or frame rate. Integers keep every advance exact,
 * so after n ticks the time is exactly start + n * tickDurationMs, with no drift.
 *
 * What time 0 means (its mapping to timetable dates and UK local times, D-026) is deferred
 * to timetable playback.
 */

const SafeNonNegativeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const ClockConfig = z.object({
  /** Simulation time at tick 0, in milliseconds. */
  startTimeMs: SafeNonNegativeInt,
  /** How far one tick advances simulation time, in milliseconds. */
  tickDurationMs: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type ClockConfig = z.infer<typeof ClockConfig>;

/** The one default clock: start at 0 ms, one-second ticks. A game setting, not a real-world claim. */
export const DEFAULT_CLOCK: ClockConfig = Object.freeze({ startTimeMs: 0, tickDurationMs: 1000 });

export interface ClockState {
  /** Ticks applied since the session started; 0 before the first. */
  tick: number;
  /** Current simulation time in milliseconds. */
  timeMs: number;
  tickDurationMs: number;
}

/** The clock at tick 0. Throws on an invalid configuration: a session must not start with one. */
export function startClock(config: ClockConfig): ClockState {
  const c = ClockConfig.parse(config);
  return { tick: 0, timeMs: c.startTimeMs, tickDurationMs: c.tickDurationMs };
}

/** Throws unless `clock` is a well-formed clock state (used on states handed to a store). */
export function assertClock(clock: ClockState): void {
  const ok =
    clock !== null &&
    typeof clock === "object" &&
    SafeNonNegativeInt.safeParse(clock.tick).success &&
    SafeNonNegativeInt.safeParse(clock.timeMs).success &&
    ClockConfig.shape.tickDurationMs.safeParse(clock.tickDurationMs).success;
  if (!ok) throw new Error(`invalid simulation clock state: ${JSON.stringify(clock)}`);
}

/**
 * The clock one tick later, or null when the next time would leave the safe-integer range.
 * The caller refuses the tick in that case (TIME_OVERFLOW); the clock never wraps or rounds.
 */
export function nextClock(clock: ClockState): ClockState | null {
  const timeMs = clock.timeMs + clock.tickDurationMs;
  if (!Number.isSafeInteger(timeMs)) return null;
  return { tick: clock.tick + 1, timeMs, tickDurationMs: clock.tickDurationMs };
}
