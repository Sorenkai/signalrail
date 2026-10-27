import { z } from "zod";
import { IsoDate, Provenance } from "./evidence.ts";

/**
 * Timetable layer: a fixed, dated snapshot. Game sessions run from snapshots only, never
 * from live train movements. Locations are referenced by TIPLOC and mapped to
 * infrastructure through TimingPointMapping, so timetable and infrastructure stay separate.
 */

/** "HH:MM" or "HH:MM:30" (CIF half-minutes). */
export const TimeOfDay = z.string().regex(/^\d{2}:\d{2}(:30)?$/, "expected HH:MM or HH:MM:30");

export const Call = z.object({
  tiploc: z.string().min(1),
  /** CIF location suffix distinguishing repeat visits to one TIPLOC. */
  suffix: z.string().optional(),
  kind: z.enum(["origin", "intermediate", "destination"]),
  arrival: TimeOfDay.nullable(),
  departure: TimeOfDay.nullable(),
  /** Passing time for timing points the train does not stop at. */
  pass: TimeOfDay.nullable(),
  publicArrival: TimeOfDay.nullable(),
  publicDeparture: TimeOfDay.nullable(),
  platform: z.string().nullable(),
  line: z.string().nullable(),
  path: z.string().nullable(),
  activities: z.array(z.string()).default([]),
  /**
   * Days after the service's runDate (origin date) of this call's FIRST time: 0, or 1 once the
   * train has crossed midnight. A later time in the same call that reads earlier on the clock
   * (arrive 23:58, depart 00:02) is on the following day. Derived from the sourced times
   * (INFERRED_BEHAVIOUR I-009). Absent only in snapshots built before D-026.
   */
  dayOffset: z.number().int().min(0).max(1).optional(),
});
export type Call = z.infer<typeof Call>;

/** CIF change en route: attributes that apply from `callIndex` onwards. */
export const ChangeEnRoute = z.object({
  callIndex: z.number().int().min(0),
  tiploc: z.string().min(1),
  suffix: z.string().optional(),
  category: z.string().nullable(),
  headcode: z.string().nullable(),
  serviceCode: z.string().nullable(),
  powerType: z.string().nullable(),
  speed: z.string().nullable(),
  /** The CR record verbatim, for fields not decoded. */
  raw: z.string(),
});
export type ChangeEnRoute = z.infer<typeof ChangeEnRoute>;

export const Service = z.object({
  /** Unique within a snapshot: `${uid}:${runDate}`. */
  id: z.string().min(1),
  uid: z.string().min(1),
  runDate: IsoDate,
  headcode: z.string().nullable(),
  operatorCode: z.string().nullable(),
  category: z.string().nullable(),
  powerType: z.string().nullable(),
  /** CIF STP indicator of the schedule that applies on runDate: P, N or O. */
  stpIndicator: z.enum(["P", "N", "O"]),
  calls: z.array(Call).min(2),
  /** CIF BS bank-holiday running value verbatim (e.g. "X"), or null when blank. */
  bankHolidayRunning: z.string().nullable().optional(),
  /**
   * not_applicable: the snapshot window holds no bank holiday, so the flag cannot apply;
   * unresolved: it does (or the calendar is unknown), and what the flag means for this train
   * has not been established. Absent when the service has no flag.
   */
  bankHolidayApplicability: z.enum(["not_applicable", "unresolved"]).optional(),
  /**
   * How the service's play-area times sit in the snapshot window: within it, or also before
   * it (starts_before), after it (ends_after) or both (spans).
   */
  window: z.enum(["within", "starts_before", "ends_after", "spans"]).optional(),
  changesEnRoute: z.array(ChangeEnRoute).optional(),
  provenance: Provenance,
});
export type Service = z.infer<typeof Service>;

/**
 * A CIF association (join, divide or next working) between two service instances. The main
 * train's instance is dated by the association's own dates; the associated train's date follows
 * the date indicator (S same day, N next day, P previous day).
 */
export const Association = z.object({
  id: z.string().min(1),
  category: z.enum(["JJ", "VV", "NP"]),
  mainServiceId: z.string().min(1),
  assocServiceId: z.string().min(1),
  location: z.string().min(1),
  baseSuffix: z.string().optional(),
  assocSuffix: z.string().optional(),
  dateIndicator: z.enum(["S", "N", "P"]),
  associationType: z.enum(["P", "O"]).nullable(),
  stpIndicator: z.enum(["P", "N", "O"]),
  /**
   * in_snapshot: the instance is in this snapshot; runs_outside_snapshot: its schedule runs on
   * that date but does not touch the play area in the window; not_running: no schedule runs that
   * day (or it is cancelled); not_in_extract: the UID has no schedule in the source.
   */
  mainStatus: z.enum(["in_snapshot", "runs_outside_snapshot", "not_running", "not_in_extract"]),
  assocStatus: z.enum(["in_snapshot", "runs_outside_snapshot", "not_running", "not_in_extract"]),
  provenance: Provenance,
});
export type Association = z.infer<typeof Association>;

/**
 * How the snapshot chooses services (D-026). area_time_window: every service instance with at
 * least one call at an area TIPLOC whose local time falls in [date windowStart, next day
 * windowStart), whatever its origin date. Times are UK local wall-clock time.
 */
export const OperatingDayConvention = z.object({
  kind: z.literal("area_time_window"),
  windowStart: TimeOfDay,
  timeZone: z.literal("Europe/London"),
  /** True when a UK clock change falls inside the window: wall-clock times there are ambiguous. */
  clockChangeInWindow: z.boolean(),
});

export const ExcludedService = z.object({
  serviceId: z.string().min(1),
  /**
   * area_times_outside_window: touches the play area, but not inside the window;
   * deferred_area_only: inside the window only at deferred-area TIPLOCs;
   * superseded_outside_area: the schedule that touches the area is overridden that day by a
   *   stronger STP schedule (overlay or new) that does not touch it.
   */
  reason: z.enum(["area_times_outside_window", "deferred_area_only", "superseded_outside_area"]),
  detail: z.string(),
});

export const TimetableSnapshot = z.object({
  id: z.string().min(1),
  /** The single operating day this snapshot describes. */
  date: IsoDate,
  /** Source extract metadata (e.g. CIF header). */
  extract: z.object({
    sourceId: z.string(),
    fileRef: z.string().nullable(),
    extractedAt: z.string().nullable(),
    validFrom: IsoDate.nullable(),
    validTo: IsoDate.nullable(),
  }),
  /** Absent in snapshots built before D-026, which held the services whose origin date was `date`. */
  convention: OperatingDayConvention.optional(),
  /** Bank-holiday status of the window's dates, per UK division, from a registered source. */
  calendar: z
    .object({
      sourceId: z.string().min(1),
      file: z.string(),
      bankHolidays: z.array(z.object({ division: z.string(), date: IsoDate, title: z.string() })),
    })
    .optional(),
  /** What the import read and did not import. */
  import: z
    .object({
      file: z.string(),
      schedulesRead: z.number().int(),
      associationsRead: z.number().int(),
      skippedRecords: z.record(z.string(), z.number().int()),
      unknownRecordTypes: z.array(z.string()),
      parseErrors: z.number().int(),
      areaTiplocs: z.array(z.string()),
      deferredTiplocs: z.array(z.string()),
      /** Instances of the previous origin date whose area times all fall before the window. */
      previousDayOutsideWindow: z.number().int(),
    })
    .optional(),
  services: z.array(Service),
  associations: z.array(Association).optional(),
  /** Services considered and left out, with the reason; never dropped silently. */
  excluded: z.array(ExcludedService).optional(),
});
export type TimetableSnapshot = z.infer<typeof TimetableSnapshot>;

/** Links a timetable TIPLOC to an infrastructure Location (and optionally track). */
export const TimingPointMapping = z.object({
  tiploc: z.string().min(1),
  locationId: z.string().min(1),
  provenance: Provenance,
});
export type TimingPointMapping = z.infer<typeof TimingPointMapping>;

/** A timetable location code as described by a reference source (e.g. Network Rail CORPUS). */
export const TiplocReference = z.object({
  tiploc: z.string().min(1),
  description: z.string().nullable(),
  stanox: z.string().nullable(),
  crs: z.string().nullable(),
  nlc: z.string().nullable(),
  provenance: Provenance,
});
export type TiplocReference = z.infer<typeof TiplocReference>;

/**
 * An inferred track position for a TIPLOC that no source places on the track graph.
 * Coordinates are copied from the first anchor track node (an OSM coordinate), so nothing is
 * invented; the inference is only that the TIPLOC sits at these nodes. Always `inferred`.
 */
export const TimingPointPosition = z
  .object({
    tiploc: z.string().min(1),
    /** Equal to the first anchor node's position. */
    position: z.object({ lat: z.number(), lon: z.number() }),
    /** Track nodes the timing point is placed at, one per running line where relevant. */
    trackNodeIds: z.array(z.string()).min(1),
    confidence: z.enum(["high", "medium", "low"]),
    method: z.string().min(1),
    /** Evidence statements supporting the placement. */
    basis: z.array(z.string()).min(1),
    provenance: Provenance,
  })
  .refine((p) => p.provenance.evidence === "inferred", {
    message: "timing-point positions must be labelled inferred",
    path: ["provenance", "evidence"],
  });
export type TimingPointPosition = z.infer<typeof TimingPointPosition>;

/**
 * timing-points.json. `areaTiplocs` lists the timetable locations considered part of the
 * study area (a project scoping choice); `mappings` links them to infrastructure.
 */
export const TimingPointsFile = z.object({
  $comment: z.string().optional(),
  areaTiplocs: z.array(TiplocReference).default([]),
  mappings: z.array(TimingPointMapping),
  inferredPositions: z.array(TimingPointPosition).default([]),
  /**
   * TIPLOCs of areas outside the current playable scope (e.g. a deferred area). Services that
   * touch only these are excluded from snapshots and listed as such.
   */
  deferredTiplocs: z.array(TiplocReference.extend({ reason: z.string().min(1) })).default([]),
});
export type TimingPointsFile = z.infer<typeof TimingPointsFile>;
