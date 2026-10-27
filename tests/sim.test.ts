/**
 * Safety-invariant harness for the authoritative command pipeline (R6, ADR 0001, D-028).
 *
 * All layouts, routes and operators are SYNTHETIC (fixtures/synthetic/dataset.ts):
 *   A ==e1== N1 ==e2== P1 ==e3== N2 ==e4== B
 *            sig1->     \==e5== N3 ==e6== C
 *   pts1 at P1: normal -> N2, reverse -> N3.  r1: sig1 -> sig2 (pts1 normal).
 *   r2: sig1 -> sig3 (pts1 reverse); r1 and r2 conflict.
 *
 * The rules exercised are the game's SIMULATION POLICY (src/sim/policy.ts) over project data.
 * Passing these tests does not certify, reproduce or prove the safety of any real interlocking.
 */
import { describe, expect, it } from "vitest";
import { syntheticDataset } from "../fixtures/synthetic/dataset.ts";
import {
  CommandStore,
  DEFAULT_POLICY,
  SimulationPolicy,
  createWorld,
  decide,
  initialState,
  operatorHandle,
  type AuthoritativeState,
  type Command,
  type CommandEnvelope,
  type StateUpdate,
} from "../src/sim/index.ts";
import type { ValidationInput } from "../src/validation/validate.ts";

const unknownProv = { evidence: "unknown" as const, sources: [] };

function setup(
  opts: {
    tweak?: (d: ValidationInput) => void;
    policy?: SimulationPolicy;
    occupancy?: Record<string, "clear" | "occupied" | "unknown">;
    points?: AuthoritativeState["points"];
  } = {},
) {
  const d = syntheticDataset();
  d.control!.areas.push({ ...d.control!.areas[0]!, id: "area-2", signalIds: [], pointsIds: [] });
  opts.tweak?.(d);
  const world = createWorld(
    {
      infrastructure: d.infrastructure,
      signalling: d.signalling!,
      control: d.control!,
      sources: d.sources,
    },
    opts.policy ?? DEFAULT_POLICY,
    { "op-1": ["area-1"], "op-2": ["area-1"], outsider: ["area-2"] },
  );
  const clear = Object.fromEntries(d.infrastructure.edges.map((e) => [e.id, "clear" as const]));
  const state = initialState(world, {
    occupancy: { ...clear, ...opts.occupancy },
    points: { pts1: { position: "normal", detected: true }, ...opts.points },
  });
  return { world, state, store: new CommandStore(world, state) };
}

let n = 0;
const env = (
  command: Command,
  o: {
    kind?: "human" | "ai";
    id?: string;
    area?: string;
    version?: number;
    commandId?: string;
  } = {},
): CommandEnvelope => ({
  commandId: o.commandId ?? `cmd-${++n}`,
  operator: { kind: o.kind ?? "human", id: o.id ?? "op-1" },
  controlAreaId: o.area ?? "area-1",
  expectedVersion: o.version ?? 0,
  command,
});
const setR = (routeId: string): Command => ({ type: "set_route", routeId });
const cancelR = (routeId: string): Command => ({ type: "cancel_route", routeId });
const move = (position: "normal" | "reverse"): Command => ({
  type: "move_points",
  pointsId: "pts1",
  position,
});
const code = (r: ReturnType<typeof decide>) => (r.accepted ? "ACCEPTED" : r.code);

describe("conflicting routes cannot both be authorised", () => {
  it("refuses a declared conflict while the first route is set", () => {
    const { store } = setup();
    expect(store.submit(env(setR("r1"))).outcome).toBe("accepted");
    const r = store.submit(env(setR("r2"), { version: 1 }));
    // pts1 is normal and locked, so the points check refuses r2 before the conflict check.
    expect(r).toMatchObject({ outcome: "rejected", code: "POINTS_WRONG_POSITION" });
    expect(Object.keys(store.view().routes)).toEqual(["r1"]);
  });

  it("refuses a route over track a set route holds (declared conflict, no points involved)", () => {
    // SYNTHETIC extension beyond N2: N2 -e4- B -e7- D -e8- E, with sig5 at D (facing E) and
    // sig6 at B (facing D). r3: sig2 -> sig5 over e4, e7; r4: sig6 -> sig5 over e7.
    const { store, world } = setup({
      tweak: (d) => {
        const infra = d.infrastructure;
        infra.nodes.find((x) => x.id === "B")!.kind = "plain";
        const prov = infra.nodes[0]!.provenance;
        infra.nodes.push(
          { id: "D", kind: "plain", provenance: prov },
          { id: "E", kind: "area_boundary", provenance: prov },
        );
        infra.edges.push(
          { ...infra.edges[0]!, id: "e7", from: "B", to: "D" },
          { ...infra.edges[0]!, id: "e8", from: "D", to: "E" },
        );
        const sig = infra.signals[0]!;
        infra.signals.push(
          {
            ...sig,
            id: "sig5",
            ref: "SIG5",
            trackNodeId: "D",
            facingTowardsNodeId: { value: "E", provenance: prov },
          },
          {
            ...sig,
            id: "sig6",
            ref: "SIG6",
            trackNodeId: "B",
            facingTowardsNodeId: { value: "D", provenance: prov },
          },
        );
        d.control!.areas[0]!.signalIds.push("sig5", "sig6");
        const r = d.signalling!.routes[0]!;
        d.signalling!.routes.push(
          {
            ...r,
            id: "r3",
            entrySignalId: "sig2",
            exitSignalId: "sig5",
            edgeIds: ["e4", "e7"],
            pointsRequired: [],
            conflictsWith: ["r4"],
          },
          {
            ...r,
            id: "r4",
            entrySignalId: "sig6",
            exitSignalId: "sig5",
            edgeIds: ["e7"],
            pointsRequired: [],
            conflictsWith: ["r3"],
          },
        );
      },
    });
    expect([world.status.get("r3"), world.status.get("r4")]).toEqual(["evidenced", "evidenced"]);
    expect(store.submit(env(setR("r3"))).outcome).toBe("accepted");
    expect(store.submit(env(setR("r4"), { version: 1 }))).toMatchObject({
      code: "ROUTE_CONFLICT",
      reason: expect.stringMatching(/conflicts with set route r3 \(declared\)/),
    });
    expect(Object.keys(store.view().routes)).toEqual(["r3"]);
  });
});

describe("required points must be proven", () => {
  it("refuses a route while required points are not detected", () => {
    const { store } = setup({ points: { pts1: { position: "normal", detected: false } } });
    expect(store.submit(env(setR("r1")))).toMatchObject({ code: "POINTS_NOT_PROVEN" });
  });

  it("refuses a route while required points are in an unknown position", () => {
    const { store } = setup({ points: { pts1: { position: "unknown", detected: false } } });
    expect(store.submit(env(setR("r1")))).toMatchObject({ code: "POINTS_NOT_PROVEN" });
  });

  it("refuses a route when points lie the wrong way; operators move points first (policy)", () => {
    const { store } = setup();
    expect(store.submit(env(setR("r2")))).toMatchObject({ code: "POINTS_WRONG_POSITION" });
    expect(store.view().points.pts1!.position).toBe("normal"); // set_route never moves points
    expect(store.submit(env(move("reverse"))).outcome).toBe("accepted");
    expect(store.submit(env(setR("r2"), { version: 1 })).outcome).toBe("accepted");
  });

  it("refuses a route whose points lie is unknown in the data, whatever the points state says", () => {
    const { store, world } = setup({
      tweak: (d) => {
        d.infrastructure.points[0]!.normalTowardsNodeId = { value: null, provenance: unknownProv };
        d.infrastructure.points[0]!.reverseTowardsNodeId = { value: null, provenance: unknownProv };
      },
    });
    expect(world.status.get("r1")).toBe("insufficient_evidence");
    expect(store.submit(env(setR("r1")))).toMatchObject({ code: "ROUTE_NOT_ESTABLISHED" });
  });
});

describe("occupied track prevents incompatible route clearance", () => {
  it("refuses a route over occupied track", () => {
    const { store } = setup({ occupancy: { e3: "occupied" } });
    expect(store.submit(env(setR("r1")))).toMatchObject({ code: "TRACK_OCCUPIED" });
    expect(store.view().signals.sig1).toBe("on");
  });

  it("treats unknown occupancy as occupied", () => {
    const { store } = setup({ occupancy: { e2: "unknown" } });
    expect(store.submit(env(setR("r1")))).toMatchObject({ code: "TRACK_NOT_PROVEN_CLEAR" });
  });

  it("checks the overlap's track as well as the route's", () => {
    const { store } = setup({
      occupancy: { e4: "occupied" },
      tweak: (d) => {
        d.signalling!.overlaps.push({
          id: "o1",
          signalId: "sig2",
          edgeIds: ["e4"],
          pointsRequired: [],
          provenance: d.signalling!.routes[0]!.provenance,
        });
        d.signalling!.routes[0]!.overlapId = "o1";
      },
    });
    expect(store.submit(env(setR("r1")))).toMatchObject({ code: "TRACK_OCCUPIED" });
  });

  it("refuses to move points on occupied or unproven track", () => {
    expect(
      setup({ occupancy: { e5: "occupied" } }).store.submit(env(move("reverse"))),
    ).toMatchObject({ code: "TRACK_OCCUPIED" });
    expect(
      setup({ occupancy: { e3: "unknown" } }).store.submit(env(move("reverse"))),
    ).toMatchObject({ code: "TRACK_NOT_PROVEN_CLEAR" });
  });
});

describe("route locking prevents prohibited conflicting changes", () => {
  it("locks the route's points until the route is cancelled", () => {
    const { store } = setup();
    store.submit(env(setR("r1")));
    expect(store.view().routes.r1!.lockedPointsIds).toEqual(["pts1"]);
    expect(store.submit(env(move("reverse"), { version: 1 }))).toMatchObject({
      code: "POINTS_LOCKED",
    });
    expect(store.submit(env(cancelR("r1"), { version: 1 })).outcome).toBe("accepted");
    expect(store.submit(env(move("reverse"), { version: 2 })).outcome).toBe("accepted");
  });

  it("does not release a route while its track is not proven clear (approach locking not modelled)", () => {
    const { world, state } = setup();
    const set = decide(world, state, env(setR("r1")));
    if (!set.accepted) throw new Error("r1 should set");
    // Occupancy is injected state until trains move: a train now stands on the route.
    const occupied = {
      ...set.state,
      occupancy: { ...set.state.occupancy, e3: "occupied" as const },
    };
    expect(code(decide(world, occupied, env(cancelR("r1"), { version: 1 })))).toBe(
      "TRACK_OCCUPIED",
    );
  });
});

describe("human and AI commands receive equivalent validation", () => {
  it("gives identical decisions for every command in every scenario", () => {
    const scenarios = [
      setup(),
      setup({ occupancy: { e3: "occupied" } }),
      setup({ points: { pts1: { position: "unknown", detected: false } } }),
    ];
    const commands: Command[] = [
      setR("r1"),
      setR("r2"),
      cancelR("r1"),
      move("reverse"),
      move("normal"),
      setR("nope"),
    ];
    for (const { world, state } of scenarios)
      for (const command of commands)
        for (const area of ["area-1", "area-2"]) {
          // The same command, from the same operator id, differing only in operator kind.
          const human = decide(world, state, env(command, { kind: "human", area, commandId: "c" }));
          const ai = decide(world, state, env(command, { kind: "ai", area, commandId: "c" }));
          expect(code(ai)).toBe(code(human));
          expect(ai).toEqual(human);
        }
  });

  it("routes both kinds through the same store and log", () => {
    const { store } = setup();
    const human = operatorHandle(store, { kind: "human", id: "op-1" });
    const ai = operatorHandle(store, { kind: "ai", id: "op-2" });
    expect(human.submit("area-1", "h-1", setR("r1")).outcome).toBe("accepted");
    expect(ai.submit("area-1", "a-1", move("reverse"))).toMatchObject({ code: "POINTS_LOCKED" });
    expect(store.log().map((e) => [e.operator?.kind, e.outcome])).toEqual([
      ["human", "accepted"],
      ["ai", "rejected"],
    ]);
  });
});

describe("rejected commands do not mutate authoritative state", () => {
  it("returns the identical frozen state and records the rejection", () => {
    const { store } = setup({ occupancy: { e3: "occupied" } });
    const before = store.view();
    const snapshot = structuredClone(before);
    for (const c of [setR("r1"), setR("r2"), move("reverse"), cancelR("r1"), setR("nope")])
      expect(store.submit(env(c)).outcome).toBe("rejected");
    expect(store.view()).toBe(before);
    expect(store.view()).toEqual(snapshot);
    expect(store.view().version).toBe(0);
    expect(store.log().map((e) => e.outcome)).toEqual(Array(5).fill("rejected"));
  });

  it("gives operators a read-only view: mutating it throws and changes nothing", () => {
    const { store } = setup();
    const ai = operatorHandle(store, { kind: "ai", id: "op-2" });
    const view = ai.view();
    expect(() => {
      (view as { version: number }).version = 99;
    }).toThrow(TypeError);
    expect(() => {
      (view.points as Record<string, unknown>).pts1 = { position: "reverse", detected: true };
    }).toThrow(TypeError);
    expect(store.view().version).toBe(0);
    expect(Object.keys(ai).sort()).toEqual(["operator", "submit", "view"]);
  });
});

describe("invalid control-area authority is rejected", () => {
  it("refuses an operator acting in an area it is not assigned", () => {
    const { store } = setup();
    expect(store.submit(env(setR("r1"), { id: "outsider", area: "area-1" }))).toMatchObject({
      code: "NOT_AUTHORISED",
    });
  });

  it("refuses an area that does not control the route's signal or points", () => {
    const { store } = setup();
    for (const kind of ["human", "ai"] as const)
      expect(store.submit(env(setR("r1"), { kind, id: "outsider", area: "area-2" }))).toMatchObject(
        { code: "NOT_AUTHORISED", reason: expect.stringMatching(/does not control sig1, pts1/) },
      );
  });
});

describe("unknown or incomplete evidence cannot bypass a safety constraint", () => {
  it("allows a labelled game-rule route but never an invalid or unproven one", () => {
    const gameRule = setup({
      tweak: (d) => {
        d.signalling!.routes[0]!.provenance = {
          evidence: "inferred",
          sources: [],
          note: "SYNTHETIC game rule",
        };
      },
    });
    expect(gameRule.world.status.get("r1")).toBe("game_rule");
    expect(gameRule.store.submit(env(setR("r1"))).outcome).toBe("accepted");

    const invalid = setup({ tweak: (d) => (d.signalling!.routes[0]!.pointsRequired = []) });
    expect(invalid.world.status.get("r1")).toBe("invalid");
    expect(invalid.store.submit(env(setR("r1")))).toMatchObject({ code: "ROUTE_NOT_ESTABLISHED" });
  });

  it("can tighten the policy to evidenced-only routes", () => {
    const { store } = setup({
      policy: { ...DEFAULT_POLICY, allowedRouteStatuses: ["evidenced"] },
      tweak: (d) => {
        d.signalling!.routes[0]!.provenance = {
          evidence: "inferred",
          sources: [],
          note: "SYNTHETIC",
        };
      },
    });
    expect(store.submit(env(setR("r1")))).toMatchObject({ code: "ROUTE_NOT_ESTABLISHED" });
  });

  it("cannot be configured to switch a fail-safe rule off", () => {
    for (const bad of [
      { unknownOccupancy: "treat_as_clear" },
      { routeSettingMovesPoints: true },
      { allowedRouteStatuses: ["evidenced", "insufficient_evidence"] },
      { allowedRouteStatuses: [] },
      { cancelRequiresClearTrack: false },
    ])
      expect(SimulationPolicy.safeParse({ ...DEFAULT_POLICY, ...bad }).success).toBe(false);
  });

  it("starts fail-safe: unknown points, unknown occupancy, all signals on", () => {
    const { world } = setup();
    const s = initialState(world);
    expect(s.points.pts1).toEqual({ position: "unknown", detected: false });
    expect(Object.values(s.occupancy).every((o) => o === "unknown")).toBe(true);
    expect(Object.values(s.signals).every((a) => a === "on")).toBe(true);
    expect(code(decide(world, s, env(setR("r1"))))).toBe("POINTS_NOT_PROVEN");
  });
});

describe("repeated, stale and malformed commands", () => {
  it("applies a repeated command once and returns the original outcome", () => {
    const { store } = setup();
    const e = env(setR("r1"), { commandId: "same" });
    expect(store.submit(e).outcome).toBe("accepted");
    const again = store.submit(e);
    expect(again).toMatchObject({ outcome: "duplicate", original: { outcome: "accepted" } });
    expect(store.view().version).toBe(1);
  });

  it("refuses a command id reused for a different command", () => {
    const { store } = setup();
    store.submit(env(setR("r1"), { commandId: "same" }));
    expect(store.submit(env(cancelR("r1"), { commandId: "same", version: 1 }))).toMatchObject({
      code: "COMMAND_ID_REUSED",
    });
    expect(store.view().routes.r1).toBeDefined();
  });

  it("refuses a command based on a stale version", () => {
    const { store } = setup();
    store.submit(env(move("reverse")));
    expect(store.submit(env(move("normal"), { version: 0 }))).toMatchObject({ code: "STALE" });
    expect(store.view().points.pts1!.position).toBe("reverse");
  });

  it("refuses a malformed envelope", () => {
    const { store } = setup();
    expect(store.submit({ commandId: "x", command: { type: "derail" } })).toMatchObject({
      code: "MALFORMED",
    });
  });
});

describe("publisher interface", () => {
  it("receives the authoritative state after each submission", () => {
    const updates: StateUpdate[] = [];
    const { world, state } = setup();
    const store = new CommandStore(world, state, { publish: (u) => updates.push(u) });
    store.submit(env(setR("r1")));
    store.submit(env(setR("r1"), { version: 1 }));
    expect(updates.map((u) => [u.version, u.event.outcome, u.event.code])).toEqual([
      [1, "accepted", undefined],
      [1, "rejected", "ROUTE_ALREADY_SET"],
    ]);
    expect(updates[0]!.state).toBe(store.view());
  });
});
