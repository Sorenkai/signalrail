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
});
export type Call = z.infer<typeof Call>;

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
  provenance: Provenance,
});
export type Service = z.infer<typeof Service>;

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
  services: z.array(Service),
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
});
export type TimingPointsFile = z.infer<typeof TimingPointsFile>;
