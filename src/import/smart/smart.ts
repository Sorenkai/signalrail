import { z } from "zod";
import type { TiplocReference } from "../../model/index.ts";

/** Network Rail SMART extract (JSON): train describer berth steps linked to STANOX locations. */
export const SmartRow = z.object({
  TD: z.string(),
  FROMBERTH: z.string(),
  TOBERTH: z.string(),
  STANOX: z.string(),
  STANME: z.string(),
  STEPTYPE: z.string(),
  EVENT: z.string(),
  PLATFORM: z.string(),
  FROMLINE: z.string(),
  TOLINE: z.string(),
  BERTHOFFSET: z.string(),
  ROUTE: z.string(),
  COMMENT: z.string(),
});
export const SmartFile = z.object({ BERTHDATA: z.array(SmartRow) });
export type SmartRow = z.infer<typeof SmartRow>;

export interface SmartCoverage {
  tiploc: string;
  stanox: string | null;
  /** SMART rows whose STANOX matches; empty means SMART has no berth data for the location. */
  rows: SmartRow[];
  tdAreas: string[];
}

/**
 * Reports, per TIPLOC, the SMART berth steps recorded at its STANOX. Absence from SMART shows
 * only that no berth step is linked to that location; it does not prove there is no TD.
 */
export function smartCoverage(
  smart: z.infer<typeof SmartFile>,
  tiplocs: Pick<TiplocReference, "tiploc" | "stanox">[],
): SmartCoverage[] {
  const byStanox = new Map<string, SmartRow[]>();
  for (const r of smart.BERTHDATA) {
    const k = r.STANOX.trim();
    if (!k) continue;
    (byStanox.get(k) ?? byStanox.set(k, []).get(k)!).push(r);
  }
  return tiplocs.map((t) => {
    const rows = t.stanox ? (byStanox.get(t.stanox) ?? []) : [];
    return {
      tiploc: t.tiploc,
      stanox: t.stanox,
      rows,
      tdAreas: [...new Set(rows.map((r) => r.TD))].sort(),
    };
  });
}
