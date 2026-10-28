import { z } from "zod";
import { Provenance } from "./evidence.ts";

/**
 * Service patterns (service-patterns.json, P5, DECISION_LOG D-035): hand-authored game-design
 * data saying which timetable journeys the game can run over its authored routes, and how.
 * A pattern links a run of consecutive timing points in a sourced schedule to an entry fringe,
 * a chain of game routes and an exit fringe. It is a MAPPING, never a timetable record: it adds
 * no service, time, call, platform or line, and a service that matches no pattern is reported
 * as unsupported, never forced onto a route. Kept apart from the timetable snapshot (layer 2)
 * and from game-rules.json (D-029), which configures points and fringe endpoints only.
 */

/** A timing point a service must call at or pass, with optional field checks. */
export const PatternCall = z.object({
  tiploc: z.string().regex(/^[A-Z0-9]{1,7}$/, "expected a TIPLOC"),
  /** CIF platform the call must show; null = must be blank. Absent = not checked. */
  platform: z.string().nullable().optional(),
  /** CIF line codes the call may show (null = blank). Absent = not checked. */
  lines: z.array(z.string().nullable()).min(1).optional(),
});
export type PatternCall = z.infer<typeof PatternCall>;

/** A mapping is an inference from sourced data, or a deliberate game simplification. */
const PatternProvenance = Provenance.refine(
  (p) => p.evidence === "inferred" || p.evidence === "simplified",
  { message: "a service pattern must be labelled inferred or simplified: it is a mapping" },
);

export const ServicePattern = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  /**
   * The timing point immediately before play. The service is due at the entry fringe from its
   * time here: the latest sourced time at which it is still outside play (D-035).
   */
  before: PatternCall,
  /**
   * Every timing point of the service at a play-area or deferred-area TIPLOC, in order, with
   * nothing between them. A service whose area calls differ in any way does not match.
   */
  through: z.array(PatternCall).min(1),
  /**
   * The timing point immediately after the area calls. Null (P7, D-037) only for a journey that
   * ends in a deferred area beyond the exit fringe: the last `through` call must be a deferred
   * TIPLOC, the service may have no call after it, and the exit fringe's cut must lead into a
   * deferred area (control.json). The train leaves play at the fringe like any other; the calls
   * beyond it, its termination included, are outside play and not simulated.
   */
  after: PatternCall.nullable(),
  /** Fringe endpoint (game-rules.json) at which the service enters play. */
  entryFringeId: z.string().min(1),
  /** Fringe endpoint at which the service leaves play. */
  exitFringeId: z.string().min(1),
  /** Routes in running order: from the entry fringe, signal to signal, to the exit fringe. */
  routeIds: z.array(z.string().min(1)).min(1),
  provenance: PatternProvenance,
});
export type ServicePattern = z.infer<typeof ServicePattern>;

export const ServicePatternsFile = z.object({
  $comment: z.string().optional(),
  datasetId: z.string().min(1),
  patterns: z.array(ServicePattern),
});
export type ServicePatternsFile = z.infer<typeof ServicePatternsFile>;
