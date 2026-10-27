/**
 * Slip junctions: sourced OSM slip types in the junction model, step classification and
 * validation. All layouts are SYNTHETIC.
 */
import { describe, expect, it } from "vitest";
import type { SmartRow } from "../src/import/smart/smart.ts";
import type { Infrastructure, Points } from "../src/model/index.ts";
import { DirectedTrack } from "../src/graph/directedTrack.ts";
import { classifySteps } from "../src/reconcile/berthSteps.ts";
import { validateDataset } from "../src/validation/validate.ts";
import { syntheticDataset } from "../fixtures/synthetic/dataset.ts";

const SYN = { sourceId: "synthetic-fixture" };
const prov = { evidence: "sourced" as const, sources: [SYN] };

/*
 * A slip node C where track 1 (W - C - E) crosses track 2 (SW - C - NE) at a shallow angle.
 * Straight across: W<->E and SW<->NE. Diagonals: W<->NE and SW<->E.
 *          NE
 *   W --- C --- E
 *   SW
 */
function slipLayout(type: Points["switchType"] | null): Infrastructure {
  const n = (id: string, lat: number, lon: number, kind = "plain") => ({
    id,
    kind: kind as "plain",
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
  const sig = (id: string, ref: string, at: string, facing: string) => ({
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
    provenance: prov,
  });
  return {
    datasetId: "synthetic",
    version: "synthetic",
    generated: "2026-01-01",
    nodes: [
      n("C", 52, -1, "switch"),
      n("W", 52, -1.001),
      n("E", 52, -0.999),
      n("NE", 52.0003, -0.999),
      n("SW", 51.9997, -1.001),
    ],
    edges: [e("cw", "W"), e("ce", "E"), e("cne", "NE"), e("csw", "SW")],
    locations: [],
    platforms: [],
    signals: [
      sig("sW", "CE1", "W", "C"), // faces into the slip from the west
      // Faces away from C (towards a node beyond the layout), so a train arriving from C
      // reaches it from behind.
      sig("sNE", "CE3", "NE", "beyond-NE"),
    ],
    points: type
      ? [
          {
            id: "pC",
            ref: null,
            trackNodeId: "C",
            switchType: type,
            normalTowardsNodeId: { value: null, provenance: { evidence: "unknown", sources: [] } },
            reverseTowardsNodeId: { value: null, provenance: { evidence: "unknown", sources: [] } },
            provenance: prov,
          },
        ]
      : [],
    occupancySections: [],
  };
}

describe("DirectedTrack with slip types", () => {
  it("double slip: straight and diagonal routes are supported, no turn-back", () => {
    const t = new DirectedTrack(slipLayout("double_slip"));
    expect(t.distance("W", "C", "E", null)).toBe(200);
    expect(t.distance("W", "C", "NE", null)).toBe(200);
    expect(t.distance("W", "C", "SW", null)).toBeNull();
  });

  it("single slip: straight supported; the unrecorded diagonal is not", () => {
    const t = new DirectedTrack(slipLayout("single_slip"));
    expect(t.distance("W", "C", "E", null)).toBe(200);
    expect(t.distance("SW", "C", "NE", null)).toBe(200);
    expect(t.distance("W", "C", "NE", null)).toBeNull();
    expect(t.distance("SW", "C", "E", null)).toBeNull();
  });

  it("single slip diagonals appear only in the explicit 'allow' model, and are reported", () => {
    const t = new DirectedTrack(slipLayout("single_slip"), "legs", {
      singleSlipDiagonals: "allow",
    });
    const r = t.route("W", "C", "NE", null)!;
    expect(r.distanceM).toBe(200);
    expect(t.singleSlipDiagonalsUsed(r)).toEqual(["C"]);
    expect(t.singleSlipDiagonalsUsed(t.route("W", "C", "E", null)!)).toEqual([]);
  });

  it("a four-edge switch with no slip type allows straight on only", () => {
    const t = new DirectedTrack(slipLayout(null));
    expect(t.distance("W", "C", "E", null)).toBe(200);
    expect(t.distance("W", "C", "NE", null)).toBeNull();
  });
});

describe("classifySteps through a slip", () => {
  const row = (from: string, to: string): SmartRow => ({
    TD: "ZZ",
    FROMBERTH: from,
    TOBERTH: to,
    STANOX: "99999",
    STANME: "SYNTHETIC",
    STEPTYPE: "B",
    EVENT: "B",
    PLATFORM: "",
    FROMLINE: "",
    TOLINE: "",
    BERTHOFFSET: "+0",
    ROUTE: "",
    COMMENT: "synthetic",
  });
  const classify = (type: Points["switchType"]) => {
    const infra = slipLayout(type);
    // CE1 -> CE3 needs the W <-> NE diagonal.
    const [s1, s3] = infra.signals;
    const signalByBerth = new Map([
      ["0001", s1!],
      ["0003", s3!],
    ]);
    return classifySteps([row("0001", "0003")], { infra, signalByBerth, osm: SYN, smart: SYN })[0]!;
  };

  it("is consistent through a double slip's diagonal", () => {
    expect(classify("double_slip").result).toBe("consistent");
  });

  it("stays unresolved through a single slip's diagonal, even though SMART records the step", () => {
    const r = classify("single_slip");
    expect(r.result).toBe("unresolved_slip_diagonal");
    expect(r.explanation).toContain("single slip(s) C");
  });
});

describe("validator: slips", () => {
  const withPoints = (switchType: Points["switchType"]) => {
    const d = syntheticDataset();
    const p = d.infrastructure.points[0]!;
    p.switchType = switchType;
    return { d, node: p.trackNodeId };
  };

  it("warns when a slip type sits on a node that is not four-way", () => {
    const { d, node } = withPoints("single_slip");
    const issue = validateDataset({ ...d, allowSynthetic: true }).find(
      (i) => i.code === "SLIP_TOPOLOGY",
    );
    expect(issue?.ids).toEqual([node]);
  });

  it("reports single-slip diagonals as unresolved and flags untyped four-way switches", () => {
    const infra = { ...slipLayout("single_slip"), signals: [] };
    const sources = syntheticDataset().sources;
    const single = validateDataset({ sources, infrastructure: infra, allowSynthetic: true });
    expect(single.find((i) => i.code === "SINGLE_SLIP_DIAGONAL_UNKNOWN")?.ids).toEqual(["C"]);
    expect(single.some((i) => i.code === "SWITCH_ARRANGEMENT_UNKNOWN")).toBe(false);
    const untyped = validateDataset({
      sources,
      infrastructure: { ...slipLayout(null), signals: [] },
      allowSynthetic: true,
    });
    expect(untyped.find((i) => i.code === "SWITCH_ARRANGEMENT_UNKNOWN")?.ids).toEqual(["C"]);
    const double = validateDataset({
      sources,
      infrastructure: { ...slipLayout("double_slip"), signals: [] },
      allowSynthetic: true,
    });
    expect(double.some((i) => /SLIP|SWITCH_ARRANGEMENT/.test(i.code))).toBe(false);
  });
});
