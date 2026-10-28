import { z } from "zod";
import { Provenance } from "./evidence.ts";

/**
 * Game rules (game-rules.json, DECISION_LOG D-029): hand-authored, deliberate simplifications
 * that let the game run where the real interlocking is unknown. Kept apart from the
 * source-derived infrastructure.json, which is never edited by hand. Every record here is
 * `simplified`: it makes no claim about the real railway, and nothing reads it as one.
 */

/** A game rule is always a deliberate simplification, never a real-world fact. */
const GameRuleProvenance = Provenance.refine((p) => p.evidence === "simplified", {
  message: "a game rule must be labelled simplified: it makes no claim about the real railway",
});

const pointsBase = {
  /** Infrastructure Points the rule configures. Its own record is not changed. */
  pointsId: z.string().min(1),
  provenance: GameRuleProvenance,
};

/**
 * Simple points: which adjacent node each position leads to. The remaining neighbour is the
 * toe. Only on a three-edge switch node whose sourced switch type is `simple` or `unknown`.
 */
export const SimplePointsRule = z.object({
  ...pointsBase,
  switchType: z.literal("simple"),
  normalTowardsNodeId: z.string().min(1),
  reverseTowardsNodeId: z.string().min(1),
});

/**
 * One movement the game permits through a slip, between two adjacent nodes (either way), with
 * the points position it needs. A movement not listed stays unresolved: neither straight-across
 * nor diagonal passage is assumed (D-021).
 */
export const SlipPassageRule = z.object({
  between: z.tuple([z.string().min(1), z.string().min(1)]),
  position: z.enum(["normal", "reverse"]),
});
export type SlipPassageRule = z.infer<typeof SlipPassageRule>;

const slipRule = <T extends "single_slip" | "double_slip">(type: T) =>
  z.object({
    ...pointsBase,
    /** Must equal the sourced OSM slip type on a four-edge node. */
    switchType: z.literal(type),
    passages: z.array(SlipPassageRule).min(1),
  });

export const PointsGameRule = z.union([
  SimplePointsRule,
  slipRule("single_slip"),
  slipRule("double_slip"),
]);
export type PointsGameRule = z.infer<typeof PointsGameRule>;

/**
 * Where a route may start or end at the edge of play, at a playable-area cut, instead of at a
 * signal. A game construct: it stands for "trains arrive from / leave to beyond the cut" and
 * does not claim any real boundary signal, direction or control limit.
 */
export const FringeEndpoint = z.object({
  id: z.string().min(1),
  /** The playable-area cut (playable-area.json) the endpoint sits on. */
  cutId: z.string().min(1),
  /** entry: routes may start here; exit: routes may end here. */
  use: z.array(z.enum(["entry", "exit"])).min(1),
  provenance: GameRuleProvenance,
});
export type FringeEndpoint = z.infer<typeof FringeEndpoint>;

export const GameRules = z.object({
  datasetId: z.string().min(1),
  points: z.array(PointsGameRule).default([]),
  fringeEndpoints: z.array(FringeEndpoint).default([]),
});
export type GameRules = z.infer<typeof GameRules>;
