/**
 * Deterministic simulation clock and tick transitions (P2, ADR 0001 "Simulation clock and
 * ticks", D-031).
 *
 * All layouts, routes and operators are SYNTHETIC (fixtures/synthetic/dataset.ts); see
 * tests/sim.test.ts for the layout. P2 advances time only: these tests also check that no tick
 * moves a train, changes occupancy or plays a timetable.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syntheticDataset } from "../fixtures/synthetic/dataset.ts";
import {
  CommandStore,
  DEFAULT_CLOCK,
  DEFAULT_POLICY,
  TICK_STAGES,
  createWorld,
  decideTick,
  initialState,
  operatorHandle,
  replay,
  type ClockConfig,
  type Command,
  type CommandEnvelope,
  type SimInput,
  type StateUpdate,
  type TickStage,
} from "../src/sim/index.ts";

function setup(
  opts: {
    clock?: ClockConfig;
    occupancy?: Record<string, "clear" | "occupied" | "unknown">;
  } = {},
) {
  const d = syntheticDataset();
  const world = createWorld(
    {
      infrastructure: d.infrastructure,
      signalling: d.signalling!,
      control: d.control!,
      sources: d.sources,
    },
    DEFAULT_POLICY,
    { "op-1": ["area-1"] },
  );
  const clear = Object.fromEntries(d.infrastructure.edges.map((e) => [e.id, "clear" as const]));
  const state = initialState(world, {
    occupancy: { ...clear, ...opts.occupancy },
    points: { pts1: { position: "normal", detected: true } },
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  return { world, state, store: new CommandStore(world, state) };
}

const env = (commandId: string, command: Command, expectedVersion: number): CommandEnvelope => ({
  commandId,
  operator: { kind: "human", id: "op-1" },
  controlAreaId: "area-1",
  expectedVersion,
  command,
});
const setR = (routeId: string): Command => ({ type: "set_route", routeId });
const move = (position: "normal" | "reverse"): Command => ({
  type: "move_points",
  pointsId: "pts1",
  position,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("clock configuration", () => {
  it("starts at tick 0 with the default clock when none is configured", () => {
    const { state } = setup();
    expect(DEFAULT_CLOCK).toEqual({ startTimeMs: 0, tickDurationMs: 1000 });
    expect(state.clock).toEqual({ tick: 0, timeMs: 0, tickDurationMs: 1000 });
    expect(state.version).toBe(0);
  });

  it("uses the configured start time and tick duration", () => {
    const { state } = setup({ clock: { startTimeMs: 21_600_000, tickDurationMs: 250 } });
    expect(state.clock).toEqual({ tick: 0, timeMs: 21_600_000, tickDurationMs: 250 });
  });

  it("refuses an invalid configuration at session creation", () => {
    for (const clock of [
      { startTimeMs: 0, tickDurationMs: 0 },
      { startTimeMs: 0, tickDurationMs: -1000 },
      { startTimeMs: 0, tickDurationMs: 1.5 },
      { startTimeMs: 0, tickDurationMs: Number.NaN },
      { startTimeMs: 0, tickDurationMs: Number.POSITIVE_INFINITY },
      { startTimeMs: -1, tickDurationMs: 1000 },
      { startTimeMs: 0.5, tickDurationMs: 1000 },
      { startTimeMs: Number.MAX_SAFE_INTEGER + 1, tickDurationMs: 1000 },
    ])
      expect(() => setup({ clock }), JSON.stringify(clock)).toThrow();
  });

  it("refuses a store whose initial state has an invalid clock", () => {
    const { world, state } = setup();
    for (const clock of [
      { tick: -1, timeMs: 0, tickDurationMs: 1000 },
      { tick: 0, timeMs: 0, tickDurationMs: 0 },
      { tick: 0, timeMs: Number.NaN, tickDurationMs: 1000 },
    ])
      expect(() => new CommandStore(world, { ...state, clock })).toThrow(
        /invalid simulation clock/,
      );
  });
});

describe("tick advancement", () => {
  it("advances one tick by exactly the configured duration", () => {
    const { store } = setup({ clock: { startTimeMs: 5000, tickDurationMs: 250 } });
    expect(store.tick({ tick: 1 })).toEqual({
      outcome: "accepted",
      version: 1,
      tick: 1,
      timeMs: 5250,
      changes: ["clock tick 1: 5000 ms -> 5250 ms"],
    });
    expect(store.view().clock).toEqual({ tick: 1, timeMs: 5250, tickDurationMs: 250 });
  });

  it("advances many ticks with no drift", () => {
    // 100 ms is not exactly representable as 0.1 s in floating point; integer ms is exact.
    const start = 123;
    const duration = 100;
    const { store } = setup({ clock: { startTimeMs: start, tickDurationMs: duration } });
    for (let n = 1; n <= 10_000; n++) {
      const r = store.tick({ tick: n });
      expect(r.outcome).toBe("accepted");
      expect(r.timeMs).toBe(start + n * duration);
    }
    expect(store.view().clock).toEqual({ tick: 10_000, timeMs: 1_000_123, tickDurationMs: 100 });
    expect(store.view().version).toBe(10_000);
  });

  it("refuses a tick that would leave the safe-integer range, at the exact boundary", () => {
    const { store } = setup({
      clock: { startTimeMs: Number.MAX_SAFE_INTEGER - 10, tickDurationMs: 10 },
    });
    expect(store.tick({ tick: 1 })).toMatchObject({
      outcome: "accepted",
      timeMs: Number.MAX_SAFE_INTEGER,
    });
    const before = store.view();
    expect(store.tick({ tick: 2 })).toMatchObject({
      outcome: "rejected",
      code: "TIME_OVERFLOW",
      tick: 1,
      timeMs: Number.MAX_SAFE_INTEGER,
    });
    expect(store.view()).toBe(before);
  });
});

describe("invalid and duplicate tick requests", () => {
  it("treats a tick number already applied as a duplicate that changes nothing", () => {
    const { store } = setup();
    store.tick({ tick: 1 });
    store.tick({ tick: 2 });
    const before = store.view();
    for (const tick of [2, 1])
      expect(store.tick({ tick })).toEqual({
        outcome: "duplicate",
        version: 2,
        tick: 2,
        timeMs: 2000,
      });
    expect(store.view()).toBe(before);
    expect(store.log().map((e) => e.outcome)).toEqual([
      "accepted",
      "accepted",
      "duplicate",
      "duplicate",
    ]);
  });

  it("refuses a tick that skips ahead", () => {
    const { store, state } = setup();
    expect(store.tick({ tick: 2 })).toMatchObject({
      outcome: "rejected",
      code: "TICK_OUT_OF_SEQUENCE",
      version: 0,
      tick: 0,
      timeMs: 0,
    });
    expect(store.view()).toBe(state);
  });

  it("refuses malformed tick requests without changing state", () => {
    const { store, state } = setup();
    for (const raw of [
      { tick: 0 },
      { tick: -1 },
      { tick: 1.5 },
      { tick: Number.NaN },
      { tick: Number.POSITIVE_INFINITY },
      { tick: Number.MAX_SAFE_INTEGER + 1 },
      { tick: "1" },
      {},
      null,
      undefined,
    ])
      expect(store.tick(raw), JSON.stringify(raw)).toMatchObject({
        outcome: "rejected",
        code: "MALFORMED",
      });
    expect(store.view()).toBe(state);
    expect(store.log().map((e) => (e.kind === "tick" ? e.tick : "?"))).toEqual([
      0,
      -1,
      1.5,
      null,
      null,
      Number.MAX_SAFE_INTEGER + 1,
      null,
      null,
      null,
      null,
    ]);
  });
});

describe("commands and ticks share one serialized transition path", () => {
  it("command then tick: the command applies at the current time, the tick advances it", () => {
    const { store } = setup();
    expect(store.submit(env("c1", setR("r1"), 0))).toMatchObject({
      outcome: "accepted",
      version: 1,
    });
    expect(store.view().clock.timeMs).toBe(0);
    expect(store.tick({ tick: 1 })).toMatchObject({ outcome: "accepted", version: 2 });
    expect(store.view().routes.r1).toBeDefined();
    expect(store.log().map((e) => [e.seq, e.kind, e.version, e.timeMs, e.outcome])).toEqual([
      [1, "command", 1, 0, "accepted"],
      [2, "tick", 2, 1000, "accepted"],
    ]);
  });

  it("tick then command: a command based on the pre-tick version is stale", () => {
    const { store } = setup();
    store.tick({ tick: 1 });
    const afterTick = store.view();
    expect(store.submit(env("c1", setR("r1"), 0))).toMatchObject({
      outcome: "rejected",
      code: "STALE",
    });
    expect(store.view()).toBe(afterTick);
    expect(store.submit(env("c2", setR("r1"), 1))).toMatchObject({
      outcome: "accepted",
      version: 2,
    });
    expect(store.log().map((e) => [e.seq, e.kind, e.version, e.timeMs, e.outcome])).toEqual([
      [1, "tick", 1, 1000, "accepted"],
      [2, "command", 1, 1000, "rejected"],
      [3, "command", 2, 1000, "accepted"],
    ]);
  });

  it("raises the version by exactly one per accepted input, never on rejection or duplicate", () => {
    const { store } = setup();
    const versions = [
      store.tick({ tick: 1 }),
      store.submit(env("c1", setR("r1"), 1)),
      store.submit(env("c1", setR("r1"), 1)), // duplicate command
      store.tick({ tick: 1 }), // duplicate tick
      store.submit(env("c2", move("reverse"), 2)), // locked
      store.tick({ tick: 5 }), // out of sequence
      store.tick({ tick: 2 }),
    ].map((r) => [r.outcome, r.version]);
    expect(versions).toEqual([
      ["accepted", 1],
      ["accepted", 2],
      ["duplicate", 2],
      ["duplicate", 2],
      ["rejected", 2],
      ["rejected", 2],
      ["accepted", 3],
    ]);
    expect(store.log().map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("leaves state identical after a rejected command between ticks", () => {
    const { store } = setup();
    store.tick({ tick: 1 });
    store.submit(env("c1", setR("r1"), 1));
    store.tick({ tick: 2 });
    const before = store.view();
    const snapshot = structuredClone(before);
    for (const [id, c] of [
      ["c2", move("reverse")],
      ["c3", setR("r2")],
      ["c4", setR("r1")],
    ] as const)
      expect(store.submit(env(id, c, 3)).outcome).toBe("rejected");
    expect(store.view()).toBe(before);
    expect(store.view()).toEqual(snapshot);
  });

  it("keeps route locking in force across ticks", () => {
    const { store } = setup();
    store.submit(env("c1", setR("r1"), 0));
    for (let n = 1; n <= 5; n++) store.tick({ tick: n });
    expect(store.submit(env("c2", move("reverse"), 6))).toMatchObject({ code: "POINTS_LOCKED" });
    expect(store.submit(env("c3", setR("r2"), 6))).toMatchObject({
      code: "POINTS_WRONG_POSITION",
    });
  });

  it("never lets a command change the clock", () => {
    const { store } = setup();
    store.tick({ tick: 1 });
    const clock = store.view().clock;
    store.submit(env("c1", setR("r1"), 1));
    store.submit(env("c2", { type: "cancel_route", routeId: "r1" }, 2));
    store.submit(env("c3", move("reverse"), 3));
    expect(store.view().version).toBe(4);
    expect(store.view().clock).toBe(clock);
  });

  it("gives operators no way to advance time", () => {
    const { store } = setup();
    const handle = operatorHandle(store, { kind: "ai", id: "op-1" });
    expect(Object.keys(handle).sort()).toEqual(["operator", "submit", "view"]);
  });

  it("publishes every tick outcome with the state after it", () => {
    const updates: StateUpdate[] = [];
    const { world, state } = setup();
    const store = new CommandStore(world, state, { publish: (u) => updates.push(u) });
    store.tick({ tick: 1 });
    store.tick({ tick: 1 });
    store.tick({ tick: 3 });
    expect(updates.map((u) => [u.version, u.event.kind, u.event.outcome, u.event.code])).toEqual([
      [1, "tick", "accepted", undefined],
      [1, "tick", "duplicate", undefined],
      [1, "tick", "rejected", "TICK_OUT_OF_SEQUENCE"],
    ]);
    expect(updates[2]!.state).toBe(store.view());
  });
});

describe("ticks without trains advance time only", () => {
  it("has exactly the movement, service and route-release stages; none writes points or trackStatus", () => {
    // P2 had no stages; P3 (D-032) adds train movement; P4 (D-034) adds route release after it;
    // P5 (D-035) adds service exit before release and service entry last.
    expect(TICK_STAGES.map((s) => s.name)).toEqual([
      "train-movement",
      "service-exit",
      "route-release",
      "service-entry",
    ]);
    const writes = (name: string) => [...TICK_STAGES.find((s) => s.name === name)!.writes].sort();
    expect(writes("train-movement")).toEqual(["occupancy", "routes", "signals", "trains"]);
    // Release frees routes only: it never changes a signal, a train or occupancy.
    expect(writes("route-release")).toEqual(["routes"]);
    // Services never change a signal or points.
    for (const name of ["service-exit", "service-entry"])
      expect(writes(name)).toEqual(["occupancy", "routes", "services", "trains"]);
    for (const s of TICK_STAGES) {
      expect(s.writes).not.toContain("points");
      expect(s.writes).not.toContain("trackStatus");
      expect(Object.isFrozen(s.writes)).toBe(true);
    }
    expect(Object.isFrozen(TICK_STAGES)).toBe(true);
  });

  it("does not touch points, routes, signals or occupancy when no train exists", () => {
    const { store } = setup({ occupancy: { e5: "occupied", e6: "unknown" } });
    store.submit(env("c1", setR("r1"), 0));
    const before = store.view();
    for (let n = 1; n <= 20; n++) store.tick({ tick: n });
    const after = store.view();
    expect(after.points).toBe(before.points);
    expect(after.routes).toBe(before.routes);
    expect(after.signals).toBe(before.signals);
    expect(after.occupancy).toBe(before.occupancy);
    expect(Object.keys(after).sort()).toEqual(
      [
        "clock",
        "occupancy",
        "points",
        "routes",
        "services",
        "signals",
        "trackStatus",
        "trains",
        "version",
      ].sort(),
    );
  });
});

describe("tick-transition contract for later phases", () => {
  it("runs stages after the clock advances and appends their changes", () => {
    const { world, state } = setup();
    const seen: number[] = [];
    const stage: TickStage = {
      name: "synthetic",
      writes: [],
      run: (_w, s) => {
        seen.push(s.clock.tick);
        return { state: s, changes: ["synthetic stage ran"] };
      },
    };
    const d = decideTick(world, state, { tick: 1 }, [stage]);
    expect(seen).toEqual([1]);
    expect(d).toMatchObject({
      outcome: "accepted",
      changes: ["clock tick 1: 0 ms -> 1000 ms", "synthetic stage ran"],
    });
  });

  it("refuses a stage that changes the version or the clock", () => {
    const { world, state } = setup();
    const writesAll = [
      "trains",
      "occupancy",
      "routes",
      "signals",
      "points",
      "trackStatus",
    ] as const;
    const bumpsVersion: TickStage = {
      name: "bumps-version",
      writes: writesAll,
      run: (_w, s) => ({ state: { ...s, version: s.version + 1 }, changes: [] }),
    };
    const movesClock: TickStage = {
      name: "moves-clock",
      writes: writesAll,
      run: (_w, s) => ({
        state: { ...s, clock: { ...s.clock, timeMs: s.clock.timeMs + 1 } },
        changes: [],
      }),
    };
    for (const stage of [bumpsVersion, movesClock])
      expect(() => decideTick(world, state, { tick: 1 }, [stage])).toThrow(
        /must not change the state version or the clock/,
      );
  });

  it("refuses a stage that changes a field it does not write, or breaks derived occupancy", () => {
    const { world, state } = setup();
    const movesPoints: TickStage = {
      name: "moves-points",
      writes: ["signals"],
      run: (_w, s) => ({
        state: { ...s, points: { ...s.points, pts1: { position: "reverse", detected: true } } },
        changes: [],
      }),
    };
    expect(() => decideTick(world, state, { tick: 1 }, [movesPoints])).toThrow(
      /moves-points changed points, which it does not write/,
    );
    const setsOccupancy: TickStage = {
      name: "sets-occupancy",
      writes: ["occupancy"],
      run: (_w, s) => ({
        state: { ...s, occupancy: { ...s.occupancy, e1: "occupied" } },
        changes: [],
      }),
    };
    expect(() => decideTick(world, state, { tick: 1 }, [setsOccupancy])).toThrow(
      /occupancy is not derived/,
    );
  });

  it("does not run stages for duplicate or refused ticks", () => {
    const { world, state } = setup();
    const stage: TickStage = {
      name: "must-not-run",
      writes: [],
      run: () => {
        throw new Error("stage must not run");
      },
    };
    expect(decideTick(world, state, { tick: 2 }, [stage]).outcome).toBe("rejected");
  });
});

describe("deterministic replay", () => {
  const inputs: SimInput[] = [
    { kind: "tick", request: { tick: 1 } },
    { kind: "command", envelope: env("c1", setR("r1"), 1) },
    { kind: "command", envelope: env("c1", setR("r1"), 1) }, // duplicate
    { kind: "command", envelope: env("c2", move("reverse"), 2) }, // locked
    { kind: "command", envelope: { commandId: "bad", command: { type: "derail" } } },
    { kind: "tick", request: { tick: 2 } },
    { kind: "tick", request: { tick: 2 } }, // duplicate
    { kind: "tick", request: { tick: 9 } }, // out of sequence
    { kind: "tick", request: { tick: "3" } }, // malformed
    { kind: "command", envelope: env("c3", { type: "cancel_route", routeId: "r1" }, 3) },
    { kind: "tick", request: { tick: 3 } },
    { kind: "command", envelope: env("c4", move("reverse"), 5) },
    { kind: "command", envelope: env("c5", setR("r2"), 6) },
  ];

  it("gives identical state and events for the same initial state and inputs", () => {
    const { world, state } = setup({ clock: { startTimeMs: 3_600_000, tickDurationMs: 500 } });
    const a = replay(world, state, inputs);
    const b = replay(world, state, inputs);
    expect(a.state).toEqual(b.state);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(a.state.clock).toEqual({ tick: 3, timeMs: 3_601_500, tickDurationMs: 500 });
    expect(a.state.version).toBe(7);
    expect(a.state.routes.r2).toBeDefined();
    expect(a.events).toHaveLength(inputs.length);
  });

  it("matches a live store fed the same inputs", () => {
    const { world, state, store } = setup();
    for (const input of inputs)
      if (input.kind === "command") store.submit(input.envelope);
      else store.tick(input.request);
    const r = replay(world, state, inputs);
    expect(r.state).toEqual(store.view());
    expect(JSON.stringify(r.events)).toBe(JSON.stringify(store.log()));
  });

  it("does not depend on system time or timers", () => {
    const { world, state } = setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2001-01-01T00:00:00Z"));
    const a = replay(world, state, inputs);
    vi.setSystemTime(new Date("2099-12-31T23:59:59Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.42);
    const b = replay(world, state, inputs);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("has no wall-clock, timer or randomness reads anywhere in the simulation layer", () => {
    const dir = join(import.meta.dirname, "../src/sim");
    const forbidden =
      /\b(Date\.now|new Date|performance\.|setTimeout|setInterval|setImmediate|requestAnimationFrame|Math\.random|process\.hrtime)\b/;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts")))
      expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(forbidden);
  });
});
