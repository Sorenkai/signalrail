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
  /**
   * path: the points lie on the route/overlap and set its course (checked against the path);
   * flank: the points lie off the path and are held for flank protection (checked only for
   * consistency, never derived). Defaults to path (D-024).
   */
  role: z.enum(["path", "flank"]).default("path"),
});
export type PointsRequirement = z.infer<typeof PointsRequirement>;

export const Overlap = z.object({
  id: z.string().min(1),
  /** Exit signal of the route the overlap belongs to. */
  signalId: z.string(),
  edgeIds: z.array(z.string()).min(1),
  pointsRequired: z.array(PointsRequirement).default([]),
  provenance: Provenance,
});
export type Overlap = z.infer<typeof Overlap>;

export const Route = z
  .object({
    id: z.string().min(1),
    /** Published route identity (e.g. from a control table), never invented. */
    ref: z.string().nullable(),
    /** Null only when the route starts at a fringe endpoint instead. */
    entrySignalId: z.string().nullable(),
    /** Null only when the route ends at a fringe endpoint instead. */
    exitSignalId: z.string().nullable(),
    /**
     * Game construct (D-029): the route starts at a fringe endpoint (game-rules.json), i.e. at
     * a playable-area cut, instead of at a signal. No real boundary signal is claimed.
     */
    entryFringeId: z.string().optional(),
    /** Game construct (D-029): the route ends at a fringe endpoint instead of at a signal. */
    exitFringeId: z.string().optional(),
    /** Contiguous edges from the route's start (signal node or cut) to its end. */
    edgeIds: z.array(z.string()).min(1),
    pointsRequired: z.array(PointsRequirement).default([]),
    overlapId: z.string().nullable(),
    conflictsWith: z.array(z.string()).default([]),
    provenance: Provenance,
  })
  .superRefine((r, ctx) => {
    for (const [end, signal, fringe] of [
      ["entry", r.entrySignalId, r.entryFringeId],
      ["exit", r.exitSignalId, r.exitFringeId],
    ] as const) {
      if ((signal === null) === (fringe === undefined))
        ctx.addIssue({
          code: "custom",
          message: `a route's ${end} is exactly one of a signal or a fringe endpoint`,
        });
    }
    if (r.entryFringeId !== undefined && r.exitFringeId !== undefined)
      ctx.addIssue({ code: "custom", message: "a route needs at least one signal" });
    if (r.exitFringeId !== undefined && r.overlapId !== null)
      ctx.addIssue({
        code: "custom",
        message: "a route ending at a fringe endpoint has no exit signal, so no overlap",
      });
  });
export type Route = z.infer<typeof Route>;

export const Signalling = z.object({
  datasetId: z.string().min(1),
  routes: z.array(Route),
  overlaps: z.array(Overlap),
});
export type Signalling = z.infer<typeof Signalling>;
