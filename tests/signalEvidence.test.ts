/**
 * Phase 1 signal reconciliation: step classification, per-claim evidence, provenance rules.
 * All layouts, refs and berths here are SYNTHETIC (source "synthetic-fixture").
 */
import { describe, expect, it } from "vitest";
import type { SmartRow } from "../src/import/smart/smart.ts";
import {
  GameplayCorrection,
  SignalEvidenceFile,
  SignalEvidenceRecord,
  type BerthStepEvidence,
  type Infrastructure,
} from "../src/model/index.ts";
import { DirectedTrack } from "../src/graph/directedTrack.ts";
import { classifySteps, decodeEvent } from "../src/reconcile/berthSteps.ts";
import { assessFromSteps, buildSignalEvidence } from "../src/reconcile/signalEvidence.ts";
import { validateDataset } from "../src/validation/validate.ts";
import { syntheticDataset } from "../fixtures/synthetic/dataset.ts";

const SYN = { sourceId: "synthetic-fixture" };
const prov = { evidence: "sourced" as const, sources: [SYN] };

/*
 * Synthetic layout (west -> east, all edges 100 m):
 *
 *                     B1 (CE2, faces J) --- BS (buffer stop)      <- a dead-end bay
 *                    /
 *   W --- S1 (CE1 ->) --- J --- M1 (<- CE4) --- S3 (CE3 ->) --- E
 *   (boundary)                                                   (boundary)
 */
function layout(): Infrastructure {
  const node = (id: string, kind: string, lat: number, lon: number) => ({
    id,
    kind: kind as "plain",
    position: { lat, lon },
    provenance: prov,
  });
  const edge = (id: string, from: string, to: string) => ({
    id,
    from,
    to,
    lengthM: 100,
    usage: "main" as const,
    provenance: prov,
  });
  const signal = (id: string, ref: string | null, at: string, facing: string) => ({
    id,
    ref,
    trackNodeId: at,
    facingTowardsNodeId: { value: facing, provenance: prov },
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
    position: nodes.find((n) => n.id === at)!.position,
    provenance: prov,
  });
  const nodes = [
    node("W", "area_boundary", 52, -1.01),
    node("S1", "plain", 52, -1.008),
    node("J", "switch", 52, -1.006),
    node("M1", "plain", 52, -1.004),
    node("S3", "plain", 52, -1.002),
    node("E", "area_boundary", 52, -1.0),
    node("B1", "plain", 52.0003, -1.004),
    node("BS", "buffer_stop", 52.0006, -1.002),
  ];
  return {
    datasetId: "synthetic",
    version: "synthetic",
    generated: "2026-01-01",
    nodes,
    edges: [
      edge("e1", "W", "S1"),
      edge("e2", "S1", "J"),
      edge("e3", "J", "M1"),
      edge("e4", "M1", "S3"),
      edge("e5", "S3", "E"),
      edge("e6", "J", "B1"),
      edge("e7", "B1", "BS"),
    ],
    locations: [],
    platforms: [],
    signals: [
      signal("sig1", "CE1", "S1", "J"),
      signal("sig2", "CE2", "B1", "J"),
      signal("sig3", "CE3", "S3", "E"),
      signal("sig4", "CE4", "M1", "J"),
      signal("sig5", "CE5BR", "M1", "S3"),
      signal("sig6", "CE6", "S3", "E"),
      signal("sig6b", "CE6", "S1", "J"),
    ],
    points: [],
    occupancySections: [],
  };
}

const row = (from: string, to: string, event: string, extra: Partial<SmartRow> = {}): SmartRow => ({
  TD: "ZZ",
  FROMBERTH: from,
  TOBERTH: to,
  STANOX: "99999",
  STANME: "SYNTHETIC",
  STEPTYPE: "B",
  EVENT: event,
  PLATFORM: "",
  FROMLINE: "",
  TOLINE: "",
  BERTHOFFSET: "+0",
  ROUTE: "",
  COMMENT: "synthetic",
  ...extra,
});

describe("decodeEvent", () => {
  it("decodes SMART arrive/depart Up/Down codes and keeps the raw value", () => {
    expect(decodeEvent("A")).toEqual({ raw: "A", kind: "arrive", direction: "up" });
    expect(decodeEvent("D")).toEqual({ raw: "D", kind: "depart", direction: "down" });
    expect(decodeEvent(" ")).toEqual({ raw: " ", kind: null, direction: null });
  });
});

describe("DirectedTrack extensions", () => {
  const infra = layout();
  const t = new DirectedTrack(infra);
  it("distinguishes from-behind and head-on arrivals", () => {
    expect(t.route("S1", "J", "M1", "J")).toBeNull(); // only reachable from J, i.e. head-on
    expect(t.route("S1", "J", "M1", "J", 6000, true)?.nodes).toEqual(["S1", "J", "M1"]);
    expect(t.route("S1", "J", "S3", "E")?.distanceM).toBe(300);
  });
  it("reports dead ends behind a signal", () => {
    expect(t.graph.plainRun("B1", "BS")).toMatchObject({ nodeId: "BS", degree: 1, distanceM: 100 });
    expect(t.graph.plainRun("M1", "S3")).toMatchObject({ nodeId: "E", degree: 1, distanceM: 200 });
  });
  it("smooth rule admits diverging forward moves at a 4-way node that the leg rule forbids", () => {
    const n = (id: string, lat: number, lon: number) => ({
      id,
      kind: "plain" as const,
      position: { lat, lon },
      provenance: prov,
    });
    const e = (id: string, to: string) => ({
      id,
      from: "C",
      to,
      lengthM: 100,
      usage: "main" as const,
      provenance: prov,
    });
    const x = {
      nodes: [
        n("C", 52, -1),
        n("Wx", 52, -1.001),
        n("Ex", 52, -0.999),
        n("NE", 52.0003, -0.999),
        n("SW", 51.9997, -1.001),
      ],
      edges: [e("a", "Wx"), e("b", "Ex"), e("c", "NE"), e("d", "SW")],
    };
    expect(new DirectedTrack(x, "legs").distance("Wx", "C", "NE", null)).toBeNull();
    expect(new DirectedTrack(x, "smooth").distance("Wx", "C", "NE", null)).toBe(200);
    expect(new DirectedTrack(x, "smooth").distance("Wx", "C", "SW", null)).toBeNull();
  });
});

describe("classifySteps (directional transitions)", () => {
  const infra = layout();
  const sig = (id: string) => infra.signals.find((s) => s.id === id)!;
  const signalByBerth = new Map([
    ["0001", sig("sig1")],
    ["0002", sig("sig2")],
    ["0003", sig("sig3")],
    ["0004", sig("sig4")],
  ]);
  const ctx = { infra, signalByBerth, osm: SYN, smart: SYN };
  const result = (rows: SmartRow[]) =>
    Object.fromEntries(classifySteps(rows, ctx).map((s) => [`${s.fromBerth}>${s.toBerth}`, s]));

  it("classifies a through movement as consistent and discriminating", () => {
    const r = result([row("0001", "0003", "D")])["0001>0003"]!;
    expect(r.result).toBe("consistent");
    expect(r.distanceM).toBe(300);
    expect(r.fromDirectionDiscriminates).toBe(true);
    expect(r.provenance.evidence).toBe("inferred");
  });

  it("explains a head-on arrival into a dead-end bay only with an opposite-direction departure", () => {
    const withDeparture = result([row("0001", "0002", "C"), row("0002", "0009", "B")]);
    expect(withDeparture["0001>0002"]!.result).toBe("reversal_at_dead_end");
    const sameDirection = result([row("0001", "0002", "C"), row("0002", "0009", "D")]);
    expect(sameDirection["0001>0002"]!.result).toBe("contradicts_direction");
    expect(sameDirection["0001>0002"]!.explanation).toMatch(/no opposite-direction departure/);
    const noDeparture = result([row("0001", "0002", "C")]);
    expect(noDeparture["0001>0002"]!.result).toBe("contradicts_direction");
  });

  it("does not excuse a head-on arrival on a through road, even with a reverse departure", () => {
    const r = result([row("0001", "0004", "C"), row("0004", "0009", "B")])["0001>0004"]!;
    expect(r.result).toBe("contradicts_direction");
    expect(r.explanation).toMatch(/not on a dead-end road/);
  });

  it("keeps a path that exists only through an incomplete two-edge switch unresolved", () => {
    // M1 re-tagged as a switch: OSM would then map a switch with only two edges (a leg missing).
    const broken = layout();
    broken.nodes.find((n) => n.id === "M1")!.kind = "switch";
    const steps = classifySteps([row("0001", "0003", "D")], { ...ctx, infra: broken });
    expect(steps[0]!.result).toBe("no_path");
    expect(steps[0]!.explanation).toMatch(/only through incomplete junction\(s\) M1/);
    expect(steps[0]!.distanceM).toBe(300);
  });

  it("reports no path, unmatched sides, and preserves raw SMART values", () => {
    const rs = result([
      row("0003", "0001", "B", { COMMENT: "20/07/2025", PLATFORM: "2" }),
      row("0001", "0099", "D"),
      row("0098", "0099", "D"),
    ]);
    expect(rs["0003>0001"]!.result).toBe("no_path");
    expect(rs["0003>0001"]!).toMatchObject({ comment: "20/07/2025", platform: "2", stepType: "B" });
    expect(rs["0001>0099"]!.result).toBe("one_side_unmatched");
    expect(rs["0001>0099"]!.provenance.evidence).toBe("sourced");
    expect(rs["0098>0099"]!.result).toBe("both_unmatched");
  });

  it("gives repeated identical rows distinct ids", () => {
    const ids = classifySteps([row("0001", "0003", "D"), row("0001", "0003", "D")], ctx).map(
      (s) => s.id,
    );
    expect(new Set(ids).size).toBe(2);
  });
});

describe("assessFromSteps (conflicting evidence)", () => {
  const s = (result: BerthStepEvidence["result"]) => ({ result }) as BerthStepEvidence;
  it("never lets a positive result hide a contradiction", () => {
    expect(assessFromSteps([s("consistent"), s("contradicts_direction")])).toBe("disputed");
    expect(assessFromSteps([s("contradicts_direction")])).toBe("contradicted");
    expect(assessFromSteps([s("reversal_at_dead_end")])).toBe("consistent_with_reversal");
    expect(assessFromSteps([s("consistent_alternative_heuristic")])).toBe("unresolved");
    expect(assessFromSteps([s("one_side_unmatched")])).toBe("not_assessed");
  });
});

describe("buildSignalEvidence (separate claims, provenance)", () => {
  const infra = layout();
  const file = buildSignalEvidence({
    datasetId: "synthetic",
    generated: "2026-01-01",
    infra,
    rawTags: new Map([["sig5", { ref: "CE5BR", fixme: "approximate position", colour: "x" }]]),
    smartRows: [
      row("0001", "0003", "D"),
      row("0001", "0002", "C"),
      row("0002", "0009", "B"),
      row("0006", "0003", "D"),
      row("0005", "0003", "D"),
      row("A005", "0003", "D"),
    ],
    corpus: [{ TIPLOC: "SYNT001", STANOX: "99999", NLCDESC: "SYNTHETIC CE 1 SIGNAL" }],
    corpusSignalPattern: /SYNTHETIC/,
    scope: { td: "ZZ", signalPrefix: "CE", stanox: { "99999": "SYNTHETIC" } },
    sources: { osm: SYN, smart: SYN, corpus: SYN },
  });
  const rec = (id: string) => file.signals.find((s) => s.signalId === id)!;

  it("parses as a SignalEvidenceFile and contains no verified claim", () => {
    expect(() => SignalEvidenceFile.parse(file)).not.toThrow();
    expect(JSON.stringify(file)).not.toContain('"verified"');
  });

  it("keeps identity corroboration separate from position, direction and berth", () => {
    const s1 = rec("sig1");
    expect(s1.identity.assessment).toBe("corroborated");
    expect(s1.identity.provenance.evidence).toBe("sourced"); // CORPUS cannot locate the signal
    expect(s1.position.assessment).toBe("single_source");
    expect(s1.direction.assessment).toBe("consistent");
    expect(s1.berths[0]!.claim.provenance.evidence).toBe("inferred");
    expect(s1.berths[0]!.claim.provenance.note).toMatch(/SMART does not name signals/);
  });

  it("marks the bay starter consistent only with reversal", () => {
    expect(rec("sig2").direction.assessment).toBe("consistent_with_reversal");
    expect(rec("sig2").trackContext.value?.behind?.nodeKind).toBe("buffer_stop");
  });

  it("treats duplicate refs and suffixes as ambiguous, and keeps raw refs and tags", () => {
    expect(rec("sig6").identity.assessment).toBe("ambiguous");
    expect(rec("sig6b").identity.assessment).toBe("ambiguous");
    expect(rec("sig6").berths[0]!.match).toBe("ambiguous");
    const s5 = rec("sig5");
    expect(s5.rawRef).toBe("CE5BR");
    expect(s5.parsedRef).toEqual({ prefix: "CE", number: 5, suffix: "BR" });
    expect(s5.berths.map((b) => b.berth).sort()).toEqual(["0005", "A005"]);
    expect(s5.berths.every((b) => b.claim.assessment === "ambiguous")).toBe(true);
    expect(s5.rawTags).toEqual({ ref: "CE5BR", fixme: "approximate position" });
    expect(s5.position.limitations).toContain('OSM fixme: "approximate position"');
  });

  it("keeps unmatched and ambiguous berths visible", () => {
    const b = Object.fromEntries(file.unmatchedBerths.map((x) => [x.berth, x.match]));
    expect(b).toMatchObject({ "0009": "unmatched", A005: "ambiguous" });
  });
});

describe("provenance rules in the schemas", () => {
  const claim = {
    value: "CE1",
    provenance: { evidence: "verified", sources: [SYN, { sourceId: "synthetic-other" }] },
    assessment: "contradicted",
    findings: [],
    limitations: [],
  };
  const record = {
    signalId: "s",
    rawRef: "CE1",
    parsedRef: null,
    identity: claim,
    position: { ...claim, value: null, provenance: prov, assessment: "single_source" },
    direction: { ...claim, value: null, provenance: prov, assessment: "not_assessed" },
    trackContext: { ...claim, value: null, provenance: prov, assessment: "single_source" },
  };
  it("rejects a verified claim unless it is corroborated", () => {
    expect(SignalEvidenceRecord.safeParse(record).success).toBe(false);
    expect(
      SignalEvidenceRecord.safeParse({
        ...record,
        identity: { ...claim, assessment: "corroborated" },
      }).success,
    ).toBe(true);
  });
  it("rejects a gameplay correction presented as sourced", () => {
    const g = {
      id: "g1",
      kind: "add_buffer_stop",
      targetIds: ["n1"],
      description: "synthetic",
      status: "proposed",
    };
    expect(GameplayCorrection.safeParse({ ...g, provenance: prov }).success).toBe(false);
    expect(
      GameplayCorrection.safeParse({
        ...g,
        provenance: { evidence: "placeholder", sources: [], note: "synthetic stand-in" },
      }).success,
    ).toBe(true);
  });
});

describe("validator: signal evidence and playable area", () => {
  it("surfaces contradicted claims and checks references", () => {
    const d = syntheticDataset();
    const sig = d.infrastructure.signals[0]!;
    const c = (assessment: string) => ({
      value: null,
      provenance: prov,
      assessment,
      findings: [],
      limitations: [],
    });
    d.signalEvidence = SignalEvidenceFile.parse({
      datasetId: d.infrastructure.datasetId,
      generated: "2026-01-01",
      method: "synthetic",
      inputs: [SYN],
      scope: { td: "ZZ", signalPrefix: "CE", stanox: {} },
      signals: [
        {
          signalId: sig.id,
          rawRef: sig.ref,
          parsedRef: null,
          identity: c("single_source"),
          position: c("single_source"),
          direction: c("contradicted"),
          trackContext: c("single_source"),
        },
        {
          signalId: "no-such-signal",
          rawRef: null,
          parsedRef: null,
          identity: c("not_assessed"),
          position: c("not_assessed"),
          direction: c("not_assessed"),
          trackContext: c("not_assessed"),
        },
      ],
      steps: [],
      unmatchedBerths: [],
    });
    const issues = validateDataset({ ...d, allowSynthetic: true });
    expect(issues.find((i) => i.code === "SIGNAL_EVIDENCE_CONFLICT")?.message).toContain(
      `${sig.id} direction is contradicted`,
    );
    expect(
      issues.some((i) => i.code === "MISSING_REFERENCE" && i.ids?.includes("no-such-signal")),
    ).toBe(true);
  });

  it("rejects a cut whose edge does not join its nodes", () => {
    const d = syntheticDataset();
    const e = d.infrastructure.edges[0]!;
    d.playableArea = {
      datasetId: d.infrastructure.datasetId,
      status: "proposed",
      basis: "game_design",
      description: "synthetic",
      cuts: [
        {
          id: "cut1",
          name: "synthetic",
          kind: "gameplay_cut",
          edgeId: e.id,
          insideNodeId: e.from,
          outsideNodeId: e.from,
          line: null,
          connectsTo: "synthetic",
          provenance: { evidence: "inferred", sources: [SYN], note: "synthetic" },
        },
      ],
      includedLocationIds: [],
      platformIds: [],
      optionalAreas: [],
      gameplayCorrections: [],
    };
    const codes = validateDataset({ ...d, allowSynthetic: true }).map((i) => i.code);
    expect(codes).toContain("PLAYABLE_AREA_CUT");
  });
});
