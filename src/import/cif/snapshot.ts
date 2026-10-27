import type { Association, Call, Service, TimetableSnapshot } from "../../model/index.ts";
import type { CifAssociation, CifFile, CifSchedule, CifScheduleKey } from "./parseCif.ts";

/** Monday = 0 ... Sunday = 6, for an ISO date interpreted as a UK calendar day. */
function weekdayIndex(isoDate: string): number {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return (d.getUTCDay() + 6) % 7;
}

/** ISO date plus `days`. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Whether a schedule's validity period and days-run cover the date. CIF dates a schedule by the
 * day the train leaves its origin; times after midnight belong to the following day.
 */
export function runsOn(
  s: Pick<CifSchedule, "runsFrom" | "runsTo" | "daysRun">,
  date: string,
): boolean {
  const to = s.runsTo ?? s.runsFrom;
  return s.runsFrom <= date && date <= to && s.daysRun[weekdayIndex(date)] === true;
}

/** STP precedence: a cancellation or overlay replaces the permanent schedule for that day. */
const STP_RANK: Record<string, number> = { C: 0, O: 1, N: 2, P: 3 };
const strongest = <T extends { stpIndicator: string }>(list: T[]): T =>
  [...list].sort((a, b) => (STP_RANK[a.stpIndicator] ?? 9) - (STP_RANK[b.stpIndicator] ?? 9))[0]!;

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
    const best = strongest(list);
    if (best.stpIndicator !== "C" && best.locations.length >= 2) out.push(best);
  }
  return out.sort((a, b) => a.uid.localeCompare(b.uid));
}

/** Whether a UID runs on a date, from the full-extract index. */
function runStatus(
  index: Map<string, CifScheduleKey[]> | undefined,
  uid: string,
  date: string,
): "runs" | "not_running" | "not_in_extract" | "unknown" {
  if (!index) return "unknown";
  const all = index.get(uid);
  if (!all) return "not_in_extract";
  const applicable = all.filter((s) => s.transaction !== "D" && runsOn(s, date));
  if (applicable.length === 0) return "not_running";
  const best = strongest(applicable);
  return best.stpIndicator !== "C" && best.hasLocations ? "runs" : "not_running";
}

const minutes = (t: string | null) =>
  t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) + (t.length > 5 ? 0.5 : 0) : null;

/**
 * Day offset of each location from the origin date. Times along a journey never go backwards,
 * so a time earlier than the previous one means the train has passed midnight
 * (INFERRED_BEHAVIOUR I-009). Each location's offset is that of its first time.
 */
export function dayOffsets(
  locations: Pick<CifSchedule["locations"][number], "arrival" | "pass" | "departure">[],
): {
  offsets: number[];
  /** Minutes from origin-date midnight of every time at each location (empty when none). */
  absolute: number[][];
} {
  let off = 0;
  let prev = -1;
  const offsets: number[] = [];
  const absolute: number[][] = [];
  for (const l of locations) {
    let firstOff: number | null = null;
    const times: number[] = [];
    for (const t of [l.arrival, l.pass, l.departure]) {
      const m = minutes(t);
      if (m === null) continue;
      if (m < prev) off += 1;
      prev = m;
      if (firstOff === null) firstOff = off;
      times.push(m + off * 1440);
    }
    offsets.push(firstOff ?? off);
    absolute.push(times);
  }
  return { offsets, absolute };
}

/** Whether UK local time changes (clocks go forward or back) during the given local day. */
export function ukClockChangeOn(date: string): boolean {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    timeZoneName: "shortOffset",
  });
  const offset = (iso: string) =>
    fmt.formatToParts(new Date(iso)).find((p) => p.type === "timeZoneName")!.value;
  return offset(`${date}T00:00:00Z`) !== offset(`${addDays(date, 1)}T00:00:00Z`);
}

export interface SnapshotOptions {
  id: string;
  sourceId: string;
  retrieved?: string;
  /** TIPLOCs of the play area: a service belongs if it has a time at one inside the window. */
  areaTiplocs: Set<string>;
  /** TIPLOCs of areas outside the playable scope; services touching only these are excluded. */
  deferredTiplocs?: Set<string>;
  /** Start of the session day, local time. Default "00:00". */
  windowStart?: string;
  /** Every schedule's dating fields (CifParser `index`), to check association partners. */
  index?: Map<string, CifScheduleKey[]>;
  calendar?: TimetableSnapshot["calendar"];
  importInfo?: Omit<
    NonNullable<TimetableSnapshot["import"]>,
    "areaTiplocs" | "deferredTiplocs" | "previousDayOutsideWindow"
  >;
}

const STATUS = (s: ReturnType<typeof runStatus>, inSnapshot: boolean): Association["mainStatus"] =>
  inSnapshot
    ? "in_snapshot"
    : s === "runs"
      ? "runs_outside_snapshot"
      : s === "not_in_extract"
        ? "not_in_extract"
        : "not_running";

/**
 * Builds a single-day snapshot under the area-time-window convention (D-026): every service
 * instance, whatever its origin date, with a time at an area TIPLOC inside
 * [date windowStart, next day windowStart). Each call carries its day offset from the origin date.
 */
export function buildSnapshot(
  cif: CifFile,
  date: string,
  opts: SnapshotOptions,
): TimetableSnapshot {
  const windowStart = opts.windowStart ?? "00:00";
  const w = minutes(windowStart)!;
  const deferred = opts.deferredTiplocs ?? new Set<string>();
  const holidayDates = new Set((opts.calendar?.bankHolidays ?? []).map((h) => h.date));
  const windowDates = w === 0 ? [date] : [date, addDays(date, 1)];
  const holidayInWindow = !opts.calendar || windowDates.some((d) => holidayDates.has(d));
  const sourceRef = (recordId: string) => ({
    sourceId: opts.sourceId,
    recordId,
    ...(cif.header?.currentFileRef ? { version: cif.header.currentFileRef } : {}),
    ...(opts.retrieved ? { retrieved: opts.retrieved } : {}),
  });

  const services: Service[] = [];
  const excluded: NonNullable<TimetableSnapshot["excluded"]> = [];
  let previousDayOutsideWindow = 0;
  // Origin dates whose trains can have times in the window (journeys are under 24 h).
  const originDates = [addDays(date, -1), date, ...(w > 0 ? [addDays(date, 1)] : [])];
  for (const origin of originDates) {
    const shift = (Date.parse(`${origin}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 60000;
    for (const s of resolveSchedulesForDate(cif, origin)) {
      const { offsets, absolute } = dayOffsets(s.locations);
      const timesAt = (set: Set<string>) =>
        s.locations.flatMap((l, i) =>
          set.has(l.tiploc) ? absolute[i]!.map((m) => m + shift) : [],
        );
      const area = timesAt(opts.areaTiplocs);
      const id = `${s.uid}:${origin}`;
      const inWindow = (t: number) => t >= w && t < w + 1440;
      if (area.length === 0) {
        if (timesAt(deferred).some(inWindow))
          excluded.push({
            serviceId: id,
            reason: "deferred_area_only",
            detail: "times in the window only at deferred-area TIPLOCs",
          });
        continue;
      }
      if (!area.some(inWindow)) {
        if (origin < date && area.every((t) => t < w)) previousDayOutsideWindow++;
        else
          excluded.push({
            serviceId: id,
            reason: "area_times_outside_window",
            detail: `play-area times fall ${area.every((t) => t < w) ? "before" : "after"} the window`,
          });
        continue;
      }
      // Only area schedules were kept; a stronger STP record elsewhere in the extract replaces it.
      const applicable = (opts.index?.get(s.uid) ?? []).filter(
        (x) => x.transaction !== "D" && runsOn(x, origin),
      );
      if (
        applicable.length > 0 &&
        (STP_RANK[strongest(applicable).stpIndicator] ?? 9) < (STP_RANK[s.stpIndicator] ?? 9)
      ) {
        excluded.push({
          serviceId: `${s.uid}:${origin}`,
          reason: "superseded_outside_area",
          detail: `STP ${strongest(applicable).stpIndicator} schedule for ${origin} replaces the ${s.stpIndicator} schedule and does not touch the play or deferred area`,
        });
        continue;
      }
      const before = area.some((t) => t < w);
      const after = area.some((t) => t >= w + 1440);
      services.push({
        id,
        uid: s.uid,
        runDate: origin,
        headcode: s.headcode,
        operatorCode: s.atocCode,
        category: s.category,
        powerType: s.powerType,
        stpIndicator: s.stpIndicator as Service["stpIndicator"],
        calls: s.locations.map((l, i): Call => ({
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
          dayOffset: offsets[i]!,
        })),
        ...(s.bankHoliday
          ? {
              bankHolidayRunning: s.bankHoliday,
              bankHolidayApplicability: holidayInWindow ? "unresolved" : "not_applicable",
            }
          : {}),
        window:
          before && after ? "spans" : before ? "starts_before" : after ? "ends_after" : "within",
        ...(s.changesEnRoute.length
          ? {
              changesEnRoute: s.changesEnRoute.map((c) => ({
                callIndex: c.locationIndex,
                tiploc: c.tiploc,
                ...(c.suffix ? { suffix: c.suffix } : {}),
                category: c.category,
                headcode: c.headcode,
                serviceCode: c.serviceCode,
                powerType: c.powerType,
                speed: c.speed,
                raw: c.raw,
              })),
            }
          : {}),
        provenance: {
          evidence: "sourced",
          sources: [sourceRef(`${s.uid}/${s.runsFrom}/${s.stpIndicator}`)],
        },
      });
    }
  }
  services.sort((a, b) => a.id.localeCompare(b.id));
  const inSnapshot = new Set(services.map((s) => s.id));

  // Associations touching a service in the snapshot, from either side.
  const byMain = new Map<string, CifAssociation[]>();
  const byAssoc = new Map<string, CifAssociation[]>();
  for (const a of cif.associations) {
    if (a.transaction === "D") continue;
    byMain.set(a.mainUid, [...(byMain.get(a.mainUid) ?? []), a]);
    byAssoc.set(a.assocUid, [...(byAssoc.get(a.assocUid) ?? []), a]);
  }
  const shiftOf = (d: CifAssociation["dateIndicator"]) => (d === "N" ? 1 : d === "P" ? -1 : 0);
  const applies = (a: CifAssociation, mainDate: string) =>
    runsOn(
      { runsFrom: a.startDate, runsTo: a.endDate, daysRun: a.daysRun ?? Array(7).fill(true) },
      mainDate,
    );
  const associations = new Map<string, Association>();
  const consider = (
    mainUid: string,
    assocUid: string,
    mainDate: string,
    candidates: CifAssociation[],
  ) => {
    const groups = new Map<string, CifAssociation[]>();
    for (const a of candidates)
      if (a.mainUid === mainUid && a.assocUid === assocUid && applies(a, mainDate)) {
        const k = `${a.location}`;
        groups.set(k, [...(groups.get(k) ?? []), a]);
      }
    for (const list of groups.values()) {
      const a = strongest(list);
      if (a.stpIndicator === "C" || !a.category || !a.dateIndicator) continue;
      const assocDate = addDays(mainDate, shiftOf(a.dateIndicator));
      const mainId = `${mainUid}:${mainDate}`;
      const assocId = `${assocUid}:${assocDate}`;
      const id = `${a.category}:${mainId}>${assocId}@${a.location}`;
      if (associations.has(id)) continue;
      associations.set(id, {
        id,
        category: a.category,
        mainServiceId: mainId,
        assocServiceId: assocId,
        location: a.location,
        ...(a.baseSuffix ? { baseSuffix: a.baseSuffix } : {}),
        ...(a.assocSuffix ? { assocSuffix: a.assocSuffix } : {}),
        dateIndicator: a.dateIndicator,
        associationType: a.associationType,
        stpIndicator: a.stpIndicator as Association["stpIndicator"],
        mainStatus: STATUS(runStatus(opts.index, mainUid, mainDate), inSnapshot.has(mainId)),
        assocStatus: STATUS(runStatus(opts.index, assocUid, assocDate), inSnapshot.has(assocId)),
        provenance: {
          evidence: "sourced",
          sources: [
            sourceRef(
              `AA ${a.mainUid}/${a.assocUid}/${a.startDate}/${a.stpIndicator} line ${a.line}`,
            ),
          ],
        },
      });
    }
  };
  for (const s of services) {
    const asMain = byMain.get(s.uid) ?? [];
    for (const partner of new Set(asMain.map((a) => a.assocUid)))
      consider(s.uid, partner, s.runDate, asMain);
    for (const a of byAssoc.get(s.uid) ?? []) {
      if (!a.dateIndicator) continue;
      consider(
        a.mainUid,
        s.uid,
        addDays(s.runDate, -shiftOf(a.dateIndicator)),
        byMain.get(a.mainUid) ?? [],
      );
    }
  }

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
    convention: {
      kind: "area_time_window",
      windowStart,
      timeZone: "Europe/London",
      clockChangeInWindow: windowDates.some(ukClockChangeOn),
    },
    ...(opts.calendar ? { calendar: opts.calendar } : {}),
    ...(opts.importInfo
      ? {
          import: {
            ...opts.importInfo,
            areaTiplocs: [...opts.areaTiplocs].sort(),
            deferredTiplocs: [...deferred].sort(),
            previousDayOutsideWindow,
          },
        }
      : {}),
    services,
    associations: [...associations.values()].sort((a, b) => a.id.localeCompare(b.id)),
    excluded: excluded.sort((a, b) => a.serviceId.localeCompare(b.serviceId)),
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
