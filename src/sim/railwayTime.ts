/**
 * Railway operating time (P5, D-035): the mapping between simulation time and UK local
 * railway time for one timetable operating date.
 *
 *   simulation time t ms  <->  UTC instant (windowStartUtcMs + t)  <->  Europe/London wall time
 *
 * `windowStartUtcMs` is the UTC instant of the snapshot's window start (D-026: local
 * `operatingDate windowStart`, 00:00 at Carlisle). Simulation time stays an integer count of
 * milliseconds; elapsed simulation time is elapsed real time, so on a clock-change day the wall
 * clock jumps while simulation time does not.
 *
 * Wall-clock conversion uses the IANA "Europe/London" zone through Intl with an explicit
 * timeZone, never the host's zone, the system clock or a timer. Wall-clock fields are combined
 * with the pure `Date.UTC` arithmetic function. A local time that does not exist (spring
 * forward) or occurs twice (fall back) is reported as such and never resolved by guessing.
 */

export const RAILWAY_TIME_ZONE = "Europe/London";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

const londonParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: RAILWAY_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Wall-clock fields of a UTC instant in Europe/London. */
function wallFields(utcMs: number) {
  const f: Record<string, number> = {};
  for (const p of londonParts.formatToParts(utcMs))
    if (p.type !== "literal") f[p.type] = Number(p.value);
  return { y: f.year!, mo: f.month!, d: f.day!, h: f.hour!, mi: f.minute!, s: f.second! };
}

/** Europe/London wall time of `utcMs`, read as if it were UTC (for offset arithmetic). */
function wallAsUtc(utcMs: number): number {
  const w = wallFields(utcMs);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) + (utcMs - Math.floor(utcMs / 1000) * 1000);
}

/** UTC offset of Europe/London at `utcMs`, in minutes (0 for GMT, 60 for BST). */
export function londonOffsetMinutes(utcMs: number): number {
  return (wallAsUtc(utcMs) - utcMs) / MINUTE_MS;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** "YYYY-MM-DDTHH:MM:SS" Europe/London wall time of `utcMs` (no offset suffix). */
export function londonWallTime(utcMs: number): string {
  const w = wallFields(utcMs);
  return `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}`;
}

export type LocalResolution =
  | { kind: "ok"; utcMs: number }
  /** The wall time is skipped by a spring-forward change. */
  | { kind: "nonexistent" }
  /** The wall time occurs twice (fall back); both instants, earlier first. */
  | { kind: "ambiguous"; utcMs: [number, number] };

/**
 * The UTC instant(s) at which Europe/London shows `isoDate` plus `dayOffset` days at
 * `timeOfDayMs` after midnight. Deterministic and independent of the host zone.
 */
export function resolveLondonTime(
  isoDate: string,
  timeOfDayMs: number,
  dayOffset = 0,
): LocalResolution {
  const [y, mo, d] = isoDate.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, mo - 1, d + dayOffset) + timeOfDayMs;
  // London's offset is never outside 0..+2 h (2 h only in wartime double summer time).
  const hits = [0, 1, 2]
    .map((h) => wall - h * HOUR_MS)
    .filter((utc) => wallAsUtc(utc) === wall)
    .sort((a, b) => a - b);
  if (hits.length === 0) return { kind: "nonexistent" };
  if (hits.length === 1) return { kind: "ok", utcMs: hits[0]! };
  return { kind: "ambiguous", utcMs: [hits[0]!, hits.at(-1)!] };
}

/** Milliseconds after midnight of a CIF "HH:MM" or "HH:MM:30" time. */
export function cifTimeMs(t: string): number {
  return (
    (Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))) * MINUTE_MS + (t.length > 5 ? 30_000 : 0)
  );
}

/** The fixed link between simulation time and the operating date of one session. */
export interface RailwayTimeBase {
  operatingDate: string;
  timeZone: typeof RAILWAY_TIME_ZONE;
  /** Local time at which the operating day (the snapshot window) starts, "HH:MM". */
  windowStart: string;
  /** UTC instant of simulation time 0. */
  windowStartUtcMs: number;
}

/** The base for `operatingDate`; throws if the window start is not a single valid instant. */
export function railwayTimeBase(operatingDate: string, windowStart: string): RailwayTimeBase {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(operatingDate) || !/^\d{2}:\d{2}$/.test(windowStart))
    throw new Error(`invalid operating date or window start: ${operatingDate} ${windowStart}`);
  const r = resolveLondonTime(operatingDate, cifTimeMs(windowStart));
  if (r.kind !== "ok")
    throw new Error(`window start ${operatingDate} ${windowStart} is ${r.kind} in Europe/London`);
  return {
    operatingDate,
    timeZone: RAILWAY_TIME_ZONE,
    windowStart,
    windowStartUtcMs: r.utcMs,
  };
}

/** Europe/London wall time at simulation time `simMs`. */
export function simTimeToLocal(base: RailwayTimeBase, simMs: number) {
  const utcMs = base.windowStartUtcMs + simMs;
  return { wallTime: londonWallTime(utcMs), utcOffsetMinutes: londonOffsetMinutes(utcMs) };
}

/** Simulation time of a local wall time, or why there is not exactly one. */
export function localToSimTime(
  base: RailwayTimeBase,
  isoDate: string,
  timeOfDayMs: number,
  dayOffset = 0,
): { kind: "ok"; simMs: number } | { kind: "nonexistent" } | { kind: "ambiguous" } {
  const r = resolveLondonTime(isoDate, timeOfDayMs, dayOffset);
  if (r.kind === "ok") return { kind: "ok", simMs: r.utcMs - base.windowStartUtcMs };
  return { kind: r.kind };
}
