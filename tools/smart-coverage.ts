/**
 * Reports SMART train-describer berth coverage for a dataset's study-area TIPLOCs.
 * Read-only: prints findings, writes nothing.
 *
 *   npm run data:smart-coverage -- --dataset shrewsbury --file data/private/SMARTExtract.json [--json]
 */
import { smartCoverage, SmartFile } from "../src/import/smart/smart.ts";
import { TimingPointsFile } from "../src/model/index.ts";
import { datasetDir, flags, path, readJson } from "./lib.ts";

const a = flags();
const datasetId = a.dataset ?? "shrewsbury";
if (!a.file) {
  console.error("Required: --file <SMART JSON path>");
  process.exit(1);
}
const smart = SmartFile.parse(readJson(path(a.file)));
const tp = TimingPointsFile.parse(readJson(path(datasetDir(datasetId), "timing-points.json")));
const coverage = smartCoverage(smart, tp.areaTiplocs);
if (a.json) {
  console.log(JSON.stringify(coverage, null, 2));
} else {
  console.log(`SMART rows: ${smart.BERTHDATA.length}. Study-area TIPLOCs: ${coverage.length}.`);
  for (const c of coverage) {
    const detail = c.rows
      .map(
        (r) =>
          `${r.TD} ${r.FROMBERTH}->${r.TOBERTH} line ${r.FROMLINE || "-"} event ${r.EVENT} (${r.COMMENT})`,
      )
      .join("; ");
    console.log(
      `${c.tiploc.padEnd(8)} STANOX ${c.stanox ?? "-"}: ${c.rows.length ? detail : "no SMART berth data"}`,
    );
  }
  const covered = coverage.filter((c) => c.rows.length > 0).length;
  console.log(`${covered}/${coverage.length} study-area TIPLOCs have SMART berth data.`);
}
