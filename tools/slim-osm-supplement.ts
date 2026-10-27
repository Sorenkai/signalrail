/**
 * Derives a slimmed copy of a raw Overpass supplement extract. The raw file is read only and
 * never modified. Deterministic: the same inputs give a byte-identical output.
 *
 * Kept: every node and way (platform outlines, disused/abandoned railway ways, stop positions,
 * other railway nodes), stop_area and site relations in full, and route=railway relations with
 * their members filtered to ways present in the main extract (line names for in-area track).
 * Omitted: route=train, route=historic and any other route relations. Their member lists name
 * ways across Great Britain and passenger service patterns, which the infrastructure import does
 * not use; each omitted relation is listed (id, tags summary, member count) in the output.
 *
 *   npx tsx tools/slim-osm-supplement.ts --in data/raw/osm/<x>-supplement.json \
 *     --main data/raw/osm/<x>.json --out data/raw/osm/<x>-supplement-slim.json
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { flags, path, ROOT, writeJson } from "./lib.ts";

interface Element {
  type: "node" | "way" | "relation";
  id: number;
  tags?: Record<string, string>;
  members?: { type: string; ref: number; role: string }[];
}

const args = flags();
if (!args.in || !args.main || !args.out) throw new Error("--in, --main and --out are required");
const inFile = path(args.in);
const outFile = path(args.out);
if (outFile === inFile) throw new Error("refusing to overwrite the raw supplement");
const rawText = readFileSync(inFile, "utf8");
const raw = JSON.parse(rawText) as { elements: Element[] } & Record<string, unknown>;
const main = JSON.parse(readFileSync(path(args.main), "utf8")) as { elements: Element[] };
const mainWays = new Set(main.elements.filter((e) => e.type === "way").map((e) => e.id));

const kept: Element[] = [];
const omitted: { relation: number; route: string; name: string | null; members: number }[] = [];
const filtered: { relation: number; name: string | null; members: number; kept: number }[] = [];
for (const e of raw.elements) {
  const route = e.type === "relation" ? e.tags?.route : undefined;
  if (route === undefined) {
    kept.push(e);
  } else if (route === "railway") {
    const members = (e.members ?? []).filter((m) => m.type === "way" && mainWays.has(m.ref));
    filtered.push({
      relation: e.id,
      name: e.tags?.name ?? null,
      members: e.members?.length ?? 0,
      kept: members.length,
    });
    kept.push({ ...e, members });
  } else {
    omitted.push({
      relation: e.id,
      route,
      name: e.tags?.name ?? null,
      members: e.members?.length ?? 0,
    });
  }
}

const { elements: _drop, ...meta } = raw;
void _drop;
const out = {
  ...meta,
  derivedFrom: {
    file: relative(ROOT, inFile),
    sha256: createHash("sha256").update(rawText).digest("hex"),
    bytes: Buffer.byteLength(rawText),
    elements: raw.elements.length,
  },
  derivation: {
    tool: "tools/slim-osm-supplement.ts",
    mainExtract: relative(ROOT, path(args.main)),
    rules: [
      "Keep all nodes and ways unchanged (geometry included).",
      "Keep relations without a route tag (stop_area, site) unchanged.",
      "Keep route=railway relations; filter their members to ways present in the main extract.",
      "Omit all other route relations (route=train, route=historic, ...): listed in `omitted`.",
    ],
    filteredRailwayRoutes: filtered,
    omitted,
  },
  elements: kept,
};
if (existsSync(outFile) && readFileSync(outFile, "utf8") !== JSON.stringify(out, null, 2) + "\n")
  console.log(`Note: ${relative(ROOT, outFile)} exists and differs; rewriting the derivative.`);
writeJson(outFile, out);
console.log(
  `Wrote ${relative(ROOT, outFile)}: ${kept.length} elements (from ${raw.elements.length}); ` +
    `omitted ${omitted.length} route relations; filtered ${filtered.length} railway routes`,
);
