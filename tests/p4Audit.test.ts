/**
 * P4 safety audit (P5 prerequisite, D-035): approach-lock release and the overlap conflict
 * exemption of ADR 0001 "Route lifecycle" (D-034).
 *
 * Layouts, lengths, routes, overlaps, trains and operators are SYNTHETIC
 * (fixtures/synthetic/routeLifecycle.ts), except the Carlisle reachability check, which reads
 * the committed Carlisle files. The approach zone, release time and overlap exemption are the
 * game's SIMULATION POLICY pending verified Carlisle overlap and interlocking data; nothing here
 * claims how Carlisle's real interlocking behaves.
 */
import { describe, expect, it } from "vitest";
import { syntheticLifecycleDataset } from "../fixtures/synthetic/routeLifecycle.ts";
import { simplified } from "../fixtures/synthetic/gameRules.ts";
import { loadDataset } from "../src/data/loadDataset.ts";
import type { Route } from "../src/model/index.ts";
import {
  CommandStore,
  DEFAULT_POLICY,
  approachLockHold,
  approachReasons,
  createWorld,
  decideTick,
  deriveOccupancy,
  initialState,
  routeConflict,
  routePhase,
  routeSignalIssues,
  stateTrainIssues,
  type AuthoritativeState,
  type Command,
  type SimulationPolicy,
  type TrainSpec,
} from "../src/sim/index.ts";
import type { ValidationInput } from "../src/validation/validate.ts";

const M = 1000;
const RELEASE_MS = 5000;
const POLICY: SimulationPolicy = { ...DEFAULT_POLICY, approachLockReleaseMs: RELEASE_MS };

/** A SYNTHETIC test train standing at sig1 (head at N1, the end of e1). */
const atSig1 = (o: Partial<TrainSpec> = {}): TrainSpec => ({
  id: "t1",
  lengthMm: 100 * M,
  speedMmPerS: 20 * M,
  path: [{ edgeId: "e1", towardsNodeId: "N1" }],
  headOffsetMm: 1000 * M,
  ...o,
});

/** SYNTHETIC overlap ov0 beyond sig1 over e2, e3 (pts1 normal), owned by r0 (sig0 -> sig1). */
function withOverlapOnR0(d: ValidationInput) {
  d.signalling!.overlaps.push({
    id: "ov0",
    signalId: "sig1",
    edgeIds: ["e2", "e3"],
    pointsRequired: [{ pointsId: "pts1", position: "normal", role: "path" }],
    provenance: simplified("overlap ov0 beyond sig1 (P4 audit tests)"),
  });
  d.signalling!.routes.find((r) => r.id === "r0")!.overlapId = "ov0";
}

function setup(
  opts: {
    trains?: TrainSpec[];
    occupancy?: Record<string, "clear" | "occupied" | "unknown">;
    tweak?: (d: ValidationInput) => void;
    overlap?: boolean;
  } = {},
) {
  const d = syntheticLifecycleDataset({ withOverlap: opts.overlap ?? false });
  opts.tweak?.(d);
  const world = createWorld(
    {
      infrastructure: d.infrastructure,
      signalling: d.signalling!,
      control: d.control!,
      sources: d.sources,
      gameRules: d.gameRules!,
      playableArea: d.playableArea!,
    },
    POLICY,
    { "op-1": ["area-1"] },
  );
  const clear = Object.fromEntries(d.infrastructure.edges.map((e) => [e.id, "clear" as const]));
  const store = new CommandStore(
    world,
    initialState(world, {
      occupancy: { ...clear, ...opts.occupancy },
      points: { pts1: { position: "normal", detected: true } },
      trains: opts.trains ?? [atSig1()],
    }),
  );
  let n = 0;
  const submit = (command: Command) =>
    store.submit({
      commandId: `c${++n}`,
      operator: { kind: "human", id: "op-1" },
      controlAreaId: "area-1",
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
  const route = (id: string) => world.routes.get(id)!;
  return { world, store, submit, tick, route };
}

const setR = (routeId: string): Command => ({ type: "set_route", routeId });
const cancelR = (routeId: string): Command => ({ type: "cancel_route", routeId });

/** Replace the trains of `s` (crafted), re-deriving occupancy. */
const withTrains = (s: AuthoritativeState, trains: AuthoritativeState["trains"]) => ({
  ...s,
  trains,
  occupancy: deriveOccupancy(s.trackStatus, trains),
});

describe("P4 audit 1A: approach-lock release", () => {
  it("releases by timer, and not one millisecond sooner", () => {
    const { store, submit, tick } = setup();
    submit(setR("r1"));
    submit(cancelR("r1"));
    tick(4);
    expect(routePhase(store.view().routes.r1!)).toBe("approach_locked");
    tick(1);
    expect(store.view().routes.r1).toBeUndefined();
  });

  it("a stopped (speed 0) train on the approach edge keeps the lock until the timer", () => {
    const { world, store, submit, tick } = setup({ trains: [atSig1({ speedMmPerS: 0 })] });
    submit(setR("r1"));
    submit(cancelR("r1"));
    tick(4);
    const s = store.view();
    expect(approachLockHold(world, s, s.routes.r1!)).toBe("train t1 approaching on e1");
    tick(1);
    expect(store.view().routes.r1).toBeUndefined();
  });

  it("a train moving away on the approach edge does not count as approaching (crafted)", () => {
    const { world, store, submit } = setup();
    submit(setR("r1"));
    submit(cancelR("r1"));
    const locked = store.view();
    const away = { ...locked.trains.t1!, path: [{ edgeId: "e1", towardsNodeId: "A" }] };
    const crafted = withTrains(locked, { t1: away });
    expect(approachReasons(world, crafted, "r1")).toEqual([]);
    const d = decideTick(world, crafted, { tick: 1 });
    if (d.outcome !== "accepted") throw new Error("tick refused");
    expect(d.changes).toContain("route r1 approach lock released: nothing approaching");
  });

  it("releases early when nothing approaches (crafted: the only route out of reach in Carlisle)", () => {
    const { world, store, submit } = setup();
    submit(setR("r1"));
    submit(cancelR("r1"));
    const d = decideTick(world, withTrains(store.view(), {}), { tick: 1 });
    if (d.outcome !== "accepted") throw new Error("tick refused");
    expect(d.changes).toContain("route r1 approach lock released: nothing approaching");
    expect(d.state.routes.r1).toBeUndefined();
  });

  for (const status of ["occupied", "unknown"] as const)
    it(`an ${status} approach edge keeps the lock (never released early as clear)`, () => {
      const { world, store, submit, tick } = setup({ trains: [], occupancy: { e1: status } });
      expect(submit(setR("r1")).outcome).toBe("accepted");
      expect(submit(cancelR("r1"))).toMatchObject({
        changes: [
          `route r1 cancelled: approach locked (approach edge e1 is ${status})`,
          "signal sig1 on",
        ],
      });
      tick(4);
      const s = store.view();
      expect(approachLockHold(world, s, s.routes.r1!)).toBe(`approach edge e1 is ${status}`);
      tick(1); // only the time release frees it
      expect(store.view().routes.r1).toBeUndefined();
    });

  it("a route whose start node is unknown is always treated as approached", () => {
    const { world, store } = setup();
    expect(approachReasons(world, store.view(), "no-such-route")).toEqual([
      "route no-such-route has no known start node",
    ]);
  });

  it("an approach-locked route is neither re-set, taken, nor are its points moved", () => {
    const { store, submit, tick } = setup();
    submit(setR("r1"));
    submit(cancelR("r1"));
    const before = store.view();
    expect(submit(setR("r1"))).toMatchObject({ code: "ROUTE_APPROACH_LOCKED" });
    expect(submit(cancelR("r1"))).toMatchObject({ code: "ROUTE_APPROACH_LOCKED" });
    expect(submit({ type: "move_points", pointsId: "pts1", position: "reverse" })).toMatchObject({
      code: "POINTS_LOCKED",
    });
    expect(submit(setR("r3"))).toMatchObject({ code: "ROUTE_CONFLICT" });
    expect(store.view()).toBe(before);
    tick(3);
    expect(store.view().trains.t1).toMatchObject({
      authority: [],
      stopped: { code: "SIGNAL_AT_DANGER", at: "sig1" },
    });
  });

  it("is unreachable on the committed Carlisle routes: nothing can leave an approach edge", () => {
    // Evidence for why the early-release path is tested only with crafted states. An
    // approaching train can stop approaching only by (a) taking another route from the same
    // start node, (b) reversing, (c) leaving play, or (d) its approach track becoming clear.
    // (b) is not modelled, nothing writes trackStatus (d), and these checks rule out (a), (c).
    const { input } = loadDataset("data", "carlisle");
    const d = structuredClone(input!);
    delete d.signalEvidence;
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
      {},
    );
    const starts = [...world.routeStart.entries()];
    expect(starts).toHaveLength(8);
    // (a) where two routes start at one node (CE323 since P6, D-036), they are declared
    // conflicting, so while one is approach locked the other cannot be set and taken
    // (exercised in carlisleGoods.test.ts). Every other start node has exactly one route.
    const byNode = new Map<string, string[]>();
    for (const [r, n] of starts) byNode.set(n, [...(byNode.get(n) ?? []), r]);
    expect([...byNode.values()].filter((rs) => rs.length > 1)).toEqual([
      ["rt-dm-ce323-fringe", "rt-dg-ce323-fringe"],
    ]);
    for (const rs of byNode.values())
      for (const a of rs)
        for (const b of rs) if (a !== b) expect(world.routes.get(a)!.conflictsWith).toContain(b);
    // (c) no exit fringe's cut edge, where a train leaves play (P5), is an approach edge.
    const approach = new Set(
      starts.flatMap(([r, node]) =>
        world.graph
          .incident(node)
          .map((i) => i.edgeId)
          .filter((e) => e !== world.routes.get(r)!.edgeIds[0]),
      ),
    );
    const exitCutEdges = d.signalling!.routes.flatMap((r) =>
      r.exitFringeId ? [world.fringes.get(r.exitFringeId)!.edgeId] : [],
    );
    expect(exitCutEdges).toEqual(["osm-w238611570-0", "osm-w238611573-0"]);
    expect(exitCutEdges.filter((e) => approach.has(e))).toEqual([]);
  });
});

describe("P4 audit 1B: the onward-over-overlap conflict exemption", () => {
  it("exempts only the onward routes from the exit signal over the overlap's leading track", () => {
    const { world, route } = setup({ tweak: withOverlapOnR0 });
    expect(world.status.get("ov0")).toBe("game_rule");
    expect(world.status.get("r0")).toBe("game_rule");
    // r1 (e2, e3) and r3 (e2, e3, e4) start at sig1 and run over ov0 with pts1 normal.
    for (const onward of ["r1", "r3"]) {
      expect(routeConflict(world, route(onward), route("r0"))).toBeNull();
      expect(routeConflict(world, route("r0"), route(onward))).toBeNull();
    }
  });

  it("keeps opposed points as a conflict even on exempt overlap track", () => {
    const { world, route } = setup({ tweak: withOverlapOnR0 });
    // r2 (e2, e5) starts at sig1 but needs pts1 reverse; ov0 holds pts1 normal.
    expect(routeConflict(world, route("r2"), route("r0"))).toBe("opposed points pts1");
    expect(routeConflict(world, route("r0"), route("r2"))).toBe("opposed points pts1");
  });

  it("never exempts a route that does not start at the exit signal (unrelated route)", () => {
    const { world, route } = setup({ overlap: true }); // ov1 = r1's overlap over e4
    // r4 (fr-b -> sig4) runs over e4 in the opposite direction: not an onward route.
    expect(routeConflict(world, route("r4"), route("r1"))).toBe("shared track e4");
    expect(routeConflict(world, route("r1"), route("r4"))).toBe("shared track e4");
  });

  it("never exempts the previous route's own running track (crafted onward route)", () => {
    const { world, route } = setup({ overlap: true });
    const onward: Route = { ...route("r5"), id: "x", edgeIds: ["e3", "e4"], conflictsWith: [] };
    // e3 is r1's own track; e4, the overlap, is not exempt either: x does not start over it.
    expect(routeConflict(world, onward, route("r1"))).toBe("shared track e3, e4");
  });

  it("fails closed on overlap track not in the leading run (crafted: reached another way)", () => {
    const { world, route } = setup({ tweak: withOverlapOnR0 });
    // Geometrically impossible on purpose: an onward route from sig1 that reaches e3 without
    // first running over e2. Before the D-035 hardening this edge was exempt.
    const reconverging: Route = { ...route("r2"), id: "y", edgeIds: ["e5", "e3"] };
    reconverging.pointsRequired = [{ pointsId: "pts1", position: "normal", role: "path" }];
    expect(routeConflict(world, reconverging, route("r0"))).toBe("shared track e3");
  });

  it("fails closed when the overlap does not belong to the exit signal (crafted data)", () => {
    const { world, route } = setup({
      tweak: (d) => {
        withOverlapOnR0(d);
        d.signalling!.overlaps.find((o) => o.id === "ov0")!.signalId = "sig0";
      },
    });
    expect(world.status.get("r0")).toBe("invalid"); // the validator refuses it as well
    expect(routeConflict(world, route("r1"), route("r0"))).toBe("shared track e2, e3");
  });

  for (const order of [
    ["r1", "r3"],
    ["r3", "r1"],
  ] as const)
    it(`allows only one of several onward routes over the overlap (${order.join(" then ")})`, () => {
      const { store, submit } = setup({ trains: [], tweak: withOverlapOnR0 });
      expect(submit(setR("r0")).outcome).toBe("accepted");
      expect(store.view().routes.r0!.edgeIds).toEqual(["e1", "e2", "e3"]);
      expect(submit(setR(order[0])).outcome).toBe("accepted");
      expect(submit(setR(order[1]))).toMatchObject({
        code: "ROUTE_CONFLICT",
        reason: `route ${order[1]} conflicts with set route ${order[0]} (declared)`,
      });
      // The overlap's points stay locked; the diverging route stays refused.
      expect(submit({ type: "move_points", pointsId: "pts1", position: "reverse" })).toMatchObject({
        code: "POINTS_LOCKED",
      });
    });
});
