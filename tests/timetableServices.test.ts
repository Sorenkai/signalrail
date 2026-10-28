/**
 * Timetable services (P5, ADR 0001 "Timetable services", D-035): the service plan, train entry
 * at a fringe, pending services, exit and replay.
 *
 * Layout, routes, timetable, services, patterns, trains and operators are all SYNTHETIC
 * (fixtures/synthetic/timetable.ts has the diagram). Train length and speed are session game
 * settings. These tests prove the model's internal consistency, not that any real train
 * describer, acceptance procedure or timetable behaves like this.
 */
import { describe, expect, it } from "vitest";
import {
  syntheticPatterns,
  syntheticService,
  syntheticSnapshot,
  syntheticTimetableDataset,
} from "../fixtures/synthetic/timetable.ts";
import type { Service, ServicePatternsFile, TimetableSnapshot } from "../src/model/index.ts";
import {
  CommandStore,
  DEFAULT_POLICY,
  TICK_STAGES,
  createWorld,
  decideTick,
  deriveOccupancy,
  hasLeftPlay,
  initialState,
  replay,
  routeChainBlockers,
  routeSignalIssues,
  serviceEntryStage,
  serviceIssues,
  stateTrainIssues,
  summarisePlan,
  timetableSessionConfig,
  type AuthoritativeState,
  type Command,
  type SimInput,
  type SimWorld,
  type TimetableSessionConfig,
  type TrainSpec,
} from "../src/sim/index.ts";
import { validateServicePatterns } from "../src/validation/servicePatterns.ts";
import type { ValidationInput } from "../src/validation/validate.ts";

const M = 1000;
const H = 3_600_000;
const DATE = "2026-11-04";
const POLICY = { ...DEFAULT_POLICY, approachLockReleaseMs: 5000 };

/** SYNTHETIC service passing SYNBEF at 06:00: due at 6 h. */
const s1 = (o: Partial<Parameters<typeof syntheticService>[0]> = {}) =>
  syntheticService({ uid: "Z00001", runDate: DATE, before: "06:00", ...o });

function worldFor(
  o: {
    services?: Service[];
    snapshot?: TimetableSnapshot;
    patterns?: ServicePatternsFile;
    config?: Partial<TimetableSessionConfig>;
    tweak?: (d: ValidationInput) => void;
    date?: string;
  } = {},
): SimWorld {
  const d = syntheticTimetableDataset();
  o.tweak?.(d);
  const date = o.date ?? DATE;
  return createWorld(
    {
      infrastructure: d.infrastructure,
      signalling: d.signalling!,
      control: d.control!,
      sources: d.sources,
      gameRules: d.gameRules!,
      playableArea: d.playableArea!,
      timetable: {
        snapshot: o.snapshot ?? syntheticSnapshot(date, o.services ?? [s1()]),
        patterns: o.patterns ?? syntheticPatterns(),
        config: timetableSessionConfig(date, {
          trainLengthMm: 100 * M,
          trainSpeedMmPerS: 20 * M,
          ...o.config,
        }),
      },
    },
    POLICY,
    { "op-1": ["area-1"] },
  );
}

function consistent(world: SimWorld, s: AuthoritativeState) {
  expect(stateTrainIssues(world, s)).toEqual([]);
  expect(routeSignalIssues(world, s)).toEqual([]);
  expect(serviceIssues(world, s)).toEqual([]);
  expect(s.occupancy).toEqual(deriveOccupancy(s.trackStatus, s.trains));
  const owner = new Map<string, string>();
  for (const t of Object.values(s.trains))
    for (const p of t.path) {
      expect(owner.get(p.edgeId), `edge ${p.edgeId}`).toBeUndefined();
      owner.set(p.edgeId, t.id);
    }
}

function setup(
  o: Parameters<typeof worldFor>[0] & {
    startTimeMs?: number;
    occupancy?: Record<string, "clear" | "unknown" | "occupied">;
    trains?: TrainSpec[];
  } = {},
) {
  const world = worldFor(o);
  const clear = Object.fromEntries(world.infrastructure.edges.map((e) => [e.id, "clear" as const]));
  const initial = initialState(world, {
    occupancy: { ...clear, ...o.occupancy },
    points: { pts1: { position: "normal", detected: true } },
    clock: { startTimeMs: o.startTimeMs ?? 6 * H - 3000, tickDurationMs: 1000 },
    trains: o.trains ?? [],
  });
  const store = new CommandStore(world, initial);
  const inputs: SimInput[] = [];
  let n = 0;
  const submit = (command: Command) => {
    const envelope = {
      commandId: `c${++n}`,
      operator: { kind: "human" as const, id: "op-1" },
      controlAreaId: "area-1",
      expectedVersion: store.view().version,
      command,
    };
    inputs.push({ kind: "command", envelope });
    return store.submit(envelope);
  };
  const tick = (times = 1) => {
    const changes: string[] = [];
    for (let i = 0; i < times; i++) {
      const request = { tick: store.view().clock.tick + 1 };
      inputs.push({ kind: "tick", request });
      const r = store.tick(request);
      expect(r.outcome).toBe("accepted");
      if (r.outcome === "accepted") changes.push(...r.changes);
      consistent(world, store.view());
    }
    return changes;
  };
  /** Tick until `pred` holds (max 500 ticks). */
  const until = (pred: (s: AuthoritativeState) => boolean) => {
    for (let i = 0; i < 500; i++) {
      if (pred(store.view())) return;
      tick();
    }
    throw new Error(
      `condition never reached: ${JSON.stringify(Object.values(store.view().trains).map((t) => [t.path, t.headOffsetMm, t.stopped]))}`,
    );
  };
  return { world, initial, store, submit, tick, until, inputs };
}

const setR = (routeId: string): Command => ({ type: "set_route", routeId });
const TRAIN = "svc-Z00001-2026-11-04";
const SYN_AREA = ["SYNSTA", "SYNJN"];

/** The synthetic world's valid fringes, in the shape validateServicePatterns takes. */
function worldFringes() {
  const d = syntheticTimetableDataset();
  const world = worldFor();
  return new Map(
    [...world.fringes.keys()].map((id) => [
      id,
      {
        endpoint: d.gameRules!.fringeEndpoints.find((f) => f.id === id)!,
        cut: d.playableArea!.cuts.find((c) => c.id === world.fringes.get(id)!.cutId)!,
      },
    ]),
  );
}

describe("service plan", () => {
  it("classifies services and never forces one onto a route", () => {
    const world = worldFor({
      services: [
        s1(), // passes SYNSTA: representable
        syntheticService({ uid: "Z00002", runDate: DATE, before: "07:00", stop: true }),
        syntheticService({ uid: "Z00003", runDate: DATE, before: "08:00", platform: "2" }),
        syntheticService({ uid: "Z00004", runDate: DATE, before: "09:00", beforeTiploc: "SYNOTH" }),
      ],
    });
    const plan = world.timetable!;
    const by = Object.fromEntries(plan.entries.map((e) => [e.uid, e]));
    expect(by.Z00001).toMatchObject({ classification: "representable", reasons: [] });
    expect(by.Z00002).toMatchObject({
      classification: "approximated",
      reasons: [{ code: "STATION_CALL_NOT_SIMULATED" }],
    });
    expect(by.Z00003).toMatchObject({
      classification: "unsupported",
      reasons: [
        { code: "PATTERN_FIELD_MISMATCH", detail: "pat-syn: SYNSTA platform 2; pattern needs 1" },
      ],
      run: null,
    });
    expect(by.Z00004).toMatchObject({
      classification: "unsupported",
      reasons: [{ code: "NO_PATTERN" }],
      observedPath: "SYNOTH > SYNSTA(1) > SYNJN > SYNAFT",
    });
    expect(by.Z00001!.run).toMatchObject({
      trainId: TRAIN,
      dueAtMs: 6 * H,
      dueLocal: "2026-11-04T06:00:00",
      dueTiploc: "SYNBEF",
      routeIds: ["ra", "r0", "r1", "r5"],
      lengthMm: 100 * M,
      characteristics: "session_default",
      entryPath: [{ edgeId: "e0", towardsNodeId: "A" }],
      entryHeadOffsetMm: 100 * M,
    });
    expect(summarisePlan(plan)).toEqual({
      total: 4,
      byClass: { representable: 1, approximated: 1, unsupported: 2, invalid: 0 },
      byCode: { STATION_CALL_NOT_SIMULATED: 1, PATTERN_FIELD_MISMATCH: 1, NO_PATTERN: 1 },
    });
    // Only runnable services reach the state.
    expect(Object.keys(initialState(world).services).sort()).toEqual([
      "Z00001:2026-11-04",
      "Z00002:2026-11-04",
    ]);
  });

  it("quarantines invalid and incomplete records with diagnostics, never repairing them", () => {
    const badTime = s1({ uid: "Z00011", sta: "25:10" });
    const noTime = s1({ uid: "Z00012" });
    const mid = noTime.calls[3]!;
    noTime.calls[3] = { ...mid, pass: null };
    const dup = s1({ uid: "Z00013" });
    const holiday = { ...s1({ uid: "Z00014" }), bankHolidayRunning: "X" };
    const plan = worldFor({
      services: [badTime, noTime, dup, structuredClone(dup), holiday],
    }).timetable!;
    const reasons = (uid: string) =>
      plan.entries.filter((e) => e.uid === uid).map((e) => [e.classification, e.reasons[0]]);
    expect(reasons("Z00011")).toEqual([
      ["invalid", expect.objectContaining({ code: "TIMETABLE_INVALID" })],
    ]);
    expect(reasons("Z00011")[0]![1]).toMatchObject({ detail: /TIMETABLE_TIME_INVALID/ });
    expect(reasons("Z00012")[0]![1]).toMatchObject({ detail: /TIMETABLE_JOURNEY_INCOMPLETE/ });
    expect(reasons("Z00013")).toEqual([
      ["invalid", expect.objectContaining({ code: "DUPLICATE_SERVICE_ID" })],
      ["invalid", expect.objectContaining({ code: "DUPLICATE_SERVICE_ID" })],
    ]);
    expect(reasons("Z00014")).toEqual([
      ["unsupported", expect.objectContaining({ code: "BANK_HOLIDAY_UNRESOLVED" })],
    ]);
    expect(plan.entries.every((e) => e.run === null)).toBe(true);
  });

  it("refuses a snapshot without an operating-day rule, for another date, or with errors", () => {
    const legacy = syntheticSnapshot(DATE, [s1()]);
    delete legacy.convention;
    expect(() => worldFor({ snapshot: legacy })).toThrow(/no operating-day convention/);
    expect(() => worldFor({ snapshot: syntheticSnapshot("2026-11-05", [s1()]) })).toThrow(
      /not operating date 2026-11-04/,
    );
    const broken = syntheticSnapshot(DATE, [s1()]);
    broken.import!.parseErrors = 1;
    expect(() => worldFor({ snapshot: broken })).toThrow(/TIMETABLE_PARSE_ERRORS/);
  });

  it("orders services due at the same instant by service id, whatever the snapshot order", () => {
    const a = s1({ uid: "Z00002" });
    const b = s1({ uid: "Z00001" });
    const c = syntheticService({ uid: "Z00000", runDate: DATE, before: "06:01" });
    for (const services of [
      [a, b, c],
      [c, b, a],
    ])
      expect(
        worldFor({ services })
          .timetable!.entries.filter((e) => e.run)
          .map((e) => e.uid),
      ).toEqual(["Z00001", "Z00002", "Z00000"]);
  });

  it("places overnight and day-boundary services on the operating day's timeline", () => {
    const plan = worldFor({
      services: [
        // Started the day before; due 23:50 on 11-03, in play at 00:05 on the operating day.
        syntheticService({
          uid: "Z00021",
          runDate: "2026-11-03",
          before: "23:50",
          sta: "00:05",
          jn: "00:06",
          after: "00:08",
        }),
        // Late on the operating day.
        syntheticService({ uid: "Z00022", runDate: DATE, before: "23:50" }),
        // In play only after the operating day ends: outside the window, so invalid.
        syntheticService({
          uid: "Z00023",
          runDate: DATE,
          before: "23:58",
          sta: "00:03",
          jn: "00:04",
          after: "00:06",
        }),
      ],
    }).timetable!;
    const due = Object.fromEntries(plan.entries.map((e) => [e.uid, e.run?.dueAtMs ?? null]));
    expect(due).toEqual({ Z00021: -10 * 60_000, Z00022: 23 * H + 50 * 60_000, Z00023: null });
    expect(plan.entries.find((e) => e.uid === "Z00023")!.reasons[0]!.detail).toMatch(
      /TIMETABLE_WINDOW/,
    );
  });

  it("never resolves a spring-forward or fall-back local time by guessing", () => {
    const spring = worldFor({
      date: "2026-03-29",
      snapshot: syntheticSnapshot(
        "2026-03-29",
        [
          syntheticService({ uid: "Z00031", runDate: "2026-03-29", before: "01:30" }),
          syntheticService({ uid: "Z00032", runDate: "2026-03-29", before: "03:00" }),
        ],
        { clockChangeInWindow: true },
      ),
    }).timetable!;
    expect(spring.entries.map((e) => [e.uid, e.reasons[0]?.code ?? e.run!.dueAtMs])).toEqual([
      ["Z00032", 2 * H],
      ["Z00031", "TIME_NONEXISTENT"],
    ]);
    const autumn = worldFor({
      date: "2026-10-25",
      snapshot: syntheticSnapshot(
        "2026-10-25",
        [
          syntheticService({ uid: "Z00041", runDate: "2026-10-25", before: "01:30" }),
          syntheticService({ uid: "Z00042", runDate: "2026-10-25", before: "02:30" }),
        ],
        { clockChangeInWindow: true },
      ),
    }).timetable!;
    expect(autumn.entries.map((e) => [e.uid, e.reasons[0]?.code ?? e.run!.dueAtMs])).toEqual([
      ["Z00042", 3.5 * H],
      ["Z00041", "TIME_AMBIGUOUS"],
    ]);
  });

  it("marks services unsupported when the train cannot be placed or cannot leave", () => {
    const tooLongToEnter = worldFor({ config: { trainLengthMm: 500 * M } }).timetable!;
    expect(tooLongToEnter.entries[0]).toMatchObject({ classification: "unsupported" });
    expect(tooLongToEnter.entries[0]!.reasons.map((r) => r.code)).toEqual([
      "ENTRY_PLACEMENT",
      "EXIT_TOO_SHORT",
    ]);
    const tooLongToLeave = worldFor({
      config: { trainLengthMm: 500 * M },
      tweak: (d) => {
        d.infrastructure.edges.find((e) => e.id === "e0")!.lengthM = 1000;
      },
    }).timetable!;
    expect(tooLongToLeave.entries[0]).toMatchObject({
      classification: "unsupported",
      reasons: [{ code: "EXIT_TOO_SHORT" }],
    });
    const notEstablished = worldFor({
      tweak: (d) => {
        d.signalling!.routes.find((r) => r.id === "r0")!.provenance = {
          evidence: "unknown",
          sources: [],
        };
      },
    }).timetable!;
    expect(notEstablished.entries[0]).toMatchObject({
      classification: "unsupported",
      reasons: [
        { code: "ROUTE_NOT_ESTABLISHED", detail: "r0 has data status insufficient_evidence" },
      ],
    });
    // An unsupported service never enters, however long the session runs.
    const { store, submit, tick } = setup({ config: { trainLengthMm: 500 * M } });
    expect(store.view().services).toEqual({});
    submit(setR("ra"));
    tick(20);
    expect(store.view().trains).toEqual({});
  });

  it("drops an invalid pattern (fail closed): its services become unsupported", () => {
    const patterns = syntheticPatterns({ routeIds: ["ra", "r3"] });
    const d = syntheticTimetableDataset();
    const world = worldFor({ patterns });
    const check = validateServicePatterns(
      patterns,
      d.signalling,
      new Map(
        [...world.fringes.keys()].map((id) => [
          id,
          {
            endpoint: d.gameRules!.fringeEndpoints.find((f) => f.id === id)!,
            cut: d.playableArea!.cuts.find((c) => c.id === world.fringes.get(id)!.cutId)!,
          },
        ]),
      ),
      { area: new Set(["SYNSTA", "SYNJN"]), deferred: new Set() },
    );
    expect(check.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: "service pattern pat-syn: route r3 does not start at the exit signal of ra",
      }),
    );
    expect(world.timetable!.entries[0]).toMatchObject({
      classification: "unsupported",
      reasons: [{ code: "NO_PATTERN" }],
    });
  });

  it("gives the synthetic entry route a game_rule status", () => {
    expect(worldFor().status.get("ra")).toBe("game_rule");
  });
});

describe("service entry", () => {
  it("enters exactly once at its due time when accepted, through the shared tick path", () => {
    const { world, store, submit, tick } = setup();
    expect(submit(setR("ra")).outcome).toBe("accepted");
    tick(2); // 21 599 000 ms: not yet due
    expect(store.view().services["Z00001:2026-11-04"]).toMatchObject({ status: "scheduled" });
    expect(store.view().trains).toEqual({});
    const changes = tick();
    expect(store.view().clock.timeMs).toBe(6 * H);
    expect(changes).toContain(
      `service Z00001:2026-11-04 (9Z99) entered play at fringe fr-a as train ${TRAIN}, taking route ra (0 ms after due)`,
    );
    const s = store.view();
    expect(s.trains[TRAIN]).toMatchObject({
      lengthMm: 100 * M,
      speedMmPerS: 20 * M,
      path: [{ edgeId: "e0", towardsNodeId: "A" }],
      headOffsetMm: 100 * M,
      authority: ["ra"],
      service: { serviceId: "Z00001:2026-11-04", headcode: "9Z99" },
    });
    expect(s.routes.ra!.takenBy).toBe(TRAIN);
    expect(s.services["Z00001:2026-11-04"]).toMatchObject({
      status: "active",
      enteredAtMs: 6 * H,
    });
    // Running the entry stage again changes nothing; a repeated tick is a duplicate.
    expect(serviceEntryStage.run(world, s).state).toBe(s);
    expect(store.tick({ tick: s.clock.tick })).toMatchObject({ outcome: "duplicate" });
    expect(store.view()).toBe(s);
    tick(30);
    expect(Object.keys(store.view().trains)).toEqual([TRAIN]);
  });

  it("waits visibly, with a stable reason, until the entry route is set", () => {
    const { store, submit, tick } = setup();
    tick(2);
    expect(tick()).toEqual([
      "clock tick 3: 21599000 ms -> 21600000 ms",
      "service Z00001:2026-11-04 (9Z99) due at 2026-11-04T06:00:00 (SYNBEF): waiting, entry route ra is not set",
    ]);
    expect(store.view().services["Z00001:2026-11-04"]).toMatchObject({
      status: "pending",
      waiting: "entry route ra is not set",
    });
    expect(tick(3)).toHaveLength(3); // only clock lines: the same reason is not repeated
    submit(setR("ra"));
    expect(tick()).toContain(
      `service Z00001:2026-11-04 (9Z99) entered play at fringe fr-a as train ${TRAIN}, taking route ra (4000 ms after due)`,
    );
  });

  it("never enters onto occupied or unproven entry track", () => {
    // Unknown track blocks setting the entry route at all.
    const unknown = setup({ occupancy: { e0: "unknown" } });
    expect(unknown.submit(setR("ra"))).toMatchObject({ code: "TRACK_NOT_PROVEN_CLEAR" });
    unknown.tick(5);
    expect(unknown.store.view().services["Z00001:2026-11-04"]!.waiting).toBe(
      "entry route ra is not set",
    );
    // Crafted: the route is offered but the track is no longer proven clear.
    const { world, store, submit } = setup();
    submit(setR("ra"));
    for (const status of ["unknown", "occupied"] as const) {
      const s = store.view();
      const trackStatus = { ...s.trackStatus, e0: status };
      let next: AuthoritativeState = {
        ...s,
        trackStatus,
        occupancy: deriveOccupancy(trackStatus, s.trains),
      };
      for (let n = 1; n <= 3; n++) {
        const r = decideTick(world, next, { tick: n });
        if (r.outcome !== "accepted") throw new Error("tick refused");
        next = r.state;
      }
      expect(next.trains).toEqual({});
      expect(next.services["Z00001:2026-11-04"]).toMatchObject({
        status: "pending",
        waiting: `entry track e0 is ${status === "unknown" ? "not proven clear" : "occupied"}`,
      });
    }
  });

  for (const [what, services] of [
    ["lower id listed first", [s1(), s1({ uid: "Z00002" })]],
    ["lower id listed last", [s1({ uid: "Z00002" }), s1()]],
  ] as const)
    it(`queues services due together at one fringe in service-id order (${what})`, () => {
      const { store, submit, tick, until } = setup({ services: [...services] });
      submit(setR("ra"));
      submit(setR("r0"));
      tick(3);
      const s = store.view();
      expect(Object.keys(s.trains)).toEqual([TRAIN]);
      expect(s.services["Z00002:2026-11-04"]).toMatchObject({
        status: "pending",
        waiting: `entry route ra is taken by train ${TRAIN}`,
      });
      // The first train clears e0; ra is released; the signaller accepts the second.
      until((x) => x.routes.ra === undefined);
      expect(store.view().services["Z00002:2026-11-04"]!.waiting).toBe("entry route ra is not set");
      submit(setR("ra"));
      tick();
      expect(Object.keys(store.view().trains).sort()).toEqual([TRAIN, "svc-Z00002-2026-11-04"]);
    });

  it("lets an earlier-due service go first even when its id sorts later", () => {
    const early = syntheticService({ uid: "Z00009", runDate: DATE, before: "05:59" });
    const { store, submit, tick } = setup({ services: [s1(), early] });
    submit(setR("ra"));
    tick(3);
    expect(Object.keys(store.view().trains)).toEqual(["svc-Z00009-2026-11-04"]);
    expect(store.view().services["Z00001:2026-11-04"]!.status).toBe("pending");
  });

  it("refuses a placed train that takes a service's train id, or a crafted service train", () => {
    const world = worldFor();
    expect(() =>
      initialState(world, {
        trains: [
          {
            id: TRAIN,
            lengthMm: 1,
            speedMmPerS: 0,
            path: [{ edgeId: "e1", towardsNodeId: "N1" }],
            headOffsetMm: 10,
          },
        ],
        occupancy: Object.fromEntries(
          world.infrastructure.edges.map((e) => [e.id, "clear" as const]),
        ),
      }),
    ).toThrow(/reserved for service/);
    const { store, initial } = setup();
    const ghost = {
      ...initial.services,
      "Z00009:2026-11-04": initial.services["Z00001:2026-11-04"]!,
    };
    expect(() => new CommandStore(world, { ...initial, services: ghost })).toThrow(
      /services are inconsistent/,
    );
    expect(store.view()).toBe(initial);
  });
});

describe("service exit", () => {
  function runThrough() {
    const t = setup();
    for (const r of ["ra", "r0", "r1", "r5"]) expect(t.submit(setR(r)).outcome).toBe("accepted");
    return t;
  }

  it("leaves play only once the whole train stands on the exit cut edge", () => {
    const { world, store, tick, until } = runThrough();
    until((s) => s.trains[TRAIN]?.path.at(-1)?.edgeId === "e4");
    // On the exit cut edge, but the head is not yet at the outside node: still in play.
    let s = store.view();
    expect(s.trains[TRAIN]!.headOffsetMm).toBeLessThan(400 * M);
    expect(s.services["Z00001:2026-11-04"]!.status).toBe("active");
    until((x) => x.services["Z00001:2026-11-04"]!.status === "departed");
    s = store.view();
    expect(s.trains).toEqual({});
    expect(s.routes).toEqual({});
    expect(Object.values(s.signals).every((x) => x === "on")).toBe(true);
    const svc = s.services["Z00001:2026-11-04"]!;
    expect(svc).toMatchObject({ status: "departed", departedAtMs: s.clock.timeMs });
    // Never counted twice and never reappears.
    const after = tick(50);
    expect(after.filter((c) => !c.startsWith("clock"))).toEqual([]);
    expect(store.view().services).toBe(s.services);
    // A crafted train with its head at the outside node but its tail behind the cut has not left.
    const run = world.timetable!.entries[0]!.run!;
    const straddling = {
      id: TRAIN,
      lengthMm: 450 * M,
      speedMmPerS: 0,
      path: [
        { edgeId: "e3", towardsNodeId: "N2" },
        { edgeId: "e4", towardsNodeId: "B" },
      ],
      headOffsetMm: 400 * M,
      residue: 0,
      authority: ["r5"],
      stopped: null,
    };
    expect(hasLeftPlay(world, straddling, run)).toBe(false);
    expect(
      hasLeftPlay(world, { ...straddling, lengthMm: 100 * M, path: [straddling.path[1]!] }, run),
    ).toBe(true);
    expect(
      hasLeftPlay(world, { ...straddling, path: [straddling.path[1]!], authority: [] }, run),
    ).toBe(false);
  });

  it("releases the routes the departing train had taken in the same tick", () => {
    const { store, until, tick } = runThrough();
    until(
      (s) =>
        s.trains[TRAIN]?.path.at(-1)?.edgeId === "e4" && s.trains[TRAIN]!.headOffsetMm >= 380 * M,
    );
    const changes = tick();
    expect(changes).toEqual(
      expect.arrayContaining([
        `service Z00001:2026-11-04 (9Z99) left play at fringe fr-b as train ${TRAIN}`,
        `route r5 released: train ${TRAIN} has left play`,
      ]),
    );
    expect(store.view().routes).toEqual({});
  });
});

describe("determinism", () => {
  it("replays a full timetable session to an identical state and byte-identical log", () => {
    const run = () => {
      const t = setup({ services: [s1(), s1({ uid: "Z00002" })] });
      for (const r of ["ra", "r0", "r1", "r5"]) t.submit(setR(r));
      t.until((s) => s.services["Z00001:2026-11-04"]!.status === "departed");
      for (const r of ["ra", "r0", "r1", "r5"]) t.submit(setR(r));
      t.until((s) => s.services["Z00002:2026-11-04"]!.status === "departed");
      return t;
    };
    const a = run();
    const b = run();
    expect(JSON.stringify(a.store.view())).toBe(JSON.stringify(b.store.view()));
    expect(JSON.stringify(a.store.log())).toBe(JSON.stringify(b.store.log()));
    const r = replay(a.world, a.initial, a.inputs);
    expect(JSON.stringify(r.state)).toBe(JSON.stringify(a.store.view()));
    expect(JSON.stringify(r.events)).toBe(JSON.stringify(a.store.log()));
    expect(TICK_STAGES.map((s) => s.name)).toContain("service-entry");
  });
});

describe("P6 route-chain, pattern-overlap and planned-routing checks (D-036)", () => {
  const syn = (patterns: ServicePatternsFile) => worldFor({ patterns }).timetable!.entries[0]!;

  it("refuses a chain whose route passes a stop signal facing the train (ROUTE_CHAIN_BLOCKED)", () => {
    // r3 runs sig1 -> fr-b straight past main signal sig2: it can be set, never run whole.
    const e = syn(syntheticPatterns({ routeIds: ["ra", "r0", "r3"] }));
    expect(e.classification).toBe("unsupported");
    expect(e.run).toBeNull();
    expect(e.reasons.map((r) => r.code)).toEqual(["ROUTE_CHAIN_BLOCKED"]);
    expect(e.reasons[0]!.detail).toMatch(
      /signal \S+ \(main\) at N2 faces the movement inside route r3/,
    );
    // The P5 chain is clear: only entry signals, each at its own route's start.
    expect(routeChainBlockers(worldFor(), ["ra", "r0", "r1", "r5"])).toEqual([]);
  });

  it("judges an intermediate signal by its function: repeaters pass, unknown functions block", () => {
    const as = (fn: "repeater" | "unknown" | "distant" | "stop_board") =>
      worldFor({
        patterns: syntheticPatterns({ routeIds: ["ra", "r0", "r3"] }),
        tweak: (d) => {
          d.infrastructure.signals.find((s) => s.id === "sig2")!.function = fn;
          // r5 starts at sig2; with sig2 no longer a worked stop it cannot authorise r5.
          d.signalling!.routes = d.signalling!.routes.filter((r) => r.id !== "r5");
        },
      }).timetable!.entries[0]!;
    expect(as("repeater").reasons.map((r) => r.code)).not.toContain("ROUTE_CHAIN_BLOCKED");
    expect(as("distant").reasons.map((r) => r.code)).not.toContain("ROUTE_CHAIN_BLOCKED");
    for (const fn of ["unknown", "stop_board"] as const) {
      const e = as(fn);
      expect(e.classification, fn).toBe("unsupported");
      expect(e.reasons[0]).toMatchObject({ code: "ROUTE_CHAIN_BLOCKED" });
      expect(e.reasons[0]!.detail).toContain("is never passed");
    }
  });

  it("refuses two patterns that one service could match, and accepts them once a check separates them", () => {
    const base = syntheticPatterns().patterns[0]!;
    const twin = (o: Partial<typeof base>) => ({ ...structuredClone(base), id: "pat-syn-2", ...o });
    const check = (patterns: ServicePatternsFile) =>
      validateServicePatterns(patterns, syntheticTimetableDataset().signalling, worldFringes(), {
        area: new Set(SYN_AREA),
        deferred: new Set(),
      });
    const overlapping = { datasetId: "synthetic", patterns: [base, twin({})] };
    const r = check(overlapping);
    expect([...r.invalid].sort()).toEqual(["pat-syn", "pat-syn-2"]);
    expect(r.issues.filter((i) => i.code === "SERVICE_PATTERN_OVERLAP")).toHaveLength(2);
    // Fail closed: the service that matched pat-syn alone now matches nothing usable.
    expect(syn(overlapping)).toMatchObject({
      classification: "unsupported",
      reasons: [{ code: "NO_PATTERN" }],
    });
    // A platform check, or line checks with no common value, tell them apart.
    const separated = [
      twin({ through: [{ tiploc: "SYNSTA", platform: "2" }, { tiploc: "SYNJN" }] }),
      twin({
        through: [{ tiploc: "SYNSTA", platform: "1", lines: ["GL"] }, { tiploc: "SYNJN" }],
      }),
    ];
    const withLines = {
      ...structuredClone(base),
      through: [{ tiploc: "SYNSTA", platform: "1", lines: [null] }, { tiploc: "SYNJN" }],
    };
    for (const p of separated)
      expect(check({ datasetId: "synthetic", patterns: [withLines, p] }).invalid.size).toBe(0);
    // Lines that share a value (blank) still overlap.
    const shared = twin({
      through: [{ tiploc: "SYNSTA", platform: "1", lines: [null, "GL"] }, { tiploc: "SYNJN" }],
    });
    expect(check({ datasetId: "synthetic", patterns: [withLines, shared] }).invalid.size).toBe(2);
  });

  it("keeps a service train off a route outside its planned chain, until the right one is set", () => {
    // r1 (sig1 -> sig2, pts1 normal) is the planned route; r2 (sig1 -> sig3, pts1 reverse) is not.
    const { store, submit, tick, until } = setup();
    expect(submit(setR("ra")).outcome).toBe("accepted");
    expect(submit(setR("r0")).outcome).toBe("accepted");
    expect(submit({ type: "move_points", pointsId: "pts1", position: "reverse" }).outcome).toBe(
      "accepted",
    );
    expect(submit(setR("r2")).outcome).toBe("accepted");
    tick(3);
    until((s) => s.trains[TRAIN]?.stopped?.code === "ROUTE_NOT_PLANNED");
    const held = store.view();
    expect(held.trains[TRAIN]!.stopped).toMatchObject({ code: "ROUTE_NOT_PLANNED", at: "N1" });
    expect(held.routes.r2!.takenBy ?? null).toBeNull();
    expect(held.signals.sig1).toBe("off");
    // It stays put: no movement, the wrong route untaken, whatever the time.
    tick(20);
    expect(store.view().trains[TRAIN]!.path).toEqual(held.trains[TRAIN]!.path);
    expect(store.view().trains[TRAIN]!.headOffsetMm).toBe(held.trains[TRAIN]!.headOffsetMm);
    // The signaller cancels r2: the train is approaching, so it is approach locked (5 s here).
    expect(submit({ type: "cancel_route", routeId: "r2" }).outcome).toBe("accepted");
    expect(submit(setR("r1"))).toMatchObject({ outcome: "rejected" });
    until((s) => s.routes.r2 === undefined);
    expect(submit({ type: "move_points", pointsId: "pts1", position: "normal" }).outcome).toBe(
      "accepted",
    );
    expect(submit(setR("r1")).outcome).toBe("accepted");
    expect(submit(setR("r5")).outcome).toBe("accepted");
    until((s) => s.services["Z00001:2026-11-04"]!.status === "departed");
    expect(store.view().trains).toEqual({});
  });

  it("still lets a placed (non-service) train take any offered route from its signal", () => {
    // Placed trains have no planned chain (P3 behaviour, unchanged).
    const { store, submit, until } = setup({
      services: [],
      trains: [
        {
          id: "placed-1",
          lengthMm: 100 * M,
          speedMmPerS: 20 * M,
          path: [{ edgeId: "e1", towardsNodeId: "N1" }],
          headOffsetMm: 1000 * M, // head at N1, sig1
        },
      ],
    });
    expect(submit({ type: "move_points", pointsId: "pts1", position: "reverse" }).outcome).toBe(
      "accepted",
    );
    expect(submit(setR("r2")).outcome).toBe("accepted");
    until((s) => s.trains["placed-1"]!.authority.includes("r2"));
    expect(store.view().routes.r2!.takenBy).toBe("placed-1");
  });
});

describe("P7 journeys that end in a deferred area beyond the exit fringe (D-037)", () => {
  /** SYNTHETIC: SYNYRD is a deferred-area TIPLOC beyond cut-b, where the schedule ends. */
  const YARD = "SYNYRD";
  const endsInYard = (o: Partial<Parameters<typeof syntheticService>[0]> = {}): Service => {
    const s = s1(o);
    const jn = s.calls.findIndex((c) => c.tiploc === "SYNJN");
    const t = s.calls[jn]!.pass!;
    const arr = `${t.slice(0, 3)}${String(Number(t.slice(3, 5)) + 3).padStart(2, "0")}`;
    return {
      ...s,
      calls: [
        ...s.calls.slice(0, jn + 1),
        { ...s.calls[jn]!, tiploc: YARD, kind: "destination", pass: null, arrival: arr },
      ],
    };
  };
  const yardSnapshot = (services: Service[]) => {
    const t = syntheticSnapshot(DATE, services);
    t.import!.deferredTiplocs = [YARD];
    return t;
  };
  const yardPattern = (o: Partial<ServicePatternsFile["patterns"][number]> = {}) =>
    syntheticPatterns({
      id: "pat-syn-yard",
      through: [{ tiploc: "SYNSTA", platform: "1" }, { tiploc: "SYNJN" }, { tiploc: YARD }],
      after: null,
      ...o,
    });
  /** cut-b's boundary leads into a deferred play area (as Carlisle's north cuts do). */
  const deferredBeyondB = (d: ValidationInput) => {
    d.control!.externalAreas!.find((e) => e.id === "ext-1")!.kind = "deferred_play_area";
  };
  const plan = (o: Parameters<typeof worldFor>[0]) => worldFor(o).timetable!.entries[0]!;
  const check = (patterns: ServicePatternsFile, deferredCuts?: ReadonlySet<string>) =>
    validateServicePatterns(
      patterns,
      syntheticTimetableDataset().signalling,
      worldFringes(),
      { area: new Set(SYN_AREA), deferred: new Set([YARD]) },
      deferredCuts,
    );

  it("runs such a journey to the exit fringe and leaves play exactly once", () => {
    const o = {
      services: [endsInYard()],
      snapshot: yardSnapshot([endsInYard()]),
      patterns: yardPattern(),
      tweak: deferredBeyondB,
    };
    expect(plan(o)).toMatchObject({
      classification: "representable",
      patternId: "pat-syn-yard",
      observedPath: "SYNBEF > SYNSTA(1) > SYNJN > SYNYRD",
      run: { exitFringeId: "fr-b", routeIds: ["ra", "r0", "r1", "r5"] },
    });
    const { store, submit, until } = setup(o);
    for (const r of ["ra", "r0", "r1", "r5"]) submit(setR(r));
    until((s) => s.services["Z00001:2026-11-04"]!.status === "departed");
    expect(store.view().trains).toEqual({});
    const left = store
      .log()
      .flatMap((e) => e.changes ?? [])
      .filter((c) => c.startsWith("service ") && c.includes("left play"));
    expect(left).toEqual([
      `service Z00001:2026-11-04 (9Z99) left play at fringe fr-b as train ${TRAIN}`,
    ]);
  });

  it("fails closed when the exit fringe does not lead into a deferred area", () => {
    // ext-1 stays outside_play: the journey would end somewhere play says nothing about.
    const e = plan({ snapshot: yardSnapshot([endsInYard()]), patterns: yardPattern() });
    expect(e).toMatchObject({ classification: "unsupported", reasons: [{ code: "NO_PATTERN" }] });
    const r = check(yardPattern());
    expect([...r.invalid]).toEqual(["pat-syn-yard"]);
    expect(r.issues.find((i) => i.code === "SERVICE_PATTERN_INVALID")!.message).toMatch(
      /exit fringe fr-b is not on a cut whose boundary leads into a deferred area/,
    );
    // Nor does a caller that supplies no deferred cuts: the default is none.
    expect(check(yardPattern()).invalid.size).toBe(1);
    expect(check(yardPattern(), new Set(["cut-b"])).invalid.size).toBe(0);
  });

  it("never lets a pattern end a journey inside play (no terminating lifecycle)", () => {
    const inPlay = yardPattern({
      through: [{ tiploc: "SYNSTA", platform: "1" }, { tiploc: "SYNJN" }],
    });
    const r = check(inPlay, new Set(["cut-b"]));
    expect([...r.invalid]).toEqual(["pat-syn-yard"]);
    expect(
      r.issues.some((i) => /last call SYNJN is not a deferred-area TIPLOC/.test(i.message)),
    ).toBe(true);
    // A service that terminates at SYNJN in play matches nothing.
    const s = s1();
    const jn = s.calls.findIndex((c) => c.tiploc === "SYNJN");
    const terminating: Service = {
      ...s,
      calls: [
        ...s.calls.slice(0, jn),
        { ...s.calls[jn]!, kind: "destination", pass: null, arrival: s.calls[jn]!.pass },
      ],
    };
    const e = plan({
      snapshot: syntheticSnapshot(DATE, [terminating]),
      patterns: inPlay,
      tweak: deferredBeyondB,
    });
    expect(e).toMatchObject({ classification: "unsupported", reasons: [{ code: "NO_PATTERN" }] });
    // Only deferred calls in `through`, with nothing in play, is refused too.
    expect(
      check(yardPattern({ through: [{ tiploc: YARD }] }), new Set(["cut-b"])).issues.some((i) =>
        /no through call is in the play area/.test(i.message),
      ),
    ).toBe(true);
  });

  it("refuses a pattern whose play-area calls are split by a deferred call (re-entry)", () => {
    const back = yardPattern({
      through: [{ tiploc: "SYNSTA", platform: "1" }, { tiploc: YARD }, { tiploc: "SYNJN" }],
      after: { tiploc: "SYNAFT" },
    });
    const r = check(back, new Set(["cut-b"]));
    expect([...r.invalid]).toEqual(["pat-syn-yard"]);
    expect(r.issues.some((i) => /leave and re-enter play/.test(i.message))).toBe(true);
    // Deferred calls only at the end (or only at the start) are one visit, and accepted.
    expect(check(yardPattern(), new Set(["cut-b"])).invalid.size).toBe(0);
  });

  it("keeps calls after the area and journeys ending beyond play apart", () => {
    // A service with a call after the deferred block does not match an after: null pattern ...
    const continuing = endsInYard();
    continuing.calls = [
      ...continuing.calls.slice(0, -1),
      {
        ...continuing.calls.at(-1)!,
        kind: "intermediate",
        arrival: null,
        pass: continuing.calls.at(-1)!.arrival,
      },
      {
        ...continuing.calls.at(-1)!,
        tiploc: "SYNDST",
        kind: "destination",
        pass: null,
        arrival: "06:30",
      },
    ];
    const o = {
      snapshot: yardSnapshot([continuing]),
      patterns: yardPattern(),
      tweak: deferredBeyondB,
    };
    expect(plan(o)).toMatchObject({
      classification: "unsupported",
      reasons: [{ code: "NO_PATTERN" }],
    });
    // ... and one ending there does not match a pattern that needs a call after the area.
    const withAfter = yardPattern({ after: { tiploc: "SYNDST" } });
    expect(
      plan({ snapshot: yardSnapshot([endsInYard()]), patterns: withAfter, tweak: deferredBeyondB }),
    ).toMatchObject({ classification: "unsupported", reasons: [{ code: "NO_PATTERN" }] });
    // The two shapes never overlap, whatever their field checks.
    const both = {
      datasetId: "synthetic",
      patterns: [
        ...yardPattern().patterns,
        ...withAfter.patterns.map((p) => ({ ...p, id: "pat-syn-yard-2" })),
      ],
    };
    expect(
      check(both, new Set(["cut-b"])).issues.filter((i) => i.code === "SERVICE_PATTERN_OVERLAP"),
    ).toEqual([]);
  });
});
