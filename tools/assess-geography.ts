/**
 * Assesses a dataset's proposed playable area (playable-area.json) against its infrastructure
 * and signal evidence: platform roads, connectivity, topology issues and a survey backlog.
 * Read-only on the dataset; writes docs/pilots/<id>-phase1-geography.json.
 *
 *   npx tsx tools/assess-geography.ts --dataset carlisle [--generated 2026-10-27]
 */
import { Infrastructure, PlayableArea, SignalEvidenceFile } from "../src/model/index.ts";
import {
  connectivity,
  platformRoads,
  type Reach,
  surveyBacklog,
  topologyIssues,
} from "../src/reconcile/geography.ts";
import { RECONCILIATION_SCOPES } from "../src/reconcile/scopes.ts";
import { datasetDir, flags, path, readJson, today, writeJson } from "./lib.ts";

const args = flags();
const id = args.dataset ?? "carlisle";
const dir = datasetDir(id);
const infra = Infrastructure.parse(readJson(path(dir, "infrastructure.json")));
const area = PlayableArea.parse(readJson(path(dir, "playable-area.json")));
const evidence = SignalEvidenceFile.parse(readJson(path(dir, "signal-evidence.json")));
const scope = RECONCILIATION_SCOPES[id]!;

/** The north limit is the latitude of the gameplay cuts' inside nodes (max), if any. */
const pos = new Map(infra.nodes.map((n) => [n.id, n.position!]));
const cutLats = area.cuts
  .filter((c) => c.kind === "gameplay_cut")
  .map((c) => pos.get(c.outsideNodeId)!.lat);
const northLimit = cutLats.length ? Math.min(...cutLats) : Infinity;
const inside = (p: { lat: number }) => p.lat < northLimit;

const optional = new Set(area.optionalAreas.flatMap((o) => o.locationIds));
/** STANOX in play: the scope's, minus those whose name is in an optional (deferred) area. */
const playableStanox = new Set(
  Object.entries(scope.stanox)
    .filter(([, name]) => !/KINGMOOR|KMR|KNGM|KMU/i.test(name) || optional.size === 0)
    .map(([s]) => s),
);

const roads = platformRoads(infra, area.platformIds);
const conn = connectivity(infra, area, roads);
const topology = topologyIssues(infra, inside);
const backlog = surveyBacklog(evidence, roads, topology, playableStanox);
const signalsInside = infra.signals.filter((s) => s.position && inside(s.position));

const result = {
  generated: args.generated ?? today(),
  datasetId: id,
  northLimitLat: northLimit,
  playableStanox: [...playableStanox].sort(),
  counts: {
    signalsInside: signalsInside.length,
    numberedSignalsInside: signalsInside.filter((s) => s.ref).length,
    bufferStopsInside: topology.filter((t) => t.kind === "buffer_stop").length,
    issuesInside: Object.fromEntries(
      [
        "dangling_end",
        "switch_too_few_edges",
        "crossing_too_few_edges",
        "four_way_switch",
        "single_slip",
        "double_slip",
      ].map((k) => [k, topology.filter((t) => t.kind === k).length]),
    ),
    backlog: {
      P1: 0,
      P2: 0,
      P3: 0,
      ...Object.fromEntries(
        ["P1", "P2", "P3"].map((p) => [p, backlog.filter((b) => b.priority === p).length]),
      ),
    },
  },
  platformRoads: roads,
  connectivity: conn,
  topology,
  backlog,
};
const out = path("docs/pilots", `${id}-phase1-geography.json`);
writeJson(out, result);
console.log(JSON.stringify(result.counts));
for (const r of roads)
  console.log(
    `platform ${r.ref}: ${r.method}/${r.status}/${r.evidence} edges ${r.edgeIds.join(",") || "-"} signals ${r.signalRefs.join(",") || "-"}; nearby ${r.nearbyEdges.map((e) => `${e.trackRef ?? "-"}@${e.distanceM}`).join(" ")}`,
  );
const fmt = (r: Reach) =>
  r.legs !== null
    ? "L"
    : r.slipDiagonal !== null
      ? "d"
      : r.incomplete !== null
        ? "i"
        : r.smooth !== null
          ? "s"
          : ".";
console.log(
  "\nentry -> platform (L = leg heuristic with sourced slip types, d = only via an unrecorded single-slip diagonal, i = only via an incomplete two-edge switch/crossing, s = smooth rule only, . = none; none of these is verified routing)",
);
for (const [c, row] of Object.entries(conn.entryToPlatform))
  console.log(
    c.padEnd(24),
    Object.entries(row)
      .map(([p, r]) => `${p.replace("platform ", "")}:${fmt(r)}`)
      .join(" "),
  );
console.log("\nplatform -> exit");
for (const [p, row] of Object.entries(conn.platformToExit))
  console.log(
    p.padEnd(14),
    Object.entries(row)
      .map(([c, r]) => `${c.replace("cut-", "")}:${fmt(r)}`)
      .join(" "),
  );
console.log("\nthrough (entry -> exit)");
for (const [c, row] of Object.entries(conn.through))
  console.log(
    c.padEnd(24),
    Object.entries(row)
      .map(([x, r]) => `${x.replace("cut-", "")}:${fmt(r)}`)
      .join(" "),
  );
console.log(`Wrote ${out}`);
