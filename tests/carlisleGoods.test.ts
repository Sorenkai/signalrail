/**
 * The Caldew Jn goods-line movement on the committed Carlisle files (P6, DECISION_LOG D-036;
 * INFERRED_BEHAVIOUR I-014): route rt-dg-ce323-fringe, points rule osm-pts2464246595, fringe
 * fr-north-down-goods and pattern pat-down-wcml-p3-caldew-goods. The local-only
 * signal-evidence.json is dropped.
 *
 * The route is a `simplified` GAME route that shares CE323 and ten edges with the Down Main
 * route rt-dm-ce323-fringe. Trains placed here and the operator scripts are test parameters;
 * service schedules are the real DFROC1F snapshot, restricted to a few services so a session
 * can start mid-day. Passing claims nothing about real Carlisle signalling or operations.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadDataset } from "../src/data/loadDataset.ts";
import { TrackGraph } from "../src/graph/trackGraph.ts";
import {
  CommandStore,
  DEFAULT_POLICY,
  cifTimeMs,
  createWorld,
  deriveOccupancy,
  initialState,
  localToSimTime,
  replay,
  routeChainBlockers,
  routeConflict,
  routeSignalIssues,
  serviceIssues,
  stateTrainIssues,
  timetableSessionConfig,
  type AuthoritativeState,
  type Command,
  type SimInput,
  type SimWorld,
  type TrainSpec,
} from "../src/sim/index.ts";

const M = 1000;
const { input } = loadDataset("data", "carlisle");
const d = structuredClone(input!);
delete d.signalEvidence;
const infra = d.infrastructure;
const fullSnapshot = d.timetables!.find((t) => t.date === "2026-11-04")!;
const route = (id: string) => d.signalling!.routes.find((r) => r.id === id)!;
const signal = (ref: string) => infra.signals.find((s) => s.ref === ref)!;

const GOODS = "rt-dg-ce323-fringe";
const DOWN_MAIN = "rt-dm-ce323-fringe";
const TO_CE323 = [
  "rt-dm-fringe-ce264",
  "rt-dm-ce264-ce272",
  "rt-dm-ce272-ce286",
  "rt-dm-ce286-ce323",
];
const GOODS_CHAIN = [...TO_CE323, GOODS];
const MAIN_CHAIN = [...TO_CE323, DOWN_MAIN];
const S4S94 = "H49635:2026-11-04"; // goods line, due 15:21 at Penrith
const S1S63 = "W34187:2026-11-04"; // Down Main, due 15:32:30 at Penrith

/** A world on the committed files; `services` restricts the real snapshot to those ids. */
function world(services?: string[]): SimWorld {
  const snapshot = structuredClone(fullSnapshot);
  if (services) {
    snapshot.services = snapshot.services.filter((s) => services.includes(s.id));
    snapshot.associations = [];
  }
  return createWorld(
    {
      infrastructure: infra,
      signalling: d.signalling!,
      control: d.control!,
      sources: d.sources,
      gameRules: d.gameRules!,
      playableArea: d.playableArea!,
      timetable: {
        snapshot,
        patterns: d.servicePatterns!,
        config: timetableSessionConfig("2026-11-04"),
      },
    },
    DEFAULT_POLICY,
    { "op-1": ["carlisle-ws-1"] },
  );
}

/**
 * Test assumptions, not claims about the railway: all track proven clear; points of the Down
 * Main chain detected as it needs them; osm-pts2464246595 (goods line only) detected normal.
 */
function session(
  w: SimWorld,
  o: { from?: string; trains?: TrainSpec[] } = {},
): {
  store: CommandStore;
  submit: (c: Command) => ReturnType<CommandStore["submit"]>;
  tick: () => string[];
  inputs: SimInput[];
  initial: AuthoritativeState;
} {
  const clear = Object.fromEntries(infra.edges.map((e) => [e.id, "clear" as const]));
  const points: Record<string, { position: "normal" | "reverse"; detected: true }> = {
    "osm-pts2464246595": { position: "normal", detected: true },
  };
  for (const id of MAIN_CHAIN)
    for (const p of route(id).pointsRequired)
      points[p.pointsId] = { position: p.position, detected: true };
  const start = localToSimTime(w.timetable!.base, "2026-11-04", cifTimeMs(o.from ?? "15:20"));
  if (start.kind !== "ok") throw new Error("start time");
  const initial = initialState(w, {
    occupancy: clear,
    points,
    trains: o.trains ?? [],
    clock: { startTimeMs: start.simMs, tickDurationMs: 1000 },
  });
  const store = new CommandStore(w, initial);
  const inputs: SimInput[] = [];
  let n = 0;
  const submit = (command: Command) => {
    const envelope = {
      commandId: `c${++n}`,
      operator: { kind: "ai" as const, id: "op-1" },
      controlAreaId: "carlisle-ws-1",
      expectedVersion: store.view().version,
      command,
    };
    inputs.push({ kind: "command", envelope });
    return store.submit(envelope);
  };
  const tick = () => {
    const request = { tick: store.view().clock.tick + 1 };
    inputs.push({ kind: "tick", request });
    const r = store.tick(request);
    if (r.outcome !== "accepted") throw new Error(`tick ${r.outcome}`);
    const s = store.view();
    expect(stateTrainIssues(w, s)).toEqual([]);
    expect(routeSignalIssues(w, s)).toEqual([]);
    expect(serviceIssues(w, s)).toEqual([]);
    expect(s.occupancy).toEqual(deriveOccupancy(s.trackStatus, s.trains));
    return r.changes;
  };
  return { store, submit, tick, inputs, initial };
}

/**
 * Test operator (not an AI signaller): moves points for, and sets, the given chain's routes
 * that lie ahead of `trainId` (all of them if it has not entered); never one behind it.
 */
function setChain(
  store: CommandStore,
  submit: (c: Command) => unknown,
  chain: readonly string[],
  trainId?: string,
) {
  const held = (trainId && store.view().trains[trainId]?.authority) || [];
  const from = held.length > 0 ? chain.indexOf(held.at(-1)!) + 1 : 0;
  for (const id of chain.slice(from)) {
    if (store.view().routes[id]) continue;
    for (const p of route(id).pointsRequired)
      if (store.view().points[p.pointsId]?.position !== p.position)
        submit({ type: "move_points", pointsId: p.pointsId, position: p.position });
    submit({ type: "set_route", routeId: id });
  }
}

describe("goods-line route: topology, direction and signals", () => {
  const w = world([]);
  const graph = new TrackGraph(infra);

  it("runs from CE323 over the Up & Down Goods to the Down Goods cut, in its sourced direction", () => {
    const r = route(GOODS);
    const ce323 = signal("CE323");
    expect(r.entrySignalId).toBe(ce323.id);
    expect(ce323.function).toBe("main");
    const walked = graph.walk(ce323.trackNodeId!, r.edgeIds);
    if (!walked.ok) throw new Error(walked.reason);
    expect(ce323.facingTowardsNodeId.value).toBe(walked.nodes[1]);
    const cut = d.playableArea!.cuts.find((c) => c.id === "cut-north-down-goods")!;
    expect(r.edgeIds.at(-1)).toBe(cut.edgeId);
    expect(walked.nodes.slice(-2)).toEqual([cut.insideNodeId, cut.outsideNodeId]);
    // It leaves the Down Main where rt-dm-ce323-fringe does not: at osm-n2464246608.
    expect(r.edgeIds.slice(0, 10)).toEqual(route(DOWN_MAIN).edgeIds.slice(0, 10));
    expect(walked.nodes[10]).toBe("osm-n2464246608");
    for (const e of r.edgeIds.slice(10, 14))
      expect(infra.edges.find((x) => x.id === e)!.trackRef).toBe("Up & Down Goods");
    expect(infra.edges.find((x) => x.id === cut.edgeId)!.trackRef).toBe("Down Goods");
    // Sourced direction (raw OSM): the Down Goods runs forwards from the switch, northwards,
    // and the Up Goods runs forwards into it: a northbound train takes the Down Goods.
    const raw = JSON.parse(readFileSync("data/raw/osm/carlisle-20261027T184451Z.json", "utf8")) as {
      elements: { type: string; id: number; nodes?: number[]; tags?: Record<string, string> }[];
    };
    const way = (id: number) => raw.elements.find((e) => e.type === "way" && e.id === id)!;
    expect(way(238611573).tags!["railway:preferred_direction"]).toBe("forward");
    expect(way(238611573).nodes![0]).toBe(2464246595);
    expect(way(238613009).tags!["railway:preferred_direction"]).toBe("forward");
    expect(way(238613009).nodes!.at(-1)).toBe(2464246595);
    expect(way(238611576).tags!["railway:bidirectional"]).toBe("regular");
    const pos = (n: string) => infra.nodes.find((x) => x.id === n)!.position!.lat;
    expect(pos(cut.outsideNodeId)).toBeGreaterThan(pos(cut.insideNodeId));
  });

  it("passes no signal that would stop the train, so the chain can be run whole", () => {
    expect(routeChainBlockers(w, GOODS_CHAIN)).toEqual([]);
    expect(routeChainBlockers(w, MAIN_CHAIN)).toEqual([]);
    expect(w.status.get(GOODS)).toBe("game_rule");
  });

  it("keeps the unknown-function blockers: CE438 inside the Up entry route, CE263 at the Up exit cut", () => {
    expect(routeChainBlockers(w, ["rt-um-fringe-ce336"])).toEqual([
      expect.stringMatching(/^signal CE438 \(unknown\) at osm-n11954024796 faces the movement/),
    ]);
    // Any Up exit to the south would cross CE263 at the cut's inside node, facing outwards.
    const up = d.playableArea!.cuts.find((c) => c.id === "cut-wcml-south-up")!;
    const ce263 = signal("CE263");
    expect(ce263).toMatchObject({ trackNodeId: up.insideNodeId, function: "unknown" });
    expect(ce263.facingTowardsNodeId.value).toBe(up.outsideNodeId);
  });
});

describe("goods-line route: conflicts and locking through the pipeline", () => {
  it("refuses either CE323 route while the other is set, and locks the opposed points", () => {
    const { store, submit } = session(world([]));
    expect(submit({ type: "set_route", routeId: DOWN_MAIN })).toMatchObject({
      outcome: "accepted",
    });
    expect(
      submit({ type: "move_points", pointsId: "osm-pts2464246608", position: "reverse" }),
    ).toMatchObject({ code: "POINTS_LOCKED" });
    expect(submit({ type: "set_route", routeId: GOODS })).toMatchObject({ outcome: "rejected" });
    expect(submit({ type: "cancel_route", routeId: DOWN_MAIN })).toMatchObject({
      outcome: "accepted",
    });
    expect(store.view().routes[DOWN_MAIN]).toBeUndefined();
    // Points still normal: the goods route is refused on its points, not set.
    expect(submit({ type: "set_route", routeId: GOODS })).toMatchObject({
      code: "POINTS_WRONG_POSITION",
    });
    expect(
      submit({ type: "move_points", pointsId: "osm-pts2464246608", position: "reverse" }),
    ).toMatchObject({ outcome: "accepted" });
    expect(submit({ type: "set_route", routeId: GOODS })).toMatchObject({ outcome: "accepted" });
    expect(store.view().signals[signal("CE323").id]).toBe("off");
    // Refused on the locked, opposed points first; the declared conflict also holds on its own.
    expect(submit({ type: "set_route", routeId: DOWN_MAIN })).toMatchObject({
      code: "POINTS_WRONG_POSITION",
    });
    const w = world([]);
    for (const [a, b] of [
      [DOWN_MAIN, GOODS],
      [GOODS, DOWN_MAIN],
    ] as const)
      expect(routeConflict(w, w.routes.get(a)!, w.routes.get(b)!), a).not.toBeNull();
    for (const p of ["osm-pts2464246608", "osm-pts2464246595", "osm-pts10288175"])
      expect(
        submit({
          type: "move_points",
          pointsId: p,
          position: store.view().points[p]!.position === "normal" ? "reverse" : "normal",
        }),
        p,
      ).toMatchObject({ code: "POINTS_LOCKED" });
  });

  it("approach locks a cancelled CE323 route and keeps the other refused until it releases", () => {
    // A stationary placed train with its head at CE323, on the approach edge from CE323BR.
    const approach = "osm-w28658022-3";
    const len = Math.round(infra.edges.find((e) => e.id === approach)!.lengthM! * M);
    const { store, submit, tick } = session(world([]), {
      trains: [
        {
          id: "test-approaching",
          lengthMm: 50 * M,
          speedMmPerS: 0,
          path: [{ edgeId: approach, towardsNodeId: signal("CE323").trackNodeId! }],
          headOffsetMm: len,
        },
      ],
    });
    submit({ type: "move_points", pointsId: "osm-pts2464246608", position: "reverse" });
    expect(submit({ type: "set_route", routeId: GOODS })).toMatchObject({ outcome: "accepted" });
    expect(submit({ type: "cancel_route", routeId: GOODS })).toMatchObject({ outcome: "accepted" });
    expect(store.view().routes[GOODS]!.approachLock).toBeDefined();
    expect(store.view().signals[signal("CE323").id]).toBe("on");
    expect(
      submit({ type: "move_points", pointsId: "osm-pts2464246608", position: "normal" }),
    ).toMatchObject({ code: "POINTS_LOCKED" });
    for (let i = 0; i < 119; i++) tick();
    expect(store.view().routes[GOODS]).toBeDefined();
    expect(submit({ type: "set_route", routeId: DOWN_MAIN })).toMatchObject({
      outcome: "rejected",
    });
    tick();
    expect(store.view().routes[GOODS]).toBeUndefined();
    expect(
      submit({ type: "move_points", pointsId: "osm-pts2464246608", position: "normal" }),
    ).toMatchObject({ outcome: "accepted" });
    expect(submit({ type: "set_route", routeId: DOWN_MAIN })).toMatchObject({
      outcome: "accepted",
    });
  });
});

describe("goods-line services", () => {
  it("runs 4S94 over the goods chain, hands it off at the Down Goods once, then lets 1S63 follow", () => {
    const w = world([S4S94, S1S63]);
    const { store, submit, tick, inputs, initial } = session(w);
    const changes: string[] = [];
    const runFor = (ticks: number) => {
      for (let i = 0; i < ticks; i++) {
        const now = store.view().clock.timeMs;
        for (const e of w.timetable!.entries) {
          const svc = store.view().services[e.serviceId]!;
          if (svc.status !== "departed" && svc.dueAtMs <= now)
            setChain(store, submit, e.run!.routeIds, e.run!.trainId);
        }
        changes.push(...tick());
        if (Object.values(store.view().services).every((s) => s.status === "departed")) return;
      }
    };
    runFor(1800);
    const s = store.view();
    const goods = s.services[S4S94]!;
    const main = s.services[S1S63]!;
    expect([goods.status, main.status]).toEqual(["departed", "departed"]);
    expect(changes.filter((c) => c.startsWith(`train ${goods.trainId} took route`))).toEqual(
      GOODS_CHAIN.slice(1).map(
        (r) => `train ${goods.trainId} took route ${r}; signal ${route(r).entrySignalId} on`,
      ),
    );
    const left = (id: string) =>
      changes.filter((c) => c.startsWith(`service ${id} (`) && c.includes("left play"));
    expect(left(S4S94)).toEqual([
      `service ${S4S94} (4S94) left play at fringe fr-north-down-goods as train ${goods.trainId}`,
    ]);
    expect(left(S1S63)).toEqual([
      `service ${S1S63} (1S63) left play at fringe fr-north-down-main as train ${main.trainId}`,
    ]);
    // 1S63 could not take the Down Main route from CE323 until the goods route was released.
    const tookMain = changes.findIndex(
      (c) => c === `train ${main.trainId} took route ${DOWN_MAIN}; signal ${signal("CE323").id} on`,
    );
    const goodsLeft = changes.indexOf(left(S4S94)[0]!);
    expect(goodsLeft).toBeGreaterThanOrEqual(0);
    expect(tookMain).toBeGreaterThan(goodsLeft);
    expect(s.trains).toEqual({});
    expect(s.routes).toEqual({});
    // Released: the goods-line points move freely again.
    expect(
      submit({ type: "move_points", pointsId: "osm-pts2464246595", position: "reverse" }),
    ).toMatchObject({ outcome: "accepted" });

    // Deterministic replay: identical state and byte-identical event log, twice.
    const a = replay(w, initial, inputs.slice(0, -1));
    const b = replay(w, initial, inputs.slice(0, -1));
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(JSON.stringify(a.state.services)).toBe(JSON.stringify(s.services));
  });

  it("never runs a goods service to the Down Main cut: offered the wrong route, it waits at CE323", () => {
    const w = world([S4S94]);
    const { store, submit, tick } = session(w);
    const train = w.timetable!.entries[0]!.run!.trainId;
    // The operator sets the Down Main chain, which is not 4S94's.
    let changes: string[] = [];
    for (let i = 0; i < 900; i++) {
      setChain(store, submit, MAIN_CHAIN);
      changes.push(...tick());
      if (store.view().trains[train]?.stopped?.code === "ROUTE_NOT_PLANNED") break;
    }
    const held = store.view().trains[train]!;
    expect(held.stopped).toMatchObject({
      code: "ROUTE_NOT_PLANNED",
      at: signal("CE323").trackNodeId,
    });
    expect(store.view().routes[DOWN_MAIN]!.takenBy ?? null).toBeNull();
    for (let i = 0; i < 30; i++) tick();
    expect(store.view().trains[train]!.path).toEqual(held.path);
    expect(store.view().services[S4S94]!.status).toBe("active");
    // Corrected: cancel (approach locked: the train is at the signal), wait, set its own route.
    expect(submit({ type: "cancel_route", routeId: DOWN_MAIN })).toMatchObject({
      outcome: "accepted",
    });
    changes = [];
    for (let i = 0; i < 900 && store.view().services[S4S94]!.status !== "departed"; i++) {
      setChain(store, submit, [GOODS]);
      changes.push(...tick());
    }
    expect(store.view().services[S4S94]!.status).toBe("departed");
    expect(changes).toContain(
      `service ${S4S94} (4S94) left play at fringe fr-north-down-goods as train ${train}`,
    );
    expect(changes.some((c) => c.includes("fr-north-down-main"))).toBe(false);
  });
});

describe("services that stay unsupported (evidence incomplete)", () => {
  const plan = world().timetable!;
  const gl = plan.entries.filter((e) => /CARLCJN\[GL\]/.test(e.observedPath));

  it("runs the four GL services with no Kingmoor yard call on the P6 pattern, and yard workings only via platform 3 (P7)", () => {
    const runnable = gl.filter((e) => e.run);
    expect(
      runnable
        .filter((e) => e.patternId === "pat-down-wcml-p3-caldew-goods")
        .map((e) => e.headcode),
    ).toEqual(["4S01", "4S94", "4S38", "4S48"]);
    const yard = gl.filter((e) => /KGMR(?!JCN)|CARLILY|CARLAME/.test(e.observedPath));
    expect(yard.length).toBeGreaterThan(0);
    // (P7, D-037) Yard workings that reach play via platform 3 leave on the Down Goods; every
    // other yard working (platform 1, the east, CIF platforms B/C) stays unsupported.
    for (const e of yard) {
      const viaP3 = /^PNTH\S* > CARLILE\(3\)\[DML\] > CARLCJN\[GL\]/.test(e.observedPath);
      if (viaP3) {
        expect(e.patternId, e.serviceId).toMatch(/^pat-down-wcml-p3-goods-kgmr-/);
        expect(e.run!.routeIds, e.serviceId).toEqual(d.servicePatterns!.patterns[1]!.routeIds);
        expect(e.run!.exitFringeId, e.serviceId).toBe("fr-north-down-goods");
      } else expect([e.classification, e.run], e.serviceId).toEqual(["unsupported", null]);
    }
    expect(yard.filter((e) => e.run)).toHaveLength(10);
  });

  it("keeps platform 1 and every Up service unsupported", () => {
    const p1 = plan.entries.filter((e) => /^PNTH\S* > CARLILE\(1\)/.test(e.observedPath));
    expect(p1.length).toBe(27); // 21 through, 3 via Kingmoor yards, 3 terminating there
    expect(p1.every((e) => e.classification === "unsupported")).toBe(true);
    const up = plan.entries.filter((e) => /CARLCJN\[UML\]/.test(e.observedPath));
    expect(up.length).toBeGreaterThan(0);
    expect(up.every((e) => e.run === null)).toBe(true);
  });
});
