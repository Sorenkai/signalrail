import { z } from "zod";
import { Provenance } from "./evidence.ts";

/**
 * Control areas: which player operates what. A control area may mirror a real signal box
 * (`basis: "real_signal_box"`, members must be evidenced) or be a game-design split
 * (`basis: "game_design"`), which is a legitimate design choice rather than a claim about
 * the real railway.
 *
 * R5 (D-027) separates three kinds of statement, each with its own label rules:
 * - real-world claims (`RealWorldClaim`): what a source says about the railway; `unknown` until
 *   evidenced, never `simplified` or `placeholder`;
 * - game-design choices (`DesignChoice`): decisions of this project, always `simplified`;
 * - unresolved items: listed explicitly, and never presented as sourced or verified.
 */

/**
 * A statement about the real railway. `value: null` exactly when the evidence is `unknown`.
 * `inferred` values need the note required by Provenance. `limitations` records what the
 * evidence does not establish.
 */
export const realWorldClaim = <T extends z.ZodType>(value: T) =>
  z
    .object({
      value: value.nullable(),
      provenance: Provenance,
      limitations: z.array(z.string()).default([]),
    })
    .superRefine((c, ctx) => {
      const ev = c.provenance.evidence;
      if (ev === "simplified" || ev === "placeholder")
        ctx.addIssue({
          code: "custom",
          message: `a real-world claim cannot be ${ev}; record game choices as a DesignChoice`,
        });
      if (((c as unknown as { value: unknown }).value === null) !== (ev === "unknown"))
        ctx.addIssue({
          code: "custom",
          message: "a real-world claim has a value exactly when its evidence is not unknown",
        });
    });

/** A decision of this project. Always labelled `simplified` (no real-world claim, D-023). */
export const designChoice = <T extends z.ZodType>(value: T) =>
  z.object({
    value,
    status: z.enum(["proposed", "adopted"]),
    rationale: z.string().min(1),
    provenance: Provenance.refine((p) => p.evidence === "simplified", {
      message: "a game-design choice must be labelled simplified, never a sourced fact",
    }),
  });

/**
 * Signalling-control equipment, as a source names it. Categories only: a value is set only
 * when a source states it, never from a box's name or the track layout.
 */
export const ControlMethod = z.enum([
  "mechanical_lever_frame",
  "entrance_exit_panel",
  "individual_function_switch_panel",
  "vdu_workstation",
  "other",
]);

/** GB methods of working between signal boxes (Rule Book terms), set only from a source. */
export const MethodOfWorking = z.enum([
  "absolute_block",
  "track_circuit_block",
  "tokenless_block",
  "electric_token_block",
  "one_train_working",
  "other",
]);

/** A real control centre (signal box, power box, operating centre) and what is known of it. */
export const ControlCentre = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Infrastructure location of the building, if mapped. */
  locationId: z.string().nullable(),
  /** Evidence that the centre exists (not of anything it controls). */
  provenance: Provenance,
  operationalStatus: realWorldClaim(z.enum(["operational", "closed", "other"])),
  controlMethod: realWorldClaim(ControlMethod),
  methodsOfWorking: realWorldClaim(z.array(MethodOfWorking).min(1)),
  /** Signalling principles or operating arrangements, as the source words them. */
  signallingPrinciples: realWorldClaim(z.array(z.string().min(1)).min(1)),
  /** Its control limits, described in words. */
  extent: realWorldClaim(z.string().min(1)),
});
export type ControlCentre = z.infer<typeof ControlCentre>;

export const ControlArea = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  basis: z.enum(["real_signal_box", "game_design"]),
  /** Location of the real signal box, when basis is real_signal_box. */
  signalBoxLocationId: z.string().nullable(),
  signalIds: z.array(z.string()).default([]),
  pointsIds: z.array(z.string()).default([]),
  /** Platforms whose train movements this area handles (optional). */
  platformIds: z.array(z.string()).optional(),
  /** Provenance of the membership lists (not of the box's existence). */
  membershipProvenance: Provenance,
  provenance: Provenance,
  /** The real centre whose control limits contain this area's members (a real-world claim). */
  controlCentre: realWorldClaim(z.string().min(1)).optional(),
  /** Who operates the area in the game. */
  operator: designChoice(z.enum(["human", "ai", "human_or_ai"])).optional(),
});
export type ControlArea = z.infer<typeof ControlArea>;

/**
 * Track and control beyond a boundary, outside the game's control areas: an adjacent area
 * that the game does not let players operate, or a deferred part of the playable area.
 */
export const ExternalArea = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["outside_play", "deferred_play_area"]),
  /** The real centre that controls the track beyond the boundary. */
  controlCentre: realWorldClaim(z.string().min(1)),
  provenance: Provenance,
});
export type ExternalArea = z.infer<typeof ExternalArea>;

/** Direction a train crosses a boundary, relative to the boundary's `fromAreaId`. */
export const CrossingDirection = z.enum(["into_from_area", "out_of_from_area"]);

/** A place where trains pass from one control area to another. */
export const AreaBoundary = z
  .object({
    id: z.string().min(1),
    fromAreaId: z.string(),
    /** A control area or an external area. */
    toAreaId: z.string(),
    /** Edge on which the hand-over happens. */
    edgeId: z.string(),
    provenance: Provenance,
    /** The playable-area cut on this edge, if any. */
    cutId: z.string().optional(),
    /** Real signals protecting or ending at the boundary. */
    boundarySignalIds: realWorldClaim(z.array(z.string()).min(1)).optional(),
    /** Directions real trains cross here (e.g. from timetabled movements). */
    trafficDirections: realWorldClaim(z.array(CrossingDirection).min(1)).optional(),
    /** How the game hands trains over here; null while undecided. */
    handover: designChoice(
      z.object({
        directions: z.array(CrossingDirection).min(1),
        /** Who offers and who accepts a train crossing in each permitted direction. */
        responsibility: z.string().min(1),
      }),
    )
      .nullable()
      .optional(),
    /** complete only when nothing above is unknown or undecided. */
    status: z.enum(["complete", "incomplete"]).optional(),
    unresolved: z.array(z.string().min(1)).optional(),
  })
  .superRefine((b, ctx) => {
    if (b.status === "incomplete" && !b.unresolved?.length)
      ctx.addIssue({
        code: "custom",
        message: "an incomplete boundary must list what is unresolved",
      });
  });
export type AreaBoundary = z.infer<typeof AreaBoundary>;

export const Control = z.object({
  $comment: z.string().optional(),
  datasetId: z.string().min(1),
  controlCentres: z.array(ControlCentre).optional(),
  areas: z.array(ControlArea),
  externalAreas: z.array(ExternalArea).optional(),
  boundaries: z.array(AreaBoundary),
});
export type Control = z.infer<typeof Control>;
