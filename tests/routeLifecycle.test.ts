/**
 * Route lifecycle: approach locking and route release (P4, ADR 0001 "Route lifecycle", D-034).
 *
 * All layouts, lengths, routes, overlaps, trains and operators are SYNTHETIC
 * (fixtures/synthetic/routeLifecycle.ts has the diagram). The approach zone and release time
 * are the game's SIMULATION POLICY. These tests prove the model's internal consistency; they do
 * not certify, reproduce or prove the behaviour of any real interlocking.
 */
import { describe, expect, it } from "vitest";
import { syntheticLifecycleDataset } from "../fixtures/synthetic/routeLifecycle.ts";
import {
  SignalFunction as SignalFunctionSchema,
  classifySignal,
  type SignalComponent,
} from "../src/model/index.ts";
import {
  CommandStore,
  DEFAULT_POLICY,
  SimulationPolicy,
  TICK_STAGES,
  approachReasons,
  createWorld,
  decideTick,
  deriveOccupancy,
  initialState,
  replay,
  routePhase,
  routeReleaseStage,
  routeSignalIssues,
  stateTrainIssues,
  takenRouteHold,
  type AuthoritativeState,
  type Command,
  type SimInput,
  type SimWorld,
  type TrainSpec,
} from "../src/sim/index.ts";
import type { ValidationInput } from "../src/validation/validate.ts";

const M = 1000; // millimetres per metre
/** Test policy: a 5 s approach-lock release (DEFAULT_POLICY uses 120 s; both are game settings). */
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
/** A SYNTHETIC test train standing at sig0 (head at A, the end of e0): two edges from sig1. */
const atSig0 = (o: Partial<TrainSpec> = {}): TrainSpec =>
  atSig1({ id: "t2", path: [{ edgeId: "e0", towardsNodeId: "A" }], headOffsetMm: 400 * M, ...o });
/** A SYNTHETIC test train standing outside play at B, beyond fringe fr-b. */
const atB = (o: Partial<TrainSpec> = {}): TrainSpec =>
  atSig1({ id: "u1", path: [{ edgeId: "e7", towardsNodeId: "B" }], headOffsetMm: 600 * M, ...o });

function setup(
  opts: {
    overlap?: boolean;
    trains?: TrainSpec[];
    occupancy?: Record<string, "clear" | "occupied" | "unknown">;
    position?: "normal" | "reverse";
    policy?: SimulationPolicy;
    tweak?: (d: ValidationInput) => void;
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
    opts.policy ?? POLICY,
    { "op-1": ["area-1"] },
  );
  const clear = Object.fromEntries(d.infrastructure.edges.map((e) => [e.id, "clear" as const]));
  const state = initialState(world, {
    occupancy: { ...clear, ...opts.occupancy },
    points: { pts1: { position: opts.position ?? "normal", detected: true } },
    trains: opts.trains ?? [atSig1()],
  });
  const store = new CommandStore(world, state);
  let n = 0;
  const envelope = (command: Command, commandId = `c${++n}`, version = store.view().version) => ({
    commandId,
    operator: { kind: "human" as const, id: "op-1" },
    controlAreaId: "area-1",
    expectedVersion: version,
    command,
  });
  const submit = (command: Command) => store.submit(envelope(command));
  /** Tick n times, checking every state is self-consistent and no two trains share an edge. */
  const tick = (times = 1) => {
    for (let i = 0; i < times; i++) {
      const r = store.tick({ tick: store.view().clock.tick + 1 });
      expect(r.outcome).toBe("accepted");
      consistent(world, store.view());
    }
  };
  return { world, state, store, submit, envelope, tick };
}

function consistent(world: SimWorld, s: AuthoritativeState) {
  expect(stateTrainIssues(world, s)).toEqual([]);
  expect(routeSignalIssues(world, s)).toEqual([]);
  expect(s.occupancy).toEqual(deriveOccupancy(s.trackStatus, s.trains));
  const owner = new Map<string, string>();
  for (const t of Object.values(s.trains))
    for (const p of t.path) {
      expect(owner.get(p.edgeId), `edge ${p.edgeId}`).toBeUndefined();
      owner.set(p.edgeId, t.id);
    }
  // Every edge a train covers ahead of its rear is protected by a route the train holds, or
  // the train has not passed a signal onto it (a train with no authority stands on one edge).
  for (const t of Object.values(s.trains))
    if (t.path.length > 1)
      for (const p of t.path.slice(1))
        expect(
          t.authority.some((r) => world.routes.get(r)!.edgeIds.includes(p.edgeId)),
          `train ${t.id} on ${p.edgeId} without a route`,
        ).toBe(true);
}

const setR = (routeId: string): Command => ({ type: "set_route", routeId });
const cancelR = (routeId: string): Command => ({ type: "cancel_route", routeId });
const movePts = (position: "normal" | "reverse"): Command => ({
  type: "move_points",
  pointsId: "pts1",
  position,
});
const head = (s: AuthoritativeState, id = "t1") => {
  const t = s.trains[id]!;
  return [t.path.at(-1)!.edgeId, t.headOffsetMm];
};
const edges = (s: AuthoritativeState, id = "t1") => s.trains[id]!.path.map((p) => p.edgeId);

describe("synthetic lifecycle fixture", () => {
  it("gives r0 and the synthetic overlap a game_rule status", () => {
    const { world } = setup({ overlap: true });
    expect(world.status.get("r0")).toBe("game_rule");
    expect(world.status.get("r1")).toBe("game_rule");
    expect(world.status.get("ov1")).toBe("game_rule");
  });
});

describe("setting and cancelling an untaken route", () => {
  it("(1) setting a valid route offers it and clears its entry signal", () => {
    const { store, submit } = setup({ trains: [] });
    expect(submit(setR("r1"))).toMatchObject({
      outcome: "accepted",
      changes: ["route r1 set", "points pts1 locked", "signal sig1 off"],
    });
    const s = store.view();
    expect(routePhase(s.routes.r1!)).toBe("offered");
    expect(s.signals.sig1).toBe("off");
  });

  it("(2) cancelling with nothing approaching returns the signal to danger and releases protection", () => {
    const { store, submit } = setup({ trains: [] });
    submit(setR("r1"));
    expect(submit(cancelR("r1"))).toMatchObject({
      outcome: "accepted",
      changes: ["route r1 cancelled", "signal sig1 on"],
    });
    const s = store.view();
    expect(s.routes).toEqual({});
    expect(s.signals.sig1).toBe("on");
    // Points and conflicting routes are free at once.
    expect(submit(movePts("reverse")).outcome).toBe("accepted");
    expect(submit(setR("r2")).outcome).toBe("accepted");
  });

  it("(9) a train outside the approach condition does not lock a cancelled route", () => {
    const outside: [string, TrainSpec][] = [
      ["two edges back, at sig0", atSig0()],
      [
        "on the approach edge, travelling away",
        atSig1({ path: [{ edgeId: "e1", towardsNodeId: "A" }] }),
      ],
      ["beyond the fringe", atB()],
    ];
    for (const [what, train] of outside) {
      const { world, store, submit } = setup({ trains: [train] });
      submit(setR("r1"));
      expect(approachReasons(world, store.view(), "r1"), what).toEqual([]);
      expect(submit(cancelR("r1")), what).toMatchObject({
        changes: ["route r1 cancelled", "signal sig1 on"],
      });
      expect(store.view().routes, what).toEqual({});
    }
  });

  it("treats approach track of unknown occupancy as approached (unknown is never clear)", () => {
    const { store, submit } = setup({ trains: [], occupancy: { e1: "unknown" } });
    // e1 is r1's approach, not its track, so r1 can still be set.
    expect(submit(setR("r1")).outcome).toBe("accepted");
    expect(submit(cancelR("r1"))).toMatchObject({
      changes: [
        "route r1 cancelled: approach locked (approach edge e1 is unknown)",
        "signal sig1 on",
      ],
    });
    expect(routePhase(store.view().routes.r1!)).toBe("approach_locked");
  });
});

describe("approach locking", () => {
  it("(5)(6)(7) keeps route, points and conflict protection with the signal at danger", () => {
    const { store, submit, tick } = setup();
    submit(setR("r1"));
    expect(submit(cancelR("r1"))).toMatchObject({
      outcome: "accepted",
      changes: [
        "route r1 cancelled: approach locked (train t1 approaching on e1)",
        "signal sig1 on",
      ],
    });
    let s = store.view();
    expect(s.signals.sig1).toBe("on");
    expect(s.routes.r1).toMatchObject({
      lockedPointsIds: ["pts1"],
      edgeIds: ["e2", "e3"],
      approachLock: { commandId: "c2", lockedAtMs: 0 },
    });
    expect(routePhase(s.routes.r1!)).toBe("approach_locked");
    tick(3); // the signal is at danger, yet the lock persists
    s = store.view();
    expect(routePhase(s.routes.r1!)).toBe("approach_locked");
    expect(s.trains.t1).toMatchObject({
      headOffsetMm: 1000 * M,
      authority: [],
      stopped: { code: "SIGNAL_AT_DANGER", at: "sig1" },
    });
    const before = store.view();
    expect(submit(movePts("reverse"))).toMatchObject({ code: "POINTS_LOCKED" });
    expect(submit(setR("r3"))).toMatchObject({ code: "ROUTE_CONFLICT" });
    expect(submit(setR("r1"))).toMatchObject({ code: "ROUTE_APPROACH_LOCKED" });
    expect(store.view()).toBe(before);
  });

  it("(8) releases exactly when the release time has elapsed since the cancel, never sooner", () => {
    const { store, submit, tick } = setup();
    tick(3); // the cancel comes at 3000 ms
    submit(setR("r1"));
    submit(cancelR("r1"));
    expect(store.view().routes.r1!.approachLock!.lockedAtMs).toBe(3000);
    tick(4); // 7000 ms: 4000 ms elapsed
    expect(routePhase(store.view().routes.r1!)).toBe("approach_locked");
    const r = store.tick({ tick: 8 }); // 8000 ms: 5000 ms elapsed
    expect(r).toMatchObject({ outcome: "accepted" });
    if (r.outcome !== "accepted") return;
    expect(r.changes).toContain("route r1 approach lock released: 5000 ms since cancellation");
    expect(store.view().routes.r1).toBeUndefined();
    expect(store.view().signals.sig1).toBe("on");
  });

  it("(8) releases at once when nothing approaches any more (crafted: the approaching train is gone)", () => {
    const { world, store, submit } = setup();
    submit(setR("r1"));
    submit(cancelR("r1"));
    const locked = store.view();
    const crafted: AuthoritativeState = {
      ...locked,
      trains: {},
      occupancy: deriveOccupancy(locked.trackStatus, {}),
    };
    const d = decideTick(world, crafted, { tick: 1 });
    if (d.outcome !== "accepted") throw new Error("tick refused");
    expect(d.changes).toContain("route r1 approach lock released: nothing approaching");
    expect(d.state.routes.r1).toBeUndefined();
  });

  it("locks a fringe-entry route while a train approaches the cut from outside", () => {
    const { store, submit, tick } = setup({ trains: [atB()] });
    submit(setR("r4"));
    expect(submit(cancelR("r4"))).toMatchObject({
      changes: ["route r4 cancelled: approach locked (train u1 approaching on e7)"],
    });
    tick(2);
    expect(store.view().trains.u1).toMatchObject({ headOffsetMm: 600 * M, authority: [] });
    expect(submit(setR("r5"))).toMatchObject({ code: "ROUTE_CONFLICT" });
    tick(3);
    expect(store.view().routes.r4).toBeUndefined();
  });

  it("(3)(11) repeated cancel, re-set and conflicting requests during the countdown change nothing", () => {
    const { store, envelope, tick } = setup();
    store.submit(envelope(setR("r1"), "set-1"));
    const first = store.submit(envelope(cancelR("r1"), "cancel-1"));
    expect(first).toMatchObject({ outcome: "accepted", version: 2 });
    const locked = store.view();
    // The same command again is a duplicate: the original result, no second transition.
    expect(store.submit(envelope(cancelR("r1"), "cancel-1", 1))).toEqual({
      outcome: "duplicate",
      version: 2,
      original: first,
    });
    // A new cancel, a re-set and an operator release attempt via cancel are refused.
    expect(store.submit(envelope(cancelR("r1"), "cancel-2"))).toMatchObject({
      outcome: "rejected",
      version: 2,
      code: "ROUTE_APPROACH_LOCKED",
    });
    expect(store.submit(envelope(setR("r1"), "set-2"))).toMatchObject({
      code: "ROUTE_APPROACH_LOCKED",
    });
    expect(store.submit(envelope(setR("r2"), "set-3"))).toMatchObject({ outcome: "rejected" });
    expect(store.view()).toBe(locked);
    tick(5);
    // Released: a further cancel finds nothing set; the route can be set again.
    expect(store.submit(envelope(cancelR("r1"), "cancel-3"))).toMatchObject({
      code: "ROUTE_NOT_SET",
    });
    expect(store.submit(envelope(setR("r1"), "set-4")).outcome).toBe("accepted");
  });

  it("(4)(21) a cancelled route never authorises a train, approach locked or released", () => {
    const { store, submit, tick } = setup({ trains: [atSig1(), atSig0()] });
    submit(setR("r1"));
    submit(cancelR("r1")); // t1 approaching: locked
    tick(5); // released
    expect(store.view().routes.r1).toBeUndefined();
    expect(submit(setR("r0")).outcome).toBe("rejected"); // t1 stands on e1
    tick(20);
    const s = store.view();
    for (const id of ["t1", "t2"]) expect(s.trains[id]!.authority).toEqual([]);
    expect(head(s)).toEqual(["e1", 1000 * M]);
    expect(s.trains.t1!.stopped).toMatchObject({ code: "SIGNAL_AT_DANGER", at: "sig1" });
    expect(s.trains.t2!.stopped).toMatchObject({ code: "SIGNAL_AT_DANGER", at: "sig0" });
  });

  it("(22) an approach-locked route is never taken, even under an `off` aspect (crafted)", () => {
    const { world, store, submit } = setup();
    submit(setR("r1"));
    submit(cancelR("r1"));
    const crafted: AuthoritativeState = {
      ...store.view(),
      signals: { ...store.view().signals, sig1: "off" },
    };
    expect(routeSignalIssues(world, crafted)).toEqual([
      "signal sig1 is off with 0 offered route(s) from it",
    ]);
    expect(() => new CommandStore(world, crafted)).toThrow(/routes and signals disagree/);
    const d = decideTick(world, crafted, { tick: 1 });
    if (d.outcome !== "accepted") throw new Error("tick refused");
    expect(d.state.trains.t1).toMatchObject({
      headOffsetMm: 1000 * M,
      authority: [],
      stopped: { code: "NO_AUTHORITY" },
    });
    expect(d.state.routes.r1!.takenBy).toBeUndefined();
  });

  it("refuses inconsistent lifecycle states (crafted)", () => {
    const { world, store, submit } = setup();
    submit(setR("r1"));
    submit(cancelR("r1"));
    const s = store.view();
    const lock = s.routes.r1!.approachLock!;
    const cases: [string, AuthoritativeState][] = [
      [
        "route r1 is both taken and approach locked",
        { ...s, routes: { r1: { ...s.routes.r1!, takenBy: "t1" } } },
      ],
      [
        "route r1 has an invalid approach lock time 1",
        { ...s, routes: { r1: { ...s.routes.r1!, approachLock: { ...lock, lockedAtMs: 1 } } } },
      ],
    ];
    for (const [issue, crafted] of cases) {
      expect(routeSignalIssues(world, crafted)).toContain(issue);
      expect(() => new CommandStore(world, crafted)).toThrow(/routes and signals disagree/);
    }
    const onIt = { ...s.trains.t1!, path: [{ edgeId: "e2", towardsNodeId: "P1" }] };
    const occupiedLock = { ...s, trains: { t1: { ...onIt, headOffsetMm: 100 * M } } };
    expect(routeSignalIssues(world, occupiedLock)).toContain(
      "approach-locked route r1 is occupied by train t1",
    );
  });
});

describe("route release after the train has passed", () => {
  it("(10) cancelling a taken route never strands the train or grants authority", () => {
    const { store, submit, tick } = setup({ trains: [atSig1({ lengthMm: 150 * M })] });
    submit(setR("r1"));
    tick(); // t1 takes r1; its tail is still on the approach edge e1
    let s = store.view();
    expect(edges(s)).toEqual(["e1", "e2"]);
    expect(s.routes.r1!.takenBy).toBe("t1");
    expect(submit(cancelR("r1"))).toMatchObject({ code: "TRACK_OCCUPIED" });
    expect(store.view()).toBe(s);
    tick(8); // head 180 m past sig1, tail 30 m: wholly on e2
    s = store.view();
    expect(edges(s)).toEqual(["e2"]);
    expect(s.trains.t1!.authority).toEqual(["r1"]);
    expect(submit(cancelR("r1"))).toMatchObject({ code: "TRACK_OCCUPIED" });
    tick(20);
    s = store.view();
    expect(head(s)).toEqual(["e3", 300 * M]); // ran to the exit signal under its authority
    expect(s.signals.sig1).toBe("on");
  });

  it("(12)(13)(14)(17) holds route, points and conflicts until the whole footprint clears", () => {
    const { world, store, submit, tick } = setup({ trains: [atSig1({ lengthMm: 150 * M })] });
    submit(setR("r1"));
    tick(40); // stopped at sig2 on r1 well past any release time: a stopped train keeps it
    let s = store.view();
    expect(s.trains.t1!.stopped).toMatchObject({ code: "SIGNAL_AT_DANGER", at: "sig2" });
    expect(s.routes.r1!.takenBy).toBe("t1");
    expect(takenRouteHold(world, s, s.routes.r1!)).toBe("train t1 holds it");
    expect(submit(movePts("reverse"))).toMatchObject({ code: "POINTS_LOCKED" });
    expect(submit(setR("r3"))).toMatchObject({ code: "ROUTE_CONFLICT" });
    expect(submit(setR("r5")).outcome).toBe("accepted");
    // Head 640 m past sig1, tail 490 m: the tail is still on e3, r1's last edge.
    const at = store.view().clock.tick;
    tick(7); // 7 more ticks at 20 m put the head 140 m into e4
    s = store.view();
    expect(head(s)).toEqual(["e4", 140 * M]);
    expect(edges(s)).toEqual(["e3", "e4"]);
    expect(s.routes.r1!.takenBy).toBe("t1");
    expect(submit(movePts("reverse"))).toMatchObject({ code: "POINTS_LOCKED" });
    expect(store.view().clock.tick).toBe(at + 7);
    // One more tick: the tail leaves e3 and r1 is released at the end of that tick.
    const r = store.tick({ tick: at + 8 });
    if (r.outcome !== "accepted") throw new Error("tick refused");
    expect(r.changes).toContain("route r1 released: train t1 has cleared it");
    s = store.view();
    expect(edges(s)).toEqual(["e4"]);
    expect(s.routes.r1).toBeUndefined();
    expect(Object.keys(s.routes)).toEqual(["r5"]);
    // Now points can move and the formerly conflicting route can be set.
    expect(submit(movePts("reverse")).outcome).toBe("accepted");
    expect(submit(setR("r2")).outcome).toBe("accepted");
  });

  it("(15)(16)(18) release frees the route without clearing its signal; it must be set again", () => {
    const { store, submit, tick } = setup({ trains: [atSig1(), atSig0()] });
    submit(setR("r1"));
    submit(setR("r5"));
    tick(10); // t1's tail leaves e1
    expect(submit(setR("r0")).outcome).toBe("accepted");
    tick(60);
    let s = store.view();
    // t1 waits at B holding r5; r1 was released when t1 cleared it. t2 stands at sig1 on r0's
    // last edge, so r0 stays held by it.
    expect(Object.keys(s.routes).sort()).toEqual(["r0", "r5"]);
    expect(s.routes.r0!.takenBy).toBe("t2");
    expect(s.signals).toMatchObject({ sig0: "on", sig1: "on", sig2: "on" });
    expect(s.trains.t2).toMatchObject({
      authority: ["r0"],
      stopped: { code: "SIGNAL_AT_DANGER", at: "sig1" },
    });
    tick(10); // nothing re-clears sig1 by itself
    expect(store.view().trains.t2!.headOffsetMm).toBe(1000 * M);
    expect(submit(setR("r1")).outcome).toBe("accepted");
    tick();
    s = store.view();
    expect(s.routes.r1!.takenBy).toBe("t2");
    tick(5); // t2's tail leaves e1: r0 is released, and only r1 and r5 remain
    s = store.view();
    expect(Object.keys(s.routes).sort()).toEqual(["r1", "r5"]);
    expect(s.signals.sig0).toBe("on");
  });

  it("(16) the release stage writes routes only, and leaves signals and trains as they were", () => {
    const { world, store, submit, tick } = setup();
    submit(setR("r1"));
    submit(setR("r5"));
    tick(30);
    const s = store.view();
    const crafted: AuthoritativeState = {
      ...s,
      routes: { ...s.routes, r1: { ...s.routes.r5!, routeId: "r1", takenBy: "t1" } },
    };
    const r = routeReleaseStage.run(world, crafted);
    expect(r.state.signals).toBe(crafted.signals);
    expect(r.state.trains).toBe(crafted.trains);
    expect(r.state.points).toBe(crafted.points);
    // Release runs after movement and service exit, and before service entry (P5, D-035).
    expect(TICK_STAGES.indexOf(routeReleaseStage)).toBe(2);
  });
});

describe("overlaps (synthetic: no dataset has overlaps)", () => {
  it("(19) an overlap blocks conflicting routes until it is released with its route", () => {
    const { store, submit, tick } = setup({ overlap: true });
    expect(submit(setR("r1")).outcome).toBe("accepted");
    expect(store.view().routes.r1!.edgeIds).toEqual(["e2", "e3", "e4"]);
    // r4 (fringe -> sig4) runs over e4, the overlap beyond sig2.
    expect(submit(setR("r4"))).toMatchObject({
      code: "ROUTE_CONFLICT",
      reason: "route r4 conflicts with set route r1 (shared track e4)",
    });
    submit(cancelR("r1")); // t1 approaching: overlap protection kept too
    expect(submit(setR("r4"))).toMatchObject({ code: "ROUTE_CONFLICT" });
    tick(5);
    expect(store.view().routes.r1).toBeUndefined();
    expect(submit(setR("r4")).outcome).toBe("accepted");
  });

  it("(20) the onward route may be set over the overlap; a conflicting route stays blocked", () => {
    const { world, store, submit, tick } = setup({ overlap: true });
    submit(setR("r1"));
    tick(40); // t1 stands at sig2 with r1 and its overlap held
    expect(store.view().routes.r1!.takenBy).toBe("t1");
    expect(submit(setR("r4"))).toMatchObject({ code: "ROUTE_CONFLICT" });
    // The onward route from r1's exit signal continues over the overlap: no deadlock.
    expect(submit(setR("r5")).outcome).toBe("accepted");
    tick(8); // head on e4 (overlap edge, under r5), tail off r1's edges
    const s = store.view();
    expect(edges(s)).toEqual(["e4"]);
    expect(s.routes.r1).toBeUndefined(); // released: e4 is protected by r5, which t1 holds
    expect(takenRouteHold(world, s, s.routes.r5!)).toBe("train t1 holds it");
    expect(submit(setR("r4"))).toMatchObject({ code: "ROUTE_CONFLICT" }); // r5 still held
  });

  it("holds a route while a train covers its overlap without an onward route (crafted)", () => {
    const { world, store, submit } = setup({ overlap: true });
    submit(setR("r1"));
    const s = store.view();
    const on = {
      ...s.trains.t1!,
      path: [{ edgeId: "e4", towardsNodeId: "B" }],
      headOffsetMm: 100 * M,
    };
    const crafted: AuthoritativeState = {
      ...s,
      routes: { r1: { ...s.routes.r1!, takenBy: "t1" } },
      signals: { ...s.signals, sig1: "on" },
      trains: { t1: on },
    };
    expect(takenRouteHold(world, crafted, crafted.routes.r1!)).toBe(
      "train t1 occupies overlap edge e4 without an onward route",
    );
    expect(routeReleaseStage.run(world, crafted).state).toBe(crafted);
  });
});

describe("signal functions stay non-authorising through the lifecycle", () => {
  const component = (category: string, sourceType: string, form: string): SignalComponent => ({
    category,
    sourceType,
    form,
    design: null,
    states: null,
    height: null,
  });
  const COMPONENTS: Partial<
    Record<(typeof SignalFunctionSchema.options)[number], SignalComponent[]>
  > = {
    distant: [component("distant", "synthetic:distant", "semaphore")],
    repeater: [component("main_repeated", "synthetic:banner", "light")],
    unknown: [],
  };

  it("(23) unknown, repeater and distant entry signals never offer, lock or authorise a route", () => {
    for (const fn of ["unknown", "repeater", "distant"] as const) {
      const { store, submit, tick } = setup({
        tweak: (d) => {
          const s = d.infrastructure.signals.find((x) => x.id === "sig1")!;
          s.components = COMPONENTS[fn]!;
          Object.assign(s, classifySignal(s.components));
        },
      });
      expect(submit(setR("r1")), fn).toMatchObject({ code: "ROUTE_NOT_ESTABLISHED" });
      expect(submit(cancelR("r1")), fn).toMatchObject({ code: "ROUTE_NOT_SET" });
      tick(10);
      const s = store.view();
      expect(s.routes, fn).toEqual({});
      expect(s.signals.sig1, fn).toBe("on");
      expect(s.trains.t1, fn).toMatchObject({ headOffsetMm: 1000 * M, authority: [] });
    }
  });
});

describe("two trains through release and re-setting", () => {
  it("(24) never share an edge or hold conflicting routes, in either id order", () => {
    const outcomes: string[] = [];
    for (const [lead, follow] of [
      ["a", "b"],
      ["b", "a"],
    ] as const) {
      const { world, store, submit, tick } = setup({
        trains: [atSig1({ id: lead }), atSig0({ id: follow })],
      });
      const step = (times: number) => {
        for (let i = 0; i < times; i++) {
          tick();
          const s = store.view();
          const set = Object.keys(s.routes);
          for (const x of set)
            for (const y of set)
              expect(world.routes.get(x)!.conflictsWith, `${x} with ${y}`).not.toContain(y);
        }
      };
      submit(setR("r1"));
      expect(submit(setR("r0"))).toMatchObject({ code: "TRACK_OCCUPIED" });
      step(5);
      expect(submit(setR("r0")).outcome).toBe("accepted");
      step(60); // the follower reaches sig1 while the leader holds r1 at sig2
      expect(submit(setR("r1"))).toMatchObject({ code: "ROUTE_ALREADY_SET" });
      expect(submit(setR("r5")).outcome).toBe("accepted");
      step(30); // the leader clears r1: released
      expect(store.view().routes.r1).toBeUndefined();
      expect(submit(setR("r1")).outcome).toBe("accepted");
      step(40);
      const s = store.view();
      expect(head(s, lead)).toEqual(["e4", 400 * M]);
      expect(head(s, follow)).toEqual(["e3", 300 * M]);
      expect(s.routes.r1!.takenBy).toBe(follow);
      outcomes.push(JSON.stringify([head(s, lead), head(s, follow), Object.keys(s.routes).sort()]));
    }
    expect(outcomes[0]).toBe(outcomes[1]);
  });
});

describe("determinism and store semantics", () => {
  const cmd = (id: string, command: Command, version: number): SimInput => ({
    kind: "command",
    envelope: {
      commandId: id,
      operator: { kind: "human", id: "op-1" },
      controlAreaId: "area-1",
      expectedVersion: version,
      command,
    },
  });
  const tickIn = (n: number): SimInput => ({ kind: "tick", request: { tick: n } });

  it("(25) replays approach locking and release to identical state and byte-identical logs", () => {
    const { world, state, store } = setup({ trains: [atSig1(), atSig0()], overlap: true });
    const inputs: SimInput[] = [
      cmd("c1", setR("r1"), 0),
      cmd("c2", cancelR("r1"), 1), // approach locked
      cmd("c2", cancelR("r1"), 1), // duplicate
      cmd("c3", setR("r1"), 2), // refused: approach locked
      ...Array.from({ length: 5 }, (_, i) => tickIn(i + 1)), // released at tick 5
      tickIn(5), // duplicate tick
      tickIn(9), // out of sequence
      cmd("c4", setR("r1"), 7),
      cmd("c5", setR("r5"), 8),
      ...Array.from({ length: 40 }, (_, i) => tickIn(i + 6)),
      cmd("c6", setR("r0"), 49),
      ...Array.from({ length: 40 }, (_, i) => tickIn(i + 46)),
    ];
    const a = replay(world, state, inputs);
    const b = replay(world, state, inputs);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (const input of inputs)
      if (input.kind === "command") store.submit(input.envelope);
      else store.tick(input.request);
    expect(a.state).toEqual(store.view());
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(store.log()));
    const changes = a.events.flatMap((e) => e.changes ?? []);
    expect(changes).toContain("route r1 approach lock released: 5000 ms since cancellation");
    expect(changes).toContain("route r1 released: train t1 has cleared it");
    // t2 stands at sig1 on r0's last edge (r1 was not set again), so r0 is still held.
    expect(a.state.routes.r0).toMatchObject({ takenBy: "t2" });
  });

  it("(26) duplicate and out-of-sequence ticks neither advance nor release an approach lock", () => {
    const { store, submit, tick } = setup();
    submit(setR("r1"));
    submit(cancelR("r1"));
    tick(4);
    const before = store.view();
    expect(store.tick({ tick: 4 })).toMatchObject({
      outcome: "duplicate",
      version: before.version,
    });
    expect(store.tick({ tick: 6 })).toMatchObject({
      outcome: "rejected",
      code: "TICK_OUT_OF_SEQUENCE",
    });
    expect(store.view()).toBe(before);
    expect(routePhase(store.view().routes.r1!)).toBe("approach_locked");
    tick();
    expect(store.view().routes.r1).toBeUndefined();
  });

  it("(27) a stale cancel is refused and starts no approach lock", () => {
    const { store, submit, envelope, tick } = setup();
    submit(setR("r1"));
    const based = store.view().version;
    tick();
    // t1 has taken r1 meanwhile; the stale cancel must not act on the superseded state.
    const before = store.view();
    expect(store.submit(envelope(cancelR("r1"), "late", based))).toMatchObject({
      outcome: "rejected",
      code: "STALE",
    });
    expect(store.view()).toBe(before);
    expect(before.routes.r1).toMatchObject({ takenBy: "t1" });
    expect(before.routes.r1!.approachLock).toBeUndefined();
  });
});

describe("P4 policy", () => {
  it("fixes the approach zone and release rule, and keeps the release time a positive game setting", () => {
    expect(DEFAULT_POLICY).toMatchObject({
      approachLocking: "approach_edge",
      approachLockReleaseMs: 120_000,
      routeRelease: "on_train_clearance",
    });
    for (const bad of [
      { approachLocking: "none" },
      { routeRelease: "never" },
      { approachLockReleaseMs: 0 },
      { approachLockReleaseMs: 1.5 },
    ])
      expect(SimulationPolicy.safeParse({ ...DEFAULT_POLICY, ...bad }).success).toBe(false);
  });
});
