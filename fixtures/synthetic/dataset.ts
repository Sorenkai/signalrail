/**
 * SYNTHETIC dataset for tests. Not a real railway layout.
 *
 *   A ==e1== N1 ==e2== P1 ==e3== N2 ==e4== B (area boundary)
 *   (buffer)  sig1->    \==e5== N3 ==e6== C (buffer)
 *                             sig3->
 *   sig2 at N2 faces B. Points pts1 at P1: normal -> N2, reverse -> N3.
 */
import type { ValidationInput } from "../../src/validation/validate.ts";
import type { Provenance, SourceRegistry } from "../../src/model/index.ts";

export const SYNTHETIC_SOURCE_ID = "synthetic-fixture";

const syn = (recordId: string): Provenance => ({
  evidence: "sourced",
  sources: [{ sourceId: SYNTHETIC_SOURCE_ID, recordId }],
});

export const syntheticSources = (): SourceRegistry => ({
  sources: [
    {
      id: SYNTHETIC_SOURCE_ID,
      name: "Synthetic test fixture",
      publisher: "Signal Network project",
      url: "https://example.invalid/synthetic",
      access: "reference-only",
      licence: { name: "Project test data", confirmed: true },
      attribution: null,
      obligations: [],
      status: "in-use",
      retrievals: [],
      // Stands in for a control table so synthetic routes can be tested as `evidenced`.
      interlockingAuthority: true,
      notes: "Synthetic. Never valid in a real dataset.",
    },
  ],
});

// Offset into Great Britain so coordinate-plausibility checks apply; the layout is still fictional.
const pos = (lat: number, lon: number) => ({ lat: 52 + lat, lon: -1 + lon });

export function syntheticDataset(): ValidationInput {
  return {
    allowSynthetic: true,
    sources: syntheticSources(),
    infrastructure: {
      datasetId: "synthetic",
      version: "synthetic-1",
      generated: "2026-10-27",
      nodes: [
        { id: "A", kind: "buffer_stop", position: pos(0, 0), provenance: syn("A") },
        { id: "N1", kind: "plain", position: pos(0, 0.001), provenance: syn("N1") },
        { id: "P1", kind: "switch", position: pos(0, 0.002), provenance: syn("P1") },
        { id: "N2", kind: "plain", position: pos(0, 0.003), provenance: syn("N2") },
        { id: "B", kind: "area_boundary", position: pos(0, 0.004), provenance: syn("B") },
        { id: "N3", kind: "plain", position: pos(-0.0005, 0.003), provenance: syn("N3") },
        { id: "C", kind: "buffer_stop", position: pos(-0.0005, 0.004), provenance: syn("C") },
      ],
      edges: [
        ["e1", "A", "N1"],
        ["e2", "N1", "P1"],
        ["e3", "P1", "N2"],
        ["e4", "N2", "B"],
        ["e5", "P1", "N3"],
        ["e6", "N3", "C"],
      ].map(([id, from, to]) => ({
        id: id!,
        from: from!,
        to: to!,
        usage: "main" as const,
        provenance: syn(id!),
      })),
      locations: [
        {
          id: "loc-syna",
          name: "Synthetic A",
          kind: "station",
          codes: {},
          provenance: syn("loc-syna"),
        },
      ],
      platforms: [],
      signals: [
        ["sig1", "N1", "P1"],
        ["sig2", "N2", "B"],
        ["sig3", "N3", "C"],
      ].map(([id, node, towards]) => ({
        id: id!,
        ref: id!.toUpperCase(),
        trackNodeId: node!,
        facingTowardsNodeId: { value: towards!, provenance: syn(id!) },
        type: "colour_light" as const,
        function: "main" as const,
        components: [
          {
            category: "main",
            sourceType: "synthetic:main",
            form: "light",
            design: null,
            states: null,
            height: null,
          },
        ],
        mounting: { value: null, provenance: { evidence: "unknown" as const, sources: [] } },
        provenance: syn(id!),
      })),
      points: [
        {
          id: "pts1",
          ref: "1",
          trackNodeId: "P1",
          switchType: "simple",
          normalTowardsNodeId: { value: "N2", provenance: syn("pts1") },
          reverseTowardsNodeId: { value: "N3", provenance: syn("pts1") },
          provenance: syn("pts1"),
        },
      ],
      occupancySections: [],
    },
    signalling: {
      datasetId: "synthetic",
      routes: [
        {
          id: "r1",
          ref: null,
          entrySignalId: "sig1",
          exitSignalId: "sig2",
          edgeIds: ["e2", "e3"],
          pointsRequired: [{ pointsId: "pts1", position: "normal", role: "path" }],
          overlapId: null,
          conflictsWith: ["r2"],
          provenance: syn("r1"),
        },
        {
          id: "r2",
          ref: null,
          entrySignalId: "sig1",
          exitSignalId: "sig3",
          edgeIds: ["e2", "e5"],
          pointsRequired: [{ pointsId: "pts1", position: "reverse", role: "path" }],
          overlapId: null,
          conflictsWith: ["r1"],
          provenance: syn("r2"),
        },
      ],
      overlaps: [],
    },
    control: {
      datasetId: "synthetic",
      areas: [
        {
          id: "area-1",
          name: "Synthetic area",
          basis: "game_design",
          signalBoxLocationId: null,
          signalIds: ["sig1", "sig2", "sig3"],
          pointsIds: ["pts1"],
          // A game-design area is a project decision, never a sourced fact (D-027).
          membershipProvenance: {
            evidence: "simplified",
            sources: [],
            note: "SYNTHETIC: game-design membership",
          },
          provenance: { evidence: "simplified", sources: [], note: "SYNTHETIC: game-design area" },
        },
      ],
      boundaries: [],
    },
    timingPoints: [{ tiploc: "SYNA", locationId: "loc-syna", provenance: syn("SYNA") }],
    timetables: [],
  };
}
