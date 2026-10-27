import { describe, expect, it } from "vitest";
import { validateDataset, summariseEvidence, type Issue } from "../src/validation/validate.ts";
import { syntheticDataset } from "../fixtures/synthetic/dataset.ts";
import { TimingPointPosition } from "../src/model/index.ts";

const codes = (issues: Issue[]) => issues.map((i) => i.code);
const errors = (issues: Issue[]) => issues.filter((i) => i.severity === "error");

describe("validateDataset", () => {
  it("accepts the clean synthetic dataset", () => {
    expect(errors(validateDataset(syntheticDataset()))).toEqual([]);
  });

  it("reports duplicate identifiers across collections", () => {
    const d = syntheticDataset();
    d.infrastructure.edges[0]!.id = "N1";
    expect(codes(validateDataset(d))).toContain("DUPLICATE_ID");
  });

  it("reports missing references", () => {
    const d = syntheticDataset();
    d.infrastructure.edges[0]!.to = "NOPE";
    d.signalling!.routes[0]!.pointsRequired[0]!.pointsId = "missing-points";
    const missing = validateDataset(d).filter((i) => i.code === "MISSING_REFERENCE");
    expect(missing.map((i) => i.ids?.[1])).toEqual(
      expect.arrayContaining(["NOPE", "missing-points"]),
    );
  });

  it("reports disconnected track", () => {
    const d = syntheticDataset();
    d.infrastructure.edges = d.infrastructure.edges.filter((e) => e.id !== "e2");
    expect(codes(validateDataset(d))).toContain("DISCONNECTED_TRACK");
  });

  it("reports dangling ends and bad switch topology", () => {
    const d = syntheticDataset();
    d.infrastructure.nodes.find((n) => n.id === "C")!.kind = "end_unknown";
    d.infrastructure.edges = d.infrastructure.edges.filter((e) => e.id !== "e5" && e.id !== "e6");
    d.signalling!.routes = [d.signalling!.routes[0]!];
    d.signalling!.routes[0]!.conflictsWith = [];
    const c = codes(validateDataset(d));
    expect(c).toContain("DANGLING_TRACK_END");
    expect(c).toContain("SWITCH_TOPOLOGY");
  });

  it("reports impossible routes: non-contiguous path, wrong exit, wrong direction, foreign points", () => {
    const base = () => syntheticDataset();
    let d = base();
    d.signalling!.routes[0]!.edgeIds = ["e2", "e4"];
    expect(validateDataset(d).find((i) => i.code === "IMPOSSIBLE_ROUTE")?.message).toMatch(
      /does not continue/,
    );

    d = base();
    d.signalling!.routes[0]!.exitSignalId = "sig3";
    expect(validateDataset(d).find((i) => i.code === "IMPOSSIBLE_ROUTE")?.message).toMatch(
      /not at exit signal/,
    );

    d = base();
    d.infrastructure.signals[0]!.facingTowardsNodeId.value = "A";
    expect(validateDataset(d).find((i) => i.code === "IMPOSSIBLE_ROUTE")?.message).toMatch(
      /faces the other way/,
    );

    d = base();
    d.signalling!.routes[0]!.edgeIds = ["e2"];
    d.signalling!.routes[0]!.exitSignalId = "sig1";
    expect(codes(validateDataset(d))).toContain("IMPOSSIBLE_ROUTE");
  });

  it("warns when a route passes a switch without a required position", () => {
    const d = syntheticDataset();
    d.signalling!.routes[0]!.pointsRequired = [];
    expect(codes(validateDataset(d))).toContain("ROUTE_POINTS_UNSPECIFIED");
  });

  it("reports a signal facing a non-adjacent node", () => {
    const d = syntheticDataset();
    d.infrastructure.signals[1]!.facingTowardsNodeId.value = "A";
    expect(codes(validateDataset(d))).toContain("SIGNAL_DIRECTION_INVALID");
  });

  it("reports unmapped timetable locations and backwards times, allowing one midnight crossing", () => {
    const d = syntheticDataset();
    const call = (tiploc: string, dep: string | null, arr: string | null) => ({
      tiploc,
      kind: "intermediate" as const,
      arrival: arr,
      departure: dep,
      pass: null,
      publicArrival: null,
      publicDeparture: null,
      platform: null,
      line: null,
      path: null,
      activities: [],
    });
    const prov = { evidence: "sourced" as const, sources: [{ sourceId: "synthetic-fixture" }] };
    d.timetables = [
      {
        id: "tt",
        date: "2026-11-02",
        extract: {
          sourceId: "synthetic-fixture",
          fileRef: null,
          extractedAt: null,
          validFrom: null,
          validTo: null,
        },
        services: [
          {
            id: "s1",
            uid: "Z1",
            runDate: "2026-11-02",
            headcode: null,
            operatorCode: null,
            category: null,
            powerType: null,
            stpIndicator: "P",
            calls: [call("SYNA", "23:50", null), call("SYNX", null, "00:10")],
            provenance: prov,
          },
          {
            id: "s2",
            uid: "Z2",
            runDate: "2026-11-02",
            headcode: null,
            operatorCode: null,
            category: null,
            powerType: null,
            stpIndicator: "P",
            calls: [call("SYNA", "10:00", null), call("SYNA", null, "09:50")],
            provenance: prov,
          },
        ],
      },
    ];
    const issues = validateDataset(d);
    expect(issues.find((i) => i.code === "UNMAPPED_TIMETABLE_LOCATION")?.ids).toEqual(["SYNX"]);
    const order = issues.filter((i) => i.code === "TIMETABLE_TIME_ORDER");
    expect(order.map((i) => i.ids?.[0])).toEqual(["s2"]);
  });

  it("rejects sources missing from the registry", () => {
    const d = syntheticDataset();
    d.infrastructure.nodes[0]!.provenance.sources[0]!.sourceId = "unregistered";
    expect(codes(validateDataset(d))).toContain("UNKNOWN_SOURCE");
  });

  it("rejects synthetic data in a real dataset", () => {
    const d = syntheticDataset();
    d.allowSynthetic = false;
    expect(codes(validateDataset(d))).toContain("SYNTHETIC_DATA");
  });

  it("surfaces placeholder data and inferred interlocking as unsupported assumptions", () => {
    const d = syntheticDataset();
    d.signalling!.routes[0]!.provenance = {
      evidence: "inferred",
      sources: [],
      note: "derived from track layout",
    };
    d.infrastructure.locations[0]!.provenance = {
      evidence: "placeholder",
      sources: [],
      note: "awaiting CORPUS",
    };
    d.control!.areas[0]!.basis = "real_signal_box";
    d.control!.areas[0]!.membershipProvenance = { evidence: "unknown", sources: [] };
    const issues = validateDataset(d);
    expect(issues.find((i) => i.code === "INFERRED_DATA")).toMatchObject({
      severity: "warning",
      ids: ["r1"],
    });
    expect(issues.find((i) => i.code === "PLACEHOLDER_DATA")?.ids).toEqual(["loc-syna"]);
    expect(issues.find((i) => i.code === "UNSUPPORTED_ASSUMPTION")?.ids).toEqual(["area-1"]);
  });

  it("surfaces deliberate simplifications and keeps them out of source-derived layers", () => {
    const d = syntheticDataset();
    d.control!.areas[0]!.provenance = {
      evidence: "simplified",
      sources: [],
      note: "one player works the whole area; the real division of work is not modelled",
    };
    const ok = validateDataset(d);
    expect(ok.find((i) => i.code === "SIMPLIFIED_DATA")).toMatchObject({
      severity: "warning",
      ids: ["area-1"],
    });
    expect(codes(ok)).not.toContain("SIMPLIFIED_IN_SOURCE_LAYER");

    d.infrastructure.edges[0]!.provenance = {
      evidence: "simplified",
      sources: [],
      note: "SYNTHETIC: a simplified track edge",
    };
    expect(validateDataset(d).find((i) => i.code === "SIMPLIFIED_IN_SOURCE_LAYER")).toMatchObject({
      severity: "error",
      ids: ["e1"],
    });
  });

  it("reports signals with no source-stated category", () => {
    const d = syntheticDataset();
    Object.assign(d.infrastructure.signals[0]!, {
      type: "unknown",
      function: "unknown",
      components: [],
    });
    expect(validateDataset(d).find((i) => i.code === "SIGNAL_CLASS_UNKNOWN")?.ids).toEqual([
      "sig1",
    ]);
  });

  it("reports elements controlled by two areas", () => {
    const d = syntheticDataset();
    d.control!.areas.push({
      ...d.control!.areas[0]!,
      id: "area-2",
      signalIds: ["sig1"],
      pointsIds: [],
    });
    expect(codes(validateDataset(d))).toContain("CONTROL_OVERLAP");
  });
});

describe("summariseEvidence", () => {
  it("counts provenance by collection and level", () => {
    const d = syntheticDataset();
    d.infrastructure.points[0]!.normalTowardsNodeId = {
      value: null,
      provenance: { evidence: "unknown", sources: [] },
    };
    const s = summariseEvidence(d);
    expect(s.byCollection["infrastructure.points.normalTowardsNodeId"]).toMatchObject({
      unknown: 1,
    });
    expect(s.byCollection["infrastructure.nodes"]).toMatchObject({ sourced: 7 });
    // The three synthetic signals state no mounting, so each counts as unknown too.
    expect(s.byCollection["infrastructure.signals.mounting"]).toMatchObject({ unknown: 3 });
    expect(s.total.unknown).toBe(4);
  });
});

describe("study-area TIPLOC scoping", () => {
  it("warns only for unmapped TIPLOCs inside the study area", () => {
    const d = syntheticDataset();
    const call = (tiploc: string, dep: string) => ({
      tiploc,
      kind: "intermediate" as const,
      arrival: null,
      departure: dep,
      pass: null,
      publicArrival: null,
      publicDeparture: null,
      platform: null,
      line: null,
      path: null,
      activities: [],
    });
    d.timetables = [
      {
        id: "tt",
        date: "2026-11-02",
        extract: {
          sourceId: "synthetic-fixture",
          fileRef: null,
          extractedAt: null,
          validFrom: null,
          validTo: null,
        },
        services: [
          {
            id: "s1",
            uid: "Z1",
            runDate: "2026-11-02",
            headcode: null,
            operatorCode: null,
            category: null,
            powerType: null,
            stpIndicator: "P",
            calls: [call("SYNFAR", "09:00"), call("SYNA", "10:00"), call("SYNB", "10:05")],
            provenance: { evidence: "sourced", sources: [{ sourceId: "synthetic-fixture" }] },
          },
        ],
      },
    ];
    d.areaTiplocs = ["SYNA", "SYNB"];
    const issues = validateDataset(d);
    expect(issues.find((i) => i.code === "UNMAPPED_TIMETABLE_LOCATION")?.ids).toEqual(["SYNB"]);
    expect(issues.find((i) => i.code === "OUT_OF_AREA_LOCATIONS")?.severity).toBe("info");
  });
});

describe("coordinates and alignment", () => {
  it("rejects coordinates outside Great Britain", () => {
    const d = syntheticDataset();
    d.infrastructure.nodes[0]!.position = { lat: 0, lon: 0 };
    expect(validateDataset(d).find((i) => i.code === "COORDINATE_IMPLAUSIBLE")?.ids).toEqual(["A"]);
  });

  it("rejects edge geometry that does not meet its nodes", () => {
    const d = syntheticDataset();
    const n = (id: string) => d.infrastructure.nodes.find((x) => x.id === id)!.position!;
    d.infrastructure.edges[0]!.geometry = [n("A"), { lat: n("N1").lat + 0.001, lon: n("N1").lon }];
    expect(validateDataset(d).find((i) => i.code === "TRACK_ALIGNMENT")?.ids).toEqual(["e1"]);
  });
});

describe("inferred timing-point positions", () => {
  const position = (tiploc: string, nodeIds: string[], at = nodeIds[0]!) => {
    const d = syntheticDataset();
    const p = d.infrastructure.nodes.find((n) => n.id === at)!.position!;
    return {
      d,
      tp: {
        tiploc,
        position: { ...p },
        trackNodeIds: nodeIds,
        confidence: "low" as const,
        method: "test",
        basis: ["synthetic"],
        provenance: { evidence: "inferred" as const, sources: [], note: "synthetic test" },
      },
    };
  };

  it("accepts a position at its anchor and counts the TIPLOC as placed", () => {
    const { d, tp } = position("SYNB", ["P1"]);
    d.timingPointPositions = [tp];
    d.areaTiplocs = ["SYNA", "SYNB"];
    const issues = validateDataset(d);
    expect(errors(issues)).toEqual([]);
    expect(issues.find((i) => i.code === "INFERRED_DATA")?.ids).toEqual(["SYNB"]);
  });

  it("rejects a position away from its first anchor, and a missing anchor", () => {
    const { d, tp } = position("SYNB", ["P1"], "C");
    d.timingPointPositions = [tp, { ...tp, tiploc: "SYNC", trackNodeIds: ["NOPE"] }];
    const issues = validateDataset(d);
    expect(issues.find((i) => i.code === "TRACK_ALIGNMENT")?.ids).toEqual(["SYNB"]);
    expect(issues.some((i) => i.code === "MISSING_REFERENCE" && i.ids?.includes("NOPE"))).toBe(
      true,
    );
  });

  it("rejects a TIPLOC that is both mapped from a source and inferred", () => {
    const { d, tp } = position("SYNA", ["N1"]);
    d.timingPointPositions = [tp];
    expect(codes(validateDataset(d))).toContain("TIMING_POINT_CONFLICT");
  });

  it("refuses to label a timing-point position as anything but inferred", () => {
    const { tp } = position("SYNB", ["P1"]);
    const bad = {
      ...tp,
      provenance: { evidence: "verified", sources: [{ sourceId: "a" }, { sourceId: "b" }] },
    };
    expect(TimingPointPosition.safeParse(bad).success).toBe(false);
    expect(TimingPointPosition.safeParse(tp).success).toBe(true);
  });
});
