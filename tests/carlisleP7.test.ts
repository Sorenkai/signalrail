/**
 * P7 (DECISION_LOG D-037): Carlisle infrastructure evidence and route recovery, on committed
 * files only (the local-only signal-evidence.json is dropped).
 *
 * - The P7 coverage report (docs/pilots/carlisle-p7-*.json) is what the tool produces today, and
 *   exactly the ten Kingmoor-yard goods workings change class against the P6 baseline.
 * - The Kingmoor handover rests on mapped topology beyond the north goods cut and on control.json
 *   leading that cut into the deferred area; take either away and the patterns fail closed.
 * - Points on a junction whose legs the data does not fully map can never be worked.
 * - The evidence gaps P7 could not close still block: unknown signal functions, untyped junctions,
 *   diamonds and the platform 1 two-edge switch.
 *
 * The routes are simplified game routes and the operator is a test script; nothing here claims
 * how Carlisle PSB or the Kingmoor yards work.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadDataset } from "../src/data/loadDataset.ts";
import { DirectedTrack } from "../src/graph/directedTrack.ts";
import { TrackGraph } from "../src/graph/trackGraph.ts";
import type { Control, TimetableSnapshot } from "../src/model/index.ts";
import { MovementGroupsFile, auditCoverage } from "../src/reconcile/timetableCoverage.ts";
import {
  CommandStore,
  DEFAULT_POLICY,
  createWorld,
  initialState,
  replay,
  routeSignalIssues,
  serviceIssues,
  stateTrainIssues,
  timetableSessionConfig,
  type Command,
  type SimInput,
} from "../src/sim/index.ts";
import { resolveGameRules } from "../src/validation/gameRules.ts";
import { deferredAreaCuts, validateServicePatterns } from "../src/validation/servicePatterns.ts";

const { input } = loadDataset("data", "carlisle");
const d = structuredClone(input!);
delete d.signalEvidence;
const snapshot = d.timetables!.find((t) => t.date === "2026-11-04")!;
const P6_PATTERNS = ["pat-down-wcml-through-p3", "pat-down-wcml-p3-caldew-goods"];
const KGMR_PATTERNS = [
  "pat-down-wcml-p3-goods-kgmr-up-yard-ends",
  "pat-down-wcml-p3-goods-kgmr-down-yard-ends",
  "pat-down-wcml-p3-goods-kgmr-down-yard-florstn",
  "pat-down-wcml-p3-goods-kgmr-up-yard-florstn",
];
const GOODS_CHAIN = [
  "rt-dm-fringe-ce264",
  "rt-dm-ce264-ce272",
  "rt-dm-ce272-ce286",
  "rt-dm-ce286-ce323",
  "rt-dg-ce323-fringe",
];

function world(o: { patternIds?: string[]; snapshot?: TimetableSnapshot; control?: Control } = {}) {
  const patterns = structuredClone(d.servicePatterns!);
  if (o.patternIds)
    patterns.patterns = patterns.patterns.filter((p) => o.patternIds!.includes(p.id));
  return createWorld(
    {
      infrastructure: d.infrastructure,
      signalling: d.signalling!,
      control: o.control ?? d.control!,
      sources: d.sources,
      gameRules: d.gameRules!,
      playableArea: d.playableArea!,
      timetable: {
        snapshot: o.snapshot ?? snapshot,
        patterns,
        config: timetableSessionConfig("2026-11-04"),
      },
    },
    DEFAULT_POLICY,
    { "op-h": ["carlisle-ws-1"], "op-ai": ["carlisle-ws-1"] },
  );
}

const table = MovementGroupsFile.parse(
  JSON.parse(readFileSync("docs/pilots/carlisle-p7-movement-groups.json", "utf8")),
);
const committed = JSON.parse(readFileSync("docs/pilots/carlisle-p7-coverage.json", "utf8"));
const p7 = auditCoverage(world().timetable!, snapshot, table);
const p6 = auditCoverage(world({ patternIds: P6_PATTERNS }).timetable!, snapshot, table);

/** The ten workings of the P6 group kingmoor-via-p3-goods, by service id (CIF DFROC1F). */
const KGMR_SERVICES = [
  ["H01259:2026-11-04", "0C50", "representable"],
  ["H41962:2026-11-03", "6C37", "representable"],
  ["H41964:2026-11-03", "6C37", "representable"],
  ["H41999:2026-11-04", "4C32", "approximated"],
  ["H42002:2026-11-03", "4C31", "representable"],
  ["H50015:2026-11-03", "6X77", "approximated"],
  ["H50093:2026-11-04", "4S77", "approximated"],
  ["H50097:2026-11-03", "6C01", "representable"],
  ["H50099:2026-11-03", "6C04", "representable"],
  ["H50115:2026-11-03", "6M00", "representable"],
];

describe("P7 coverage audit (2026-11-04)", () => {
  it("puts every service in one group, and no runnable service in a blocked group", () => {
    expect(p7.total).toBe(381);
    expect(p7.unmatched).toEqual([]);
    expect(p7.inconsistent).toEqual([]);
    expect(p7.groups.find((g) => g.id === "unclassified")!.services).toBe(0);
    expect(p7.groups.find((g) => g.id === "kingmoor-via-p3-goods")!.services).toBe(0);
  });

  it("matches the committed P7 report", () => {
    expect(committed.patterns).toEqual([...P6_PATTERNS, ...KGMR_PATTERNS]);
    expect(committed.baseline.patterns).toEqual(P6_PATTERNS);
    expect(committed.current.byClass).toEqual(p7.byClass);
    expect(committed.baseline.byClass).toEqual(p6.byClass);
    expect(committed.byFamily).toEqual(p7.byFamily);
    expect(committed.baselineByFamily).toEqual(p6.byFamily);
    expect(committed.groups).toEqual(p7.groups);
    expect(committed.services).toEqual(p7.services);
    expect(committed.blockers).toEqual(table.blockers);
  });

  it("changes exactly the ten Kingmoor-yard goods workings, all from NO_PATTERN", () => {
    expect(p6.byClass).toEqual({
      representable: 3,
      approximated: 52,
      unsupported: 326,
      invalid: 0,
    });
    expect(p7.byClass).toEqual({
      representable: 10,
      approximated: 55,
      unsupported: 316,
      invalid: 0,
    });
    const changed = p7.services.filter((s) => {
      const b = p6.services.find((x) => x.serviceId === s.serviceId)!;
      return b.classification !== s.classification;
    });
    expect(changed.map((s) => [s.serviceId, s.headcode, s.classification])).toEqual(KGMR_SERVICES);
    for (const s of changed) {
      expect(s.groupId).toBe("kingmoor-yard-goods");
      expect(KGMR_PATTERNS).toContain(s.patternId);
      expect(p6.services.find((x) => x.serviceId === s.serviceId)).toMatchObject({
        classification: "unsupported",
        reasons: ["NO_PATTERN"],
        groupId: "kingmoor-via-p3-goods",
      });
    }
    // Every other service keeps its P6 class and group. Three platform 1 Kingmoor workings now
    // share a P7 pattern's timing points, so their reason narrows from NO_PATTERN to the
    // platform 3 check they fail; no stricter check reclassified any service.
    const reasonOnly: string[][] = [];
    for (const s of p7.services.filter((x) => !changed.includes(x))) {
      const b = p6.services.find((x) => x.serviceId === s.serviceId)!;
      expect([s.classification, s.groupId], s.serviceId).toEqual([b.classification, b.groupId]);
      if (s.reasons.join() !== b.reasons.join())
        reasonOnly.push([s.serviceId, s.headcode!, `${b.reasons.join()} -> ${s.reasons.join()}`]);
    }
    expect(reasonOnly).toEqual([
      ["H57305:2026-11-04", "0C17", "NO_PATTERN -> PATTERN_FIELD_MISMATCH"],
      ["W32422:2026-11-04", "4S43", "NO_PATTERN -> PATTERN_FIELD_MISMATCH"],
      ["W32435:2026-11-04", "6C02", "NO_PATTERN -> PATTERN_FIELD_MISMATCH"],
    ]);
    for (const [id] of reasonOnly)
      expect(p7.services.find((x) => x.serviceId === id)!.observedPath).toMatch(/CARLILE\(1\)/);
  });

  it("leaves every other family as P6 left it", () => {
    const unsupported = Object.fromEntries(
      Object.entries(p7.byFamily).map(([f, c]) => [f, c.unsupported]),
    );
    expect(unsupported).toEqual({
      down_main: 0,
      up_main: 72,
      platform_1: 21,
      goods_line: 0,
      other_lines: 3,
      kingmoor: 59,
      internal_start_termination: 159,
      unresolved: 2,
    });
  });
});

describe("Kingmoor-yard handover at the north goods cut (D-037)", () => {
  const cuts = new Map(d.playableArea!.cuts.map((c) => [c.id, c]));
  const inside = new Set(d.playableArea!.cuts.map((c) => c.insideNodeId));
  /** Edge usages reachable beyond a cut without re-entering play (I-004 "legs" heuristic). */
  const beyond = (cutId: string) => {
    const dt = new DirectedTrack(d.infrastructure, "legs");
    const cut = cuts.get(cutId)!;
    const edges = new Map(d.infrastructure.edges.map((e) => [e.id, e]));
    const usages = new Set<string>();
    let reentered = false;
    const seen = new Set<string>();
    const queue = [{ node: cut.outsideNodeId, via: cut.edgeId }];
    while (queue.length > 0) {
      const { node, via } = queue.shift()!;
      if (seen.has(`${node}|${via}`)) continue;
      seen.add(`${node}|${via}`);
      if (inside.has(node)) {
        reentered = true;
        continue;
      }
      usages.add(edges.get(via)!.usage);
      // `exits` is private: this test reads the heuristic exactly as reconciliation does.
      for (const x of (
        dt as unknown as { exits(n: string, v: string): { edge: string; to: string }[] }
      ).exits(node, via))
        queue.push({ node: x.to, via: x.edge });
    }
    return { usages, reentered };
  };

  it("finds the Kingmoor yard tracks beyond the Down Goods cut, and none beyond the Down Main cut", () => {
    const goods = beyond("cut-north-down-goods");
    expect(goods.reentered).toBe(false);
    expect(goods.usages).toContain("yard");
    expect(goods.usages).toContain("siding");
    const main = beyond("cut-north-down-main");
    expect(main.reentered).toBe(false);
    expect([...main.usages]).toEqual(["main"]);
    // The Down Main beyond the cut runs to the extract edge (an area_boundary), nothing else.
    const g = new TrackGraph(d.infrastructure);
    const run = g.plainRun("osm-n11954024792", "osm-n3866898355")!;
    expect(run.kind).toBe("area_boundary");
  });

  it("leads every north cut into the deferred Kingmoor area and no other cut", () => {
    expect([...deferredAreaCuts(d.control)].sort()).toEqual([
      "cut-north-down-goods",
      "cut-north-down-main",
      "cut-north-up-goods",
      "cut-north-up-main",
    ]);
    expect(d.control!.externalAreas!.find((e) => e.id === "ext-kingmoor")!.kind).toBe(
      "deferred_play_area",
    );
  });

  it("refuses the terminating-beyond-play patterns if the goods cut led outside play instead", () => {
    const control = structuredClone(d.control!);
    control.boundaries.find((b) => b.cutId === "cut-north-down-goods")!.toAreaId = "ext-wcml-south";
    const fringes = resolveGameRules(
      d.infrastructure,
      new TrackGraph(d.infrastructure),
      d.gameRules,
      d.playableArea,
    ).context.fringes;
    const tiplocs = {
      area: new Set(snapshot.import!.areaTiplocs),
      deferred: new Set(snapshot.import!.deferredTiplocs),
    };
    const ok = validateServicePatterns(
      d.servicePatterns,
      d.signalling,
      fringes,
      tiplocs,
      deferredAreaCuts(d.control),
    );
    expect(ok.invalid.size).toBe(0);
    const bad = validateServicePatterns(
      d.servicePatterns,
      d.signalling,
      fringes,
      tiplocs,
      deferredAreaCuts(control),
    );
    expect([...bad.invalid].sort()).toEqual([
      "pat-down-wcml-p3-goods-kgmr-down-yard-ends",
      "pat-down-wcml-p3-goods-kgmr-up-yard-ends",
    ]);
    // Fail closed in the planner too: the six terminating workings lose their pattern.
    const plan = world({ control }).timetable!;
    for (const [id] of KGMR_SERVICES) {
      const e = plan.entries.find((x) => x.serviceId === id)!;
      const ends = !/FLORSTN$/.test(e.observedPath);
      expect(e.classification === "unsupported", id).toBe(ends);
      if (ends) expect(e.reasons.map((r) => r.code)).toEqual(["NO_PATTERN"]);
    }
  });

  it("runs a working that terminates in the Kingmoor yard over the goods chain, leaving play once", () => {
    const target = "H01259:2026-11-04"; // 0C50, PNTH 08:25, ends at CARLILY (NY (DBS)) 09:04
    const only: TimetableSnapshot = {
      ...snapshot,
      services: snapshot.services.filter((s) => s.id === target),
      associations: [],
      excluded: [],
    };
    const w = world({ snapshot: only });
    const e = w.timetable!.entries[0]!;
    expect(e).toMatchObject({
      serviceId: target,
      classification: "representable",
      patternId: "pat-down-wcml-p3-goods-kgmr-up-yard-ends",
      run: { routeIds: GOODS_CHAIN, exitFringeId: "fr-north-down-goods", dueTiploc: "PNTH" },
    });
    // Test assumptions, as in carlisleTimetable.test.ts: all track proven clear; points start
    // undetected and are moved by the test operator through the pipeline.
    const clear = Object.fromEntries(d.infrastructure.edges.map((x) => [x.id, "clear" as const]));
    const initial = initialState(w, {
      occupancy: clear,
      clock: { startTimeMs: e.run!.dueAtMs - 2000, tickDurationMs: 1000 },
    });
    const run = () => {
      const store = new CommandStore(w, initial);
      const inputs: SimInput[] = [];
      let n = 0;
      const submit = (command: Command) => {
        const envelope = {
          commandId: `c${++n}`,
          operator: { kind: "ai" as const, id: "op-ai" },
          controlAreaId: "carlisle-ws-1",
          expectedVersion: store.view().version,
          command,
        };
        inputs.push({ kind: "command", envelope });
        return store.submit(envelope);
      };
      const changes: string[] = [];
      for (let i = 0; i < 1500 && store.view().services[target]!.status !== "departed"; i++) {
        for (const routeId of GOODS_CHAIN) {
          if (store.view().routes[routeId]) continue;
          for (const p of d.signalling!.routes.find((r) => r.id === routeId)!.pointsRequired)
            if (
              store.view().points[p.pointsId]?.position !== p.position ||
              !store.view().points[p.pointsId]?.detected
            )
              submit({ type: "move_points", pointsId: p.pointsId, position: p.position });
          submit({ type: "set_route", routeId });
        }
        const request = { tick: store.view().clock.tick + 1 };
        inputs.push({ kind: "tick", request });
        const r = store.tick(request);
        if (r.outcome !== "accepted") throw new Error(r.outcome);
        changes.push(...r.changes);
        const s = store.view();
        expect(stateTrainIssues(w, s)).toEqual([]);
        expect(routeSignalIssues(w, s)).toEqual([]);
        expect(serviceIssues(w, s)).toEqual([]);
      }
      return { store, inputs, changes };
    };
    const a = run();
    const svc = a.store.view().services[target]!;
    expect(svc.status).toBe("departed");
    expect(Object.keys(a.store.view().trains)).toEqual([]);
    const left = a.changes.filter(
      (c) => c.startsWith(`service ${target} (`) && c.includes("left play"),
    );
    expect(left).toEqual([
      `service ${target} (0C50) left play at fringe fr-north-down-goods as train ${svc.trainId}`,
    ]);
    expect(a.changes.some((c) => c.includes("fr-north-down-main"))).toBe(false);
    // Replaying the same inputs gives the same state and a byte-identical log.
    const b = replay(w, initial, a.inputs);
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.store.view()));
    expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.store.log()));
  });
});

describe("points on incomplete junctions are never worked (D-037)", () => {
  const w = world({ patternIds: [] });
  const clear = Object.fromEntries(d.infrastructure.edges.map((x) => [x.id, "clear" as const]));
  const store = new CommandStore(w, initialState(w, { occupancy: clear }));
  const move = (pointsId: string, kind: "human" | "ai") =>
    store.submit({
      commandId: `m-${pointsId}-${kind}`,
      operator: { kind, id: kind === "human" ? "op-h" : "op-ai" },
      controlAreaId: "carlisle-ws-1",
      expectedVersion: store.view().version,
      command: { type: "move_points", pointsId, position: "reverse" },
    });

  it("refuses the platform 1 two-edge switch and the other in-play two-edge switches, for human and AI alike", () => {
    for (const id of [
      "osm-pts1460504022",
      "osm-pts314950822",
      "osm-pts2464330439",
      "osm-pts2814195214",
      "osm-pts10069394082",
    ])
      for (const kind of ["human", "ai"] as const) {
        const before = store.view();
        expect(move(id, kind), `${id} ${kind}`).toMatchObject({
          outcome: "rejected",
          code: "POINTS_TOPOLOGY_INCOMPLETE",
        });
        expect(store.view()).toBe(before);
      }
  });

  it("rejects a game rule that would configure the platform 1 two-edge switch", () => {
    const g = new TrackGraph(d.infrastructure);
    const rules = structuredClone(d.gameRules!);
    const [a, b] = g.neighbours("osm-n1460504022");
    rules.points.push({
      pointsId: "osm-pts1460504022",
      switchType: "simple",
      normalTowardsNodeId: a!,
      reverseTowardsNodeId: b!,
      provenance: {
        evidence: "simplified",
        sources: [],
        note: "TEST ONLY: a rule P7 does not author; it must be refused",
      },
    });
    const r = resolveGameRules(d.infrastructure, g, rules, d.playableArea);
    expect(r.issues.filter((i) => i.code === "GAME_RULE_POINTS_INVALID").map((i) => i.ids)).toEqual(
      [["osm-pts1460504022"]],
    );
    expect(r.context.points.has("osm-pts1460504022")).toBe(false);
  });

  it("still moves points on a fully mapped three-edge switch", () => {
    expect(move("osm-pts10288162", "human")).toMatchObject({ outcome: "accepted" });
  });
});

describe("evidence gaps P7 could not close stay blocking", () => {
  const g = new TrackGraph(d.infrastructure);
  const signal = (ref: string) => d.infrastructure.signals.find((s) => s.ref === ref)!;

  it("keeps CE438, CE263 and CE268 of unknown function", () => {
    for (const ref of ["CE438", "CE263", "CE268"]) {
      expect(signal(ref).function, ref).toBe("unknown");
      expect(signal(ref).components, ref).toEqual([]);
    }
  });

  it("keeps the platform 1 switch incomplete and the Up Main junctions untyped, with no Points", () => {
    expect(g.junction("osm-n1460504022")).toMatchObject({
      cls: "incomplete",
      reason: "two_edge_junction",
    });
    for (const n of ["osm-n2464365978", "osm-n13915496837"]) {
      expect(g.junction(n), n).toMatchObject({ cls: "incomplete", reason: "untyped_junction" });
      expect(g.pointsAt(n), n).toBeUndefined();
    }
  });

  it("never passes a diamond or the platform 1 switch: no route crosses them", () => {
    for (const n of ["osm-n3057659458", "osm-n1051241139"]) {
      expect(g.junction(n).cls, n).toBe("crossing");
      const [a, b] = g.neighbours(n);
      expect(g.switchPassage(a!, n, b!).status, n).toBe("unresolved");
    }
    const blocked = new Set([
      "osm-n3057659458",
      "osm-n1051241139",
      "osm-n1460504022",
      "osm-n2464365978",
      "osm-n13915496837",
    ]);
    for (const r of d.signalling!.routes) {
      const nodes = new Set(
        r.edgeIds.flatMap((id) => {
          const e = g.edge(id)!;
          return [e.from, e.to];
        }),
      );
      expect(
        [...blocked].filter((n) => nodes.has(n)),
        r.id,
      ).toEqual([]);
    }
  });
});
