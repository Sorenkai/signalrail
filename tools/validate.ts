/**
 * Validates datasets: schemas, ids, references, topology, routes, timetable mapping and
 * unsupported assumptions. Exits non-zero if any error is found.
 *
 *   npm run data:validate                       # all datasets
 *   npm run data:validate -- --dataset shrewsbury [--json] [--verbose]
 */
import { listDatasets, loadDataset } from "../src/data/loadDataset.ts";
import { summariseEvidence, validateDataset, type Issue } from "../src/validation/validate.ts";
import { flags, path } from "./lib.ts";

const args = flags();
const ids = args.dataset ? [args.dataset] : listDatasets(path("data"));
let errorCount = 0;
const json: Record<string, unknown> = {};

for (const id of ids) {
  const { input, schemaIssues } = loadDataset(path("data"), id);
  const issues: Issue[] = [...schemaIssues, ...(input ? validateDataset(input) : [])];
  const summary = input ? summariseEvidence(input) : null;
  errorCount += issues.filter((i) => i.severity === "error").length;
  if (args.json) {
    json[id] = { issues, evidence: summary };
    continue;
  }
  console.log(`\n=== ${id} ===`);
  if (summary) {
    console.log("Evidence (all provenance records):", JSON.stringify(summary.total));
  }
  for (const sev of ["error", "warning", "info"] as const) {
    const list = issues.filter((i) => i.severity === sev);
    console.log(`${sev.toUpperCase()}S: ${list.length}`);
    for (const i of list) {
      const shown =
        i.ids && args.verbose
          ? `  [${i.ids.slice(0, 10).join(", ")}${i.ids.length > 10 ? ", ..." : ""}]`
          : "";
      console.log(`  ${i.code}: ${i.message}${shown}`);
    }
  }
}
if (args.json) console.log(JSON.stringify(json, null, 2));
else console.log(`\n${errorCount === 0 ? "No errors." : `${errorCount} error(s).`}`);
process.exit(errorCount === 0 ? 0 : 1);
