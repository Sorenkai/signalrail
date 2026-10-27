/**
 * Builds a dated timetable snapshot from a CIF file the user has downloaded manually
 * (e.g. Network Rail SCHEDULE full extract, ~1 GB). The file is streamed; credentials are
 * never handled by this tool. Deterministic for the same inputs.
 *
 *   npm run data:import-cif -- --dataset carlisle --file data/private/toc-full.CIF \
 *       --date 2026-11-04 --source nr-open-data-feeds --retrieved 2026-10-27 \
 *       [--bank-holidays data/raw/govuk/bank-holidays-2026-10-27.json] [--window-start 00:00] \
 *       [--out <path>]
 *
 * Operating day (D-026): the snapshot for --date holds every service instance, whatever its
 * origin date, with a time at a play-area TIPLOC (timing-points.json areaTiplocs) inside
 * [date window-start, next day window-start), UK local time. Each kept service retains its whole
 * journey. Services touching only deferredTiplocs, or only outside the window, are listed in
 * `excluded`, never dropped silently.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { CifParser } from "../src/import/cif/parseCif.ts";
import { addDays, buildSnapshot, runsOn } from "../src/import/cif/snapshot.ts";
import { TimetableSnapshot, TimingPointsFile } from "../src/model/index.ts";
import { datasetDir, flags, path, readJson, writeJson } from "./lib.ts";

const a = flags();
const datasetId = a.dataset ?? "shrewsbury";
if (!a.file || !a.date || !a.source) {
  console.error("Required: --file <CIF path> --date YYYY-MM-DD --source <registry id>");
  process.exit(1);
}
const date = a.date;
const windowStart = a["window-start"] ?? "00:00";
const holidaysFile = a["bank-holidays"] ?? "data/raw/govuk/bank-holidays-2026-10-27.json";
const tp = TimingPointsFile.parse(readJson(path(datasetDir(datasetId), "timing-points.json")));
const area = new Set(tp.areaTiplocs.map((t) => t.tiploc));
const deferred = new Set(tp.deferredTiplocs.map((t) => t.tiploc));
if (area.size === 0) {
  console.error("timing-points.json lists no areaTiplocs; run data:import-corpus first.");
  process.exit(1);
}

const originDates = [addDays(date, -1), date, addDays(date, 1)];
// Location-less schedules (STP cancellations) are kept so they can cancel area services.
const parser = new CifParser(
  (s) =>
    originDates.some((d) => runsOn(s, d)) &&
    (s.locations.length === 0 ||
      s.locations.some((l) => area.has(l.tiploc) || deferred.has(l.tiploc))),
  { index: true },
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

// GOV.UK bank holidays (OGL): every division's holidays within a day of the snapshot date.
const govuk = readJson(path(holidaysFile)) as Record<
  string,
  { division: string; events: { title: string; date: string }[] }
>;
const near = new Set([addDays(date, -1), date, addDays(date, 1)]);
const bankHolidays = Object.values(govuk)
  .flatMap((d) => d.events.map((e) => ({ division: d.division, date: e.date, title: e.title })))
  .filter((h) => near.has(h.date))
  .sort((x, y) => (x.date + x.division).localeCompare(y.date + y.division));

const snapshot = buildSnapshot(cif, date, {
  id: `${datasetId}-${date}`,
  sourceId: a.source,
  ...(a.retrieved ? { retrieved: a.retrieved } : {}),
  areaTiplocs: area,
  deferredTiplocs: deferred,
  windowStart,
  index: parser.index,
  calendar: { sourceId: "govuk-bank-holidays", file: holidaysFile, bankHolidays },
  importInfo: {
    file: a.file,
    schedulesRead: parser.scheduleCount,
    associationsRead: cif.associations.length,
    skippedRecords: cif.skippedRecords,
    unknownRecordTypes: cif.unknownRecordTypes,
    parseErrors: cif.errors.length,
  },
});
TimetableSnapshot.parse(snapshot);
const out = a.out ?? `data/datasets/${datasetId}/timetables/${date}.json`;
writeJson(path(out), snapshot);

const h = cif.header;
const tally = (xs: string[]) =>
  JSON.stringify(xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {}));
console.log(
  `Read ${parser.scheduleCount} schedules and ${cif.associations.length} associations (header ${h?.currentFileRef ?? "none"}, extracted ${h?.extractDate ?? "?"}, valid ${h?.userStartDate}..${h?.userEndDate}); skipped ${JSON.stringify(cif.skippedRecords)}.`,
);
console.log(`Wrote ${out}: ${snapshot.services.length} services in the ${date} window.`);
console.log(`  by origin date: ${tally(snapshot.services.map((s) => s.runDate))}`);
console.log(`  window: ${tally(snapshot.services.map((s) => s.window!))}`);
console.log(
  `  associations: ${tally((snapshot.associations ?? []).map((x) => `${x.category} ${x.mainStatus}/${x.assocStatus}`))}`,
);
console.log(
  `  excluded: ${tally((snapshot.excluded ?? []).map((x) => x.reason))}; previous-day services entirely before the window: ${snapshot.import!.previousDayOutsideWindow}`,
);
console.log(
  `  bank holidays near ${date}: ${bankHolidays.length ? JSON.stringify(bankHolidays) : "none"}`,
);
