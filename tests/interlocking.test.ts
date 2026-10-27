/**
 * Interlocking data invariants (R2; docs/DATA_MODEL.md "Interlocking validation", D-024).
 * All layouts, signals, points and routes here are SYNTHETIC: none describes a real railway.
 *
 * Base fixture (fixtures/synthetic/dataset.ts):
 *   A ==e1== N1 ==e2== P1 ==e3== N2 ==e4== B
 *            sig1->     \==e5== N3 ==e6== C
 *   pts1 at P1: normal -> N2, reverse -> N3, so the toe is N1.
 *   r1: sig1 -> sig2 (e2, e3; pts1 normal). r2: sig1 -> sig3 (e2, e5; pts1 reverse).
 */
import { describe, expect, it } from "vitest";
import { syntheticDataset, SYNTHETIC_SOURCE_ID } from "../fixtures/synthetic/dataset.ts";
import { DataSource, OccupancySection, SourceRegistry, type Route } from "../src/model/index.ts";
import { TrackGraph } from "../src/graph/trackGraph.ts";
import { assessInterlocking } from "../src/validation/interlocking.ts";
import { validateDataset, type Issue } from "../src/validation/validate.ts";
import type { ValidationInput } from "../src/validation/validate.ts";
import { readFileSync } from "node:fs";

type Signal = ValidationInput["infrastructure"]["signals"][number];

const syn = (recordId: string) => ({
  evidence: "sourced" as const,
  sources: [{ sourceId: SYNTHETIC_SOURCE_ID, recordId }],
});
const unknown = { evidence: "unknown" as const, sources: [] };

/** Synthetic sources that cannot establish interlocking, standing in for OSM and SMART. */
const NOT_AUTHORITY = ["synthetic-track-layout", "synthetic-movements"];
function dataset(): ValidationInput {
  const d = syntheticDataset();
  const base = d.sources.sources[0]!;
  for (const id of NOT_AUTHORITY)
    d.sources.sources.push({ ...base, id, name: id, interlockingAuthority: false });
  return d;
}

function run(d: ValidationInput) {
  return assessInterlocking(
    d.infrastructure,
    d.signalling,
    d.sources,
    new TrackGraph(d.infrastructure),
  );
}
const status = (d: ValidationInput, id: string) =>
  run(d).assessments.find((a) => a.id === id)?.status;
const issuesFor = (d: ValidationInput, id: string) =>
  run(d).issues.filter((i) => i.ids?.[0] === id);
const codesFor = (d: ValidationInput, id: string) => issuesFor(d, id).map((i) => i.code);
const errorsOf = (issues: Issue[]) => issues.filter((i) => i.severity === "error");

const route = (d: ValidationInput, id: string) => d.signalling!.routes.find((r) => r.id === id)!;
const pts1 = (d: ValidationInput) => d.infrastructure.points[0]!;

function addSignal(d: ValidationInput, id: string, at: string, towards: string | null) {
  const s: Signal = {
    ...d.infrastructure.signals[0]!,
    id,
    ref: id.toUpperCase(),
    trackNodeId: at,
    facingTowardsNodeId: towards
      ? { value: towards, provenance: syn(id) }
      : { value: null, provenance: unknown },
    provenance: syn(id),
  };
  d.infrastructure.signals.push(s);
}

function addTrack(
  d: ValidationInput,
  nodes: [string, string][],
  edges: [string, string, string][],
) {
  for (const [id, kind] of nodes) {
    d.infrastructure.nodes.push({
      id,
      kind: kind as "plain",
      position: { lat: 52.001, lon: -0.99 },
      provenance: syn(id),
    });
  }
  for (const [id, from, to] of edges)
    d.infrastructure.edges.push({ id, from, to, usage: "main", provenance: syn(id) });
}

describe("valid routes stay valid under the stricter checks", () => {
  it("accepts the synthetic routes as evidenced, with no interlocking issues", () => {
    const d = dataset();
    expect(run(d).issues).toEqual([]);
    expect(status(d, "r1")).toBe("evidenced");
    expect(status(d, "r2")).toBe("evidenced");
    expect(errorsOf(validateDataset(d))).toEqual([]);
    expect(validateDataset(d).find((i) => i.code === "INTERLOCKING_STATUS")?.message).toMatch(
      /2 route evidenced.*not a safety case/,
    );
  });

  it("classifies a consistent inferred or simplified route as a game rule, not evidenced", () => {
    for (const evidence of ["inferred", "simplified"] as const) {
      const d = dataset();
      route(d, "r1").provenance = { evidence, sources: [], note: "SYNTHETIC game rule" };
      expect(status(d, "r1")).toBe("game_rule");
      expect(errorsOf(run(d).issues)).toEqual([]);
    }
  });

  it("treats a placeholder route as insufficient evidence", () => {
    const d = dataset();
    route(d, "r1").provenance = { evidence: "placeholder", sources: [], note: "replace" };
    expect(status(d, "r1")).toBe("insufficient_evidence");
  });
});

describe("points and paths (P1-P7)", () => {
  it("P5: rejects a required position that disagrees with the leg taken", () => {
    const d = dataset();
    route(d, "r1").pointsRequired[0]!.position = "reverse";
    expect(codesFor(d, "r1")).toContain("ROUTE_POINTS_MISMATCH");
    expect(status(d, "r1")).toBe("invalid");
  });

  it("P2: rejects a path through points with no required position", () => {
    const d = dataset();
    route(d, "r1").pointsRequired = [];
    const issue = issuesFor(d, "r1").find((i) => i.code === "ROUTE_POINTS_UNSPECIFIED");
    expect(issue?.severity).toBe("error");
    expect(status(d, "r1")).toBe("invalid");
  });

  it("P4: rejects the same points required in both positions", () => {
    const d = dataset();
    route(d, "r1").pointsRequired.push({ pointsId: "pts1", position: "reverse", role: "path" });
    expect(codesFor(d, "r1")).toContain("ROUTE_POINTS_MISMATCH");
  });

  it("P6: an unknown lie is insufficient evidence, never a pass and never invalid", () => {
    const d = dataset();
    pts1(d).normalTowardsNodeId = { value: null, provenance: unknown };
    pts1(d).reverseTowardsNodeId = { value: null, provenance: unknown };
    expect(codesFor(d, "r1")).toEqual(["ROUTE_SWITCH_UNRESOLVED"]);
    expect(status(d, "r1")).toBe("insufficient_evidence");
    expect(status(d, "r2")).toBe("insufficient_evidence");
    expect(errorsOf(run(d).issues)).toEqual([]);
  });

  it("P6: a half-known lie, or a lie labelled unknown, is also unresolved", () => {
    let d = dataset();
    pts1(d).reverseTowardsNodeId = { value: null, provenance: unknown };
    expect(codesFor(d, "r1")).toContain("ROUTE_SWITCH_UNRESOLVED");
    d = dataset();
    pts1(d).normalTowardsNodeId.provenance = unknown;
    expect(status(d, "r1")).toBe("insufficient_evidence");
  });

  it("P7: a lie that is only inferred leaves the route insufficiently evidenced", () => {
    const d = dataset();
    pts1(d).normalTowardsNodeId.provenance = {
      evidence: "inferred",
      sources: [],
      note: "SYNTHETIC: from geometry",
    };
    expect(codesFor(d, "r1")).toContain("ROUTE_DEPENDS_ON_INFERRED");
    expect(status(d, "r1")).toBe("insufficient_evidence");
  });

  it("P5: rejects a path running leg to leg through simple points", () => {
    const d = dataset();
    addSignal(d, "sig4", "N2", "P1");
    d.signalling!.routes.push({
      ...route(d, "r1"),
      id: "r3",
      entrySignalId: "sig4",
      exitSignalId: "sig3",
      edgeIds: ["e3", "e5"],
      pointsRequired: [{ pointsId: "pts1", position: "reverse", role: "path" }],
      conflictsWith: [],
    });
    route(d, "r1").conflictsWith.push("r3");
    route(d, "r2").conflictsWith.push("r3");
    route(d, "r3").conflictsWith = ["r1", "r2"];
    expect(codesFor(d, "r3")).toContain("ROUTE_SWITCH_UNSUPPORTED");
    expect(status(d, "r3")).toBe("invalid");

    // With the lie unknown the same path cannot be proven wrong: insufficient, not invalid.
    pts1(d).normalTowardsNodeId = { value: null, provenance: unknown };
    pts1(d).reverseTowardsNodeId = { value: null, provenance: unknown };
    expect(status(d, "r3")).toBe("insufficient_evidence");
  });

  it("P6: slips, crossings and untyped junctions cannot be checked", () => {
    let d = dataset();
    pts1(d).switchType = "single_slip";
    expect(issuesFor(d, "r1").map((i) => i.message)).toEqual([
      expect.stringMatching(/single_slip points; the passage cannot be checked/),
    ]);
    d = dataset();
    d.infrastructure.nodes.find((n) => n.id === "P1")!.kind = "crossing";
    expect(codesFor(d, "r1")).toEqual(["ROUTE_SWITCH_UNRESOLVED"]);
    d = dataset();
    d.infrastructure.points = [];
    route(d, "r1").pointsRequired = [];
    route(d, "r2").pointsRequired = [];
    expect(issuesFor(d, "r1")[0]!.message).toMatch(/no Points record/);
  });

  it("P3: path points must be on the path, flank points off it", () => {
    let d = dataset();
    route(d, "r1").pointsRequired[0]!.role = "flank";
    expect(codesFor(d, "r1")).toContain("IMPOSSIBLE_ROUTE");
    d = dataset();
    addSignal(d, "sig5", "N2", "N4");
    addSignal(d, "sig6", "N4", "N5");
    addTrack(
      d,
      [
        ["N4", "plain"],
        ["N5", "buffer_stop"],
      ],
      [
        ["e7", "N2", "N4"],
        ["e8", "N4", "N5"],
      ],
    );
    const r3: Route = {
      ...route(d, "r1"),
      id: "r3",
      entrySignalId: "sig5",
      exitSignalId: "sig6",
      edgeIds: ["e7"],
      pointsRequired: [{ pointsId: "pts1", position: "normal", role: "flank" }],
      conflictsWith: [],
    };
    d.signalling!.routes.push(r3);
    // Flank pts1 normal opposes r2's pts1 reverse, so r2 and r3 must be declared conflicting.
    expect(codesFor(d, "r3")).toEqual(["ROUTE_CONFLICT_MISSING"]);
    r3.conflictsWith = ["r2"];
    route(d, "r2").conflictsWith.push("r3");
    expect(codesFor(d, "r3")).toEqual([]);
    expect(status(d, "r3")).toBe("evidenced");
    r3.pointsRequired[0]!.role = "path";
    expect(codesFor(d, "r3")).toContain("IMPOSSIBLE_ROUTE");
  });

  it("P1: rejects a path that visits a node twice", () => {
    const d = dataset();
    route(d, "r1").edgeIds = ["e2", "e3", "e3"];
    expect(issuesFor(d, "r1")[0]!.message).toMatch(/visits a node twice/);
  });

  it("rejects a points lie that names a non-adjacent or repeated node", () => {
    let d = dataset();
    pts1(d).normalTowardsNodeId.value = "A";
    expect(validateDataset(d).find((i) => i.code === "POINTS_LIE_INVALID")?.severity).toBe("error");
    d = dataset();
    pts1(d).reverseTowardsNodeId.value = "N2";
    expect(validateDataset(d).map((i) => i.code)).toContain("POINTS_LIE_INVALID");
  });
});

describe("signals and direction (S1-S5)", () => {
  it("S2: an unknown entry direction is reported and blocks evidenced status", () => {
    const d = dataset();
    d.infrastructure.signals[0]!.facingTowardsNodeId = { value: null, provenance: unknown };
    expect(issuesFor(d, "r1").map((i) => [i.code, i.severity])).toEqual([
      ["ROUTE_DIRECTION_UNKNOWN", "warning"],
    ]);
    expect(status(d, "r1")).toBe("insufficient_evidence");
  });

  it("S3: an unknown exit direction is reported and blocks evidenced status", () => {
    const d = dataset();
    d.infrastructure.signals[1]!.facingTowardsNodeId = { value: null, provenance: unknown };
    expect(issuesFor(d, "r1")[0]!.message).toMatch(/exit signal sig2 is unknown/);
    expect(status(d, "r1")).toBe("insufficient_evidence");
  });

  it("S3: rejects an exit signal that faces back along the route", () => {
    const d = dataset();
    d.infrastructure.signals[1]!.facingTowardsNodeId.value = "P1";
    expect(issuesFor(d, "r1")[0]!.message).toMatch(/exit signal sig2 faces back/);
    expect(status(d, "r1")).toBe("invalid");
  });

  it("S2: rejects an entry signal facing away from the path", () => {
    const d = dataset();
    d.infrastructure.signals[0]!.facingTowardsNodeId.value = "A";
    expect(issuesFor(d, "r1")[0]!.message).toMatch(/entry signal sig1 faces the other way/);
  });

  it("S1: rejects a route that starts and ends at the same signal", () => {
    const d = dataset();
    route(d, "r1").exitSignalId = "sig1";
    expect(issuesFor(d, "r1")[0]!.message).toMatch(/same signal/);
  });

  it("S5: reads directions only from the infrastructure, not from movement evidence", () => {
    // assessInterlocking takes no signal-evidence input, so SMART-derived assessments cannot
    // supply or confirm a direction. An unknown direction stays unknown.
    expect(assessInterlocking.length).toBe(4);
  });
});

describe("conflicting routes (C1-C4)", () => {
  it("C2: rejects an asymmetric declaration", () => {
    const d = dataset();
    route(d, "r2").conflictsWith = [];
    expect(codesFor(d, "r1")).toEqual(["ROUTE_CONFLICT_ASYMMETRIC"]);
  });

  it("C3: requires a declared conflict for shared track and opposed points", () => {
    const d = dataset();
    route(d, "r1").conflictsWith = [];
    route(d, "r2").conflictsWith = [];
    const msg = issuesFor(d, "r1").find((i) => i.code === "ROUTE_CONFLICT_MISSING")!.message;
    expect(msg).toMatch(/share track e2/);
    expect(msg).toMatch(/require points pts1 normal and reverse/);
    expect(status(d, "r2")).toBe("invalid");
  });

  it("C3: derives a conflict from opposed points alone (flank against path)", () => {
    const d = dataset();
    addSignal(d, "sig5", "N2", "N4");
    addSignal(d, "sig6", "N4", "N5");
    addTrack(
      d,
      [
        ["N4", "plain"],
        ["N5", "buffer_stop"],
      ],
      [
        ["e7", "N2", "N4"],
        ["e8", "N4", "N5"],
      ],
    );
    d.signalling!.routes.push({
      ...route(d, "r1"),
      id: "r3",
      entrySignalId: "sig5",
      exitSignalId: "sig6",
      edgeIds: ["e7"],
      pointsRequired: [{ pointsId: "pts1", position: "reverse", role: "flank" }],
      conflictsWith: [],
    });
    expect(issuesFor(d, "r3").map((i) => i.message)).toEqual([
      expect.stringMatching(/routes r1 and r3 require points pts1 normal and reverse/),
    ]);
    // r2 also requires pts1 reverse: no conflict is derived between r2 and r3.
    expect(codesFor(d, "r2")).toEqual([]);
  });

  it("C1: rejects a self-conflict", () => {
    const d = dataset();
    route(d, "r1").conflictsWith.push("r1");
    expect(codesFor(d, "r1")).toContain("ROUTE_CONFLICT_INVALID");
  });

  it("C4: routes crossing at a diamond are reported as undetermined, not compatible", () => {
    const d = dataset();
    d.signalling!.routes = [];
    addTrack(
      d,
      [
        ["W", "plain"],
        ["E", "plain"],
        ["NN", "plain"],
        ["S", "plain"],
        ["X", "crossing"],
        ["W0", "buffer_stop"],
        ["E0", "buffer_stop"],
        ["N0", "buffer_stop"],
        ["S0", "buffer_stop"],
      ],
      [
        ["x1", "W", "X"],
        ["x2", "X", "E"],
        ["x3", "NN", "X"],
        ["x4", "X", "S"],
        ["x5", "W0", "W"],
        ["x6", "E", "E0"],
        ["x7", "N0", "NN"],
        ["x8", "S", "S0"],
      ],
    );
    addSignal(d, "sw", "W", "X");
    addSignal(d, "se", "E", "E0");
    addSignal(d, "sn", "NN", "X");
    addSignal(d, "ss", "S", "S0");
    const base = { ref: null, pointsRequired: [], overlapId: null, provenance: syn("rx") };
    d.signalling!.routes.push(
      {
        ...base,
        id: "rA",
        entrySignalId: "sw",
        exitSignalId: "se",
        edgeIds: ["x1", "x2"],
        conflictsWith: [],
      },
      {
        ...base,
        id: "rB",
        entrySignalId: "sn",
        exitSignalId: "ss",
        edgeIds: ["x3", "x4"],
        conflictsWith: [],
      },
    );
    expect(codesFor(d, "rA")).toEqual(["ROUTE_SWITCH_UNRESOLVED", "ROUTE_CONFLICT_UNDETERMINED"]);
    expect(status(d, "rA")).toBe("insufficient_evidence");
    // Declaring the conflict removes the undetermined finding; the diamond itself stays unchecked.
    route(d, "rA").conflictsWith = ["rB"];
    route(d, "rB").conflictsWith = ["rA"];
    expect(codesFor(d, "rA")).toEqual(["ROUTE_SWITCH_UNRESOLVED"]);
  });
});

describe("overlaps (O1-O3)", () => {
  /** o1 for sig2 runs on beyond it, e4 towards B. */
  function withOverlap(edgeIds: string[], signalId = "sig2") {
    const d = dataset();
    d.signalling!.overlaps.push({
      id: "o1",
      signalId,
      edgeIds,
      pointsRequired: [],
      provenance: syn("o1"),
    });
    route(d, "r1").overlapId = "o1";
    return d;
  }

  it("accepts an overlap that continues beyond the exit signal", () => {
    const d = withOverlap(["e4"]);
    expect(run(d).issues).toEqual([]);
    expect(status(d, "o1")).toBe("evidenced");
    expect(status(d, "r1")).toBe("evidenced");
  });

  it("S4/O2: rejects an overlap running behind its signal", () => {
    const d = withOverlap(["e3"]);
    expect(issuesFor(d, "o1")[0]!.message).toMatch(/behind signal sig2/);
    expect(codesFor(d, "r1")).toContain("IMPOSSIBLE_ROUTE"); // doubles back over e3
    expect(status(d, "r1")).toBe("invalid");
  });

  it("O1: checks point requirements on the overlap path", () => {
    // An overlap for sig1 through pts1 towards N2 (normal).
    const d = withOverlap(["e2", "e3"], "sig1");
    route(d, "r1").overlapId = null;
    expect(codesFor(d, "o1")).toEqual(["ROUTE_POINTS_UNSPECIFIED"]);
    d.signalling!.overlaps[0]!.pointsRequired = [
      { pointsId: "pts1", position: "reverse", role: "path" },
    ];
    expect(codesFor(d, "o1")).toEqual(["ROUTE_POINTS_MISMATCH"]);
    d.signalling!.overlaps[0]!.pointsRequired[0]!.position = "normal";
    expect(status(d, "o1")).toBe("evidenced");
  });

  it("O3: an overlap over points with an unknown lie is incomplete, not invalid", () => {
    const d = withOverlap(["e2", "e3"], "sig1");
    route(d, "r1").overlapId = null;
    d.signalling!.overlaps[0]!.pointsRequired = [
      { pointsId: "pts1", position: "normal", role: "path" },
    ];
    pts1(d).normalTowardsNodeId = { value: null, provenance: unknown };
    pts1(d).reverseTowardsNodeId = { value: null, provenance: unknown };
    expect(status(d, "o1")).toBe("insufficient_evidence");
    expect(errorsOf(issuesFor(d, "o1"))).toEqual([]);
  });

  it("a route is no better established than its overlap", () => {
    const d = withOverlap(["e4"]);
    d.infrastructure.signals[1]!.facingTowardsNodeId = { value: null, provenance: unknown };
    expect(status(d, "o1")).toBe("insufficient_evidence");
    expect(status(d, "r1")).toBe("insufficient_evidence");
  });
});

describe("provenance (E1, E2)", () => {
  it("rejects a sourced route backed only by a track-layout source", () => {
    const d = dataset();
    route(d, "r1").provenance = { evidence: "sourced", sources: [{ sourceId: NOT_AUTHORITY[0]! }] };
    expect(codesFor(d, "r1")).toEqual(["INTERLOCKING_SOURCE_UNSUITABLE"]);
    expect(status(d, "r1")).toBe("invalid");
  });

  it("rejects a route 'verified' by track layout plus train movements", () => {
    const d = dataset();
    route(d, "r1").provenance = {
      evidence: "verified",
      sources: NOT_AUTHORITY.map((sourceId) => ({ sourceId })),
    };
    expect(codesFor(d, "r1")).toEqual(["INTERLOCKING_SOURCE_UNSUITABLE"]);
  });

  it("requires two interlocking sources for verified, not one plus a map", () => {
    const d = dataset();
    route(d, "r1").provenance = {
      evidence: "verified",
      sources: [{ sourceId: SYNTHETIC_SOURCE_ID }, { sourceId: NOT_AUTHORITY[0]! }],
    };
    expect(codesFor(d, "r1")).toEqual(["INTERLOCKING_SOURCE_UNSUITABLE"]);
  });

  it("applies the same rule to overlaps", () => {
    const d = dataset();
    d.signalling!.overlaps.push({
      id: "o1",
      signalId: "sig2",
      edgeIds: ["e4"],
      pointsRequired: [],
      provenance: { evidence: "sourced", sources: [{ sourceId: NOT_AUTHORITY[1]! }] },
    });
    expect(codesFor(d, "o1")).toEqual(["INTERLOCKING_SOURCE_UNSUITABLE"]);
  });

  it("E2: an inferred route may start from track layout and stays a game rule", () => {
    const d = dataset();
    route(d, "r1").provenance = {
      evidence: "inferred",
      sources: [{ sourceId: NOT_AUTHORITY[0]! }],
      note: "SYNTHETIC: route drawn from the track layout",
    };
    expect(codesFor(d, "r1")).toEqual([]);
    expect(status(d, "r1")).toBe("game_rule");
  });

  it("no registered real source can establish interlocking yet", () => {
    const reg = SourceRegistry.parse(JSON.parse(readFileSync("data/sources.json", "utf8")));
    expect(reg.sources.filter((s) => s.interlockingAuthority)).toEqual([]);
    expect(DataSource.shape.interlockingAuthority.parse(undefined)).toBe(false);
  });
});

describe("simulated occupancy (audit M3)", () => {
  const section = (kind: string, evidence: string) => ({
    id: "os1",
    ref: null,
    kind,
    edgeIds: ["e1"],
    provenance: { evidence, sources: [{ sourceId: "synthetic-fixture" }], note: "why" },
  });

  it("rejects a simulated section labelled sourced or verified", () => {
    expect(OccupancySection.safeParse(section("simulated", "sourced")).success).toBe(false);
    expect(OccupancySection.safeParse(section("simulated", "unknown")).success).toBe(false);
  });

  it("accepts a simulated section labelled inferred, placeholder or simplified", () => {
    for (const ev of ["inferred", "placeholder", "simplified"])
      expect(OccupancySection.safeParse(section("simulated", ev)).success).toBe(true);
  });

  it("keeps real section kinds out of the simplified label", () => {
    expect(OccupancySection.safeParse(section("track_circuit", "simplified")).success).toBe(false);
    expect(OccupancySection.safeParse(section("track_circuit", "sourced")).success).toBe(true);
  });
});
