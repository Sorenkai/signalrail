import type { Service, TimetableSnapshot } from "../model/index.ts";
import type { Issue, Severity } from "./validate.ts";

/**
 * Timetable snapshot checks (DATA_MODEL "Timetable validation", D-026). They test the
 * snapshot's own consistency against CIF semantics; they do not judge whether a train's
 * timing is operationally sensible. Legitimate timetable behaviour (equal consecutive times,
 * one midnight crossing, a call whose departure falls after midnight) is never rejected.
 */

const UID = /^[A-Z ]\d{5}$/;
const TIPLOC = /^[A-Z0-9]{1,7}$/;

const toMinutes = (t: string | null) =>
  t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) + (t.length > 5 ? 0.5 : 0) : null;

const addDays = (isoDate: string, days: number) => {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Minutes from the origin date's midnight for each time of each call, using the stored
 * dayOffset: a call's first time is on dayOffset; a later time in the same call that reads
 * earlier on the clock is on the next day.
 */
function absoluteTimes(s: Service): { tiploc: string; time: string; abs: number }[] {
  const out: { tiploc: string; time: string; abs: number }[] = [];
  for (const c of s.calls) {
    let day = c.dayOffset ?? 0;
    let prev: number | null = null;
    for (const time of [c.arrival, c.pass, c.departure]) {
      const m = toMinutes(time);
      if (m === null) continue;
      if (prev !== null && m < prev) day++;
      prev = m;
      out.push({ tiploc: c.tiploc, time: time!, abs: day * 1440 + m });
    }
  }
  return out;
}

/** Day offsets recomputed from the clock times alone (the I-009 rule). */
function expectedOffsets(s: Service): number[] {
  let off = 0;
  let prev = -1;
  return s.calls.map((c) => {
    let first: number | null = null;
    for (const time of [c.arrival, c.pass, c.departure]) {
      const m = toMinutes(time);
      if (m === null) continue;
      if (m < prev) off++;
      prev = m;
      if (first === null) first = off;
    }
    return first ?? off;
  });
}

export function validateTimetables(
  timetables: TimetableSnapshot[],
  timingPoints: { area: Set<string> | null; deferred: Set<string> },
): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Severity, code: string, message: string, ids?: string[]) =>
    issues.push({ severity, code, message, ...(ids ? { ids } : {}) });

  for (const overlap of [...timingPoints.deferred].filter((t) => timingPoints.area?.has(t)))
    add(
      "error",
      "TIMING_POINT_SCOPE_CONFLICT",
      `TIPLOC ${overlap} is both an area and a deferred TIPLOC`,
      [overlap],
    );

  for (const t of timetables) {
    const conv = t.convention;
    if (!conv)
      add(
        "warning",
        "TIMETABLE_LEGACY_CONVENTION",
        `${t.id} predates the operating-day convention (D-026): it holds services by origin date, so trains that began the previous day and reach the area after midnight are absent`,
        [t.id],
      );
    else if (conv.clockChangeInWindow)
      add(
        "warning",
        "TIMETABLE_CLOCK_CHANGE",
        `${t.id}: a UK clock change falls in the window; wall-clock times around it are ambiguous`,
        [t.id],
      );

    // --- source records the import did not take in ---
    const imp = t.import;
    if (imp) {
      if (imp.parseErrors > 0)
        add("error", "TIMETABLE_PARSE_ERRORS", `${t.id}: ${imp.parseErrors} CIF parse error(s)`, [
          t.id,
        ]);
      if (imp.unknownRecordTypes.length > 0)
        add(
          "warning",
          "TIMETABLE_UNSUPPORTED_RECORDS",
          `${t.id}: unknown CIF record type(s) ${imp.unknownRecordTypes.join(", ")} were counted, not imported`,
          [t.id],
        );
      const skipped = Object.entries(imp.skippedRecords);
      if (skipped.length > 0)
        add(
          "info",
          "TIMETABLE_SKIPPED_RECORDS",
          `${t.id}: not imported: ${skipped.map(([k, n]) => `${k} x${n}`).join(", ")} (TIPLOC master records describe locations, not trains)`,
          [t.id],
        );
    }

    const area = imp ? new Set(imp.areaTiplocs) : timingPoints.area;
    const holidays = new Set((t.calendar?.bankHolidays ?? []).map((h) => h.date));
    const windowDates =
      conv && conv.windowStart !== "00:00" ? [t.date, addDays(t.date, 1)] : [t.date];
    const holidayInWindow = windowDates.some((d) => holidays.has(d));
    const w = conv ? toMinutes(conv.windowStart)! : 0;
    const ids = new Set<string>();

    for (const s of t.services) {
      ids.add(s.id);
      // --- identifiers ---
      if (!UID.test(s.uid))
        add("error", "TIMETABLE_SERVICE_ID_INVALID", `${s.id}: invalid UID "${s.uid}"`, [s.id]);
      if (s.id !== `${s.uid}:${s.runDate}`)
        add(
          "error",
          "TIMETABLE_SERVICE_ID_INVALID",
          `${s.id}: id must be "${s.uid}:${s.runDate}"`,
          [s.id],
        );
      for (const c of s.calls)
        if (!TIPLOC.test(c.tiploc))
          add("error", "TIMETABLE_TIPLOC_INVALID", `${s.id}: "${c.tiploc}" is not a valid TIPLOC`, [
            s.id,
          ]);

      // --- journey shape ---
      const first = s.calls[0]!;
      const last = s.calls.at(-1)!;
      const shape: string[] = [];
      if (first.kind !== "origin" || !first.departure)
        shape.push("does not start at an origin with a departure");
      if (last.kind !== "destination" || !last.arrival)
        shape.push("does not end at a destination with an arrival");
      if (s.calls.slice(1, -1).some((c) => c.kind !== "intermediate"))
        shape.push("has an origin or destination mid-journey");
      if (s.calls.slice(1, -1).some((c) => !c.arrival && !c.departure && !c.pass))
        shape.push("has an intermediate call with no time");
      if (shape.length > 0)
        add("error", "TIMETABLE_JOURNEY_INCOMPLETE", `${s.id} ${shape.join("; ")}`, [s.id]);

      // --- time order and overnight rollover ---
      const hasOffsets = s.calls.every((c) => c.dayOffset !== undefined);
      if (conv && !hasOffsets)
        add("error", "TIMETABLE_DAY_OFFSET", `${s.id}: calls lack dayOffset`, [s.id]);
      if (hasOffsets) {
        const expected = expectedOffsets(s);
        if (s.calls.some((c, i) => c.dayOffset !== expected[i]))
          add(
            "error",
            "TIMETABLE_DAY_OFFSET",
            `${s.id}: stored day offsets disagree with the times (expected ${expected.join(",")})`,
            [s.id],
          );
        const times = absoluteTimes(s);
        for (let i = 1; i < times.length; i++)
          if (times[i]!.abs < times[i - 1]!.abs)
            add(
              "error",
              "TIMETABLE_TIME_ORDER",
              `service ${s.id}: time ${times[i]!.time} at ${times[i]!.tiploc} goes backwards`,
              [s.id],
            );
      } else {
        // Legacy snapshots: one midnight crossing allowed.
        let prev: number | null = null;
        let wrapped = false;
        for (const c of s.calls)
          for (const time of [c.arrival, c.pass, c.departure]) {
            const m = toMinutes(time);
            if (m === null) continue;
            if (prev !== null && m < prev) {
              if (!wrapped && prev - m > 12 * 60) wrapped = true;
              else
                add(
                  "error",
                  "TIMETABLE_TIME_ORDER",
                  `service ${s.id}: time ${time} at ${c.tiploc} goes backwards`,
                  [s.id],
                );
            }
            prev = m;
          }
      }

      // --- window membership (area-time convention) ---
      if (conv && hasOffsets && area) {
        const shift =
          (Date.parse(`${s.runDate}T00:00:00Z`) - Date.parse(`${t.date}T00:00:00Z`)) / 60000;
        const areaTimes = absoluteTimes(s)
          .filter((x) => area.has(x.tiploc))
          .map((x) => x.abs + shift);
        const inWin = areaTimes.filter((m) => m >= w && m < w + 1440);
        if (inWin.length === 0)
          add(
            "error",
            "TIMETABLE_WINDOW",
            `${s.id} has no play-area time inside the ${t.date} window`,
            [s.id],
          );
        else if (s.window) {
          const before = areaTimes.some((m) => m < w);
          const after = areaTimes.some((m) => m >= w + 1440);
          const expected =
            before && after ? "spans" : before ? "starts_before" : after ? "ends_after" : "within";
          if (s.window !== expected)
            add(
              "error",
              "TIMETABLE_WINDOW",
              `${s.id}: window "${s.window}" should be "${expected}"`,
              [s.id],
            );
        }
      }

      // --- change en route ---
      for (const c of s.changesEnRoute ?? [])
        if (s.calls[c.callIndex]?.tiploc !== c.tiploc)
          add(
            "error",
            "TIMETABLE_CHANGE_EN_ROUTE",
            `${s.id}: change en route at ${c.tiploc} does not match call ${c.callIndex}`,
            [s.id],
          );

      // --- bank holidays ---
      if (s.bankHolidayRunning) {
        if (
          !t.calendar ||
          s.bankHolidayApplicability === "unresolved" ||
          !s.bankHolidayApplicability
        )
          add(
            "warning",
            "BANK_HOLIDAY_UNRESOLVED",
            `${s.id} carries bank-holiday running "${s.bankHolidayRunning}" and ${t.calendar ? "the window holds a bank holiday" : "the snapshot has no bank-holiday calendar"}: whether it runs is unresolved`,
            [s.id],
          );
        else if (holidayInWindow)
          add(
            "error",
            "BANK_HOLIDAY_INCONSISTENT",
            `${s.id} is marked not_applicable, but the window holds a bank holiday`,
            [s.id],
          );
      } else if (s.bankHolidayApplicability)
        add(
          "error",
          "BANK_HOLIDAY_INCONSISTENT",
          `${s.id} has a bank-holiday applicability but no bank-holiday running flag`,
          [s.id],
        );
    }

    // --- associations ---
    const byId = new Map(t.services.map((s) => [s.id, s]));
    const assocIds = new Set<string>();
    for (const a of t.associations ?? []) {
      if (assocIds.has(a.id))
        add("error", "DUPLICATE_ID", `association ${a.id} repeated in ${t.id}`, [a.id]);
      assocIds.add(a.id);
      const ends = [
        [a.mainServiceId, a.mainStatus, a.baseSuffix],
        [a.assocServiceId, a.assocStatus, a.assocSuffix],
      ] as const;
      if (!ends.some(([, st]) => st === "in_snapshot"))
        add(
          "error",
          "ASSOCIATION_UNKNOWN_SERVICE",
          `association ${a.id} involves no service in the snapshot`,
          [a.id],
        );
      for (const [sid, st, suffix] of ends) {
        const svc = byId.get(sid);
        if (st === "in_snapshot" && !svc)
          add(
            "error",
            "ASSOCIATION_UNKNOWN_SERVICE",
            `association ${a.id}: ${sid} is marked in the snapshot but is not in it`,
            [a.id, sid],
          );
        else if (st !== "in_snapshot" && svc)
          add(
            "error",
            "ASSOCIATION_UNKNOWN_SERVICE",
            `association ${a.id}: ${sid} is in the snapshot but marked ${st}`,
            [a.id, sid],
          );
        else if (st === "not_running" || st === "not_in_extract")
          add(
            "warning",
            "ASSOCIATION_UNKNOWN_SERVICE",
            `association ${a.id}: ${sid} is ${st === "not_running" ? "not running that day" : "not in the source extract"}`,
            [a.id, sid],
          );
        if (
          svc &&
          !svc.calls.some((c) => c.tiploc === a.location && (c.suffix ?? "") === (suffix ?? ""))
        )
          add(
            "error",
            "ASSOCIATION_LOCATION",
            `association ${a.id}: ${sid} does not call at ${a.location}${suffix ? ` (suffix ${suffix})` : ""}`,
            [a.id, sid],
          );
      }
    }

    for (const x of t.excluded ?? [])
      if (ids.has(x.serviceId))
        add(
          "error",
          "TIMETABLE_EXCLUDED_CONFLICT",
          `${x.serviceId} is both a service and excluded in ${t.id}`,
          [x.serviceId],
        );
  }
  return issues;
}
