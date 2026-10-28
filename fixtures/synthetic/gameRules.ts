/**
 * SYNTHETIC game-rule dataset for tests (D-029). Not a real railway layout, and none of its
 * game rules describes a real interlocking.
 *
 * The base synthetic layout (dataset.ts) with its points lie made UNKNOWN, as at every real
 * dataset, so that only game-rules.json can make routes over pts1 clearable:
 *
 *   A ==e1== N1 ==e2== P1 ==e3== N2 ==e4== B   (cut-b on e4: inside N2, outside B)
 *            sig1->     \==e5== N3 ==e6== C
 *                        sig4 at N2 faces P1 (towards the station, away from the cut)
 *
 *   Game rule: pts1 simple, normal -> N2, reverse -> N3. Fringe fr-b on cut-b (entry, exit).
 *   r1: sig1 -> sig2 (pts1 normal)   r2: sig1 -> sig3 (pts1 reverse)
 *   r3: sig1 -> fringe fr-b (pts1 normal)   r4: fringe fr-b -> sig4
 */
import type { ValidationInput } from "../../src/validation/validate.ts";
import type { Provenance } from "../../src/model/index.ts";
import { SYNTHETIC_SOURCE_ID, syntheticDataset } from "./dataset.ts";

const unknown = { evidence: "unknown" as const, sources: [] };
export const simplified = (note: string): Provenance => ({
  evidence: "simplified",
  sources: [],
  note: `SYNTHETIC game rule: ${note}`,
});
const unknownClaim = (note: string) => ({
  value: null,
  provenance: unknown,
  limitations: [`SYNTHETIC: ${note}`],
});

export function syntheticGameRuleDataset(): ValidationInput {
  const d = syntheticDataset();
  const infra = d.infrastructure;

  // As in real data: OSM states neither the lie nor the switch type.
  const pts1 = infra.points[0]!;
  pts1.switchType = "unknown";
  pts1.normalTowardsNodeId = { value: null, provenance: unknown };
  pts1.reverseTowardsNodeId = { value: null, provenance: unknown };

  infra.signals.push({
    ...infra.signals[0]!,
    id: "sig4",
    ref: "SIG4",
    trackNodeId: "N2",
    facingTowardsNodeId: {
      value: "P1",
      provenance: { evidence: "sourced", sources: [{ sourceId: SYNTHETIC_SOURCE_ID }] },
    },
    provenance: { evidence: "sourced", sources: [{ sourceId: SYNTHETIC_SOURCE_ID }] },
  });

  const route = (
    id: string,
    ends: {
      entrySignalId?: string;
      exitSignalId?: string;
      entryFringeId?: string;
      exitFringeId?: string;
    },
    edgeIds: string[],
    position: "normal" | "reverse" | null,
    conflictsWith: string[],
  ) => ({
    id,
    ref: null,
    entrySignalId: ends.entrySignalId ?? null,
    exitSignalId: ends.exitSignalId ?? null,
    ...(ends.entryFringeId ? { entryFringeId: ends.entryFringeId } : {}),
    ...(ends.exitFringeId ? { exitFringeId: ends.exitFringeId } : {}),
    edgeIds,
    pointsRequired: position ? [{ pointsId: "pts1", position, role: "path" as const }] : [],
    overlapId: null,
    conflictsWith,
    provenance: simplified(`route ${id}`),
  });
  d.signalling = {
    datasetId: "synthetic",
    routes: [
      route("r1", { entrySignalId: "sig1", exitSignalId: "sig2" }, ["e2", "e3"], "normal", [
        "r2",
        "r3",
      ]),
      route("r2", { entrySignalId: "sig1", exitSignalId: "sig3" }, ["e2", "e5"], "reverse", [
        "r1",
        "r3",
      ]),
      route("r3", { entrySignalId: "sig1", exitFringeId: "fr-b" }, ["e2", "e3", "e4"], "normal", [
        "r1",
        "r2",
        "r4",
      ]),
      route("r4", { entryFringeId: "fr-b", exitSignalId: "sig4" }, ["e4"], null, ["r3"]),
    ],
    overlaps: [],
  };

  d.gameRules = {
    datasetId: "synthetic",
    points: [
      {
        pointsId: "pts1",
        switchType: "simple",
        normalTowardsNodeId: "N2",
        reverseTowardsNodeId: "N3",
        provenance: simplified("pts1 lie; the real lie is not known"),
      },
    ],
    fringeEndpoints: [
      {
        id: "fr-b",
        cutId: "cut-b",
        use: ["entry", "exit"],
        provenance: simplified("trains enter and leave play at cut-b"),
      },
    ],
  };

  d.playableArea = {
    datasetId: "synthetic",
    status: "proposed",
    basis: "game_design",
    description: "SYNTHETIC",
    cuts: [
      {
        id: "cut-b",
        name: "SYNTHETIC cut at B",
        kind: "extract_boundary",
        edgeId: "e4",
        insideNodeId: "N2",
        outsideNodeId: "B",
        line: null,
        connectsTo: "SYNTHETIC beyond",
        provenance: { evidence: "inferred", sources: [], note: "SYNTHETIC" },
      },
    ],
    includedLocationIds: [],
    platformIds: [],
    optionalAreas: [],
    gameplayCorrections: [],
  };

  const control = d.control!;
  control.areas[0]!.signalIds.push("sig4");
  control.externalAreas = [
    {
      id: "ext-1",
      name: "SYNTHETIC beyond",
      kind: "outside_play",
      controlCentre: unknownClaim("not stated"),
      provenance: { evidence: "inferred", sources: [], note: "SYNTHETIC" },
    },
  ];
  control.boundaries = [
    {
      id: "bd-1",
      fromAreaId: "area-1",
      toAreaId: "ext-1",
      edgeId: "e4",
      cutId: "cut-b",
      provenance: simplified("boundary at cut-b"),
      // No real boundary signal or traffic direction is claimed (D-029).
      boundarySignalIds: unknownClaim("not stated"),
      trafficDirections: unknownClaim("not stated"),
      handover: null,
      status: "incomplete",
      unresolved: ["boundary signals", "traffic directions", "handover"],
    },
  ];
  return d;
}
