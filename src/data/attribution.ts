import type { SourceRegistry } from "../model/index.ts";

/** Collects every sourceId cited anywhere in a data structure. */
export function citedSourceIds(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) citedSourceIds(v, out);
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.sourceId === "string") out.add(o.sourceId);
    for (const v of Object.values(o)) citedSourceIds(v, out);
  }
  return out;
}

/** Attribution line for everything a piece of data cites, in registry order. */
export function attributionFor(data: unknown, registry: SourceRegistry): string {
  const cited = citedSourceIds(data);
  return registry.sources
    .filter((s) => cited.has(s.id) && s.attribution)
    .map((s) => s.attribution)
    .join(" ");
}
