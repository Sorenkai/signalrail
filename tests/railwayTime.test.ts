/**
 * Railway operating time (P5, D-035): simulation time <-> UTC <-> Europe/London wall time.
 * The dates are real calendar dates chosen for their UK clock rules (2026: BST starts 29 March
 * 01:00 UTC, ends 25 October 01:00 UTC); no timetable data is involved.
 */
import { describe, expect, it } from "vitest";
import {
  cifTimeMs,
  localToSimTime,
  londonOffsetMinutes,
  londonWallTime,
  railwayTimeBase,
  resolveLondonTime,
  simTimeToLocal,
} from "../src/sim/index.ts";

const H = 3_600_000;
const M = 60_000;
const utc = (iso: string) => Date.parse(`${iso}Z`);

describe("Europe/London wall time", () => {
  it("is GMT in winter and BST in summer", () => {
    expect(londonOffsetMinutes(utc("2026-11-04T12:00:00"))).toBe(0);
    expect(londonOffsetMinutes(utc("2026-07-01T12:00:00"))).toBe(60);
    expect(londonWallTime(utc("2026-07-01T12:00:00"))).toBe("2026-07-01T13:00:00");
  });

  it("does not depend on the host time zone", () => {
    const original = process.env.TZ;
    const results: string[] = [];
    try {
      for (const tz of ["UTC", "America/New_York", "Asia/Tokyo", "Australia/Lord_Howe"]) {
        process.env.TZ = tz;
        const base = railwayTimeBase("2026-11-04", "00:00");
        results.push(
          JSON.stringify([
            base.windowStartUtcMs,
            simTimeToLocal(base, 7 * H + 30 * M),
            localToSimTime(base, "2026-11-04", cifTimeMs("23:59:30")),
            resolveLondonTime("2026-03-29", cifTimeMs("01:30")),
            resolveLondonTime("2026-10-25", cifTimeMs("01:30")),
          ]),
        );
      }
    } finally {
      process.env.TZ = original;
    }
    expect(new Set(results).size).toBe(1);
  });
});

describe("local times on clock-change days", () => {
  it("reports the spring-forward gap as nonexistent, never as a guessed instant", () => {
    expect(resolveLondonTime("2026-03-29", cifTimeMs("00:59"))).toEqual({
      kind: "ok",
      utcMs: utc("2026-03-29T00:59:00"),
    });
    expect(resolveLondonTime("2026-03-29", cifTimeMs("01:00"))).toEqual({ kind: "nonexistent" });
    expect(resolveLondonTime("2026-03-29", cifTimeMs("01:59:30"))).toEqual({
      kind: "nonexistent",
    });
    expect(resolveLondonTime("2026-03-29", cifTimeMs("02:00"))).toEqual({
      kind: "ok",
      utcMs: utc("2026-03-29T01:00:00"),
    });
  });

  it("reports the fall-back hour as ambiguous, with both instants", () => {
    expect(resolveLondonTime("2026-10-25", cifTimeMs("00:59"))).toEqual({
      kind: "ok",
      utcMs: utc("2026-10-24T23:59:00"),
    });
    expect(resolveLondonTime("2026-10-25", cifTimeMs("01:30"))).toEqual({
      kind: "ambiguous",
      utcMs: [utc("2026-10-25T00:30:00"), utc("2026-10-25T01:30:00")],
    });
    expect(resolveLondonTime("2026-10-25", cifTimeMs("02:00"))).toEqual({
      kind: "ok",
      utcMs: utc("2026-10-25T02:00:00"),
    });
  });
});

describe("simulation time and the operating date", () => {
  it("starts the operating day at local window start, whatever the UTC offset", () => {
    expect(railwayTimeBase("2026-11-04", "00:00").windowStartUtcMs).toBe(
      utc("2026-11-04T00:00:00"),
    );
    expect(railwayTimeBase("2026-07-01", "00:00").windowStartUtcMs).toBe(
      utc("2026-06-30T23:00:00"),
    );
  });

  it("maps a normal day exactly, including the CIF half minute", () => {
    const base = railwayTimeBase("2026-11-04", "00:00");
    expect(localToSimTime(base, "2026-11-04", cifTimeMs("06:12:30"))).toEqual({
      kind: "ok",
      simMs: 6 * H + 12 * M + 30_000,
    });
    expect(simTimeToLocal(base, 6 * H + 12 * M + 30_000)).toEqual({
      wallTime: "2026-11-04T06:12:30",
      utcOffsetMinutes: 0,
    });
  });

  it("places previous-day and next-day times before 0 and after 24 h", () => {
    const base = railwayTimeBase("2026-11-04", "00:00");
    // A train that started the day before (runDate 11-03) and is due at 23:50 that day.
    expect(localToSimTime(base, "2026-11-03", cifTimeMs("23:50"))).toEqual({
      kind: "ok",
      simMs: -10 * M,
    });
    // The same train's next-day call (dayOffset 1 from runDate 11-03) at 00:05.
    expect(localToSimTime(base, "2026-11-03", cifTimeMs("00:05"), 1)).toEqual({
      kind: "ok",
      simMs: 5 * M,
    });
    expect(localToSimTime(base, "2026-11-04", cifTimeMs("00:30"), 1)).toEqual({
      kind: "ok",
      simMs: 24 * H + 30 * M,
    });
  });

  it("counts elapsed time across the spring-forward change: 03:00 BST is 2 h after midnight", () => {
    const base = railwayTimeBase("2026-03-29", "00:00");
    expect(localToSimTime(base, "2026-03-29", cifTimeMs("03:00"))).toEqual({
      kind: "ok",
      simMs: 2 * H,
    });
    expect(simTimeToLocal(base, 1 * H)).toEqual({
      wallTime: "2026-03-29T02:00:00",
      utcOffsetMinutes: 60,
    });
    expect(localToSimTime(base, "2026-03-29", cifTimeMs("01:30"))).toEqual({
      kind: "nonexistent",
    });
  });

  it("counts elapsed time across the fall-back change: 02:30 GMT is 3.5 h after midnight", () => {
    const base = railwayTimeBase("2026-10-25", "00:00");
    expect(localToSimTime(base, "2026-10-25", cifTimeMs("02:30"))).toEqual({
      kind: "ok",
      simMs: 3.5 * H,
    });
    expect(localToSimTime(base, "2026-10-25", cifTimeMs("01:30"))).toEqual({ kind: "ambiguous" });
    // The wall clock shows 01:30 twice; simulation time does not repeat.
    expect(simTimeToLocal(base, 1.5 * H).wallTime).toBe("2026-10-25T01:30:00");
    expect(simTimeToLocal(base, 2.5 * H).wallTime).toBe("2026-10-25T01:30:00");
  });

  it("refuses a malformed operating date or window start", () => {
    expect(() => railwayTimeBase("4 Nov 2026", "00:00")).toThrow(/invalid operating date/);
    expect(() => railwayTimeBase("2026-11-04", "0:00")).toThrow(/invalid operating date/);
  });
});
