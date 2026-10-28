/**
 * SYNTHETIC movement dataset for train and occupancy tests (P3, D-032). Not a real railway
 * layout, and none of its lengths, routes or game rules describes a real railway.
 *
 * The synthetic game-rule layout (gameRules.ts), with edge lengths, track beyond the cut and a
 * route from sig2 out to the fringe:
 *
 *   A ==e1 1000m== N1 ==e2 200m== P1 ==e3 300m== N2 ==e4 400m== B ==e7 600m== X
 *   (buffer)       sig1->           \             sig2-> <-sig4   (cut-b on e4)  (boundary)
 *                                    \==e5 300m== N3 ==e6 500m== C (buffer)
 *                                                 sig3->
 *
 *   Game rule: pts1 simple, normal -> N2, reverse -> N3. Fringe fr-b on cut-b (entry, exit).
 *   r1: sig1 -> sig2 (normal)   r2: sig1 -> sig3 (reverse)   r3: sig1 -> fr-b (normal)
 *   r4: fr-b -> sig4            r5: sig2 -> fr-b (SYNTHETIC, P3)
 */
import type { ValidationInput } from "../../src/validation/validate.ts";
import { simplified, syntheticGameRuleDataset } from "./gameRules.ts";
import { SYNTHETIC_SOURCE_ID } from "./dataset.ts";

/** Synthetic edge lengths in metres. */
export const SYNTHETIC_LENGTHS_M: Record<string, number> = {
  e1: 1000,
  e2: 200,
  e3: 300,
  e4: 400,
  e5: 300,
  e6: 500,
  e7: 600,
};

export function syntheticMovementDataset(): ValidationInput {
  const d = syntheticGameRuleDataset();
  const infra = d.infrastructure;
  const syn = (recordId: string) => ({
    evidence: "sourced" as const,
    sources: [{ sourceId: SYNTHETIC_SOURCE_ID, recordId }],
  });

  // Track continues beyond the cut, so a train can stand outside play and enter at fr-b.
  infra.nodes.find((n) => n.id === "B")!.kind = "plain";
  infra.nodes.push({
    id: "X",
    kind: "area_boundary",
    position: { lat: 52, lon: -1 + 0.005 },
    provenance: syn("X"),
  });
  infra.edges.push({ id: "e7", from: "B", to: "X", usage: "main", provenance: syn("e7") });
  for (const e of infra.edges) e.lengthM = SYNTHETIC_LENGTHS_M[e.id]!;
  d.playableArea!.cuts[0]!.kind = "gameplay_cut";

  d.signalling!.routes.push({
    id: "r5",
    ref: null,
    entrySignalId: "sig2",
    exitSignalId: null,
    exitFringeId: "fr-b",
    edgeIds: ["e4"],
    pointsRequired: [],
    overlapId: null,
    conflictsWith: ["r3", "r4"],
    provenance: simplified("route r5 (P3 movement tests)"),
  });
  // r5 shares e4 with r3 and r4; the validator requires the conflict to be declared both ways.
  for (const r of d.signalling!.routes)
    if (r.id === "r3" || r.id === "r4") r.conflictsWith.push("r5");
  return d;
}
