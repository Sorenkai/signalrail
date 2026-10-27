import { describe, expect, it } from "vitest";
import { mapByCrs, tiplocReferences } from "../src/import/corpus/corpus.ts";
import type { Location } from "../src/model/index.ts";

// SYNTHETIC CORPUS rows (codes invented for the test).
const corpus = {
  TIPLOCDATA: [
    {
      NLC: 1,
      STANOX: "99001",
      TIPLOC: "SYNA",
      "3ALPHA": "ZZA",
      UIC: " ",
      NLCDESC: "SYNTHETIC A",
      NLCDESC16: " ",
    },
    {
      NLC: 2,
      STANOX: " ",
      TIPLOC: "SYNJN",
      "3ALPHA": " ",
      UIC: " ",
      NLCDESC: "SYNTHETIC JN",
      NLCDESC16: " ",
    },
    {
      NLC: 3,
      STANOX: " ",
      TIPLOC: " ",
      "3ALPHA": " ",
      UIC: " ",
      NLCDESC: "NO TIPLOC",
      NLCDESC16: " ",
    },
  ],
};
const opts = { sourceId: "synthetic-fixture", retrieved: "2026-10-27" };

describe("CORPUS", () => {
  it("describes TIPLOCs and reports missing ones", () => {
    const { references, missing } = tiplocReferences(corpus, ["SYNA", "SYNJN", "SYNX"], opts);
    expect(missing).toEqual(["SYNX"]);
    expect(references[0]).toMatchObject({
      tiploc: "SYNA",
      description: "SYNTHETIC A",
      stanox: "99001",
      crs: "ZZA",
      nlc: "1",
    });
    expect(references[1]).toMatchObject({ stanox: null, crs: null });
    expect(references[0]!.provenance.sources[0]).toMatchObject({ recordId: "CORPUS:NLC=1" });
  });

  it("maps only on an exact, unique CRS join and cites both sources", () => {
    const { references } = tiplocReferences(corpus, ["SYNA", "SYNJN"], opts);
    const loc = (id: string, crs?: string): Location => ({
      id,
      name: id,
      kind: "station",
      codes: crs ? { crs } : {},
      provenance: { evidence: "sourced", sources: [{ sourceId: "openstreetmap", recordId: id }] },
    });
    const mapped = mapByCrs(references, [loc("st-a", "ZZA"), loc("other")]);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({ tiploc: "SYNA", locationId: "st-a" });
    expect(mapped[0]!.provenance.sources.map((s) => s.sourceId)).toEqual([
      "synthetic-fixture",
      "openstreetmap",
    ]);
    expect(mapByCrs(references, [loc("a1", "ZZA"), loc("a2", "ZZA")])).toEqual([]);
  });
});
