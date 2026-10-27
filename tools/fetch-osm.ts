/**
 * Downloads a dated OpenStreetMap railway extract for a dataset's bbox from the public
 * Overpass API (no account needed). Respect the Overpass usage policy: run rarely and
 * commit the snapshot rather than re-fetching. Data is ODbL; see docs/DATA_SOURCES.md.
 *
 *   npm run data:fetch-osm -- --dataset shrewsbury [--endpoint URL]
 */
import { buildRailwayQuery, type OverpassResponse } from "../src/import/osm/overpass.ts";
import { datasetDir, flags, path, readArea, readJson, today, writeJson } from "./lib.ts";

const args = flags();
const datasetId = args.dataset ?? "shrewsbury";
const endpoint = args.endpoint ?? "https://overpass-api.de/api/interpreter";
const area = readArea(datasetId);
const query = buildRailwayQuery(area.bbox);

const res = await fetch(endpoint, {
  method: "POST",
  headers: {
    "User-Agent": "signal-network-data-tools/0.1",
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({ data: query }),
});
if (!res.ok) {
  console.error(`Overpass request failed: HTTP ${res.status} ${res.statusText}`);
  process.exit(1);
}
const data = (await res.json()) as OverpassResponse;
if (!data.osm3s?.timestamp_osm_base || !Array.isArray(data.elements)) {
  console.error("Unexpected Overpass response; nothing written.");
  process.exit(1);
}

const rel = `data/raw/osm/${datasetId}-${today()}.json`;
writeJson(path(rel), { query, endpoint, retrieved: today(), ...data });
const areaFile = path(datasetDir(datasetId), "area.json");
writeJson(areaFile, { ...(readJson(areaFile) as object), osmSnapshot: rel });
console.log(
  `Wrote ${rel}: ${data.elements.length} elements, OSM base ${data.osm3s.timestamp_osm_base}`,
);
