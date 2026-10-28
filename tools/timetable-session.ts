/**
 * Builds a dataset's timetable service plan for one operating date (P5, D-035) and optionally
 * runs a headless session through the authoritative store.
 *
 *   npm run sim:timetable -- --dataset carlisle --date 2026-11-04            # plan report
 *   npm run sim:timetable -- --dataset carlisle --date 2026-11-04 --list     # every service
 *   npm run sim:timetable -- --dataset carlisle --date 2026-11-04 \
 *       --from 01:57 --minutes 30 [--set-routes]                            # run a session
 *
 * The timetable is data/datasets/<id>/timetables/<date>.json, mapped by service-patterns.json.
 * Session assumptions, printed with the run: every edge proven clear, every points detected in
 * the position the first route (in file order) that needs it requires, 1 s ticks, and the
 * session's game train length and speed. `--set-routes` is a demo script, not an AI signaller:
 * each tick, for every due or active service in plan order, it requests through the normal
 * command pipeline the points moves and route settings of that service's own chain that are not
 * yet in place; refusals (locked points, conflicting routes) are kept. Since P6 (D-036) two
 * routes can start at one signal, and a service train takes only routes of its own chain.
 * Without it, due services wait at their fringe, pending, as no one accepts them.
 */
import { loadDataset } from "../src/data/loadDataset.ts";
import {
  CommandStore,
  DEFAULT_POLICY,
  cifTimeMs,
  createWorld,
  initialState,
  localToSimTime,
  simTimeToLocal,
  summarisePlan,
  timetableSessionConfig,
  type Command,
} from "../src/sim/index.ts";
import { flags, path } from "./lib.ts";

const args = flags();
const id = args.dataset ?? "carlisle";
const date = args.date;
if (!date) throw new Error("--date YYYY-MM-DD is required (the timetable operating date)");

const { input, schemaIssues } = loadDataset(path("data"), id);
if (!input || schemaIssues.length > 0)
  throw new Error(`dataset ${id} did not load: ${schemaIssues.map((i) => i.message).join("; ")}`);
const snapshot = (input.timetables ?? []).find((t) => t.date === date);
if (!snapshot) throw new Error(`no timetable snapshot for ${date} in ${id}/timetables`);
if (!input.servicePatterns) throw new Error(`${id} has no service-patterns.json`);
if (!input.signalling || !input.control) throw new Error(`${id} has no signalling or control`);
const areaId = input.control.areas[0]?.id;
if (!areaId) throw new Error(`${id} has no control area`);

const world = createWorld(
  {
    infrastructure: input.infrastructure,
    signalling: input.signalling,
    control: input.control,
    sources: input.sources,
    ...(input.gameRules ? { gameRules: input.gameRules } : {}),
    ...(input.playableArea ? { playableArea: input.playableArea } : {}),
    timetable: {
      snapshot,
      patterns: input.servicePatterns,
      config: timetableSessionConfig(date),
      ...(input.areaTiplocs ? { areaTiplocs: input.areaTiplocs } : {}),
      ...(input.deferredTiplocs ? { deferredTiplocs: input.deferredTiplocs } : {}),
    },
  },
  DEFAULT_POLICY,
  { "demo-script": [areaId] },
);
const plan = world.timetable!;
const summary = summarisePlan(plan);
console.log(
  `=== ${id} ${date}: ${plan.snapshotId} (${snapshot.extract.fileRef ?? "no file ref"}) ===`,
);
console.log(
  `operating day from ${plan.base.windowStart} Europe/London = UTC ${new Date(plan.base.windowStartUtcMs).toISOString()} (simulation time 0)`,
);
console.log(
  `game settings for every service train: length ${plan.config.trainLengthMm / 1000} m, speed ${plan.config.trainSpeedMmPerS / 1000} m/s (not from the timetable)`,
);
console.log("services:", JSON.stringify(summary.byClass), "of", summary.total);
console.log("reasons:", JSON.stringify(summary.byCode));
for (const e of plan.entries)
  if (e.run || args.list)
    console.log(
      `  ${e.classification.padEnd(13)} ${e.serviceId.padEnd(18)} ${(e.headcode ?? "-").padEnd(4)} ${e.run ? `due ${e.run.dueLocal} at ${e.run.dueTiploc}` : e.reasons.map((r) => r.code).join(",")}  ${args.list ? e.observedPath : ""}`,
    );

if (args.minutes) {
  const from = localToSimTime(plan.base, date, cifTimeMs(args.from ?? "00:00"));
  if (from.kind !== "ok" || from.simMs < 0)
    throw new Error(`--from ${args.from} is not a single local time on ${date}`);
  const clear = Object.fromEntries(input.infrastructure.edges.map((e) => [e.id, "clear" as const]));
  const points: Record<string, { position: "normal" | "reverse"; detected: true }> = {};
  for (const r of input.signalling.routes)
    for (const p of r.pointsRequired)
      points[p.pointsId] ??= { position: p.position, detected: true };
  const store = new CommandStore(
    world,
    initialState(world, {
      occupancy: clear,
      points,
      clock: { startTimeMs: from.simMs, tickDurationMs: 1000 },
    }),
  );
  console.log(
    `\nsession: ${args.minutes} min from ${args.from ?? "00:00"}; ASSUMED all track proven clear and route points detected${args["set-routes"] ? "; demo script sets pattern routes" : ""}`,
  );
  const routes = new Map(input.signalling.routes.map((r) => [r.id, r]));
  let n = 0;
  const submit = (command: Command) =>
    store.submit({
      commandId: `demo-${++n}`,
      operator: { kind: "ai", id: "demo-script" },
      controlAreaId: areaId,
      expectedVersion: store.view().version,
      command,
    });
  for (let i = 0; i < Number(args.minutes) * 60; i++) {
    if (args["set-routes"])
      for (const e of plan.entries) {
        const svc = store.view().services[e.serviceId];
        if (!svc || svc.status === "departed" || svc.dueAtMs > store.view().clock.timeMs) continue;
        for (const routeId of e.run!.routeIds) {
          if (store.view().routes[routeId]) continue;
          for (const p of routes.get(routeId)!.pointsRequired)
            if (store.view().points[p.pointsId]?.position !== p.position)
              submit({ type: "move_points", pointsId: p.pointsId, position: p.position });
          submit({ type: "set_route", routeId });
        }
      }
    const r = store.tick({ tick: store.view().clock.tick + 1 });
    if (r.outcome !== "accepted") throw new Error(`tick refused: ${JSON.stringify(r)}`);
    const at = simTimeToLocal(plan.base, r.timeMs).wallTime.slice(11);
    for (const c of r.changes)
      if (c.startsWith("service") || (args.verbose && !c.startsWith("clock")))
        console.log(`  ${at} ${c}`);
  }
  const counts: Record<string, number> = {};
  for (const s of Object.values(store.view().services))
    counts[s.status] = (counts[s.status] ?? 0) + 1;
  console.log("service status at end:", JSON.stringify(counts));
}
