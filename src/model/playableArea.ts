import { z } from "zod";
import { Provenance } from "./evidence.ts";

/**
 * Proposed playable geography (playable-area.json). A game-design definition layered on the
 * infrastructure: where play starts and stops, and what is in scope. It makes no claim about
 * the real railway beyond the infrastructure ids it cites. Source geometry is never edited
 * here: any gameplay-specific correction is listed separately in `gameplayCorrections` and
 * must not be applied to infrastructure.json.
 */

export const AreaCut = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /**
   * extract_boundary: the OSM extract ends here (an area_boundary node), so the railway
   *   continues; gameplay_cut: a project choice to stop play on a track that continues in the data.
   */
  kind: z.enum(["extract_boundary", "gameplay_cut"]),
  /** Edge on which trains enter or leave play, and its inside/outside ends. */
  edgeId: z.string(),
  insideNodeId: z.string(),
  outsideNodeId: z.string(),
  /** OSM track ref of the edge, as published, or null. */
  line: z.string().nullable(),
  /** Where the line leads beyond the cut (from route knowledge; see provenance). */
  connectsTo: z.string(),
  provenance: Provenance,
});
export type AreaCut = z.infer<typeof AreaCut>;

export const GameplayCorrection = z.object({
  id: z.string().min(1),
  kind: z.enum(["add_connection", "add_buffer_stop", "add_signal", "set_switch_legs", "other"]),
  /** Infrastructure ids the correction would act on. */
  targetIds: z.array(z.string()).min(1),
  description: z.string().min(1),
  status: z.enum(["proposed", "applied"]),
  /** Always placeholder, inferred or simplified: a correction is not a source fact. */
  provenance: Provenance.refine(
    (p) => p.evidence === "placeholder" || p.evidence === "inferred" || p.evidence === "simplified",
    { message: "a gameplay correction must be placeholder, inferred or simplified" },
  ),
});

export const PlayableArea = z.object({
  datasetId: z.string().min(1),
  status: z.enum(["proposed", "adopted"]),
  basis: z.literal("game_design"),
  description: z.string(),
  cuts: z.array(AreaCut).min(1),
  includedLocationIds: z.array(z.string()),
  platformIds: z.array(z.string()),
  optionalAreas: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      status: z.enum(["deferred", "included"]),
      reason: z.string(),
      locationIds: z.array(z.string()),
    }),
  ),
  gameplayCorrections: z.array(GameplayCorrection).default([]),
});
export type PlayableArea = z.infer<typeof PlayableArea>;
