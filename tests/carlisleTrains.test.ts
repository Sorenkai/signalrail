/**
 * Train movement on the Carlisle MVP route set (P3, D-032), using committed files only. The
 * local-only, git-ignored signal-evidence.json is dropped after loading.
 *
 * The routes and points rules are the seven `simplified` game routes of D-030: a playable game
 * model, NOT Carlisle Power Signal Box's real interlocking. The trains are SYNTHETIC test
 * trains (ids, lengths and speeds are test parameters). Edge lengths are the OSM-derived
 * `lengthM`. Nothing here infers a points type, lie, signal category, overlap or length.
 * Passing these tests claims nothing about real Carlisle operations.
 */
import { describe, expect, it } from "vitest";
import { loadDataset } from "../src/data/loadDataset.ts";
import { TrackGraph } from "../src/graph/trackGraph.ts";
import {
  CommandStore,
  DEFAULT_POLICY,
  createWorld,
  deriveOccupancy,
  initialState,
  stateTrainIssues,
  type AuthoritativeState,
  type Command,
  type TrainSpec,
} from "../src/sim/index.ts";

const M = 1000;
const { input, schemaIssues } = loadDataset("data", "carlisle");
const d = structuredClone(input!);
delete d.signalEvidence;
const infra = d.infrastructure;
const signal = (ref: string) => infra.signals.find((s) => s.ref === ref)!;
const edgeMm = (id: string) => Math.round(infra.edges.find((e) => e.id === id)!.lengthM! * 1000);

/**
 * Every MVP route's points in the position it needs; no two of the seven D-030 routes share
 * points. The P6 goods route (D-036) needs osm-pts2464246608 reverse, so it is left out here and
 * tested on its own in carlisleGoods.test.ts.
 */
const P6_GOODS_ROUTES = ["rt-dg-ce323-fringe"];
const routePoints = Object.fromEntries(
  d
    .signalling!.routes.filter((r) => !P6_GOODS_ROUTES.includes(r.id))
    .flatMap((r) =>
      r.pointsRequired.map((p) => [p.pointsId, { position: p.position, detected: true }]),
    ),
);

function session(trains: TrainSpec[]) {
  const world = createWorld(
    {
      infrastructure: infra,
      signalling: d.signalling!,
      control: d.control!,
      sources: d.sources,
      gameRules: d.gameRules!,
      playableArea: d.playableArea!,
    },
    DEFAULT_POLICY,
    { "op-1": ["carlisle-ws-1"] },
  );
  // Test assumption: no obstruction other than the synthetic trains (all track proven clear).
  const clear = Object.fromEntries(infra.edges.map((e) => [e.id, "clear" as const]));
  const store = new CommandStore(
    world,
    initialState(world, { occupancy: clear, points: routePoints, trains }),
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
  /** Tick until the train has been stopped for the same reason twice running (max 400). */
  const runUntilStopped = (id: string) => {
    for (let i = 0; i < 400; i++) {
      store.tick({ tick: store.view().clock.tick + 1 });
      const s = store.view();
      expect(stateTrainIssues(world, s)).toEqual([]);
      expect(s.occupancy).toEqual(deriveOccupancy(s.trackStatus, s.trains));
      if (s.trains[id]!.stopped) return s;
    }
    throw new Error(`train ${id} never stopped`);
  };
  return { store, submit, runUntilStopped };
}
const setR = (routeId: string): Command => ({ type: "set_route", routeId });
const head = (s: AuthoritativeState, id: string) => [
  s.trains[id]!.path.at(-1)!.edgeId,
  s.trains[id]!.headOffsetMm,
];

/** A SYNTHETIC test train whose head stands at the end of `edgeId`, travelling towards `node`. */
const standing = (id: string, edgeId: string, node: string, lengthMm: number): TrainSpec => ({
  id,
  lengthMm,
  speedMmPerS: 40 * M,
  path: [{ edgeId, towardsNodeId: node }],
  headOffsetMm: edgeMm(edgeId),
});

describe("Carlisle: trains on the MVP game routes", () => {
  it("loads the committed dataset cleanly", () => {
    expect(schemaIssues).toEqual([]);
  });

  it("Down Main: runs CE264 -> CE272 -> CE286, passes banner repeater CE323BR, stops at CE323", () => {
    const ce264 = signal("CE264");
    // CE323BR's function is sourced (OSM railway:signal:main_repeated=GB-NR:banner), so the
    // policy passes it as a no_stop signal (D-033); its `on` state does not stop the train.
    expect(signal("CE323BR")).toMatchObject({ function: "repeater", type: "light" });
    const { store, submit, runUntilStopped } = session([
      standing("down-1", "osm-w342066398-0", ce264.trackNodeId!, 200 * M),
    ]);
    for (const r of ["rt-dm-ce264-ce272", "rt-dm-ce272-ce286", "rt-dm-ce286-ce323"])
      expect(submit(setR(r)), r).toMatchObject({ outcome: "accepted" });
    let s = runUntilStopped("down-1");
    expect(s.trains["down-1"]!.stopped).toMatchObject({
      code: "SIGNAL_AT_DANGER",
      at: signal("CE323").id,
    });
    expect(head(s, "down-1")).toEqual(["osm-w28658022-3", edgeMm("osm-w28658022-3")]);
    // The 200 m train straddles CE323BR's node, still at `on`.
    expect(s.trains["down-1"]!.path.map((p) => p.edgeId)).toContain("osm-w28658022-2");
    expect(s.signals[signal("CE323BR").id]).toBe("on");
    // P4 (D-034): routes the whole train has cleared are released; the route it stands on is
    // held. Release never clears a signal: every passed signal is back on.
    expect(s.routes["rt-dm-ce264-ce272"]).toBeUndefined();
    expect(s.routes["rt-dm-ce272-ce286"]).toBeUndefined();
    expect(s.routes["rt-dm-ce286-ce323"]!.takenBy).toBe("down-1");
    for (const ref of ["CE264", "CE272", "CE286"]) expect(s.signals[signal(ref).id]).toBe("on");
    // Clearing CE323 lets the same train run on to the north cut.
    expect(submit(setR("rt-dm-ce323-fringe"))).toMatchObject({ outcome: "accepted" });
    s = runUntilStopped("down-1");
    expect(s.trains["down-1"]!.stopped).toMatchObject({
      code: "NO_AUTHORITY",
      at: "osm-n2464246638",
    });
    expect(s.signals[signal("CE323").id]).toBe("on");
    expect(store.log().some((e) => e.kind === "tick" && e.outcome === "accepted")).toBe(true);
  });

  it("Down Main: runs CE323 -> north cut and stops at the end of its authority", () => {
    const ce323 = signal("CE323");
    // Placed between CE323BR and CE323 on a 57.3 m edge, so the train cannot straddle CE323BR.
    const { submit, runUntilStopped } = session([
      standing("down-2", "osm-w28658022-3", ce323.trackNodeId!, 50 * M),
    ]);
    expect(submit(setR("rt-dm-ce323-fringe"))).toMatchObject({ outcome: "accepted" });
    const s = runUntilStopped("down-2");
    expect(s.trains["down-2"]!.stopped).toMatchObject({
      code: "NO_AUTHORITY",
      at: "osm-n2464246638",
    });
    expect(head(s, "down-2")).toEqual(["osm-w238611570-0", edgeMm("osm-w238611570-0")]);
  });

  it("Up Main: enters from the north fringe and stops at CE438 (no recorded category)", () => {
    // CE438's OSM node states no signal category, so its function is unknown. The policy never
    // passes an unknown-function signal and never lets one authorise a movement (D-033).
    expect(signal("CE438")).toMatchObject({ function: "unknown", components: [] });
    const { submit, runUntilStopped } = session([
      standing("up-1", "osm-w238611575-0", "osm-n2464246568", 100 * M),
    ]);
    expect(submit(setR("rt-um-fringe-ce336"))).toMatchObject({ outcome: "accepted" });
    const s = runUntilStopped("up-1");
    expect(s.trains["up-1"]!.stopped).toMatchObject({
      code: "SIGNAL_AT_DANGER",
      at: signal("CE438").id,
    });
    expect(head(s, "up-1")).toEqual(["osm-w238611571-0", edgeMm("osm-w238611571-0")]);
  });

  it("Up Main: runs CE336 -> CE304 and stops at CE304 (no Up route beyond, D-030)", () => {
    const { submit, runUntilStopped } = session([
      standing("up-2", "osm-w1466120258-0", signal("CE336").trackNodeId!, 150 * M),
    ]);
    expect(submit(setR("rt-um-ce336-ce304"))).toMatchObject({ outcome: "accepted" });
    const s = runUntilStopped("up-2");
    expect(s.trains["up-2"]!.stopped).toMatchObject({
      code: "SIGNAL_AT_DANGER",
      at: signal("CE304").id,
    });
    expect(head(s, "up-2")).toEqual(["osm-w262069383-2", edgeMm("osm-w262069383-2")]);
  });

  it("cannot stand a train beyond the south fringe: the extract ends at the cut", () => {
    const cut = d.playableArea!.cuts.find((c) => c.id === "cut-wcml-south-down")!;
    expect(cut.kind).toBe("extract_boundary");
    // The only mapped edge at the outside node is the cut edge itself, so no train can stand
    // outside the cut, and rt-dm-fringe-ce264 can never be taken (P5 must spawn at fringes).
    expect(new TrackGraph(infra).degree(cut.outsideNodeId)).toBe(1);
  });
});
