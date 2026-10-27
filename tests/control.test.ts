/**
 * Control-area model and validation (R5, D-027). Synthetic fixtures are labelled SYNTHETIC;
 * the real Carlisle and Shrewsbury files are checked as they are.
 */
import { describe, expect, it } from "vitest";
import { syntheticDataset } from "../fixtures/synthetic/dataset.ts";
import { loadDataset } from "../src/data/loadDataset.ts";
import {
  AreaBoundary,
  Control,
  ControlCentre,
  designChoice,
  realWorldClaim,
} from "../src/model/index.ts";
import { z } from "zod";
import { validateDataset, type ValidationInput } from "../src/validation/validate.ts";

const codes = (d: ValidationInput) => validateDataset(d).map((i) => i.code);
const errors = (d: ValidationInput) =>
  validateDataset(d)
    .filter((i) => i.severity === "error")
    .map((i) => i.code);

const syn = { evidence: "sourced" as const, sources: [{ sourceId: "synthetic-fixture" }] };
const unknown = (note: string) => ({
  value: null,
  provenance: { evidence: "unknown" as const, sources: [] },
  limitations: [note],
});
const choice = <T>(value: T) => ({
  value,
  status: "proposed" as const,
  rationale: "SYNTHETIC design choice",
  provenance: { evidence: "simplified" as const, sources: [], note: "SYNTHETIC" },
});

/** The synthetic dataset plus a playable area cut at N2|B, a control centre and a boundary. */
function dataset(): ValidationInput {
  const d = syntheticDataset();
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
  d.control!.controlCentres = [
    {
      id: "cc-1",
      name: "SYNTHETIC box",
      locationId: null,
      provenance: syn,
      operationalStatus: { value: "operational", provenance: syn, limitations: [] },
      controlMethod: { value: "mechanical_lever_frame", provenance: syn, limitations: [] },
      methodsOfWorking: unknown("SYNTHETIC: not stated"),
      signallingPrinciples: unknown("SYNTHETIC: not stated"),
      extent: unknown("SYNTHETIC: not stated"),
    },
  ];
  d.control!.areas[0]!.controlCentre = unknown("SYNTHETIC: not stated");
  d.control!.areas[0]!.operator = choice("human_or_ai" as const);
  d.control!.externalAreas = [
    {
      id: "ext-1",
      name: "SYNTHETIC beyond",
      kind: "outside_play",
      controlCentre: unknown("SYNTHETIC: not stated"),
      provenance: { evidence: "inferred", sources: [], note: "SYNTHETIC" },
    },
  ];
  d.control!.boundaries = [
    {
      id: "bd-1",
      fromAreaId: "area-1",
      toAreaId: "ext-1",
      edgeId: "e4",
      cutId: "cut-b",
      provenance: { evidence: "simplified", sources: [], note: "SYNTHETIC boundary" },
      boundarySignalIds: unknown("SYNTHETIC: not stated"),
      trafficDirections: unknown("SYNTHETIC: not stated"),
      handover: null,
      status: "incomplete",
      unresolved: ["boundary signals", "traffic directions", "handover"],
    },
  ];
  return d;
}

describe("schema: real-world claims, design choices, boundaries", () => {
  const Claim = realWorldClaim(z.string());

  it("accepts an evidenced claim and an explicit unknown", () => {
    expect(Claim.safeParse({ value: "x", provenance: syn }).success).toBe(true);
    expect(Claim.safeParse(unknown("none")).success).toBe(true);
  });

  it("rejects a value with unknown evidence, and unknown dressed up with a value", () => {
    expect(
      Claim.safeParse({ value: "x", provenance: { evidence: "unknown", sources: [] } }).success,
    ).toBe(false);
    expect(Claim.safeParse({ value: null, provenance: syn }).success).toBe(false);
  });

  it("rejects a real-world claim labelled as a game choice or placeholder", () => {
    for (const evidence of ["simplified", "placeholder"])
      expect(
        Claim.safeParse({ value: "x", provenance: { evidence, sources: [], note: "n" } }).success,
      ).toBe(false);
  });

  it("requires provenance, with sources, for a real-world control-method claim", () => {
    const c = dataset().control!.controlCentres![0]!;
    expect(ControlCentre.safeParse(c).success).toBe(true);
    expect(
      ControlCentre.safeParse({ ...c, controlMethod: { value: "vdu_workstation" } }).success,
    ).toBe(false);
    expect(
      ControlCentre.safeParse({
        ...c,
        controlMethod: {
          value: "vdu_workstation",
          provenance: { evidence: "sourced", sources: [] },
        },
      }).success,
    ).toBe(false);
  });

  it("refuses a game-design choice labelled as a sourced fact", () => {
    const Choice = designChoice(z.string());
    expect(Choice.safeParse(choice("x")).success).toBe(true);
    expect(Choice.safeParse({ ...choice("x"), provenance: syn }).success).toBe(false);
  });

  it("refuses an incomplete boundary that does not say what is unresolved", () => {
    const b = dataset().control!.boundaries[0]!;
    expect(AreaBoundary.safeParse(b).success).toBe(true);
    expect(AreaBoundary.safeParse({ ...b, unresolved: [] }).success).toBe(false);
  });

  it("parses Shrewsbury's control.json unchanged (all new fields are optional)", () => {
    const { input, schemaIssues } = loadDataset("data", "shrewsbury");
    expect(schemaIssues).toEqual([]);
    expect(Control.parse(input!.control).areas.map((a) => a.basis)).toEqual(
      Array(4).fill("real_signal_box"),
    );
  });
});

describe("validation: valid configurations", () => {
  it("accepts the synthetic configuration with explicit unknowns and an incomplete boundary", () => {
    expect(errors(dataset())).toEqual([]);
    expect(codes(dataset())).toEqual(
      expect.arrayContaining(["CONTROL_CENTRE_UNKNOWN", "BOUNDARY_INCOMPLETE"]),
    );
  });

  it("accepts a complete boundary whose facts are evidenced and whose handover is decided", () => {
    const d = dataset();
    Object.assign(d.control!.boundaries[0]!, {
      boundarySignalIds: { value: ["sig2"], provenance: syn, limitations: [] },
      trafficDirections: { value: ["out_of_from_area"], provenance: syn, limitations: [] },
      handover: choice({
        directions: ["out_of_from_area"],
        responsibility: "SYNTHETIC: area-1 offers",
      }),
      status: "complete",
      unresolved: [],
    });
    d.control!.externalAreas![0]!.controlCentre = {
      value: "cc-1",
      provenance: syn,
      limitations: [],
    };
    expect(errors(d)).toEqual([]);
  });

  it("accepts the real Carlisle and Shrewsbury configurations", () => {
    for (const id of ["carlisle", "shrewsbury"]) {
      const { input } = loadDataset("data", id);
      const control = validateDataset(input!).filter(
        (i) =>
          i.severity === "error" &&
          /CONTROL|BOUNDARY|GAME_DESIGN|MISSING_REFERENCE|DUPLICATE_ID/.test(i.code),
      );
      expect(control).toEqual([]);
    }
  });
});

describe("validation: invalid configurations", () => {
  it("rejects duplicate control-area identifiers", () => {
    const d = dataset();
    d.control!.areas.push({ ...d.control!.areas[0]!, signalIds: [], pointsIds: [] });
    expect(errors(d)).toContain("DUPLICATE_ID");
  });

  it("rejects references to unknown platforms, signals, areas, cuts and centres", () => {
    const d = dataset();
    d.control!.areas[0]!.platformIds = ["no-such-platform"];
    d.control!.areas[0]!.controlCentre = { value: "cc-missing", provenance: syn, limitations: [] };
    const b = d.control!.boundaries[0]!;
    b.toAreaId = "ext-missing";
    b.cutId = "cut-missing";
    b.boundarySignalIds = { value: ["sig-missing"], provenance: syn, limitations: [] };
    const missing = validateDataset(d).filter((i) => i.code === "MISSING_REFERENCE");
    expect(missing.map((i) => i.ids?.[1])).toEqual(
      expect.arrayContaining([
        "no-such-platform",
        "cc-missing",
        "ext-missing",
        "cut-missing",
        "sig-missing",
      ]),
    );
  });

  it("rejects inconsistent membership and boundaries", () => {
    let d = dataset();
    d.control!.boundaries[0]!.edgeId = "e3"; // the cut is on e4
    expect(errors(d)).toContain("BOUNDARY_INCONSISTENT");

    d = dataset();
    d.control!.boundaries[0]!.fromAreaId = "ext-1"; // external to external
    expect(errors(d)).toContain("BOUNDARY_INCONSISTENT");

    d = dataset();
    d.control!.areas.push({
      ...d.control!.areas[0]!,
      id: "area-2",
      signalIds: ["sig1"],
      pointsIds: [],
    });
    expect(errors(d)).toContain("CONTROL_OVERLAP");

    // Move the cut so that sig3's branch (P1 -> N3 -> C) lies outside the playable area.
    d = dataset();
    d.playableArea!.cuts[0] = {
      ...d.playableArea!.cuts[0]!,
      edgeId: "e5",
      insideNodeId: "P1",
      outsideNodeId: "N3",
    };
    d.control!.boundaries[0]!.edgeId = "e5";
    const issues = validateDataset(d).filter((i) => i.code === "CONTROL_MEMBERSHIP");
    expect(issues[0]).toMatchObject({ severity: "error", ids: ["area-1", "sig3"] });
  });

  it("warns about elements inside play that no control area operates", () => {
    const d = dataset();
    d.control!.areas[0]!.signalIds = ["sig1"];
    expect(validateDataset(d).find((i) => i.code === "CONTROL_MEMBERSHIP")?.ids).toEqual(
      expect.arrayContaining(["sig2", "sig3"]),
    );
  });

  it("rejects game-design areas labelled as sourced or verified facts", () => {
    const d = dataset();
    d.control!.areas[0]!.provenance = syn;
    d.control!.areas[0]!.membershipProvenance = syn;
    expect(validateDataset(d).filter((i) => i.code === "GAME_DESIGN_AS_FACT")).toHaveLength(2);
  });

  it("rejects unresolved boundaries presented as complete or verified", () => {
    let d = dataset();
    d.control!.boundaries[0]!.status = "complete";
    expect(errors(d)).toContain("BOUNDARY_UNRESOLVED_AS_COMPLETE");

    d = dataset();
    d.control!.boundaries[0]!.provenance = {
      evidence: "verified",
      sources: [{ sourceId: "synthetic-fixture" }, { sourceId: "synthetic-other" }],
    };
    d.sources.sources.push({ ...d.sources.sources[0]!, id: "synthetic-other" });
    expect(errors(d)).toContain("BOUNDARY_UNRESOLVED_AS_COMPLETE");
  });

  it("warns when a playable-area cut has no control boundary", () => {
    const d = dataset();
    d.control!.boundaries = [];
    expect(codes(d)).toContain("BOUNDARY_MISSING");
  });
});
