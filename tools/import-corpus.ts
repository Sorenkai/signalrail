/**
 * Records CORPUS details for the study area's TIPLOCs in timing-points.json and maps any
 * that join exactly on CRS code to an infrastructure location. Existing mappings are kept.
 *
 *   npm run data:import-corpus -- --dataset shrewsbury --file data/private/CORPUSExtract.json \
 *       --retrieved 2026-10-27 [--tiplocs SHRWBY,SHRWEBJ,...] \
 *       [--deferred KGMRJCN,... --deferred-reason "Kingmoor area deferred (playable-area.json)"]
 *
 * Without --tiplocs, the TIPLOCs already listed in areaTiplocs are refreshed. --deferred records
 * TIPLOCs of an area outside the playable scope (deferredTiplocs), described from CORPUS too;
 * without it, existing deferredTiplocs are kept.
 */
import { CorpusFile, mapByCrs, tiplocReferences } from "../src/import/corpus/corpus.ts";
import { Infrastructure, TimingPointsFile } from "../src/model/index.ts";
import { datasetDir, flags, path, readJson, writeJson } from "./lib.ts";

const a = flags();
const datasetId = a.dataset ?? "shrewsbury";
if (!a.file) {
  console.error("Required: --file <CORPUS JSON path>");
  process.exit(1);
}
const tpPath = path(datasetDir(datasetId), "timing-points.json");
const existing = TimingPointsFile.parse(readJson(tpPath));
const tiplocs = a.tiplocs
  ? a.tiplocs
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
  : existing.areaTiplocs.map((t) => t.tiploc);
if (tiplocs.length === 0) {
  console.error("No TIPLOCs given (--tiplocs) and none listed in areaTiplocs.");
  process.exit(1);
}
const corpus = CorpusFile.parse(readJson(path(a.file)));
const opts = { sourceId: "nr-open-data-feeds", ...(a.retrieved ? { retrieved: a.retrieved } : {}) };
const { references, missing } = tiplocReferences(corpus, tiplocs, opts);
const infra = Infrastructure.parse(readJson(path(datasetDir(datasetId), "infrastructure.json")));
const joined = mapByCrs(references, infra.locations);
const deferredList = a.deferred
  ?.split(",")
  .map((t) => t.trim())
  .filter(Boolean);
if (deferredList && !a["deferred-reason"]) {
  console.error("--deferred needs --deferred-reason");
  process.exit(1);
}
const deferred = deferredList
  ? (() => {
      const d = tiplocReferences(corpus, deferredList, opts);
      if (d.missing.length) console.log(`Deferred TIPLOCs not in CORPUS: ${d.missing.join(", ")}`);
      return d.references.map((r) => ({ ...r, reason: a["deferred-reason"]! }));
    })()
  : existing.deferredTiplocs;
const kept = existing.mappings.filter((m) => !joined.some((j) => j.tiploc === m.tiploc));

writeJson(tpPath, {
  $comment: existing.$comment,
  areaTiplocs: references,
  mappings: [...kept, ...joined].sort((x, y) => x.tiploc.localeCompare(y.tiploc)),
  inferredPositions: existing.inferredPositions,
  deferredTiplocs: deferred,
});
console.log(
  `${references.length} TIPLOC(s) described from CORPUS; ${joined.length} mapped by CRS.`,
);
if (missing.length > 0) console.log(`Not found in CORPUS: ${missing.join(", ")}`);
const placed = new Set([...kept, ...joined, ...existing.inferredPositions].map((m) => m.tiploc));
const unmapped = references.filter((r) => !placed.has(r.tiploc));
console.log(
  `Unmapped (need a sourced position on the track graph): ${unmapped.map((r) => r.tiploc).join(", ")}`,
);
