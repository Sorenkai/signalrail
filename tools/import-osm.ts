/**
 * Builds data/datasets/<id>/infrastructure.json from the raw OSM snapshot named in area.json.
 *
 *   npm run data:import-osm -- --dataset shrewsbury
 */
import { importOsm } from "../src/import/osm/importOsm.ts";
import type { OverpassResponse } from "../src/import/osm/overpass.ts";
import { Infrastructure } from "../src/model/index.ts";
import { datasetDir, flags, path, readArea, readJson, writeJson } from "./lib.ts";

const datasetId = flags().dataset ?? "shrewsbury";
const area = readArea(datasetId);
if (!area.osmSnapshot) {
  console.error(
    `No OSM snapshot recorded for ${datasetId}. Run: npm run data:fetch-osm -- --dataset ${datasetId}`,
  );
  process.exit(1);
}
const raw = readJson(path(area.osmSnapshot)) as OverpassResponse & { retrieved: string };
const { infrastructure, report } = importOsm(raw, {
  datasetId,
  bbox: area.bbox,
  retrieved: raw.retrieved,
  generated: raw.retrieved,
});
Infrastructure.parse(infrastructure);
writeJson(path(datasetDir(datasetId), "infrastructure.json"), infrastructure);

const i = infrastructure;
console.log(`Imported ${area.osmSnapshot} (${i.version})`);
console.log(
  `  nodes ${i.nodes.length}, edges ${i.edges.length}, signals ${i.signals.length}, points ${i.points.length}, ` +
    `locations ${i.locations.length}, platforms ${i.platforms.length}`,
);
console.log(
  `  skipped ways ${report.skippedWays.length}, off-track signals ${report.offTrackSignals}, ` +
    `platforms without track link ${report.platformsWithoutTrackLink}`,
);
