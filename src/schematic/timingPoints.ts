import type { Infrastructure, LatLon, TimingPointsFile } from "../model/index.ts";

/** Timing points with a drawable position: sourced mappings via their location, plus inferred positions. */
export function previewTimingPoints(
  file: TimingPointsFile,
  infra: Infrastructure,
): { tiploc: string; position: LatLon; inferred: boolean; confidence: string | null }[] {
  const locations = new Map(infra.locations.map((l) => [l.id, l]));
  const sourced = file.mappings.flatMap((m) => {
    const p = locations.get(m.locationId)?.position;
    return p ? [{ tiploc: m.tiploc, position: p, inferred: false, confidence: null }] : [];
  });
  const inferred = file.inferredPositions.map((t) => ({
    tiploc: t.tiploc,
    position: t.position,
    inferred: true,
    confidence: t.confidence,
  }));
  return [...sourced, ...inferred];
}
