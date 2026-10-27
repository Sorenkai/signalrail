/**
 * Renders data/previews/<id>.svg, a geographic preview of a dataset's infrastructure.
 *
 *   npm run data:preview -- --dataset shrewsbury
 */
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { Infrastructure, SourceRegistry, TimingPointsFile } from "../src/model/index.ts";
import { previewTimingPoints } from "../src/schematic/timingPoints.ts";
import { buildPreview, renderPreviewSvg } from "../src/schematic/preview.ts";
import { attributionFor } from "../src/data/attribution.ts";
import { datasetDir, flags, path, readJson } from "./lib.ts";

const id = flags().dataset ?? "shrewsbury";
const infra = Infrastructure.parse(readJson(path(datasetDir(id), "infrastructure.json")));
const registry = SourceRegistry.parse(readJson(path("data", "sources.json")));
const tpFile = path(datasetDir(id), "timing-points.json");
const timingPoints = existsSync(tpFile)
  ? previewTimingPoints(TimingPointsFile.parse(readJson(tpFile)), infra)
  : [];
const svg = renderPreviewSvg(
  buildPreview(infra, {
    attribution: attributionFor(
      { infra, timingPoints: existsSync(tpFile) ? readJson(tpFile) : null },
      registry,
    ),
    timingPoints,
  }),
);
mkdirSync(path("data", "previews"), { recursive: true });
writeFileSync(path("data", "previews", `${id}.svg`), svg);
console.log(`Wrote data/previews/${id}.svg`);
