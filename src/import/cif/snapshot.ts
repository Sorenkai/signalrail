import type { Call, Service, TimetableSnapshot } from "../../model/index.ts";
import type { CifFile, CifSchedule } from "./parseCif.ts";

/** Monday = 0 ... Sunday = 6, for an ISO date interpreted as a UK calendar day. */
function weekdayIndex(isoDate: string): number {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return (d.getUTCDay() + 6) % 7;
}

/** Whether a schedule's validity period and days-run cover the date. */
export function runsOn(s: CifSchedule, date: string): boolean {
  const to = s.runsTo ?? s.runsFrom;
  return s.runsFrom <= date && date <= to && s.daysRun[weekdayIndex(date)] === true;
}

/** STP precedence: a cancellation or overlay replaces the permanent schedule for that day. */
const STP_RANK: Record<string, number> = { C: 0, O: 1, N: 2, P: 3 };

/**
 * Resolves the schedules that actually run on `date`. Per UID, the applicable record with the
 * strongest STP indicator wins; if that is a cancellation (C) the train does not run.
 */
export function resolveSchedulesForDate(cif: CifFile, date: string): CifSchedule[] {
  const byUid = new Map<string, CifSchedule[]>();
  for (const s of cif.schedules) {
    if (s.transaction === "D" || !runsOn(s, date)) continue;
    const list = byUid.get(s.uid) ?? [];
    list.push(s);
    byUid.set(s.uid, list);
  }
  const out: CifSchedule[] = [];
  for (const list of byUid.values()) {
    const best = [...list].sort(
      (a, b) => (STP_RANK[a.stpIndicator] ?? 9) - (STP_RANK[b.stpIndicator] ?? 9),
    )[0]!;
    if (best.stpIndicator !== "C" && best.locations.length >= 2) out.push(best);
  }
  return out.sort((a, b) => a.uid.localeCompare(b.uid));
}

/** Builds a fixed, single-day timetable snapshot from a CIF extract. */
export function buildSnapshot(
  cif: CifFile,
  date: string,
  opts: { id: string; sourceId: string; retrieved?: string },
): TimetableSnapshot {
  const services: Service[] = resolveSchedulesForDate(cif, date).map((s) => ({
    id: `${s.uid}:${date}`,
    uid: s.uid,
    runDate: date,
    headcode: s.headcode,
    operatorCode: s.atocCode,
    category: s.category,
    powerType: s.powerType,
    stpIndicator: s.stpIndicator as Service["stpIndicator"],
    calls: s.locations.map((l): Call => ({
      tiploc: l.tiploc,
      ...(l.suffix ? { suffix: l.suffix } : {}),
      kind: l.record === "LO" ? "origin" : l.record === "LT" ? "destination" : "intermediate",
      arrival: l.arrival,
      departure: l.departure,
      pass: l.pass,
      publicArrival: l.publicArrival,
      publicDeparture: l.publicDeparture,
      platform: l.platform,
      line: l.line,
      path: l.path,
      activities: l.activities,
    })),
    provenance: {
      evidence: "sourced",
      sources: [
        {
          sourceId: opts.sourceId,
          recordId: `${s.uid}/${s.runsFrom}/${s.stpIndicator}`,
          ...(cif.header?.currentFileRef ? { version: cif.header.currentFileRef } : {}),
          ...(opts.retrieved ? { retrieved: opts.retrieved } : {}),
        },
      ],
    },
  }));
  return {
    id: opts.id,
    date,
    extract: {
      sourceId: opts.sourceId,
      fileRef: cif.header?.currentFileRef || null,
      extractedAt:
        cif.header?.extractDate && cif.header.extractTime
          ? `${cif.header.extractDate}T${cif.header.extractTime}`
          : null,
      validFrom: cif.header?.userStartDate ?? null,
      validTo: cif.header?.userEndDate ?? null,
    },
    services,
  };
}

/** Keeps only services that call at or pass at least one of the given TIPLOCs. */
export function filterByTiplocs(
  snapshot: TimetableSnapshot,
  tiplocs: Set<string>,
): TimetableSnapshot {
  return {
    ...snapshot,
    services: snapshot.services.filter((s) => s.calls.some((c) => tiplocs.has(c.tiploc))),
  };
}
