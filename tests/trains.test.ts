/**
 * Train movement and derived occupancy (P3, ADR 0001 "Trains, movement and occupancy", D-032).
 *
 * All layouts, lengths, routes, trains and operators are SYNTHETIC
 * (fixtures/synthetic/movement.ts has the diagram). Trains are labelled synthetic test trains.
 * The rules exercised are the game's SIMULATION POLICY; passing these tests does not certify,
 * reproduce or prove the safety of any real interlocking.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { simplified } from "../fixtures/synthetic/gameRules.ts";
import { syntheticMovementDataset } from "../fixtures/synthetic/movement.ts";
import {
  SignalFunction as SignalFunctionSchema,
  classifySignal,
  type SignalComponent,
} from "../src/model/index.ts";
import {
  CommandStore,
  Command as CommandSchema,
  DEFAULT_POLICY,
  SIGNAL_MOVEMENT_ROLE,
  TICK_STAGES,
  createWorld,
  decide,
  decideTick,
  deriveOccupancy,
  initialState,
  replay,
  routeSignalIssues,
  stateTrainIssues,
  type AuthoritativeState,
  type Command,
  type SetRoute,
  type SimInput,
  type SimWorld,
  type TrainSpec,
} from "../src/sim/index.ts";
import type { ValidationInput } from "../src/validation/validate.ts";

const M = 1000; // millimetres per metre
type SignalFunction = (typeof SignalFunctionSchema.options)[number];

function worldOf(d: ValidationInput): SimWorld {
  return createWorld(
    {
      infrastructure: d.infrastructure,
      signalling: d.signalling!,
      control: d.control!,
      sources: d.sources,
      gameRules: d.gameRules!,
      playableArea: d.playableArea!,
    },
    DEFAULT_POLICY,
    { "op-1": ["area-1"] },
  );
}

/** A SYNTHETIC test train standing at sig1 (head at N1, the end of e1). */
const atSig1 = (o: Partial<TrainSpec> = {}): TrainSpec => ({
  id: "t1",
  lengthMm: 100 * M,
  speedMmPerS: 20 * M,
  path: [{ edgeId: "e1", towardsNodeId: "N1" }],
  headOffsetMm: 1000 * M,
  ...o,
});
/** A SYNTHETIC test train standing outside play at B, beyond fringe fr-b. */
const atB = (o: Partial<TrainSpec> = {}): TrainSpec => ({
  id: "u1",
  lengthMm: 100 * M,
  speedMmPerS: 20 * M,
  path: [{ edgeId: "e7", towardsNodeId: "B" }],
  headOffsetMm: 600 * M,
  ...o,
});

function setup(
  opts: {
    tweak?: (d: ValidationInput) => void;
    trains?: unknown[];
    occupancy?: Record<string, "clear" | "occupied" | "unknown">;
    position?: "normal" | "reverse";
  } = {},
) {
  const d = syntheticMovementDataset();
  opts.tweak?.(d);
  const world = worldOf(d);
  const clear = Object.fromEntries(d.infrastructure.edges.map((e) => [e.id, "clear" as const]));
  const state = initialState(world, {
    occupancy: { ...clear, ...opts.occupancy },
    points: { pts1: { position: opts.position ?? "normal", detected: true } },
    trains: opts.trains ?? [atSig1()],
  });
  const store = new CommandStore(world, state);
  let n = 0;
  const submit = (command: Command) =>
    store.submit({
      commandId: `c${++n}`,
      operator: { kind: "human", id: "op-1" },
      controlAreaId: "area-1",
      expectedVersion: store.view().version,
      command,
    });
  /** Tick n times, checking every resulting state is self-consistent. */
  const tick = (times = 1) => {
    for (let i = 0; i < times; i++) {
      const r = store.tick({ tick: store.view().clock.tick + 1 });
      expect(r.outcome).toBe("accepted");
      consistent(world, store.view());
    }
  };
  return { world, state, store, submit, tick };
}

function consistent(world: SimWorld, s: AuthoritativeState) {
  expect(stateTrainIssues(world, s)).toEqual([]);
  expect(s.occupancy).toEqual(deriveOccupancy(s.trackStatus, s.trains));
}

const setR = (routeId: string): Command => ({ type: "set_route", routeId });
const cancelR = (routeId: string): Command => ({ type: "cancel_route", routeId });
const head = (s: AuthoritativeState, id = "t1") => {
  const t = s.trains[id]!;
  return [t.path.at(-1)!.edgeId, t.headOffsetMm];
};
const edges = (s: AuthoritativeState, id = "t1") => s.trains[id]!.path.map((p) => p.edgeId);
const occupied = (s: AuthoritativeState) =>
  Object.entries(s.occupancy)
    .filter(([, o]) => o === "occupied")
    .map(([e]) => e);

/** A SYNTHETIC signal component of one source category (P3.1 signal-function tests, D-033). */
const component = (category: string, sourceType: string, form: string): SignalComponent => ({
  category,
  sourceType,
  form,
  design: null,
  states: null,
  height: null,
});
const COMPONENTS: Record<SignalFunction, SignalComponent[]> = {
  main: [component("main", "synthetic:main", "light")],
  shunting: [component("shunting", "synthetic:shunting", "light")],
  distant: [component("distant", "synthetic:distant", "semaphore")],
  repeater: [component("main_repeated", "synthetic:banner", "light")], // a banner repeater
  stop_board: [component("stop", "synthetic:stop", "sign")],
  other: [], // classifySignal never yields "other"; listed for completeness only
  unknown: [], // no source-stated category
};

/** Give a signal the components of `fn`; type and function are derived, as on import. */
function withFunction(d: ValidationInput, signalId: string, fn: SignalFunction) {
  const s = d.infrastructure.signals.find((x) => x.id === signalId)!;
  s.components = COMPONENTS[fn];
  Object.assign(s, classifySignal(s.components));
  expect(s.function).toBe(fn);
}

/** Add a SYNTHETIC signal at `node`, facing `towards` (null: facing unknown), of function `fn`. */
function addSignal(
  d: ValidationInput,
  id: string,
  node: string,
  towards: string | null,
  fn: SignalFunction,
) {
  const s = structuredClone(d.infrastructure.signals[0]!);
  s.id = id;
  s.ref = id.toUpperCase();
  s.trackNodeId = node;
  s.facingTowardsNodeId = {
    value: towards,
    provenance: towards ? s.facingTowardsNodeId.provenance : { evidence: "unknown", sources: [] },
  };
  d.infrastructure.signals.push(s);
  withFunction(d, id, fn);
}

/** A crafted state for defence-in-depth checks the pipeline itself would never reach. */
const taken = (routeId: string, edgeIds: string[], trainId?: string): SetRoute => ({
  routeId,
  lockedPointsIds: [],
  edgeIds,
  setBy: "test",
  commandId: `crafted-${routeId}`,
  ...(trainId ? { takenBy: trainId } : {}),
});

describe("synthetic fixture", () => {
  it("gives every route a game_rule status, so movement runs on game-rule passages", () => {
    const { world } = setup();
    expect([...world.status].sort()).toEqual([
      ["r1", "game_rule"],
      ["r2", "game_rule"],
      ["r3", "game_rule"],
      ["r4", "game_rule"],
      ["r5", "game_rule"],
    ]);
  });
});

describe("train placement", () => {
  it("places a valid train with no authority, occupying exactly its path", () => {
    const { state } = setup();
    expect(state.trains.t1).toEqual({
      ...atSig1(),
      residue: 0,
      authority: [],
      stopped: null,
    });
    expect(occupied(state)).toEqual(["e1"]);
    expect(state.trackStatus.e1).toBe("clear");
  });

  it("rejects malformed and impossible placements with a specific code", () => {
    const cases: [string, unknown[], ((d: ValidationInput) => void)?][] = [
      ["MALFORMED", [atSig1({ lengthMm: 0 })]],
      ["MALFORMED", [atSig1({ speedMmPerS: 1.5 })]],
      ["MALFORMED", [atSig1({ path: [] })]],
      ["MALFORMED", [{ id: "t1" }]],
      ["DUPLICATE_TRAIN", [atSig1(), atSig1()]],
      ["UNKNOWN_EDGE", [atSig1({ path: [{ edgeId: "nope", towardsNodeId: "N1" }] })]],
      ["DISCONNECTED_PATH", [atSig1({ path: [{ edgeId: "e1", towardsNodeId: "P1" }] })]],
      [
        "DISCONNECTED_PATH",
        [
          atSig1({
            path: [
              { edgeId: "e1", towardsNodeId: "N1" },
              { edgeId: "e3", towardsNodeId: "N2" },
            ],
            headOffsetMm: 50 * M,
          }),
        ],
      ],
      [
        "EDGE_LENGTH_UNKNOWN",
        [atSig1()],
        (d) => delete d.infrastructure.edges.find((e) => e.id === "e1")!.lengthM,
      ],
      ["HEAD_OUTSIDE_EDGE", [atSig1({ headOffsetMm: 1000 * M + 1 })]],
      ["MALFORMED", [atSig1({ headOffsetMm: 0 })]],
      ["TRAIN_LONGER_THAN_PATH", [atSig1({ lengthMm: 1000 * M + 1 })]],
      [
        "PATH_LONGER_THAN_TRAIN",
        [
          atSig1({
            path: [
              { edgeId: "e2", towardsNodeId: "P1" },
              { edgeId: "e3", towardsNodeId: "N2" },
            ],
            headOffsetMm: 200 * M,
            lengthMm: 100 * M,
          }),
        ],
      ],
      [
        // Leg to leg through pts1: from N2 straight into the reverse leg.
        "PASSAGE_NOT_PERMITTED",
        [
          atSig1({
            path: [
              { edgeId: "e3", towardsNodeId: "P1" },
              { edgeId: "e5", towardsNodeId: "N3" },
            ],
            headOffsetMm: 50 * M,
          }),
        ],
      ],
      [
        // Across pts1 onto the reverse leg while it lies normal.
        "POINTS_NOT_PROVEN",
        [
          atSig1({
            path: [
              { edgeId: "e2", towardsNodeId: "P1" },
              { edgeId: "e5", towardsNodeId: "N3" },
            ],
            headOffsetMm: 50 * M,
          }),
        ],
      ],
      [
        // Already past sig1 with no authority.
        "SIGNAL_INSIDE_TRAIN",
        [
          atSig1({
            path: [
              { edgeId: "e1", towardsNodeId: "N1" },
              { edgeId: "e2", towardsNodeId: "P1" },
            ],
            headOffsetMm: 50 * M,
          }),
        ],
      ],
      ["TRACK_OCCUPIED", [atSig1(), atSig1({ id: "t2", headOffsetMm: 500 * M })]],
    ];
    for (const [code, trains, tweak] of cases)
      expect(() => setup({ trains, ...(tweak ? { tweak } : {}) }), code).toThrow(
        new RegExp(`invalid train placement: .*${code}`),
      );
    expect(() => setup({ occupancy: { e1: "occupied" } })).toThrow(/TRACK_OCCUPIED/);
  });

  it("refuses a store whose trains or occupancy are inconsistent", () => {
    const { world, state } = setup();
    expect(
      () => new CommandStore(world, { ...state, occupancy: { ...state.occupancy, e1: "clear" } }),
    ).toThrow(/occupancy is not derived/);
    const t1 = { ...state.trains.t1!, authority: ["r1"] };
    expect(() => new CommandStore(world, { ...state, trains: { t1 } })).toThrow(
      /AUTHORITY_INVALID/,
    );
  });
});

describe("movement along taken routes", () => {
  it("takes a set route, replaces its signal, spans two edges and stops at the exit signal", () => {
    const { store, submit, tick } = setup();
    expect(submit(setR("r1")).outcome).toBe("accepted");
    expect(store.view().signals.sig1).toBe("off");
    tick();
    let s = store.view();
    expect(head(s)).toEqual(["e2", 20 * M]);
    expect(edges(s)).toEqual(["e1", "e2"]); // the train spans the signal
    expect(occupied(s)).toEqual(["e1", "e2"]);
    expect(s.trains.t1!.authority).toEqual(["r1"]);
    expect(s.routes.r1!.takenBy).toBe("t1");
    expect(s.signals.sig1).toBe("on"); // replacement on passing
    tick(4);
    s = store.view();
    expect(head(s)).toEqual(["e2", 100 * M]);
    expect(edges(s)).toEqual(["e2"]); // tail has left e1
    expect(s.occupancy.e1).toBe("clear");
    tick(20); // 500 m from sig1 to sig2 at 20 m per tick
    s = store.view();
    expect(head(s)).toEqual(["e3", 300 * M]);
    expect(s.trains.t1!.stopped).toBeNull();
    tick();
    s = store.view();
    expect(head(s)).toEqual(["e3", 300 * M]);
    expect(s.trains.t1!.stopped).toMatchObject({ code: "SIGNAL_AT_DANGER", at: "sig2" });
    expect(occupied(s)).toEqual(["e3"]);
    // The train stands on r1, so r1 stays set and taken: a stopped train keeps its route (D-034).
    expect(s.routes.r1).toMatchObject({ takenBy: "t1" });
  });

  it("continues onto the next route and stops at the end of its authority at the fringe", () => {
    const { store, submit, tick } = setup();
    submit(setR("r1"));
    tick(26);
    expect(submit(setR("r5")).outcome).toBe("accepted");
    tick(20);
    expect(head(store.view())).toEqual(["e4", 400 * M]);
    tick();
    const s = store.view();
    expect(s.trains.t1!.stopped).toMatchObject({ code: "NO_AUTHORITY", at: "B" });
    expect(s.trains.t1!.authority).toEqual(["r5"]); // r1 is no longer held once left
    expect(occupied(s)).toEqual(["e4"]); // leaving play is not modelled: it stops at B
    // P4 (D-034): r1 was released when the tail cleared it; r5 cannot be cancelled under it.
    expect(s.routes.r1).toBeUndefined();
    expect(submit(cancelR("r1"))).toMatchObject({ code: "ROUTE_NOT_SET" });
    expect(submit(cancelR("r5"))).toMatchObject({ code: "TRACK_OCCUPIED" });
  });

  it("follows the reverse leg when the route needs it, and only then", () => {
    const { store, submit, tick } = setup({ position: "reverse" });
    expect(submit(setR("r2")).outcome).toBe("accepted");
    tick(30);
    const s = store.view();
    expect(head(s)).toEqual(["e5", 300 * M]);
    expect(s.trains.t1!.stopped).toMatchObject({ code: "SIGNAL_AT_DANGER", at: "sig3" });
  });

  it("moves exactly over many ticks, carrying sub-millimetre progress", () => {
    const d = syntheticMovementDataset();
    const world = worldOf(d);
    const clear = Object.fromEntries(d.infrastructure.edges.map((e) => [e.id, "clear" as const]));
    const store = new CommandStore(
      world,
      initialState(world, {
        occupancy: clear,
        points: { pts1: { position: "normal", detected: true } },
        trains: [atSig1({ speedMmPerS: 333 })],
        clock: { startTimeMs: 0, tickDurationMs: 100 },
      }),
    );
    store.submit({
      commandId: "c1",
      operator: { kind: "human", id: "op-1" },
      controlAreaId: "area-1",
      expectedVersion: 0,
      command: setR("r1"),
    });
    for (let n = 1; n <= 30; n++) store.tick({ tick: n });
    // 333 mm/s x 3 s = 999 mm exactly; 33.3 mm per tick never drifts.
    expect(head(store.view())).toEqual(["e2", 999]);
  });
});

describe("signals and authority", () => {
  it("never moves a train with no set route, and never past a signal at danger", () => {
    const { store, tick } = setup();
    const before = store.view().trains.t1;
    tick();
    const s = store.view();
    expect(s.trains.t1).toMatchObject({ path: before!.path, headOffsetMm: before!.headOffsetMm });
    expect(s.trains.t1!.stopped).toMatchObject({ code: "SIGNAL_AT_DANGER", at: "sig1" });
  });

  it("stops at a signal returned to danger before the train reaches it (route cancelled)", () => {
    const { store, submit, tick } = setup();
    submit(setR("r1"));
    expect(submit(cancelR("r1")).outcome).toBe("accepted");
    tick(5);
    expect(head(store.view())).toEqual(["e1", 1000 * M]);
    expect(store.view().trains.t1!.stopped).toMatchObject({ code: "SIGNAL_AT_DANGER" });
  });

  it("stops at a stop signal inside a route that faces the train and is on, of any stopping function", () => {
    for (const fn of ["main", "shunting", "stop_board", "unknown"] as const)
      for (const facing of ["N2", null]) {
        const { store, submit, tick } = setup({
          tweak: (d) => addSignal(d, "sig-test", "P1", facing, fn),
        });
        submit(setR("r1"));
        tick(30);
        expect(head(store.view()), `${fn} ${facing}`).toEqual(["e2", 200 * M]);
        expect(store.view().trains.t1!.stopped).toMatchObject({
          code: "SIGNAL_AT_DANGER",
          at: "sig-test",
        });
      }
  });

  it("never moves beyond its authority, however fast", () => {
    const { store, submit, tick } = setup({ trains: [atSig1({ speedMmPerS: 1_000_000 * M })] });
    submit(setR("r1"));
    tick();
    expect(head(store.view())).toEqual(["e3", 300 * M]);
    expect(store.view().occupancy.e4).toBe("clear");
  });

  it("stops when authority is withdrawn (crafted: unreachable through the pipeline)", () => {
    const { world, state } = setup();
    const t1 = { ...state.trains.t1!, authority: ["r1"] };
    const crafted = { ...state, trains: { t1 } }; // r1 is not set
    const d = decideTick(world, crafted, { tick: 1 });
    expect(d.outcome).toBe("accepted");
    if (d.outcome !== "accepted") return;
    expect(d.state.trains.t1).toMatchObject({
      headOffsetMm: 1000 * M,
      stopped: { code: "AUTHORITY_WITHDRAWN", at: "r1" },
    });
  });

  it("refuses a disconnected authority path (crafted, impossible route)", () => {
    const { world, state } = setup({
      tweak: (d) =>
        d.signalling!.routes.push({
          ...structuredClone(d.signalling!.routes[0]!),
          id: "r9",
          edgeIds: ["e2", "e4"],
          conflictsWith: [],
        }),
    });
    expect(world.status.get("r9")).toBe("invalid");
    const t1 = {
      ...state.trains.t1!,
      path: [{ edgeId: "e2", towardsNodeId: "P1" }],
      headOffsetMm: 200 * M,
      authority: ["r9"],
    };
    const trains = { t1 };
    const crafted = {
      ...state,
      trains,
      routes: { r9: taken("r9", ["e2", "e4"], "t1") },
      occupancy: deriveOccupancy(state.trackStatus, trains),
    };
    const d = decideTick(world, crafted, { tick: 1 });
    if (d.outcome !== "accepted") throw new Error("tick refused");
    expect(d.state.trains.t1!.stopped).toMatchObject({ code: "DISCONNECTED_PATH" });
    expect(d.state.trains.t1!.headOffsetMm).toBe(200 * M);
  });
});

describe("occupancy is derived and never assumed clear", () => {
  it("returns a vacated edge to unknown when it was unknown before the train", () => {
    const { store, submit, tick } = setup({ occupancy: { e1: "unknown" } });
    submit(setR("r1"));
    tick(10);
    const s = store.view();
    expect(edges(s)).toEqual(["e2"]);
    expect(s.occupancy.e1).toBe("unknown");
  });

  it("stops before track of unknown occupancy (crafted: a route cannot be set over it)", () => {
    const { world, state } = setup({ occupancy: { e3: "unknown" } });
    const crafted = {
      ...state,
      routes: { r1: { ...taken("r1", ["e2", "e3"]), lockedPointsIds: ["pts1"] } },
      signals: { ...state.signals, sig1: "off" as const },
    };
    let s: AuthoritativeState = crafted;
    for (let n = 1; n <= 15; n++) {
      const d = decideTick(world, s, { tick: n });
      if (d.outcome !== "accepted") throw new Error("tick refused");
      s = d.state;
    }
    expect(head(s)).toEqual(["e2", 200 * M]);
    expect(s.trains.t1!.stopped).toMatchObject({ code: "TRACK_NOT_PROVEN_CLEAR", at: "e3" });
  });

  it("stops before track of unknown length, though the route can be set", () => {
    const { store, submit, tick } = setup({
      tweak: (d) => delete d.infrastructure.edges.find((e) => e.id === "e3")!.lengthM,
    });
    expect(submit(setR("r1")).outcome).toBe("accepted");
    tick(20);
    expect(head(store.view())).toEqual(["e2", 200 * M]);
    expect(store.view().trains.t1!.stopped).toMatchObject({
      code: "EDGE_LENGTH_UNKNOWN",
      at: "e3",
    });
  });

  it("refuses commands over a train's track, leaving state unchanged", () => {
    const { store, submit, tick } = setup();
    submit(setR("r1"));
    tick(3);
    const before = store.view();
    expect(submit(cancelR("r1"))).toMatchObject({ code: "TRACK_OCCUPIED" });
    expect(submit({ type: "move_points", pointsId: "pts1", position: "reverse" })).toMatchObject({
      code: "POINTS_LOCKED",
    });
    expect(submit(setR("r3"))).toMatchObject({ outcome: "rejected" });
    expect(store.view()).toBe(before);
  });
});

describe("several trains", () => {
  it("blocks the second of two trains wanting the same track, through the pipeline", () => {
    const { store, submit, tick } = setup({ trains: [atSig1(), atB()] });
    submit(setR("r1"));
    tick(26); // t1 at sig2
    expect(submit(setR("r4")).outcome).toBe("accepted"); // u1 enters from the fringe
    tick();
    expect(store.view().occupancy.e4).toBe("occupied");
    expect(submit(setR("r5"))).toMatchObject({ outcome: "rejected" }); // conflict / occupied
    tick(25);
    const s = store.view();
    expect(head(s, "u1")).toEqual(["e4", 400 * M]);
    expect(s.trains.u1!.stopped).toMatchObject({ code: "SIGNAL_AT_DANGER", at: "sig4" });
    expect(s.trains.t1!.stopped).toMatchObject({ code: "SIGNAL_AT_DANGER", at: "sig2" });
  });

  it("orders trains by id within a tick: the first takes the track, the second is blocked (crafted)", () => {
    // Two conflicting routes both set over e4, from opposite ends: impossible through the
    // pipeline, crafted to show that movement alone still keeps trains apart. Train "a" is
    // processed first wherever it stands, so it wins; "b" is blocked and takes nothing.
    for (const [atBId, atSig2Id] of [
      ["a", "b"],
      ["b", "a"],
    ] as const) {
      const t = atSig1({
        id: atSig2Id,
        path: [{ edgeId: "e3", towardsNodeId: "N2" }],
        headOffsetMm: 300 * M,
      });
      const u = atB({ id: atBId });
      const { world, state } = setup({ trains: [t, u] });
      const crafted = {
        ...state,
        routes: { r4: taken("r4", ["e4"]), r5: taken("r5", ["e4"]) },
        signals: { ...state.signals, sig2: "off" as const },
      };
      const d = decideTick(world, crafted, { tick: 1 });
      if (d.outcome !== "accepted") throw new Error("tick refused");
      const won = atBId === "a" ? "r4" : "r5";
      const lost = atBId === "a" ? "r5" : "r4";
      expect(edges(d.state, "a")).toContain("e4");
      expect(d.state.routes[won]!.takenBy).toBe("a");
      expect(d.state.trains.b!.stopped).toMatchObject({ code: "TRACK_OCCUPIED", at: "e4" });
      expect(edges(d.state, "b")).not.toContain("e4");
      expect(d.state.routes[lost]!.takenBy).toBeUndefined();
      consistent(world, d.state);
    }
  });

  it("reports movement of several trains in ascending id order", () => {
    const { store, submit } = setup({ trains: [atB({ id: "z" }), atSig1({ id: "m" })] });
    submit(setR("r1"));
    submit(setR("r4"));
    const r = store.tick({ tick: 1 });
    if (r.outcome !== "accepted") throw new Error("tick refused");
    const trainsInOrder = r.changes
      .filter((c) => c.startsWith("train"))
      .map((c) => c.split(" ")[1]);
    expect(trainsInOrder).toEqual(["m", "m", "z", "z"]);
  });
});

describe("deterministic replay with trains", () => {
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

  it("gives identical state and events, and matches a live store", () => {
    const { world, state, store } = setup({ trains: [atSig1(), atB()] });
    const inputs: SimInput[] = [
      cmd("c1", setR("r1"), 0),
      ...Array.from({ length: 26 }, (_, i) => tickIn(i + 1)),
      cmd("c2", setR("r4"), 27),
      cmd("c3", setR("r5"), 28), // refused: r4 conflicts
      tickIn(27),
      tickIn(27), // duplicate
      cmd("c4", cancelR("r1"), 29),
      ...Array.from({ length: 10 }, (_, i) => tickIn(i + 28)),
    ];
    const a = replay(world, state, inputs);
    const b = replay(world, state, inputs);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (const input of inputs)
      if (input.kind === "command") store.submit(input.envelope);
      else store.tick(input.request);
    expect(a.state).toEqual(store.view());
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(store.log()));
    expect(a.state.trains.u1!.path.at(-1)!.edgeId).toBe("e4");
  });
});

describe("signal functions (P3.1, D-033)", () => {
  const offeredR1 = (state: AuthoritativeState): AuthoritativeState => ({
    ...state,
    routes: { r1: { ...taken("r1", ["e2", "e3"]), lockedPointsIds: ["pts1"] } },
    signals: { ...state.signals, sig1: "off" },
  });

  it("gives every signal function exactly one movement role", () => {
    expect(Object.keys(SIGNAL_MOVEMENT_ROLE).sort()).toEqual(
      [...SignalFunctionSchema.options].sort(),
    );
    expect(SIGNAL_MOVEMENT_ROLE).toEqual({
      main: "worked_stop",
      shunting: "worked_stop",
      distant: "no_stop",
      repeater: "no_stop",
      stop_board: "always_stop",
      other: "always_stop",
      unknown: "always_stop",
    });
  });

  it("passes a confirmed banner repeater (or a distant) facing it at on: not a stop signal", () => {
    for (const fn of ["repeater", "distant"] as const) {
      const { store, submit, tick } = setup({
        tweak: (d) => addSignal(d, "sig-x", "P1", "N2", fn),
      });
      expect(submit(setR("r1")).outcome).toBe("accepted");
      tick(30);
      const s = store.view();
      expect(head(s), fn).toEqual(["e3", 300 * M]);
      expect(s.trains.t1!.stopped).toMatchObject({ code: "SIGNAL_AT_DANGER", at: "sig2" });
      expect(s.signals["sig-x"]).toBe("on"); // passed at on; nothing ever clears it
    }
  });

  it("lets a placed train stand across a repeater or distant, never across a stop signal", () => {
    const across = atSig1({
      path: [
        { edgeId: "e2", towardsNodeId: "P1" },
        { edgeId: "e3", towardsNodeId: "N2" },
      ],
      headOffsetMm: 50 * M,
    });
    for (const fn of ["repeater", "distant"] as const)
      expect(() =>
        setup({ trains: [across], tweak: (d) => addSignal(d, "sig-x", "P1", "N2", fn) }),
      ).not.toThrow();
    for (const fn of ["main", "shunting", "stop_board", "unknown"] as const)
      expect(() =>
        setup({ trains: [across], tweak: (d) => addSignal(d, "sig-x", "P1", "N2", fn) }),
      ).toThrow(/SIGNAL_INSIDE_TRAIN/);
  });

  it("never passes a running signal at danger at the train's own route entry", () => {
    const { store, tick } = setup();
    tick(3);
    expect(head(store.view())).toEqual(["e1", 1000 * M]);
    expect(store.view().trains.t1!.stopped).toMatchObject({ code: "SIGNAL_AT_DANGER", at: "sig1" });
  });

  it("never treats an aspect as authority: a stop signal off for no route the train takes (crafted)", () => {
    const { world, state } = setup({ tweak: (d) => addSignal(d, "sig-x", "P1", "N2", "main") });
    const crafted = {
      ...offeredR1(state),
      signals: { ...offeredR1(state).signals, "sig-x": "off" as const },
    };
    // The store would refuse this state outright; movement must refuse it too.
    expect(routeSignalIssues(world, crafted)).toEqual([
      "signal sig-x is off with 0 offered route(s) from it",
    ]);
    expect(() => new CommandStore(world, crafted)).toThrow(/routes and signals disagree/);
    let s: AuthoritativeState = crafted;
    for (let n = 1; n <= 15; n++) {
      const d = decideTick(world, s, { tick: n });
      if (d.outcome !== "accepted") throw new Error("tick refused");
      s = d.state;
    }
    expect(head(s)).toEqual(["e2", 200 * M]);
    expect(s.trains.t1!.stopped).toMatchObject({ code: "NO_AUTHORITY", at: "sig-x" });
  });

  it("never lets an unknown, repeater, distant or stop-board entry signal authorise a movement", () => {
    for (const fn of ["unknown", "repeater", "distant", "stop_board"] as const) {
      const { world, state, store, submit } = setup({
        tweak: (d) => withFunction(d, "sig1", fn),
      });
      // The R2 data status does not read signal functions; the pipeline and movement do.
      expect(world.status.get("r1"), fn).toBe("game_rule");
      const before = store.view();
      expect(submit(setR("r1")), fn).toMatchObject({
        outcome: "rejected",
        code: "ROUTE_NOT_ESTABLISHED",
      });
      expect(store.view()).toBe(before);
      expect(before.signals.sig1).toBe("on");
      // Crafted: the route offered and the signal off anyway. The train still takes nothing.
      const d = decideTick(world, offeredR1(state), { tick: 1 });
      if (d.outcome !== "accepted") throw new Error("tick refused");
      expect(d.state.trains.t1, fn).toMatchObject({
        headOffsetMm: 1000 * M,
        authority: [],
        stopped: { code: "ROUTE_NOT_ESTABLISHED", at: "sig1" },
      });
      expect(d.state.routes.r1!.takenBy).toBeUndefined();
    }
  });
});

describe("route allocation and movement authority (P3.1, D-033)", () => {
  /**
   * SYNTHETIC approach track behind sig1, so a second train can follow the first:
   *   A0 ==e0 400m== A ==e1== N1 ...   sig0 at A facing N1; r0: sig0 -> sig1 over e1.
   */
  const approach = (d: ValidationInput) => {
    const infra = d.infrastructure;
    const a = infra.nodes.find((n) => n.id === "A")!;
    infra.nodes.push({
      ...structuredClone(a),
      id: "A0",
      position: { lat: a.position!.lat, lon: a.position!.lon - 0.004 },
    });
    a.kind = "plain";
    const e1 = infra.edges.find((e) => e.id === "e1")!;
    infra.edges.push({ ...structuredClone(e1), id: "e0", from: "A0", to: "A", lengthM: 400 });
    addSignal(d, "sig0", "A", "N1", "main");
    d.control!.areas[0]!.signalIds.push("sig0");
    d.signalling!.routes.push({
      id: "r0",
      ref: null,
      entrySignalId: "sig0",
      exitSignalId: "sig1",
      edgeIds: ["e1"],
      pointsRequired: [],
      overlapId: null,
      conflictsWith: [],
      provenance: simplified("route r0 (P3.1 following-train test)"),
    });
  };
  const behind = atSig1({
    id: "t2",
    path: [{ edgeId: "e0", towardsNodeId: "A" }],
    headOffsetMm: 400 * M,
  });

  it("allocates a route to one train; a follower never moves under the stale route", () => {
    const { world, store, submit, tick } = setup({ tweak: approach, trains: [atSig1(), behind] });
    expect(world.status.get("r0")).toBe("game_rule");
    /** Tick, checking that no edge is ever covered by both trains. */
    const run = (times: number) => {
      for (let i = 0; i < times; i++) {
        tick();
        const s = store.view();
        const shared = edges(s, "t1").filter((e) => edges(s, "t2").includes(e));
        expect(shared).toEqual([]);
      }
    };
    expect(submit(setR("r1")).outcome).toBe("accepted");
    expect(submit(setR("r0"))).toMatchObject({ code: "TRACK_OCCUPIED" }); // t1 is on e1
    run(5); // t1's tail leaves e1
    expect(store.view().occupancy.e1).toBe("clear");
    expect(submit(setR("r0")).outcome).toBe("accepted");
    run(55);
    let s = store.view();
    // Allocation, not aspect: r1 is still set but allocated to t1, and sig1 is back on.
    expect(s.routes.r1!.takenBy).toBe("t1");
    expect(s.signals.sig1).toBe("on");
    expect(head(s, "t1")).toEqual(["e3", 300 * M]);
    expect(head(s, "t2")).toEqual(["e1", 1000 * M]);
    expect(s.trains.t2).toMatchObject({
      authority: ["r0"],
      stopped: { code: "SIGNAL_AT_DANGER", at: "sig1" },
    });
    // Nothing re-offers r1 while t1 holds it: it is already set, and cannot be cancelled.
    expect(submit(setR("r1"))).toMatchObject({ code: "ROUTE_ALREADY_SET" });
    expect(submit(cancelR("r1"))).toMatchObject({ code: "TRACK_OCCUPIED" });
    expect(store.view()).toBe(s);
    // t1 moves on; once its tail clears r1, r1 is released (P4, D-034). Release never clears
    // sig1, so t2 still stands at danger with no authority over r1.
    expect(submit(setR("r5")).outcome).toBe("accepted");
    run(25);
    s = store.view();
    expect(s.trains.t1).toMatchObject({ authority: ["r5"], stopped: { code: "NO_AUTHORITY" } });
    expect(s.routes.r1).toBeUndefined();
    expect(s.signals.sig1).toBe("on");
    expect(s.trains.t2!.stopped).toMatchObject({ code: "SIGNAL_AT_DANGER", at: "sig1" });
    expect(head(s, "t2")).toEqual(["e1", 1000 * M]);
    expect(submit(cancelR("r1"))).toMatchObject({ code: "ROUTE_NOT_SET" });
    expect(store.view()).toBe(s);
    // Only a fresh route, set anew, is offered to t2.
    expect(submit(setR("r1")).outcome).toBe("accepted");
    expect(store.view().routes.r1!.takenBy).toBeUndefined();
    expect(store.view().signals.sig1).toBe("off");
    run(1);
    expect(store.view().routes.r1!.takenBy).toBe("t2");
    expect(store.view().signals.sig1).toBe("on");
    run(30);
    s = store.view();
    expect(head(s, "t2")).toEqual(["e3", 300 * M]);
    expect(s.trains.t2).toMatchObject({
      authority: ["r1"],
      stopped: { code: "SIGNAL_AT_DANGER", at: "sig2" }, // sig2 is on: r5 is allocated to t1
    });
    expect(s.routes.r1!.takenBy).toBe("t2"); // held: t2 stands on it
    expect(s.routes.r0).toBeUndefined(); // released: t2's tail has left e1
  });

  it("cancelling a taken route never replaces a signal cleared since for another route (crafted)", () => {
    const { world, state } = setup();
    // r1 allocated to t1 and left behind; sig1 off for r3. Unreachable today (r1 and r3 share
    // e2), crafted to pin the rule that only an offered route's entry signal is put back.
    const crafted: AuthoritativeState = {
      ...state,
      routes: {
        r1: { ...taken("r1", ["e2", "e3"], "t1"), lockedPointsIds: ["pts1"] },
        r3: { ...taken("r3", ["e2", "e3", "e4"]), lockedPointsIds: ["pts1"] },
      },
      signals: { ...state.signals, sig1: "off" },
    };
    expect(routeSignalIssues(world, crafted)).toEqual([]);
    const d = decide(world, crafted, {
      commandId: "c1",
      operator: { kind: "human", id: "op-1" },
      controlAreaId: "area-1",
      expectedVersion: 0,
      command: cancelR("r1"),
    });
    expect(d).toMatchObject({ accepted: true, changes: ["route r1 cancelled"] });
    if (!d.accepted) return;
    expect(d.state.signals.sig1).toBe("off");
    expect(routeSignalIssues(world, d.state)).toEqual([]);
  });

  it("refuses a state in which one signal is off for two offered routes (crafted)", () => {
    const { world, state } = setup();
    const crafted: AuthoritativeState = {
      ...state,
      routes: {
        r1: { ...taken("r1", ["e2", "e3"]), lockedPointsIds: ["pts1"] },
        r3: { ...taken("r3", ["e2", "e3", "e4"]), lockedPointsIds: ["pts1"] },
      },
      signals: { ...state.signals, sig1: "off" },
    };
    expect(routeSignalIssues(world, crafted)).toEqual([
      "signal sig1 is off for several routes at once: r1, r3",
    ]);
    expect(() => new CommandStore(world, crafted)).toThrow(/routes and signals disagree/);
    // A route allocated to a train that does not exist is refused too.
    const ghost = { ...state, routes: { r1: taken("r1", ["e2", "e3"], "nobody") } };
    expect(routeSignalIssues(world, ghost)).toEqual([
      "route r1 is taken by train nobody, which does not exist",
    ]);
  });
});

describe("full train footprint (P3.1)", () => {
  it("covers several edges; the tail holds track and authority after the head moves on", () => {
    // A 600 m train; e1 behind it is of unknown occupancy apart from the train.
    const { store, submit, tick } = setup({
      trains: [atSig1({ lengthMm: 600 * M })],
      occupancy: { e1: "unknown" },
    });
    expect(submit(setR("r1")).outcome).toBe("accepted");
    expect(submit(setR("r5")).outcome).toBe("accepted");
    tick(28); // head 560 m beyond sig1, 60 m into e4; tail still 40 m on e1: four edges
    let s = store.view();
    expect(head(s)).toEqual(["e4", 60 * M]);
    expect(edges(s)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(occupied(s)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(s.trains.t1!.authority).toEqual(["r1", "r5"]);
    // Commands over any part of the footprint are refused, leaving state unchanged.
    expect(submit(cancelR("r1"))).toMatchObject({ code: "TRACK_OCCUPIED" });
    expect(submit(cancelR("r5"))).toMatchObject({ code: "TRACK_OCCUPIED" });
    expect(submit({ type: "move_points", pointsId: "pts1", position: "reverse" })).toMatchObject({
      code: "POINTS_LOCKED",
    });
    expect(store.view()).toBe(s);
    tick(7); // head 700 m beyond sig1; the tail has left e1 and is 100 m into e2
    s = store.view();
    expect(edges(s)).toEqual(["e2", "e3", "e4"]);
    expect(s.occupancy.e1).toBe("unknown"); // vacated, and unknown again: never clear
    tick(30); // the head stops at B, the end of its authority
    s = store.view();
    expect(head(s)).toEqual(["e4", 400 * M]);
    expect(s.trains.t1!.stopped).toMatchObject({ code: "NO_AUTHORITY", at: "B" });
    // Tail 300 m back, on e3: r1 is still held through it, and e2 has cleared.
    expect(edges(s)).toEqual(["e3", "e4"]);
    expect(occupied(s)).toEqual(["e3", "e4"]);
    expect(s.occupancy).toMatchObject({ e1: "unknown", e2: "clear" });
    expect(s.trains.t1!.authority).toEqual(["r1", "r5"]);
    expect(submit(cancelR("r1"))).toMatchObject({ code: "TRACK_OCCUPIED" });
    tick(2); // a blocked train stays exactly where it is, its footprint unchanged
    expect(store.view().trains.t1).toEqual(s.trains.t1);
    expect(store.view().occupancy).toEqual(s.occupancy);
  });

  it("refuses points moves and routes under any part of a train, head or tail, unlocked", () => {
    const cases: [string, TrainSpec][] = [
      [
        "straddling P1, tail on e2",
        atSig1({
          path: [
            { edgeId: "e2", towardsNodeId: "P1" },
            { edgeId: "e3", towardsNodeId: "N2" },
          ],
          headOffsetMm: 250 * M,
          lengthMm: 300 * M,
        }),
      ],
      [
        "head at P1",
        atSig1({ path: [{ edgeId: "e2", towardsNodeId: "P1" }], headOffsetMm: 200 * M }),
      ],
      [
        "beyond P1, rear at it",
        atSig1({ path: [{ edgeId: "e3", towardsNodeId: "N2" }], headOffsetMm: 300 * M }),
      ],
    ];
    for (const [what, train] of cases) {
      const { world, store, submit } = setup({ trains: [train] });
      const before = store.view();
      expect(
        submit({ type: "move_points", pointsId: "pts1", position: "reverse" }),
        what,
      ).toMatchObject({ code: "TRACK_OCCUPIED" });
      expect(submit(setR("r1")), what).toMatchObject({ code: "TRACK_OCCUPIED" });
      expect(store.view()).toBe(before);
      consistent(world, before);
    }
    // Control: with the train wholly on e1, clear of P1, the points move.
    const { submit } = setup();
    expect(submit({ type: "move_points", pointsId: "pts1", position: "reverse" }).outcome).toBe(
      "accepted",
    );
  });

  it("never lets a second train onto an edge held only by another train's tail (crafted)", () => {
    // t1's tail is on e2; r1 offered all the same (the pipeline would refuse to set it).
    const t1 = atSig1({
      path: [
        { edgeId: "e2", towardsNodeId: "P1" },
        { edgeId: "e3", towardsNodeId: "N2" },
      ],
      headOffsetMm: 250 * M,
      lengthMm: 300 * M,
    });
    const { world, state } = setup({ trains: [t1, atSig1({ id: "t2" })] });
    const crafted: AuthoritativeState = {
      ...state,
      routes: { r1: { ...taken("r1", ["e2", "e3"]), lockedPointsIds: ["pts1"] } },
      signals: { ...state.signals, sig1: "off" },
    };
    const d = decideTick(world, crafted, { tick: 1 });
    if (d.outcome !== "accepted") throw new Error("tick refused");
    expect(d.state.trains.t2).toMatchObject({
      path: [{ edgeId: "e1", towardsNodeId: "N1" }],
      headOffsetMm: 1000 * M,
      authority: [],
      stopped: { code: "TRACK_OCCUPIED", at: "e2" },
    });
    expect(d.state.routes.r1!.takenBy).toBeUndefined();
    expect(d.state.signals.sig1).toBe("off");
    consistent(world, d.state);
  });
});

describe("P3 scope", () => {
  it("adds no operator command; timetable reads stay in the service plan (P5)", () => {
    expect(CommandSchema.options.map((o) => o.shape.type.value).sort()).toEqual([
      "cancel_route",
      "move_points",
      "set_route",
    ]);
    // P4 (D-034) adds route release after movement; P5 (D-035) adds the two service stages.
    expect(TICK_STAGES.map((s) => s.name)).toEqual([
      "train-movement",
      "service-exit",
      "route-release",
      "service-entry",
    ]);
    // Timetable data enters the simulation only through the plan built at session setup.
    const dir = join(import.meta.dirname, "../src/sim");
    const readers = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /import[^;]*(timetable|Timetable)/.test(readFileSync(join(dir, f), "utf8")));
    expect(readers.sort()).toEqual(["servicePlan.ts", "state.ts"]);
  });
});
