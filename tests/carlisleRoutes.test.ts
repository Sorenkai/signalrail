/**
 * Carlisle MVP route set (P1, DECISION_LOG D-030), with the Caldew Jn goods-line route (P6,
 * D-036; its movement and conflicts are tested in carlisleGoods.test.ts), on the committed dataset:
 * data/datasets/carlisle/{infrastructure,playable-area,control,signalling,game-rules}.json.
 * The local-only, git-ignored signal-evidence.json is dropped after loading, so these tests
 * run on a fresh clone.
 *
 * The routes are GAME routes labelled `simplified`: a small playable model built on OSM track,
 * signals and directions, with game-rule points lies. They are not Carlisle Power Signal Box's
 * routes, and passing these tests does not show that any real interlocking is safe.
 *
 * Test-only routes below are built in memory to probe the rules and are never written to data.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadDataset } from "../src/data/loadDataset.ts";
import { TrackGraph } from "../src/graph/trackGraph.ts";
import { DirectedTrack } from "../src/graph/directedTrack.ts";
import { assessInterlocking } from "../src/validation/interlocking.ts";
import { resolveGameRules } from "../src/validation/gameRules.ts";
import { validateDataset, type ValidationInput } from "../src/validation/validate.ts";
import type { Route } from "../src/model/index.ts";
import {
  CommandStore,
  DEFAULT_POLICY,
  createWorld,
  initialState,
  type Command,
} from "../src/sim/index.ts";

/** A fresh copy of the committed Carlisle inputs, without local-only signal evidence. */
function carlisle(): ValidationInput {
  const { input, schemaIssues } = loadDataset("data", "carlisle");
  expect(schemaIssues).toEqual([]);
  const d = structuredClone(input!);
  delete d.signalEvidence;
  return d;
}
const base = carlisle();
const infra = base.infrastructure;
const routes = base.signalling!.routes;
const rules = base.gameRules!;
const graph = new TrackGraph(infra);
const signalRef = (id: string | null) =>
  id === null ? null : infra.signals.find((s) => s.id === id)!.ref;

function assess(d: ValidationInput) {
  const g = new TrackGraph(d.infrastructure);
  const r = resolveGameRules(d.infrastructure, g, d.gameRules, d.playableArea);
  return {
    ruleIssues: r.issues,
    ...assessInterlocking(d.infrastructure, d.signalling, d.sources, g, r.context),
  };
}
const statusOf = (d: ValidationInput, id: string) =>
  assess(d).assessments.find((a) => a.id === id)?.status;
const issuesOf = (d: ValidationInput, id: string) =>
  assess(d).issues.filter((i) => i.ids?.[0] === id);

/** Start and end node of a route: a signal's node, or a fringe endpoint's outside node. */
function ends(r: Route) {
  const cut = (f: string | undefined) => {
    const e = rules.fringeEndpoints.find((x) => x.id === f)!;
    return base.playableArea!.cuts.find((c) => c.id === e.cutId)!;
  };
  const node = (s: string | null) => infra.signals.find((x) => x.id === s)!.trackNodeId!;
  return {
    start: r.entrySignalId ? node(r.entrySignalId) : cut(r.entryFringeId).outsideNodeId,
    end: r.exitSignalId ? node(r.exitSignalId) : cut(r.exitFringeId).outsideNodeId,
  };
}
const walk = (r: Route) => {
  const w = graph.walk(ends(r).start, r.edgeIds);
  if (!w.ok) throw new Error(w.reason);
  return w.nodes;
};

/**
 * The route set, one line per route, with why it is in the MVP. Changing, adding or removing
 * a route must update this table and D-030 (P1) or D-036 (P6) together.
 */
const EXPECTED = [
  // Down Main, northbound. Entry from Penrith (WCML south) to the first northbound main signal.
  "rt-dm-fringe-ce264: fringe fr-wcml-south-down -> CE264 | 1 edges | -",
  // Plain Down Main running between consecutive northbound main signals.
  "rt-dm-ce264-ce272: CE264 -> CE272 | 3 edges | osm-pts10288162",
  "rt-dm-ce272-ce286: CE272 -> CE286 | 8 edges | osm-pts13520521846 osm-pts7261456040",
  // Through Carlisle South Jn (straight across a single slip) and platform 3.
  "rt-dm-ce286-ce323: CE286 -> CE323 | 11 edges | osm-pts1460504014 osm-pts3057659452 osm-pts3057659457 osm-pts10288170 osm-pts7185463926",
  // Through Carlisle North Jn (straight across a single slip) to the north gameplay cut.
  "rt-dm-ce323-fringe: CE323 -> fringe fr-north-down-main | 15 edges | osm-pts10288175 osm-pts7253833743 osm-pts3720819849 osm-pts13520580930 osm-pts2464246583 osm-pts2464246608 osm-pts2464246628",
  // (P6, D-036) As above to Caldew Jn, then the Up & Down Goods and the Down Goods to the north cut.
  "rt-dg-ce323-fringe: CE323 -> fringe fr-north-down-goods | 15 edges | osm-pts10288175 osm-pts7253833743 osm-pts3720819849 osm-pts13520580930 osm-pts2464246583 osm-pts2464246608 osm-pts2464246595",
  // Up Main, southbound. Entry from the north to the first southbound main signal.
  "rt-um-fringe-ce336: fringe fr-north-up-main -> CE336 | 7 edges | osm-pts2464246609 osm-pts2464246616",
  // Through platform 4 to CE304; the Up Main south of CE304 is blocked (D-030 omissions).
  "rt-um-ce336-ce304: CE336 -> CE304 | 8 edges | osm-pts13520580929 osm-pts1460409471 osm-pts2464251373",
];
/**
 * Fingerprint of every route and game rule as parsed (ids, edges, requirements, provenance).
 * Any edit to signalling.json or game-rules.json changes it; update it deliberately.
 */
const FINGERPRINT = "76b2de3b08c2c567"; // P6 (D-036): goods route, its rule and fringe; P1 value 972bbde888b20d7b

describe("Carlisle MVP route set: identity and regression", () => {
  it("is exactly the documented set", () => {
    const summary = routes.map((r) => {
      const from = r.entrySignalId ? signalRef(r.entrySignalId) : `fringe ${r.entryFringeId}`;
      const to = r.exitSignalId ? signalRef(r.exitSignalId) : `fringe ${r.exitFringeId}`;
      const pts = r.pointsRequired.map((p) => p.pointsId).join(" ") || "-";
      return `${r.id}: ${from} -> ${to} | ${r.edgeIds.length} edges | ${pts}`;
    });
    expect(summary).toEqual(EXPECTED);
    expect(base.signalling!.overlaps).toEqual([]);
  });

  it("matches the recorded fingerprint", () => {
    const hash = createHash("sha256")
      .update(JSON.stringify({ routes, points: rules.points, fringes: rules.fringeEndpoints }))
      .digest("hex")
      .slice(0, 16);
    expect(hash).toBe(FINGERPRINT);
  });

  it("has unique ids, no duplicate paths, and one rule per points, each used by a route", () => {
    expect(new Set(routes.map((r) => r.id)).size).toBe(routes.length);
    const paths = routes.map((r) => `${ends(r).start}|${r.edgeIds.join(",")}`);
    expect(new Set(paths).size).toBe(routes.length);
    const ruled = rules.points.map((p) => p.pointsId);
    expect(new Set(ruled).size).toBe(ruled.length);
    const required = new Set(routes.flatMap((r) => r.pointsRequired.map((p) => p.pointsId)));
    // No rule exists that no route needs: nothing outside the route set is silently resolved.
    expect([...required].sort()).toEqual([...ruled].sort());
    const fringesUsed = routes.flatMap((r) => [r.entryFringeId, r.exitFringeId]).filter(Boolean);
    expect([...fringesUsed].sort()).toEqual(rules.fringeEndpoints.map((f) => f.id).sort());
  });
});

describe("endpoints and connectivity", () => {
  it("starts and ends at main signals facing along the route, or at configured fringe endpoints", () => {
    for (const r of routes) {
      const nodes = walk(r);
      for (const [sid, next] of [
        [r.entrySignalId, nodes[1]],
        [r.exitSignalId, null],
      ] as const) {
        if (sid === null) continue;
        const s = infra.signals.find((x) => x.id === sid)!;
        expect(s.function, `${r.id} ${s.ref}`).toBe("main");
        expect(s.facingTowardsNodeId.provenance.evidence).toBe("sourced");
        if (next) expect(s.facingTowardsNodeId.value).toBe(next);
        else expect(s.facingTowardsNodeId.value).not.toBe(nodes.at(-2));
      }
      expect(nodes.at(-1)).toBe(ends(r).end);
    }
  });

  it("crosses the cut edge at every fringe end", () => {
    for (const r of routes) {
      const cutOf = (f: string) =>
        base.playableArea!.cuts.find(
          (c) => c.id === rules.fringeEndpoints.find((x) => x.id === f)!.cutId,
        )!;
      if (r.entryFringeId) expect(r.edgeIds[0]).toBe(cutOf(r.entryFringeId).edgeId);
      if (r.exitFringeId) expect(r.edgeIds.at(-1)).toBe(cutOf(r.exitFringeId).edgeId);
    }
  });

  it("passes only plain track, simple switches and slips, never an unresolved junction", () => {
    for (const r of routes) {
      const nodes = walk(r);
      for (const n of nodes.slice(1, -1)) {
        const cls = graph.junction(n).cls;
        expect(["plain", "switch", "single_slip"], `${r.id} at ${n}`).toContain(cls);
      }
    }
  });

  it("keeps every element inside the one proposed control area", () => {
    const area = base.control!.areas.find((a) => a.id === "carlisle-ws-1")!;
    for (const r of routes) {
      for (const s of [r.entrySignalId, r.exitSignalId]) if (s) expect(area.signalIds).toContain(s);
      for (const p of r.pointsRequired) expect(area.pointsIds).toContain(p.pointsId);
    }
    for (const f of rules.fringeEndpoints) {
      const b = base.control!.boundaries.find((x) => x.cutId === f.cutId)!;
      expect(b.fromAreaId).toBe("carlisle-ws-1");
      // The boundary's real-world facts stay unknown: no boundary signal was invented.
      expect(b.boundarySignalIds?.value).toBeNull();
    }
  });
});

describe("points passages: explicit game rules only", () => {
  const dt = new DirectedTrack(infra);

  it("every switch or slip passed has a valid rule, and the passage is set in the required position", () => {
    const { context } = resolveGameRules(infra, graph, rules, base.playableArea);
    expect(context.points.size).toBe(rules.points.length);
    for (const r of routes) {
      const nodes = walk(r);
      for (let i = 1; i < nodes.length - 1; i++) {
        const j = graph.junction(nodes[i]!);
        if (j.cls === "plain") continue;
        const passage = graph.switchPassage(
          nodes[i - 1]!,
          nodes[i]!,
          nodes[i + 1]!,
          context.points,
        );
        expect(passage, `${r.id} at ${nodes[i]}`).toMatchObject({
          status: "set",
          evidence: "simplified",
        });
        const req = r.pointsRequired.find((q) => q.pointsId === j.points!.id)!;
        expect(req.role).toBe("path");
        expect(passage.status === "set" && passage.position).toBe(req.position);
        // Without the game rule the same passage is unresolved: OSM alone cannot support it.
        expect(graph.switchPassage(nodes[i - 1]!, nodes[i]!, nodes[i + 1]!).status).toBe(
          "unresolved",
        );
      }
    }
  });

  it("orients every simple rule as the I-004 heuristic does, and the route never runs leg to leg", () => {
    for (const rule of rules.points) {
      if (rule.switchType !== "simple") continue;
      const node = infra.points.find((p) => p.id === rule.pointsId)!.trackNodeId;
      const toe = graph
        .neighbours(node)
        .find((n) => n !== rule.normalTowardsNodeId && n !== rule.reverseTowardsNodeId)!;
      // Toe to either leg is a movement under I-004 (rule "legs"); leg to leg is not.
      expect(dt.passes(toe, node, rule.normalTowardsNodeId), rule.pointsId).toBe(true);
      expect(dt.passes(toe, node, rule.reverseTowardsNodeId), rule.pointsId).toBe(true);
      expect(dt.passes(rule.normalTowardsNodeId, node, rule.reverseTowardsNodeId)).toBe(false);
      expect(dt.passes(rule.reverseTowardsNodeId, node, rule.normalTowardsNodeId)).toBe(false);
    }
  });

  it("permits only the straight-across movement at each slip, never a diagonal", () => {
    const { context } = resolveGameRules(infra, graph, rules, base.playableArea);
    for (const rule of rules.points) {
      if (rule.switchType === "simple") continue;
      expect(rule.switchType).toBe("single_slip");
      expect(rule.passages).toHaveLength(1);
      const node = infra.points.find((p) => p.id === rule.pointsId)!.trackNodeId;
      const [a, b] = rule.passages[0]!.between;
      expect(dt.passes(a, node, b)).toBe(true); // I-004: straight across
      expect(dt.passes(b, node, a)).toBe(true);
      for (const x of graph.neighbours(node))
        for (const y of graph.neighbours(node)) {
          if (x === y || (x === a && y === b) || (x === b && y === a)) continue;
          expect(graph.switchPassage(x, node, y, context.points).status, `${x}>${y}`).toBe(
            "unresolved",
          );
        }
    }
    for (const r of routes) {
      const nodes = walk(r);
      expect(
        dt.singleSlipDiagonalsUsed({ nodes, distanceM: 0, basis: "geometric_heuristic" }),
      ).toEqual([]);
    }
  });

  it("leaves the configured points unknown in the source-derived infrastructure", () => {
    for (const rule of rules.points) {
      const p = infra.points.find((x) => x.id === rule.pointsId)!;
      expect(p.normalTowardsNodeId).toMatchObject({
        value: null,
        provenance: { evidence: "unknown" },
      });
      expect(p.reverseTowardsNodeId).toMatchObject({
        value: null,
        provenance: { evidence: "unknown" },
      });
      expect(p.switchType).toBe(rule.switchType === "simple" ? "unknown" : rule.switchType);
    }
  });
});

describe("evidence labelling", () => {
  it("labels every route and rule simplified, and every route is a game rule, never evidenced", () => {
    for (const x of [...routes, ...rules.points, ...rules.fringeEndpoints])
      expect(x.provenance.evidence).toBe("simplified");
    const { assessments, issues } = assess(base);
    expect(assessments.map((a) => a.status)).toEqual(routes.map(() => "game_rule"));
    const flagged = issues.filter((i) => i.code === "ROUTE_USES_GAME_RULE").map((i) => i.ids![0]);
    expect(flagged).toEqual(routes.map((r) => r.id));
  });

  it("validates the whole dataset with no errors and reports the simplifications", () => {
    const issues = validateDataset(base);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    const simplified = issues.filter((i) => i.code === "SIMPLIFIED_DATA").map((i) => i.message);
    expect(simplified).toContain(
      `${routes.length} deliberate game simplification(s) at signalling.routes (not real-world behaviour)`,
    );
    expect(simplified).toContain(
      `${rules.points.length} deliberate game simplification(s) at gameRules.points (not real-world behaviour)`,
    );
  });
});

describe("conflicts", () => {
  /** (P6, D-036) The only pair of routes sharing anything: both start at CE323. */
  const SHARING = ["rt-dg-ce323-fringe", "rt-dm-ce323-fringe"];

  it("declares the one sharing pair conflicting both ways; every other pair shares nothing", () => {
    const junctions = (r: Route) =>
      walk(r)
        .slice(1, -1)
        .filter((n) => graph.junction(n).cls !== "plain");
    for (let i = 0; i < routes.length; i++)
      for (let k = i + 1; k < routes.length; k++) {
        const [a, b] = [routes[i]!, routes[k]!];
        const edges = a.edgeIds.filter((e) => b.edgeIds.includes(e));
        const pa = a.pointsRequired.map((p) => p.pointsId);
        const pts = b.pointsRequired.filter((p) => pa.includes(p.pointsId));
        const nodes = junctions(a).filter((n) => junctions(b).includes(n));
        if (SHARING.includes(a.id) && SHARING.includes(b.id)) {
          expect(edges).toHaveLength(10);
          expect(pts.map((p) => p.pointsId)).toHaveLength(6);
          expect(nodes.length).toBeGreaterThan(0);
          expect(a.conflictsWith).toEqual([b.id]);
          expect(b.conflictsWith).toEqual([a.id]);
          // Opposed at the goods-line switch: the Down Main needs it normal, the goods reverse.
          const at = (r: Route) =>
            r.pointsRequired.find((p) => p.pointsId === "osm-pts2464246608")!.position;
          expect([at(a), at(b)].sort()).toEqual(["normal", "reverse"]);
        } else {
          expect([edges, pts, nodes], `${a.id} / ${b.id}`).toEqual([[], [], []]);
        }
      }
    for (const r of routes) if (!SHARING.includes(r.id)) expect(r.conflictsWith).toEqual([]);
  });

  it("makes the shared pair invalid if either conflict declaration is dropped", () => {
    for (const id of SHARING) {
      const d = carlisle();
      d.signalling!.routes.find((r) => r.id === id)!.conflictsWith = [];
      const codes = assess(d).issues.map((i) => i.code);
      expect(codes, id).toContain("ROUTE_CONFLICT_ASYMMETRIC");
    }
    const d = carlisle();
    for (const id of SHARING) d.signalling!.routes.find((r) => r.id === id)!.conflictsWith = [];
    expect(statusOf(d, "rt-dg-ce323-fringe")).toBe("invalid");
    expect(statusOf(d, "rt-dm-ce323-fringe")).toBe("invalid");
  });

  it("would require a declared conflict for any route sharing track (test-only route)", () => {
    const d = carlisle();
    const twin: Route = { ...structuredClone(d.signalling!.routes[1]!), id: "test-only-twin" };
    d.signalling!.routes.push(twin);
    const missing = issuesOf(d, "test-only-twin").filter(
      (i) => i.code === "ROUTE_CONFLICT_MISSING",
    );
    expect(missing[0]?.message).toMatch(/share track .* but are not declared conflicting/);
    expect(statusOf(d, "test-only-twin")).toBe("invalid");
  });
});

describe("authoritative pipeline on the real route set", () => {
  function session(d: ValidationInput = carlisle()) {
    const world = createWorld(
      {
        infrastructure: d.infrastructure,
        signalling: d.signalling!,
        control: d.control!,
        sources: d.sources,
        gameRules: d.gameRules!,
        playableArea: d.playableArea!,
      },
      DEFAULT_POLICY,
      { "op-1": ["carlisle-ws-1"] },
    );
    const clear = Object.fromEntries(d.infrastructure.edges.map((e) => [e.id, "clear" as const]));
    const normal = Object.fromEntries(
      d.gameRules!.points.map((p) => [p.pointsId, { position: "normal" as const, detected: true }]),
    );
    const store = new CommandStore(
      world,
      initialState(world, { occupancy: clear, points: normal }),
    );
    let n = 0;
    const submit = (command: Command) =>
      store.submit({
        commandId: `c${++n}`,
        operator: { kind: "ai", id: "op-1" },
        controlAreaId: "carlisle-ws-1",
        expectedVersion: store.view().version,
        command,
      });
    return { store, submit };
  }
  const setR = (routeId: string): Command => ({ type: "set_route", routeId });

  it("sets every MVP route once its points are proven, clearing only real entry signals", () => {
    const { store, submit } = session();
    // All points normal: every route but the goods route (osm-pts2464246608 reverse, and in
    // conflict with rt-dm-ce323-fringe from the same signal) can be set together.
    const mvp = routes.filter((r) => r.id !== "rt-dg-ce323-fringe");
    for (const r of mvp) expect(submit(setR(r.id)), r.id).toMatchObject({ outcome: "accepted" });
    expect(submit(setR("rt-dg-ce323-fringe"))).toMatchObject({ outcome: "rejected" });
    const off = Object.entries(store.view().signals)
      .filter(([, a]) => a === "off")
      .map(([s]) => s);
    expect(off.sort()).toEqual(
      mvp.flatMap((r) => (r.entrySignalId ? [r.entrySignalId] : [])).sort(),
    );
  });

  it("locks a set route's points, and refuses a route whose points lie the wrong way or are unproven", () => {
    const { submit } = session();
    expect(
      submit({ type: "move_points", pointsId: "osm-pts10288162", position: "reverse" }),
    ).toMatchObject({ outcome: "accepted" });
    expect(submit(setR("rt-dm-ce264-ce272"))).toMatchObject({ code: "POINTS_WRONG_POSITION" });
    expect(
      submit({ type: "move_points", pointsId: "osm-pts10288162", position: "normal" }),
    ).toMatchObject({ outcome: "accepted" });
    expect(submit(setR("rt-dm-ce264-ce272"))).toMatchObject({ outcome: "accepted" });
    expect(
      submit({ type: "move_points", pointsId: "osm-pts10288162", position: "reverse" }),
    ).toMatchObject({ code: "POINTS_LOCKED" });
    expect(submit(setR("rt-dm-ce264-ce272"))).toMatchObject({ code: "ROUTE_ALREADY_SET" });
  });

  it("refuses the second of two conflicting routes (test-only declared conflict)", () => {
    const d = carlisle();
    const twin: Route = {
      ...structuredClone(d.signalling!.routes[1]!),
      id: "test-only-twin",
      conflictsWith: ["rt-dm-ce264-ce272"],
    };
    d.signalling!.routes[1]!.conflictsWith = ["test-only-twin"];
    d.signalling!.routes.push(twin);
    expect(statusOf(d, "test-only-twin")).toBe("game_rule");
    const { submit } = session(d);
    expect(submit(setR("rt-dm-ce264-ce272"))).toMatchObject({ outcome: "accepted" });
    expect(submit(setR("test-only-twin"))).toMatchObject({ code: "ROUTE_CONFLICT" });
  });

  it("refuses a route once its game rule is removed", () => {
    const d = carlisle();
    d.gameRules!.points = d.gameRules!.points.filter((p) => p.pointsId !== "osm-pts10288162");
    expect(statusOf(d, "rt-dm-ce264-ce272")).toBe("insufficient_evidence");
    expect(session(d).submit(setR("rt-dm-ce264-ce272"))).toMatchObject({
      code: "ROUTE_NOT_ESTABLISHED",
    });
  });
});

describe("unsupported movements stay rejected, with diagnostics", () => {
  it("keeps an inferred-only lie insufficient", () => {
    const d = carlisle();
    d.gameRules!.points = d.gameRules!.points.filter((p) => p.pointsId !== "osm-pts10288162");
    const p = d.infrastructure.points.find((x) => x.id === "osm-pts10288162")!;
    const inferred = { evidence: "inferred" as const, sources: [], note: "TEST-ONLY reasoning" };
    p.switchType = "simple";
    p.normalTowardsNodeId = { value: "osm-n13956027902", provenance: inferred };
    p.reverseTowardsNodeId = { value: "osm-n7683158456", provenance: inferred };
    expect(statusOf(d, "rt-dm-ce264-ce272")).toBe("insufficient_evidence");
    expect(issuesOf(d, "rt-dm-ce264-ce272").map((i) => i.code)).toContain(
      "ROUTE_DEPENDS_ON_INFERRED",
    );
  });

  it("reports the omitted Up Main route CE304 -> CE285 as unresolved at the untyped junctions and the diamond", () => {
    const d = carlisle();
    const sig = (ref: string) => d.infrastructure.signals.find((s) => s.ref === ref)!.id;
    d.signalling!.routes.push({
      id: "test-only-um-ce304-ce285",
      ref: null,
      entrySignalId: sig("CE304"),
      exitSignalId: sig("CE285"),
      // The Up Main between them, as mapped in OSM (D-030 omissions).
      edgeIds: [
        "osm-w262069383-3",
        "osm-w238574859-0",
        "osm-w238574861-0",
        "osm-w238574861-1",
        "osm-w238574861-2",
        "osm-w238574861-3",
        "osm-w238574861-4",
        "osm-w238574861-5",
        "osm-w238574861-6",
        "osm-w238574860-0",
      ],
      pointsRequired: [],
      overlapId: null,
      conflictsWith: [],
      provenance: {
        evidence: "simplified",
        sources: [],
        note: "TEST-ONLY probe of an omitted route",
      },
    });
    const messages = issuesOf(d, "test-only-um-ce304-ce285").map((i) => `${i.code}: ${i.message}`);
    for (const node of ["osm-n2464365978", "osm-n13915496837", "osm-n3057659458"])
      expect(
        messages.some((m) => m.startsWith("ROUTE_SWITCH_UNRESOLVED") && m.includes(node)),
        node,
      ).toBe(true);
    expect(statusOf(d, "test-only-um-ce304-ce285")).not.toBe("game_rule");
  });

  it("names the break in a disconnected route", () => {
    const d = carlisle();
    const r = d.signalling!.routes.find((x) => x.id === "rt-dm-ce272-ce286")!;
    r.edgeIds.splice(3, 1);
    expect(statusOf(d, r.id)).toBe("invalid");
    expect(issuesOf(d, r.id)[0]!.message).toMatch(/IMPOSSIBLE|does not continue from node/);
  });
});
