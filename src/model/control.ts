import { z } from "zod";
import { Provenance } from "./evidence.ts";

/**
 * Control areas: which player operates what. A control area may mirror a real signal box
 * (`basis: "real_signal_box"`, members must be evidenced) or be a game-design split
 * (`basis: "game_design"`), which is a legitimate design choice rather than a claim about
 * the real railway.
 */

export const ControlArea = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  basis: z.enum(["real_signal_box", "game_design"]),
  /** Location of the real signal box, when basis is real_signal_box. */
  signalBoxLocationId: z.string().nullable(),
  signalIds: z.array(z.string()).default([]),
  pointsIds: z.array(z.string()).default([]),
  /** Provenance of the membership lists (not of the box's existence). */
  membershipProvenance: Provenance,
  provenance: Provenance,
});
export type ControlArea = z.infer<typeof ControlArea>;

/** A place where trains pass from one control area to another. */
export const AreaBoundary = z.object({
  id: z.string().min(1),
  fromAreaId: z.string(),
  toAreaId: z.string(),
  /** Edge on which the hand-over happens. */
  edgeId: z.string(),
  provenance: Provenance,
});
export type AreaBoundary = z.infer<typeof AreaBoundary>;

export const Control = z.object({
  datasetId: z.string().min(1),
  areas: z.array(ControlArea),
  boundaries: z.array(AreaBoundary),
});
export type Control = z.infer<typeof Control>;
