/**
 * Timetable services on the Carlisle pilot (P5, D-035), from committed files only: the CIF
 * snapshot timetables/2026-11-04.json (DFROC1F), service-patterns.json and the simplified
 * game routes (D-030; the Caldew Jn goods route since P6, D-036, also used by the Kingmoor-yard
 * patterns since P7, D-037). The local-only
 * signal-evidence.json is dropped.
 *
 * The plan fingerprint pins how many real services the game can run and why the rest cannot.
 * The session runs real schedules over GAME routes with GAME train length and speed; the
 * operator is a test script. Passing claims nothing about real Carlisle operations.
 */
import { describe, expect, it } from "vitest";
import { loadDataset } from "../src/data/loadDataset.ts";
import {
  CommandStore,
  DEFAULT_POLICY,
  cifTimeMs,
  createWorld,
  initialState,
  localToSimTime,
  routeSignalIssues,
  serviceIssues,
  stateTrainIssues,
  summarisePlan,
  timetableSessionConfig,
  type Command,
} from "../src/sim/index.ts";

const { input } = loadDataset("data", "carlisle");
const d = structuredClone(input!);
delete d.signalEvidence;
const snapshot = d.timetables!.find((t) => t.date === "2026-11-04")!;
const CHAIN = [
  "rt-dm-fringe-ce264",
  "rt-dm-ce264-ce272",
  "rt-dm-ce272-ce286",
  "rt-dm-ce286-ce323",
  "rt-dm-ce323-fringe",
];
/** (P6, D-036) The goods-line chain: the same to CE323, then the Down Goods to the north cut. */
const GOODS_CHAIN = [...CHAIN.slice(0, 4), "rt-dg-ce323-fringe"];

const world = createWorld(
  {
    infrastructure: d.infrastructure,
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
const plan = world.timetable!;
const entry = (id: string) => plan.entries.find((e) => e.serviceId === id)!;

describe("Carlisle service plan (2026-11-04)", () => {
  it("runs 65 of 381 services and says why each of the others cannot run", () => {
    // P5: 2 representable, 49 approximated, 330 unsupported (25 field mismatches). P6 (D-036)
    // adds the 4 Caldew Jn goods-line services. P7 (D-037) adds the 10 goods-line workings into
    // the Kingmoor yards; 3 platform 1 yard workings now fail a P7 pattern's platform check
    // instead of matching none. Nothing else changes class.
    expect(summarisePlan(plan)).toEqual({
      total: 381,
      byClass: { representable: 10, approximated: 55, unsupported: 316, invalid: 0 },
      byCode: { STATION_CALL_NOT_SIMULATED: 55, NO_PATTERN: 292, PATTERN_FIELD_MISMATCH: 24 },
    });
    const mismatch = plan.entries
      .filter((e) => e.reasons[0]?.code === "PATTERN_FIELD_MISMATCH")
      .map((e) => e.reasons[0]!.detail.replace(/^pat-[a-z0-9-]+: /, ""));
    expect(mismatch.filter((m) => m === "CARLILE platform 1; pattern needs 3")).toHaveLength(24);
    expect(mismatch).toHaveLength(24);
  });

  it("runs only Down WCML trains via platform 3, on the Down Main or the Caldew Jn goods line", () => {
    const runnable = plan.entries.filter((e) => e.run);
    expect(new Set(runnable.map((e) => e.patternId))).toEqual(
      new Set([
        "pat-down-wcml-through-p3",
        "pat-down-wcml-p3-caldew-goods",
        "pat-down-wcml-p3-goods-kgmr-up-yard-ends",
        "pat-down-wcml-p3-goods-kgmr-down-yard-ends",
        "pat-down-wcml-p3-goods-kgmr-down-yard-florstn",
        "pat-down-wcml-p3-goods-kgmr-up-yard-florstn",
      ]),
    );
    for (const e of runnable) {
      const goods = e.patternId !== "pat-down-wcml-through-p3";
      expect(e.observedPath).toMatch(
        goods
          ? /^PNTH\S* > CARLILE\(3\)\[DML\] > CARLCJN\[GL\] > KGMRJCN\S* > /
          : /^PNTH\S* > CARLILE\(3\)\[DML\] > CARLCJN > KGMRJCN\S* > FLORSTN/,
      );
      expect(e.run).toMatchObject({
        routeIds: goods ? GOODS_CHAIN : CHAIN,
        entryFringeId: "fr-wcml-south-down",
        exitFringeId: goods ? "fr-north-down-goods" : "fr-north-down-main",
        lengthMm: 200_000,
        speedMmPerS: 20_000,
        characteristics: "session_default",
        entryPath: [{ edgeId: "osm-w342066398-0", towardsNodeId: "osm-n13956027901" }],
      });
    }
    expect(
      plan.entries.filter((e) => e.classification === "representable").map((e) => e.headcode),
    ).toEqual(["4S01", "6C01", "1S29", "4C31", "1S04", "6C37", "6C37", "6M00", "6C04", "0C50"]);
    expect(
      runnable
        .filter((e) => e.patternId === "pat-down-wcml-p3-caldew-goods")
        .map((e) => e.headcode),
    ).toEqual(["4S01", "4S94", "4S38", "4S48"]);
    // (P7) Kingmoor yard workings: in play the goods chain, leaving play on the Down Goods.
    expect(runnable.filter((e) => e.patternId!.includes("-kgmr-")).map((e) => e.headcode)).toEqual([
      "6X77",
      "6C01",
      "4C31",
      "6C37",
      "6C37",
      "6M00",
      "6C04",
      "0C50",
      "4C32",
      "4S77",
    ]);
    // Up trains (from Gretna Jn) have no exit: the Up Main ends at CE304 (D-030).
    const up = plan.entries.filter((e) => e.observedPath.startsWith("GRETNAJ"));
    expect(up.length).toBeGreaterThan(0);
    expect(up.every((e) => e.classification === "unsupported" && e.run === null)).toBe(true);
  });

  it("times overnight services on the operating day from the timing point before play", () => {
    // 1S25 started on 11-03 and passes Penrith at 01:58 on the operating day.
    expect(entry("C04568:2026-11-03")).toMatchObject({
      headcode: "1S25",
      classification: "approximated",
      run: { dueTiploc: "PNTH", dueLocal: "2026-11-04T01:58:00", dueAtMs: 7_080_000 },
    });
  });
});

describe("Carlisle timetable session", () => {
  it("accepts, runs and hands off overnight Down services in plan order, each on its own chain", () => {
    const due = localToSimTime(plan.base, "2026-11-04", cifTimeMs("01:57"));
    if (due.kind !== "ok") throw new Error("start time");
    // Test assumption, as in carlisleTrains.test.ts: all track proven clear, the points of the
    // Down Main chain detected in the position it needs. Neither is a claim about the railway.
    // Points the goods chain needs otherwise are moved by the test operator, through the pipeline.
    const clear = Object.fromEntries(d.infrastructure.edges.map((e) => [e.id, "clear" as const]));
    const points = Object.fromEntries(
      CHAIN.map((id) => d.signalling!.routes.find((r) => r.id === id)!).flatMap((r) =>
        r.pointsRequired.map((p) => [p.pointsId, { position: p.position, detected: true }]),
      ),
    );
    const store = new CommandStore(
      world,
      initialState(world, {
        occupancy: clear,
        points,
        clock: { startTimeMs: due.simMs, tickDurationMs: 1000 },
      }),
    );
    let n = 0;
    const changes: string[] = [];
    const submit = (command: Command) =>
      store.submit({
        commandId: `c${++n}`,
        operator: { kind: "ai", id: "op-1" },
        controlAreaId: "carlisle-ws-1",
        expectedVersion: store.view().version,
        command,
      });
    /**
     * Test operator, not an AI signaller: each tick, for every due or active service in plan
     * order, moves the points and (re)sets each route of that service's own chain that is not
     * set. Refusals (locked points, conflicts) are kept; an earlier service is served first.
     */
    const operate = () => {
      const now = store.view().clock.timeMs;
      for (const e of plan.entries) {
        const svc = store.view().services[e.serviceId];
        if (!svc || svc.status === "departed" || svc.dueAtMs > now) continue;
        for (const routeId of e.run!.routeIds) {
          if (store.view().routes[routeId]) continue;
          for (const p of d.signalling!.routes.find((r) => r.id === routeId)!.pointsRequired)
            if (store.view().points[p.pointsId]?.position !== p.position)
              submit({ type: "move_points", pointsId: p.pointsId, position: p.position });
          submit({ type: "set_route", routeId });
        }
      }
    };
    // (P7) Three services are due before play starts at 01:57 and wait at the fringe: 6X77
    // (Kingmoor Down yard, then Floriston), 4S01 (goods line) and 6C01 (ends in the Kingmoor Up
    // yard). All three take the goods chain and leave play on the Down Goods.
    const yardFirst = "H50015:2026-11-03"; // 6X77, due 23:59 on 11-03
    const goods = "H49630:2026-11-03"; // 4S01, due 00:32:30
    const yardEnds = "H50097:2026-11-03"; // 6C01, due 01:42, terminates at CARLILY beyond play
    const first = "C04568:2026-11-03"; // 1S25, due 01:58
    const second = "C01656:2026-11-03"; // 1S29, due 02:17
    for (let i = 0; i < 1800 && store.view().services[second]!.status !== "departed"; i++) {
      operate();
      const r = store.tick({ tick: store.view().clock.tick + 1 });
      if (r.outcome !== "accepted") throw new Error(r.outcome);
      changes.push(...r.changes.filter((c) => !c.startsWith("clock")));
      const s = store.view();
      expect(stateTrainIssues(world, s)).toEqual([]);
      expect(routeSignalIssues(world, s)).toEqual([]);
      expect(serviceIssues(world, s)).toEqual([]);
    }
    const s = store.view();
    const order = [
      [yardFirst, GOODS_CHAIN, "fr-north-down-goods"],
      [goods, GOODS_CHAIN, "fr-north-down-goods"],
      [yardEnds, GOODS_CHAIN, "fr-north-down-goods"],
      [first, CHAIN, "fr-north-down-main"],
      [second, CHAIN, "fr-north-down-main"],
    ] as const;
    for (const [id, chain, exit] of order) {
      const svc = s.services[id]!;
      expect(svc.status).toBe("departed");
      // Never before it is due; the first waiting service enters on the first tick of play.
      expect(svc.enteredAtMs!).toBeGreaterThanOrEqual(Math.max(svc.dueAtMs, due.simMs + 1000));
      if (id === yardFirst) expect(svc.enteredAtMs).toBe(due.simMs + 1000);
      const train = svc.trainId;
      expect(changes.filter((c) => c.startsWith(`train ${train} took route`))).toEqual(
        chain.slice(1).map((r) => {
          const sig = d.signalling!.routes.find((x) => x.id === r)!.entrySignalId;
          return `train ${train} took route ${r}; signal ${sig} on`;
        }),
      );
      expect(changes).toContain(
        `service ${id} (${entry(id).headcode}) left play at fringe ${exit} as train ${train}`,
      );
      // Exactly once.
      expect(
        changes.filter((c) => c.startsWith(`service ${id} (`) && c.includes("left play")),
      ).toHaveLength(1);
    }
    // They enter one at a time, in plan order (due time, then service id).
    for (let i = 1; i < order.length; i++)
      expect(s.services[order[i - 1]![0]]!.enteredAtMs!).toBeLessThan(
        s.services[order[i]![0]]!.enteredAtMs!,
      );
    expect(s.services[first]!.departedAtMs!).toBeLessThan(s.services[second]!.enteredAtMs!);
    expect(Object.keys(s.trains)).toEqual([]);
    // No other service has entered; none other was due before 1S29.
    expect(
      Object.values(s.services).filter((x) => x.status !== "scheduled" && x.status !== "pending"),
    ).toHaveLength(order.length);
  });
});
