import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const path = (...p: string[]) => resolve(ROOT, ...p);

export const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
export function writeJson(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export const AreaConfig = z.object({
  datasetId: z.string(),
  name: z.string(),
  bbox: z.object({ south: z.number(), west: z.number(), north: z.number(), east: z.number() }),
  /** Path (relative to repo root) of the raw OSM snapshot the infrastructure is built from. */
  osmSnapshot: z.string().nullable(),
  /**
   * Optional supplement extract for the same bbox (platform outlines, stop_area relations),
   * used by the importer to link platforms to track. Must be a committed file.
   */
  osmSupplement: z.string().nullable().optional(),
});
export type AreaConfig = z.infer<typeof AreaConfig>;

export const datasetDir = (id: string) => path("data", "datasets", id);
export const readArea = (id: string) =>
  AreaConfig.parse(readJson(path(datasetDir(id), "area.json")));

/** Parses `--name value` flags; positional args are ignored. */
export function flags(argv = process.argv.slice(2)): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--"))
      out[a.slice(2)] = argv[i + 1]?.startsWith("--") ? "true" : (argv[++i] ?? "true");
  }
  return out;
}

export const today = () => new Date().toISOString().slice(0, 10);
