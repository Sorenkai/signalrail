/**
 * Game-rule interlocking layer (P0, D-029): simplified points configuration and fringe
 * endpoints. Every layout, rule and route here is SYNTHETIC (fixtures/synthetic/gameRules.ts):
 *
 *   A ==e1== N1 ==e2== P1 ==e3== N2 ==e4== B   (cut-b on e4)
 *            sig1->     \==e5== N3 ==e6== C
 *   pts1 lie UNKNOWN in infrastructure; game rule: normal -> N2, reverse -> N3.
 *   r1 sig1->sig2, r2 sig1->sig3, r3 sig1->fringe fr-b, r4 fringe fr-b->sig4.
 *
 * Passing these tests shows the data rules hold; it says nothing about any real interlocking.
 */
import { describe, expect, it } from "vitest";
import { syntheticGameRuleDataset, simplified } from "../fixtures/synthetic/gameRules.ts";
import { SYNTHETIC_SOURCE_ID } from "../fixtures/synthetic/dataset.ts";
import { GameRules, Route, type Infrastructure, type Points } from "../src/model/index.ts";
import { TrackGraph } from "../src/graph/trackGraph.ts";
import { assessInterlocking } from "../src/validation/interlocking.ts";
import { resolveGameRules } from "../src/validation/gameRules.ts";
import {
  summariseEvidence,
  validateDataset,
  type ValidationInput,
} from "../src/validation/validate.ts";
import { loadDataset } from "../src/data/loadDataset.ts";
import {
  CommandStore,
  DEFAULT_POLICY,
  createWorld,
  initialState,
  type Command,
} from "../src/sim/index.ts";

const syn = { evidence: "sourced" as const, sources: [{ sourceId: SYNTHETIC_SOURCE_ID }] };
const unknown = { evidence: "unknown" as const, sources: [] };

function assess(d: ValidationInput) {
  const graph = new TrackGraph(d.infrastructure);
  const rules = resolveGameRules(d.infrastructure, graph, d.gameRules, d.playableArea);
  const il = assessInterlocking(d.infrastructure, d.signalling, d.sources, graph, rules.context);
  return { ruleIssues: rules.issues, context: rules.context, ...il };
}
const status = (d: ValidationInput, id: string) =>
  assess(d).assessments.find((a) => a.id === id)?.status;
const codesFor = (d: ValidationInput, id: string) => {
  const a = assess(d);
  return [...a.ruleIssues, ...a.issues].filter((i) => i.ids?.[0] === id).map((i) => i.code);
};
const errorCodes = (d: ValidationInput) =>
  validateDataset(d)
    .filter((i) => i.severity === "error")
    .map((i) => i.code);
const route = (d: ValidationInput, id: string) => d.signalling!.routes.find((r) => r.id === id)!;
const pointsRule = (d: ValidationInput) => d.gameRules!.points[0]!;
const pts1 = (d: ValidationInput) => d.infrastructure.points[0]!;

/** The simulation, with every edge proven clear and pts1 detected normal. */
function sim(d: ValidationInput, assignments = { "op-1": ["area-1"] }) {
  const world = createWorld(
    {
      infrastructure: d.infrastructure,
      signalling: d.signalling!,
      control: d.control!,
      sources: d.sources,
      ...(d.gameRules ? { gameRules: d.gameRules } : {}),
      ...(d.playableArea ? { playableArea: d.playableArea } : {}),
    },
    DEFAULT_POLICY,
    assignments,
  );
  const clear = Object.fromEntries(d.infrastructure.edges.map((e) => [e.id, "clear" as const]));
  const state = initialState(world, {
    occupancy: clear,
    points: { pts1: { position: "normal", detected: true } },
  });
  const store = new CommandStore(world, state);
  let n = 0;
  const submit = (command: Command, area = "area-1", op = "op-1") =>
    store.submit({
      commandId: `c${++n}`,
      operator: { kind: "human", id: op },
      controlAreaId: area,
      expectedVersion: store.view().version,
      command,
    });
  return { world, store, submit };
}
const setR = (routeId: string): Command => ({ type: "set_route", routeId });

describe("1. an authored, consistent simplified points configuration", () => {
  it("lets routes over unknown real points be game rules, and the dataset validates cleanly", () => {
    const d = syntheticGameRuleDataset();
    expect(status(d, "r1")).toBe("game_rule");
    expect(status(d, "r2")).toBe("game_rule");
    expect(codesFor(d, "r1")).toContain("ROUTE_USES_GAME_RULE");
    expect(errorCodes(d)).toEqual([]);
  });

  it("lets the simulation clear such a route once the points are proven", () => {
    const { store, submit } = sim(syntheticGameRuleDataset());
    expect(submit(setR("r1"))).toMatchObject({ outcome: "accepted" });
    expect(store.view().signals.sig1).toBe("off");
  });
});

describe("2. missing or unknown points configuration", () => {
  it("leaves the route insufficiently evidenced, and the simulation refuses it", () => {
    const d = syntheticGameRuleDataset();
    d.gameRules!.points = [];
    expect(status(d, "r1")).toBe("insufficient_evidence");
    expect(codesFor(d, "r1")).toContain("ROUTE_SWITCH_UNRESOLVED");
    expect(sim(d).submit(setR("r1"))).toMatchObject({ code: "ROUTE_NOT_ESTABLISHED" });
  });

  it("treats a dataset with no game-rules file the same way", () => {
    const d = syntheticGameRuleDataset();
    delete d.gameRules;
    expect(status(d, "r1")).toBe("insufficient_evidence");
  });

  it("ignores an invalid rule rather than half-using it", () => {
    const d = syntheticGameRuleDataset();
    const rule = pointsRule(d);
    if (rule.switchType === "simple") rule.reverseTowardsNodeId = "A"; // not adjacent to P1
    expect(codesFor(d, "pts1")).toContain("GAME_RULE_POINTS_INVALID");
    expect(status(d, "r1")).toBe("insufficient_evidence");
    expect(sim(d).submit(setR("r1"))).toMatchObject({ code: "ROUTE_NOT_ESTABLISHED" });
  });
});

describe("3. an inferred lie", () => {
  it("remains insufficient evidence", () => {
    const d = syntheticGameRuleDataset();
    d.gameRules!.points = [];
    const inferred = { evidence: "inferred" as const, sources: [], note: "SYNTHETIC reasoning" };
    pts1(d).switchType = "simple";
    pts1(d).normalTowardsNodeId = { value: "N2", provenance: inferred };
    pts1(d).reverseTowardsNodeId = { value: "N3", provenance: inferred };
    expect(status(d, "r1")).toBe("insufficient_evidence");
    expect(codesFor(d, "r1")).toContain("ROUTE_DEPENDS_ON_INFERRED");
  });

  it("cannot be overridden by a game rule, which is refused and unused", () => {
    const d = syntheticGameRuleDataset();
    const inferred = { evidence: "inferred" as const, sources: [], note: "SYNTHETIC reasoning" };
    pts1(d).normalTowardsNodeId = { value: "N2", provenance: inferred };
    pts1(d).reverseTowardsNodeId = { value: "N3", provenance: inferred };
    expect(codesFor(d, "pts1")).toContain("GAME_RULE_CONFLICTS_WITH_SOURCE");
    expect(status(d, "r1")).toBe("insufficient_evidence");
  });
});

describe("4. simplified configuration is never mistaken for sourced infrastructure", () => {
  it("is only accepted when labelled simplified", () => {
    const base = syntheticGameRuleDataset().gameRules!;
    for (const provenance of [syn, { evidence: "inferred", sources: [], note: "x" }, unknown]) {
      const bad = { ...base, points: [{ ...base.points[0]!, provenance }] };
      expect(GameRules.safeParse(bad).success).toBe(false);
    }
    expect(GameRules.safeParse(base).success).toBe(true);
  });

  it("leaves the infrastructure's points record untouched and unknown", () => {
    const d = syntheticGameRuleDataset();
    const before = structuredClone(pts1(d));
    validateDataset(d);
    const { world } = sim(d);
    expect(pts1(d)).toEqual(before);
    expect(world.infrastructure.points[0]!.normalTowardsNodeId.provenance.evidence).toBe("unknown");
  });

  it("reports a game-rule passage as simplified, and counts it under gameRules", () => {
    const d = syntheticGameRuleDataset();
    const { context } = assess(d);
    const g = new TrackGraph(d.infrastructure);
    expect(g.switchPassage("N1", "P1", "N2", context.points)).toMatchObject({
      status: "set",
      position: "normal",
      evidence: "simplified",
    });
    expect(g.switchPassage("N1", "P1", "N2").status).toBe("unresolved");
    expect(summariseEvidence(d).byCollection["gameRules.points"]).toMatchObject({
      simplified: 1,
      sourced: 0,
    });
    const simplifiedData = validateDataset(d).filter((i) => i.code === "SIMPLIFIED_DATA");
    // Regression (found in P1): points rules have no `id`, and were reported as 0 owners.
    const points = simplifiedData.find((i) => i.message.includes("at gameRules.points"));
    expect(points?.message).toMatch(/^1 deliberate game simplification/);
    expect(points?.ids).toEqual(["pts1"]);
  });

  it("never yields evidenced, even for a route labelled sourced from an interlocking source", () => {
    const d = syntheticGameRuleDataset();
    route(d, "r1").provenance = syn;
    expect(status(d, "r1")).toBe("game_rule");
  });

  it("does not use a simplified lie placed in infrastructure, and reports it as an error", () => {
    const d = syntheticGameRuleDataset();
    d.gameRules!.points = [];
    pts1(d).normalTowardsNodeId = { value: "N2", provenance: simplified("misplaced") };
    pts1(d).reverseTowardsNodeId = { value: "N3", provenance: simplified("misplaced") };
    expect(errorCodes(d)).toContain("SIMPLIFIED_IN_SOURCE_LAYER");
    expect(status(d, "r1")).toBe("insufficient_evidence");
  });
});

describe("5. invalid switch configurations and incompatible movements", () => {
  const ruleCase = (name: string, edit: (d: ValidationInput) => void, code: string) =>
    it(name, () => {
      const d = syntheticGameRuleDataset();
      edit(d);
      expect(codesFor(d, "pts1")).toContain(code);
      expect(errorCodes(d)).toContain(code);
      expect(status(d, "r1")).not.toBe("game_rule");
    });

  ruleCase(
    "rejects normal and reverse naming the same node",
    (d) => {
      const r = pointsRule(d);
      if (r.switchType === "simple") r.reverseTowardsNodeId = "N2";
    },
    "GAME_RULE_POINTS_INVALID",
  );
  ruleCase(
    "rejects a simple rule on points the source types as a slip",
    (d) => {
      pts1(d).switchType = "single_slip";
    },
    "GAME_RULE_POINTS_INVALID",
  );
  ruleCase(
    "rejects a slip rule that does not match the sourced type",
    (d) => {
      d.gameRules!.points = [
        {
          pointsId: "pts1",
          switchType: "double_slip",
          passages: [{ between: ["N1", "N2"], position: "normal" }],
          provenance: simplified("x"),
        },
      ];
    },
    "GAME_RULE_POINTS_INVALID",
  );
  ruleCase(
    "rejects points configured twice",
    (d) => {
      d.gameRules!.points.push(structuredClone(pointsRule(d)));
    },
    "GAME_RULE_POINTS_INVALID",
  );
  ruleCase(
    "rejects a rule for points whose lie the source states",
    (d) => {
      pts1(d).normalTowardsNodeId = { value: "N2", provenance: syn };
      pts1(d).reverseTowardsNodeId = { value: "N3", provenance: syn };
    },
    "GAME_RULE_CONFLICTS_WITH_SOURCE",
  );

  it("rejects a rule for unknown points", () => {
    const d = syntheticGameRuleDataset();
    pointsRule(d).pointsId = "nowhere";
    expect(errorCodes(d)).toContain("MISSING_REFERENCE");
  });

  it("rejects a route needing the other position from the one its path takes", () => {
    const d = syntheticGameRuleDataset();
    route(d, "r1").pointsRequired = [{ pointsId: "pts1", position: "reverse", role: "path" }];
    expect(status(d, "r1")).toBe("invalid");
    expect(codesFor(d, "r1")).toContain("ROUTE_POINTS_MISMATCH");
  });

  it("rejects a path running leg to leg through game-rule points", () => {
    const d = syntheticGameRuleDataset();
    d.infrastructure.signals.push({
      ...d.infrastructure.signals[0]!,
      id: "sig5",
      ref: "SIG5",
      trackNodeId: "N2",
      facingTowardsNodeId: { value: "P1", provenance: syn },
    });
    d.signalling!.routes.push({
      ...route(d, "r1"),
      id: "r5",
      entrySignalId: "sig5",
      exitSignalId: "sig3",
      edgeIds: ["e3", "e5"],
      conflictsWith: [],
    });
    expect(status(d, "r5")).toBe("invalid");
    expect(codesFor(d, "r5")).toContain("ROUTE_SWITCH_UNSUPPORTED");
  });

  it("still requires a points requirement on the path", () => {
    const d = syntheticGameRuleDataset();
    route(d, "r1").pointsRequired = [];
    expect(codesFor(d, "r1")).toContain("ROUTE_POINTS_UNSPECIFIED");
    expect(status(d, "r1")).toBe("invalid");
  });

  it("still requires declared conflicts between game-rule routes", () => {
    const d = syntheticGameRuleDataset();
    route(d, "r1").conflictsWith = ["r3"];
    route(d, "r2").conflictsWith = ["r3"];
    expect(codesFor(d, "r1")).toContain("ROUTE_CONFLICT_MISSING");
  });
});

describe("6. configured fringe endpoints", () => {
  it("let routes enter and leave play without any boundary signal", () => {
    const d = syntheticGameRuleDataset();
    const signals = d.infrastructure.signals.length;
    expect(status(d, "r3")).toBe("game_rule");
    expect(status(d, "r4")).toBe("game_rule");
    expect(errorCodes(d)).toEqual([]);
    // Nothing is fabricated: no signal added, the boundary's real signals stay unknown.
    expect(d.infrastructure.signals.length).toBe(signals);
    expect(d.control!.boundaries[0]!.boundarySignalIds?.provenance.evidence).toBe("unknown");
  });

  it("can be set by the area owning the boundary at that cut; a fringe entry clears no signal", () => {
    const { store, submit } = sim(syntheticGameRuleDataset());
    const signalsBefore = store.view().signals;
    expect(submit(setR("r4"))).toMatchObject({ outcome: "accepted" });
    expect(store.view().signals).toEqual(signalsBefore);
    expect(submit({ type: "cancel_route", routeId: "r4" })).toMatchObject({
      outcome: "accepted",
    });
    expect(submit(setR("r3"))).toMatchObject({ outcome: "accepted" });
    expect(store.view().signals.sig1).toBe("off");
  });

  it("keeps the usual safety checks: r3 and r4 share the cut edge and conflict", () => {
    const { submit } = sim(syntheticGameRuleDataset());
    expect(submit(setR("r3"))).toMatchObject({ outcome: "accepted" });
    expect(submit(setR("r4"))).toMatchObject({ code: "ROUTE_CONFLICT" });
  });
});

describe("7. missing, invalid or unconfigured fringe endpoints", () => {
  it("rejects a route naming an unknown endpoint", () => {
    const d = syntheticGameRuleDataset();
    route(d, "r4").entryFringeId = "fr-nowhere";
    expect(status(d, "r4")).toBe("invalid");
    expect(codesFor(d, "r4")).toContain("FRINGE_ENDPOINT_INVALID");
  });

  it("rejects an endpoint on an unknown cut, and every route using it", () => {
    const d = syntheticGameRuleDataset();
    d.gameRules!.fringeEndpoints[0]!.cutId = "cut-nowhere";
    expect(codesFor(d, "fr-b")).toContain("FRINGE_ENDPOINT_INVALID");
    expect(status(d, "r3")).toBe("invalid");
    expect(status(d, "r4")).toBe("invalid");
    // Authority is checked first, and an invalid endpoint belongs to no area; the route's
    // invalid status would refuse it next (ROUTE_NOT_ESTABLISHED). Either way, nothing changes.
    const { store, submit } = sim(d);
    expect(submit(setR("r4"))).toMatchObject({ outcome: "rejected", code: "NOT_AUTHORISED" });
    expect(store.view().version).toBe(0);
  });

  it("rejects an endpoint when the dataset has no playable area", () => {
    const d = syntheticGameRuleDataset();
    delete d.playableArea;
    expect(codesFor(d, "fr-b")).toContain("FRINGE_ENDPOINT_INVALID");
    expect(status(d, "r4")).toBe("invalid");
  });

  it("rejects an endpoint used in a direction it is not configured for", () => {
    const d = syntheticGameRuleDataset();
    d.gameRules!.fringeEndpoints[0]!.use = ["exit"];
    expect(status(d, "r4")).toBe("invalid");
    expect(status(d, "r3")).toBe("game_rule");
  });

  it("rejects a fringe route that does not cross the cut edge", () => {
    const d = syntheticGameRuleDataset();
    const r = route(d, "r3");
    r.edgeIds = ["e2", "e3"]; // ends at N2, inside play
    expect(status(d, "r3")).toBe("invalid");
    expect(codesFor(d, "r3")).toContain("IMPOSSIBLE_ROUTE");
  });

  it("is refused by the schema without exactly one start and one end, or with an overlap", () => {
    const base = route(syntheticGameRuleDataset(), "r3");
    expect(Route.safeParse(base).success).toBe(true);
    expect(Route.safeParse({ ...base, entrySignalId: null }).success).toBe(false);
    expect(Route.safeParse({ ...base, exitFringeId: undefined }).success).toBe(false);
    expect(Route.safeParse({ ...base, exitSignalId: "sig2" }).success).toBe(false);
    expect(Route.safeParse({ ...base, entrySignalId: null, entryFringeId: "fr-b" }).success).toBe(
      false,
    );
    expect(Route.safeParse({ ...base, overlapId: "ov-1" }).success).toBe(false);
  });

  it("refuses an operator whose area has no boundary at that cut", () => {
    const d = syntheticGameRuleDataset();
    d.control!.boundaries = [];
    expect(sim(d).submit(setR("r4"))).toMatchObject({ code: "NOT_AUTHORISED" });
  });
});

/**
 * SYNTHETIC slip layout: W0 - W1 - X - E1 - E0 and W2 - X - E2 - E3 (buffers at the ends).
 * X is a single slip (sourced type, unknown lie). sW at W1 faces X; sE at E1 faces E0; sE2
 * at E2 faces E3. Straight: sW -> sE (W1-X-E1). Diagonal: sW -> sE2 (W1-X-E2).
 */
function slipDataset(passages: [string, string, "normal" | "reverse"][] | null): ValidationInput {
  const d = syntheticGameRuleDataset();
  const node = (id: string, kind: Infrastructure["nodes"][number]["kind"]) => ({
    id,
    kind,
    position: { lat: 52.01, lon: -0.99 },
    provenance: syn,
  });
  d.infrastructure.nodes.push(
    ...(["W0", "E0", "W2", "E3"] as const).map((id) => node(id, "buffer_stop")),
    ...(["W1", "E1", "E2"] as const).map((id) => node(id, "plain")),
    node("X", "switch"),
  );
  for (const [id, from, to] of [
    ["s1", "W0", "W1"],
    ["s2", "W1", "X"],
    ["s3", "X", "E1"],
    ["s4", "E1", "E0"],
    ["s5", "W2", "X"],
    ["s6", "X", "E2"],
    ["s7", "E2", "E3"],
  ] as const)
    d.infrastructure.edges.push({ id, from, to, usage: "main", provenance: syn });
  const slip: Points = {
    id: "ptsX",
    ref: null,
    trackNodeId: "X",
    switchType: "single_slip",
    normalTowardsNodeId: { value: null, provenance: unknown },
    reverseTowardsNodeId: { value: null, provenance: unknown },
    provenance: syn,
  };
  d.infrastructure.points.push(slip);
  for (const [id, at, towards] of [
    ["sW", "W1", "X"],
    ["sE", "E1", "E0"],
    ["sE2", "E2", "E3"],
  ] as const)
    d.infrastructure.signals.push({
      ...d.infrastructure.signals[0]!,
      id,
      ref: id,
      trackNodeId: at,
      facingTowardsNodeId: { value: towards, provenance: syn },
    });
  const slipRoute = (
    id: string,
    exit: string,
    edges: string[],
    position: "normal" | "reverse",
  ) => ({
    id,
    ref: null,
    entrySignalId: "sW",
    exitSignalId: exit,
    edgeIds: edges,
    pointsRequired: [{ pointsId: "ptsX", position, role: "path" as const }],
    overlapId: null,
    conflictsWith: [id === "rs" ? "rd" : "rs"],
    provenance: simplified(`slip route ${id}`),
  });
  d.signalling!.routes.push(
    slipRoute("rs", "sE", ["s2", "s3"], "normal"),
    slipRoute("rd", "sE2", ["s2", "s6"], "reverse"),
  );
  if (passages)
    d.gameRules!.points.push({
      pointsId: "ptsX",
      switchType: "single_slip",
      passages: passages.map(([a, b, position]) => ({ between: [a, b], position })),
      provenance: simplified("slip passages; which diagonal the real slip has is unknown"),
    });
  return d;
}

describe("slips: no movement is assumed (D-021)", () => {
  it("leaves both straight and diagonal unresolved without a rule", () => {
    const d = slipDataset(null);
    expect(status(d, "rs")).toBe("insufficient_evidence");
    expect(status(d, "rd")).toBe("insufficient_evidence");
  });

  it("permits exactly the movements a rule lists; an unlisted diagonal stays unresolved", () => {
    const d = slipDataset([
      ["W1", "E1", "normal"],
      ["W2", "E2", "normal"],
    ]);
    expect(status(d, "rs")).toBe("game_rule");
    expect(status(d, "rd")).toBe("insufficient_evidence");
    expect(codesFor(d, "rd")).toContain("ROUTE_SWITCH_UNRESOLVED");
  });

  it("permits the diagonal once a rule defines it, with its own position", () => {
    const d = slipDataset([
      ["W1", "E1", "normal"],
      ["W1", "E2", "reverse"],
    ]);
    expect(status(d, "rd")).toBe("game_rule");
    route(d, "rd").pointsRequired = [{ pointsId: "ptsX", position: "normal", role: "path" }];
    expect(codesFor(d, "rd")).toContain("ROUTE_POINTS_MISMATCH");
  });

  it("rejects passages that name non-adjacent nodes, repeat, or exceed the slip's count", () => {
    for (const passages of [
      [["W0", "E1", "normal"]],
      [
        ["W1", "E1", "normal"],
        ["E1", "W1", "reverse"],
      ],
      [
        ["W1", "E1", "normal"],
        ["W2", "E2", "normal"],
        ["W1", "E2", "reverse"],
        ["W2", "E1", "reverse"],
      ],
    ] as [string, string, "normal" | "reverse"][][]) {
      const d = slipDataset(passages);
      expect(codesFor(d, "ptsX")).toContain("GAME_RULE_POINTS_INVALID");
      expect(status(d, "rs")).toBe("insufficient_evidence");
    }
  });

  it("does not assume two undeclared routes across a slip are compatible", () => {
    const d = slipDataset([
      ["W1", "E1", "normal"],
      ["W2", "E2", "normal"],
    ]);
    // rx runs the other straight (W2-X-E2): it shares slip X with rs but no edge.
    d.infrastructure.signals.push({
      ...d.infrastructure.signals[0]!,
      id: "sW2",
      ref: "sW2",
      trackNodeId: "W2",
      facingTowardsNodeId: { value: "X", provenance: syn },
    });
    d.signalling!.routes.push({
      ...route(d, "rs"),
      id: "rx",
      entrySignalId: "sW2",
      exitSignalId: "sE2",
      edgeIds: ["s5", "s6"],
      conflictsWith: ["rd"],
    });
    route(d, "rd").conflictsWith = ["rs", "rx"];
    expect(codesFor(d, "rx")).toContain("ROUTE_CONFLICT_UNDETERMINED");
    expect(status(d, "rx")).toBe("insufficient_evidence");
  });
});

describe("9. a dataset without signalling.json", () => {
  it("gets an informational result, not an error", () => {
    const d = syntheticGameRuleDataset();
    delete d.signalling;
    const absent = validateDataset(d).filter((i) => i.code === "SIGNALLING_ABSENT");
    expect(absent).toHaveLength(1);
    expect(absent[0]!.severity).toBe("info");
    expect(errorCodes(d)).toEqual([]);
  });

  it("is not reported when signalling is present", () => {
    const codes = validateDataset(syntheticGameRuleDataset()).map((i) => i.code);
    expect(codes).not.toContain("SIGNALLING_ABSENT");
  });
});

describe("10. real datasets (committed inputs)", () => {
  // P0 checked Carlisle before it had signalling (SIGNALLING_ABSENT). Since P1 (D-030) it has
  // the MVP route set and its game rules; tests/carlisleRoutes.test.ts covers them in detail.
  it("Carlisle loads its signalling and game rules, and still has no errors", () => {
    const { input, schemaIssues } = loadDataset("data", "carlisle");
    expect(schemaIssues).toEqual([]);
    expect(input!.signalling).toBeDefined();
    expect(input!.gameRules).toBeDefined();
    const issues = validateDataset(input!);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(issues.map((i) => i.code)).not.toContain("SIGNALLING_ABSENT");
  });

  it("Shrewsbury has signalling, so no new result, and still has no errors", () => {
    const { input } = loadDataset("data", "shrewsbury");
    const issues = validateDataset(input!);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(issues.map((i) => i.code)).not.toContain("SIGNALLING_ABSENT");
  });
});
