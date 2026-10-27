import { z } from "zod";
import type { Location, TimingPointMapping, TiplocReference } from "../../model/index.ts";

/** Network Rail CORPUS extract (JSON): `{ "TIPLOCDATA": [ ... ] }`. Blank fields are " ". */
export const CorpusRow = z.object({
  NLC: z.union([z.number(), z.string()]),
  STANOX: z.string(),
  TIPLOC: z.string(),
  "3ALPHA": z.string(),
  UIC: z.string(),
  NLCDESC: z.string(),
  NLCDESC16: z.string(),
});
export const CorpusFile = z.object({ TIPLOCDATA: z.array(CorpusRow) });
export type CorpusRow = z.infer<typeof CorpusRow>;

const blank = (s: string) => (s.trim() === "" ? null : s.trim());

export interface CorpusOptions {
  sourceId: string;
  retrieved?: string;
  version?: string;
}

const ref = (row: CorpusRow, o: CorpusOptions) => ({
  sourceId: o.sourceId,
  recordId: `CORPUS:NLC=${row.NLC}`,
  ...(o.version ? { version: o.version } : {}),
  ...(o.retrieved ? { retrieved: o.retrieved } : {}),
});

/** Looks up CORPUS rows for the given TIPLOCs. Missing TIPLOCs are returned separately. */
export function tiplocReferences(
  corpus: z.infer<typeof CorpusFile>,
  tiplocs: string[],
  o: CorpusOptions,
): { references: TiplocReference[]; missing: string[] } {
  const byTiploc = new Map<string, CorpusRow>();
  for (const row of corpus.TIPLOCDATA) {
    const t = blank(row.TIPLOC);
    if (t && !byTiploc.has(t)) byTiploc.set(t, row);
  }
  const references: TiplocReference[] = [];
  const missing: string[] = [];
  for (const t of tiplocs) {
    const row = byTiploc.get(t);
    if (!row) {
      missing.push(t);
      continue;
    }
    references.push({
      tiploc: t,
      description: blank(row.NLCDESC),
      stanox: blank(row.STANOX),
      crs: blank(row["3ALPHA"]),
      nlc: String(row.NLC),
      provenance: { evidence: "sourced", sources: [ref(row, o)] },
    });
  }
  return { references, missing };
}

/**
 * Maps TIPLOCs to infrastructure locations by an exact CRS-code join: CORPUS gives
 * TIPLOC -> CRS, the infrastructure source gives location -> CRS. No name matching.
 */
export function mapByCrs(
  references: TiplocReference[],
  locations: Location[],
): TimingPointMapping[] {
  const out: TimingPointMapping[] = [];
  for (const r of references) {
    if (!r.crs) continue;
    const matches = locations.filter((l) => l.codes.crs === r.crs);
    if (matches.length !== 1) continue;
    const loc = matches[0]!;
    out.push({
      tiploc: r.tiploc,
      locationId: loc.id,
      provenance: {
        evidence: "sourced",
        sources: [...r.provenance.sources, ...loc.provenance.sources],
        note: `Joined on CRS ${r.crs}: CORPUS gives ${r.tiploc} -> ${r.crs}; the location's CRS is from its own source.`,
      },
    });
  }
  return out;
}
