/**
 * Route release and approach locking on the Carlisle MVP route set (P4, D-034), using committed
 * files only. The local-only, git-ignored signal-evidence.json is dropped after loading.
 *
 * The routes and points rules are the seven `simplified` game routes of D-030, NOT Carlisle
 * Power Signal Box's real interlocking. The trains are SYNTHETIC test trains. The approach zone
 * (one edge) and the 120 s release are the game's DEFAULT_POLICY settings: no Carlisle
 * approach-locking distance, release time, track circuit or overlap is known or claimed. These
 * tests prove the model is internally consistent on Carlisle data, not that it is faithful to it.
 */
import { describe, expect, it } from "vitest";
import { loadDataset } from "../src/data/loadDataset.ts";
import {
  CommandStore,
  DEFAULT_POLICY,
  createWorld,
  initialState,
  routePhase,
  routeSignalIssues,
  stateTrainIssues,
  type Command,
  type TrainSpec,
} from "../src/sim/index.ts";

const M = 1000;
const { input } = loadDataset("data", "carlisle");
const d = structuredClone(input!);
delete d.signalEvidence;
const infra = d.infrastructure;
const signal = (ref: string) => infra.signals.find((s) => s.ref === ref)!;
const edgeMm = (id: string) => Math.round(infra.edges.find((e) => e.id === id)!.lengthM! * 1000);
/** The seven D-030 routes' points; the P6 goods route (D-036) is tested in carlisleGoods.test.ts. */
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
  const tick = (times = 1) => {
    for (let i = 0; i < times; i++) {
      expect(store.tick({ tick: store.view().clock.tick + 1 }).outcome).toBe("accepted");
      expect(stateTrainIssues(world, store.view())).toEqual([]);
      expect(routeSignalIssues(world, store.view())).toEqual([]);
    }
  };
  /** Tick until the train reports the same stop twice running (max 400 ticks). */
  const runUntilStopped = (id: string) => {
    for (let i = 0; i < 400; i++) {
      const before = store.view().trains[id]!;
      tick();
      const after = store.view().trains[id]!;
      if (after.stopped && before.stopped && after.headOffsetMm === before.headOffsetMm)
        return store.view();
    }
    throw new Error(`train ${id} never stopped`);
  };
  return { store, submit, tick, runUntilStopped };
}
const setR = (routeId: string): Command => ({ type: "set_route", routeId });
const cancelR = (routeId: string): Command => ({ type: "cancel_route", routeId });

const CE264_APPROACH = "osm-w342066398-0";
/** A SYNTHETIC 200 m test train standing at CE264 on the Down Main. */
const atCe264 = (): TrainSpec => ({
  id: "down-1",
  lengthMm: 200 * M,
  speedMmPerS: 40 * M,
  path: [{ edgeId: CE264_APPROACH, towardsNodeId: signal("CE264").trackNodeId! }],
  headOffsetMm: edgeMm(CE264_APPROACH),
});

describe("Carlisle: route release and approach locking (game rules, P4)", () => {
  it("does not reuse a route until its train has cleared it and it is set again", () => {
    const { store, submit, runUntilStopped } = session([atCe264()]);
    expect(submit(setR("rt-dm-ce264-ce272")).outcome).toBe("accepted");
    let s = runUntilStopped("down-1");
    expect(s.trains["down-1"]!.stopped).toMatchObject({
      code: "SIGNAL_AT_DANGER",
      at: signal("CE272").id,
    });
    // The train stands on the route: it stays held, cannot be re-set and cannot be cancelled.
    expect(s.routes["rt-dm-ce264-ce272"]!.takenBy).toBe("down-1");
    expect(submit(setR("rt-dm-ce264-ce272"))).toMatchObject({ code: "ROUTE_ALREADY_SET" });
    expect(submit(cancelR("rt-dm-ce264-ce272"))).toMatchObject({ code: "TRACK_OCCUPIED" });
    expect(
      submit({ type: "move_points", pointsId: "osm-pts10288162", position: "reverse" }),
    ).toMatchObject({ code: "POINTS_LOCKED" });
    expect(store.view()).toBe(s);
    // Onward: once the whole 200 m train has left it, the route is released, CE264 stays on.
    expect(submit(setR("rt-dm-ce272-ce286")).outcome).toBe("accepted");
    s = runUntilStopped("down-1");
    expect(s.trains["down-1"]!.stopped).toMatchObject({ at: signal("CE286").id });
    expect(s.routes["rt-dm-ce264-ce272"]).toBeUndefined();
    expect(s.routes["rt-dm-ce272-ce286"]!.takenBy).toBe("down-1");
    expect(s.signals[signal("CE264").id]).toBe("on");
    // Set again explicitly: offered, CE264 off. Nothing approaches, so a cancel frees it at once.
    expect(submit(setR("rt-dm-ce264-ce272")).outcome).toBe("accepted");
    expect(store.view().signals[signal("CE264").id]).toBe("off");
    expect(submit(cancelR("rt-dm-ce264-ce272"))).toMatchObject({
      changes: ["route rt-dm-ce264-ce272 cancelled", `signal ${signal("CE264").id} on`],
    });
  });

  it("keeps a route approach locked while a train stands at CE264, until the game release time", () => {
    const { store, submit, tick } = session([atCe264()]);
    submit(setR("rt-dm-ce264-ce272"));
    expect(submit(cancelR("rt-dm-ce264-ce272"))).toMatchObject({
      changes: [
        `route rt-dm-ce264-ce272 cancelled: approach locked (train down-1 approaching on ${CE264_APPROACH})`,
        `signal ${signal("CE264").id} on`,
      ],
    });
    tick(119); // 119 s of the 120 s game-setting release
    let s = store.view();
    expect(routePhase(s.routes["rt-dm-ce264-ce272"]!)).toBe("approach_locked");
    expect(s.trains["down-1"]).toMatchObject({
      headOffsetMm: edgeMm(CE264_APPROACH),
      authority: [],
      stopped: { code: "SIGNAL_AT_DANGER", at: signal("CE264").id },
    });
    expect(
      submit({ type: "move_points", pointsId: "osm-pts10288162", position: "reverse" }),
    ).toMatchObject({ code: "POINTS_LOCKED" });
    tick();
    s = store.view();
    expect(s.routes["rt-dm-ce264-ce272"]).toBeUndefined();
    expect(s.signals[signal("CE264").id]).toBe("on");
    expect(s.trains["down-1"]!.authority).toEqual([]);
  });

  it("keeps CE323BR passable and CE438 a conservative stop through release", () => {
    expect(signal("CE323BR")).toMatchObject({ function: "repeater" });
    expect(signal("CE438")).toMatchObject({ function: "unknown" });
    // No MVP route starts at CE323BR or CE438, so neither can ever be offered or locked.
    for (const ref of ["CE323BR", "CE438"])
      expect(d.signalling!.routes.filter((r) => r.entrySignalId === signal(ref).id)).toEqual([]);
    const { store, submit, runUntilStopped } = session([
      {
        id: "up-1",
        lengthMm: 100 * M,
        speedMmPerS: 40 * M,
        path: [{ edgeId: "osm-w238611575-0", towardsNodeId: "osm-n2464246568" }],
        headOffsetMm: edgeMm("osm-w238611575-0"),
      },
    ]);
    submit(setR("rt-um-fringe-ce336"));
    const s = runUntilStopped("up-1");
    expect(s.trains["up-1"]!.stopped).toMatchObject({ at: signal("CE438").id });
    // The train stands on its fringe route at CE438: the route stays held however long it waits.
    expect(s.routes["rt-um-fringe-ce336"]!.takenBy).toBe("up-1");
    expect(store.view().signals[signal("CE438").id]).toBe("on");
  });
});
