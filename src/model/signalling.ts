import { z } from "zod";
import { Provenance } from "./evidence.ts";

/**
 * Simulated interlocking layer. Built on infrastructure ids but stored separately, because
 * public map data does not prove how a real interlocking behaves. Anything here that is not
 * backed by a control table or equivalent source must be `inferred` with its reasoning, and
 * documented in docs/INFERRED_BEHAVIOUR.md.
 */

export const PointsRequirement = z.object({
  pointsId: z.string(),
  position: z.enum(["normal", "reverse"]),
});

export const Overlap = z.object({
  id: z.string().min(1),
  /** Exit signal of the route the overlap belongs to. */
  signalId: z.string(),
  edgeIds: z.array(z.string()).min(1),
  pointsRequired: z.array(PointsRequirement).default([]),
  provenance: Provenance,
});
export type Overlap = z.infer<typeof Overlap>;

export const Route = z.object({
  id: z.string().min(1),
  /** Published route identity (e.g. from a control table), never invented. */
  ref: z.string().nullable(),
  entrySignalId: z.string(),
  exitSignalId: z.string(),
  /** Contiguous edges from the entry signal's node to the exit signal's node. */
  edgeIds: z.array(z.string()).min(1),
  pointsRequired: z.array(PointsRequirement).default([]),
  overlapId: z.string().nullable(),
  conflictsWith: z.array(z.string()).default([]),
  provenance: Provenance,
});
export type Route = z.infer<typeof Route>;

export const Signalling = z.object({
  datasetId: z.string().min(1),
  routes: z.array(Route),
  overlaps: z.array(Overlap),
});
export type Signalling = z.infer<typeof Signalling>;
