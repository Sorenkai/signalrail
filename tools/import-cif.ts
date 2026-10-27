/**
 * Builds a dated timetable snapshot from a CIF file the user has downloaded manually
 * (e.g. Network Rail SCHEDULE full extract, ~1 GB). The file is streamed; credentials are
 * never handled by this tool.
 *
 *   npm run data:import-cif -- --dataset shrewsbury --file data/private/toc-full.CIF \
 *       --date 2026-11-04 --source nr-open-data-feeds [--retrieved 2026-10-27] [--all]
 *
 * By default only services that call at or pass a study-area TIPLOC (timing-points.json
 * areaTiplocs) are kept; each kept service retains its whole journey. --all keeps every
 * service running on the date.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { CifParser } from "../src/import/cif/parseCif.ts";
import { buildSnapshot, runsOn } from "../src/import/cif/snapshot.ts";
import { TimetableSnapshot, TimingPointsFile } from "../src/model/index.ts";
import { datasetDir, flags, path, readJson, writeJson } from "./lib.ts";

const a = flags();
const datasetId = a.dataset ?? "shrewsbury";
if (!a.file || !a.date || !a.source) {
  console.error("Required: --file <CIF path> --date YYYY-MM-DD --source <registry id>");
  process.exit(1);
}
const date = a.date;
let area: Set<string> | null = null;
if (!a.all) {
  const tp = TimingPointsFile.parse(readJson(path(datasetDir(datasetId), "timing-points.json")));
  area = new Set(tp.areaTiplocs.map((t) => t.tiploc));
  if (area.size === 0) {
    console.error(
      "timing-points.json lists no areaTiplocs; run data:import-corpus first, or pass --all.",
    );
    process.exit(1);
  }
}

// Location-less schedules (STP cancellations) are kept so they can cancel area services.
const parser = new CifParser(
  (s) =>
    runsOn(s, date) &&
    (!area || s.locations.length === 0 || s.locations.some((l) => area.has(l.tiploc))),
);
const lines = createInterface({
  input: createReadStream(path(a.file), { encoding: "latin1" }),
  crlfDelay: Infinity,
});
for await (const line of lines) parser.push(line);
const cif = parser.finish();
if (cif.errors.length > 0) {
  console.error(
    `${cif.errors.length} CIF parse error(s); first: line ${cif.errors[0]!.line}: ${cif.errors[0]!.message}`,
  );
  process.exit(1);
}

const snapshot = buildSnapshot(cif, date, {
  id: `${datasetId}-${date}`,
  sourceId: a.source,
  ...(a.retrieved ? { retrieved: a.retrieved } : {}),
});
if (area)
  snapshot.services = snapshot.services.filter((s) => s.calls.some((c) => area.has(c.tiploc)));
TimetableSnapshot.parse(snapshot);
const out = `data/datasets/${datasetId}/timetables/${date}.json`;
writeJson(path(out), snapshot);
const h = cif.header;
console.log(
  `Read ${parser.scheduleCount} schedules (header ${h?.currentFileRef ?? "none"}, extracted ${h?.extractDate ?? "?"}, ` +
    `valid ${h?.userStartDate}..${h?.userEndDate}).`,
);
console.log(`Wrote ${out}: ${snapshot.services.length} services running on ${date}.`);
