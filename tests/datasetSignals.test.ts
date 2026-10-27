/**
 * Guards on the real Carlisle and Shrewsbury datasets (audit M1, M2; R1): signal classes,
 * components and mounting must be exactly what the recorded OSM snapshot states, and the
 * committed infrastructure.json must be what the importer produces from that snapshot.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadDataset } from "../src/data/loadDataset.ts";
import { importOsm, signalComponents } from "../src/import/osm/importOsm.ts";
import type { OverpassResponse } from "../src/import/osm/overpass.ts";
import { validateDataset } from "../src/validation/validate.ts";

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe.each(["carlisle", "shrewsbury"])("%s dataset", (id) => {
  const { input, schemaIssues } = loadDataset("data", id);
  const signals = input!.infrastructure.signals;

  it("passes schema and dataset validation with no errors", () => {
    expect(schemaIssues).toEqual([]);
    expect(validateDataset(input!).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("is reproducible from its raw OSM snapshot", () => {
    const area = readJson(`data/datasets/${id}/area.json`);
    const raw = readJson(area.osmSnapshot) as OverpassResponse & { retrieved: string };
    const sup = area.osmSupplement ? readJson(area.osmSupplement) : null;
    const { infrastructure } = importOsm(raw, {
      datasetId: id,
      bbox: area.bbox,
      retrieved: raw.retrieved,
      generated: raw.retrieved,
      ...(sup
        ? {
            supplement: {
              elements: sup.elements,
              version: sup.osm3s.timestamp_osm_base,
              retrieved: sup.retrieved,
              file: area.osmSupplement,
            },
          }
        : {}),
    });
    expect(input!.infrastructure).toEqual(infrastructure);
  });

  it("keeps every signal's components identical to its source tags", () => {
    for (const s of signals) {
      expect(s.sourceTags).toBeDefined();
      expect(s.components).toEqual(signalComponents(s.sourceTags!));
    }
  });

  it("states a mounting only where the source tags one", () => {
    for (const s of signals) {
      const pos = s.sourceTags!["railway:signal:position"];
      if (pos === "bridge") expect(s.mounting.value).toBe("gantry");
      else {
        expect(s.mounting.value).toBeNull();
        expect(s.mounting.provenance.evidence).toBe("unknown");
      }
    }
  });
});

describe("Carlisle signal capabilities (real data)", () => {
  const signals = loadDataset("data", "carlisle").input!.infrastructure.signals;
  const has = (category: string) =>
    signals.filter((s) => s.components.some((c) => c.category === category));

  it("types light shunting signals as light, never ground", () => {
    const shuntOnly = signals.filter((s) => s.function === "shunting");
    expect(shuntOnly).toHaveLength(15);
    for (const s of shuntOnly) expect(s.type).toBe("light");
  });

  it("keeps the shunting component on the 21 main signals that carry one", () => {
    expect(has("shunting").filter((s) => s.function === "main")).toHaveLength(21);
  });

  it("keeps the 8 junction route indicators with design and stated indications", () => {
    const route = (ref: string) =>
      signals.find((s) => s.ref === ref)!.components.find((c) => c.category === "route")!;
    expect(has("route")).toHaveLength(8);
    expect(route("CE264")).toMatchObject({
      sourceType: "GB-NR:junction",
      design: "feather",
      states: ["position_4", "position_6", "off"],
    });
    // Theatre indicators at Carlisle have no states tag: the indications stay unknown.
    expect(route("CE408")).toMatchObject({ design: "theatre", states: null });
  });
});
