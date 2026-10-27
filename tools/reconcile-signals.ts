/**
 * Builds the signal evidence layer for a dataset: data/datasets/<id>/signal-evidence.json.
 * Reads the dataset's infrastructure.json and raw OSM snapshot, plus the owner-supplied SMART
 * and CORPUS extracts in data/private/. Deterministic for the same inputs and --generated date.
 *
 *   npx tsx tools/reconcile-signals.ts --dataset carlisle [--generated 2026-10-27]
 */
import { CorpusFile } from "../src/import/corpus/corpus.ts";
import { SmartFile } from "../src/import/smart/smart.ts";
import { Infrastructure, SignalEvidenceFile } from "../src/model/index.ts";
import { buildSignalEvidence } from "../src/reconcile/signalEvidence.ts";
import { RECONCILIATION_SCOPES } from "../src/reconcile/scopes.ts";
import { datasetDir, flags, path, readArea, readJson, today, writeJson } from "./lib.ts";

const args = flags();
const datasetId = args.dataset ?? "carlisle";
const scope = RECONCILIATION_SCOPES[datasetId];
if (!scope) throw new Error(`no reconciliation scope for dataset "${datasetId}"`);
const area = readArea(datasetId);
if (!area.osmSnapshot) throw new Error(`${datasetId} has no OSM snapshot`);

const infra = Infrastructure.parse(readJson(path(datasetDir(datasetId), "infrastructure.json")));
const raw = readJson(path(area.osmSnapshot)) as {
  osm3s?: { timestamp_osm_base?: string };
  elements: { type: string; id: number; tags?: Record<string, string> }[];
};
const rawTags = new Map(
  raw.elements
    .filter((e) => e.type === "node" && e.tags?.railway === "signal")
    .map((e) => [`osm-sig${e.id}`, e.tags!]),
);
const smart = SmartFile.parse(readJson(path("data/private/SMARTExtract.json")));
const corpus = CorpusFile.parse(readJson(path("data/private/CORPUSExtract.json")));

const { corpusSignalPattern, ...evidenceScope } = scope;
const evidence = buildSignalEvidence({
  datasetId,
  generated: args.generated ?? today(),
  infra,
  rawTags,
  smartRows: smart.BERTHDATA,
  corpus: corpus.TIPLOCDATA,
  corpusSignalPattern,
  scope: evidenceScope,
  sources: {
    osm: { sourceId: "openstreetmap", version: infra.version, recordId: area.osmSnapshot },
    smart: {
      sourceId: "nr-open-data-feeds",
      version: "SMARTExtract.json (owner-supplied, retrieved 2026-10-27)",
    },
    corpus: {
      sourceId: "nr-open-data-feeds",
      version: "CORPUSExtract.json (owner-supplied, retrieved 2026-10-27)",
    },
  },
});
const out = path(datasetDir(datasetId), "signal-evidence.json");
writeJson(out, SignalEvidenceFile.parse(evidence));

const tally = (xs: string[]) => {
  const m: Record<string, number> = {};
  for (const x of xs) m[x] = (m[x] ?? 0) + 1;
  return m;
};
const s = evidence.signals;
console.log(`signals ${s.length}; steps ${evidence.steps.length}`);
console.log("identity :", JSON.stringify(tally(s.map((x) => x.identity.assessment))));
console.log("position :", JSON.stringify(tally(s.map((x) => x.position.assessment))));
console.log("direction:", JSON.stringify(tally(s.map((x) => x.direction.assessment))));
console.log(
  "berths   :",
  JSON.stringify(tally(s.flatMap((x) => x.berths.map((b) => b.claim.assessment)))),
);
console.log("steps    :", JSON.stringify(tally(evidence.steps.map((x) => x.result))));
console.log(`Wrote ${out}`);
