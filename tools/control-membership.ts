/**
 * Sets a game-design control area's members to every OSM signal and points inside the
 * playable area: track reached from the playable cuts' inside nodes without crossing a cut
 * (src/validation/control.ts nodesInPlay). Rewrites only that area's signalIds and pointsIds
 * in control.json; everything else in the file is hand-authored and kept.
 *
 *   npm run data:control-membership -- --dataset carlisle --area carlisle-ws-1
 */
import { TrackGraph } from "../src/graph/trackGraph.ts";
import { Control, Infrastructure, PlayableArea } from "../src/model/index.ts";
import { nodesInPlay } from "../src/validation/control.ts";
import { datasetDir, flags, path, readJson, writeJson } from "./lib.ts";

const a = flags();
if (!a.dataset || !a.area) {
  console.error("Required: --dataset <id> --area <control area id>");
  process.exit(1);
}
const dir = datasetDir(a.dataset);
const infra = Infrastructure.parse(readJson(path(dir, "infrastructure.json")));
const playable = PlayableArea.parse(readJson(path(dir, "playable-area.json")));
const raw = readJson(path(dir, "control.json")) as Record<string, unknown>;
const control = Control.parse(raw);
const area = control.areas.find((x) => x.id === a.area);
if (!area || area.basis !== "game_design") {
  console.error(`${a.area} is not a game-design control area in ${a.dataset}/control.json`);
  process.exit(1);
}
const inPlay = nodesInPlay(new TrackGraph(infra), playable);
const signalIds = infra.signals
  .filter((s) => s.trackNodeId && inPlay.has(s.trackNodeId))
  .map((s) => s.id);
const pointsIds = infra.points.filter((p) => inPlay.has(p.trackNodeId)).map((p) => p.id);
const areas = (raw.areas as Record<string, unknown>[]).map((x) =>
  x.id === a.area ? { ...x, signalIds, pointsIds } : x,
);
Control.parse({ ...raw, areas });
writeJson(path(dir, "control.json"), { ...raw, areas });
console.log(
  `${a.area}: ${signalIds.length} signals and ${pointsIds.length} points inside the playable area (${inPlay.size} track nodes).`,
);
