import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  Control,
  Infrastructure,
  PlayableArea,
  SignalEvidenceFile,
  Signalling,
  SourceRegistry,
  TimetableSnapshot,
  TimingPointsFile,
} from "../model/index.ts";
import type { Issue, ValidationInput } from "../validation/validate.ts";

/**
 * Loads a dataset directory (data/datasets/<id>/). Each layer lives in its own file:
 * infrastructure.json, signalling.json, control.json, timing-points.json, timetables/*.json,
 * plus optional signal-evidence.json and playable-area.json.
 * Schema failures are returned as issues rather than thrown, so validation can report them all.
 */
export function loadDataset(
  dataRoot: string,
  datasetId: string,
): { input: ValidationInput | null; schemaIssues: Issue[] } {
  const dir = join(dataRoot, "datasets", datasetId);
  const schemaIssues: Issue[] = [];

  function load<T extends z.ZodType>(
    file: string,
    schema: T,
    required: boolean,
  ): z.infer<T> | undefined {
    const p = join(dir, file);
    if (!existsSync(p)) {
      if (required)
        schemaIssues.push({
          severity: "error",
          code: "MISSING_FILE",
          message: `${datasetId}/${file} not found`,
        });
      return undefined;
    }
    const parsed = schema.safeParse(JSON.parse(readFileSync(p, "utf8")));
    if (parsed.success) return parsed.data;
    for (const issue of parsed.error.issues.slice(0, 50)) {
      schemaIssues.push({
        severity: "error",
        code: "SCHEMA",
        message: `${datasetId}/${file} ${issue.path.join(".")}: ${issue.message}`,
      });
    }
    return undefined;
  }

  const sources = (() => {
    const parsed = SourceRegistry.safeParse(
      JSON.parse(readFileSync(join(dataRoot, "sources.json"), "utf8")),
    );
    if (parsed.success) return parsed.data;
    for (const i of parsed.error.issues) {
      schemaIssues.push({
        severity: "error",
        code: "SCHEMA",
        message: `sources.json ${i.path.join(".")}: ${i.message}`,
      });
    }
    return undefined;
  })();
  const infrastructure = load("infrastructure.json", Infrastructure, true);
  const signalling = load("signalling.json", Signalling, false);
  const control = load("control.json", Control, false);
  const timingPointsFile = load("timing-points.json", TimingPointsFile, false);
  const signalEvidence = load("signal-evidence.json", SignalEvidenceFile, false);
  const playableArea = load("playable-area.json", PlayableArea, false);
  const timingPoints = timingPointsFile?.mappings ?? [];
  const areaTiplocs = timingPointsFile?.areaTiplocs.map((t) => t.tiploc);
  const timingPointPositions = timingPointsFile?.inferredPositions ?? [];
  const deferredTiplocs = timingPointsFile?.deferredTiplocs.map((t) => t.tiploc) ?? [];
  const ttDir = join(dir, "timetables");
  const timetables = existsSync(ttDir)
    ? readdirSync(ttDir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => load(join("timetables", f), TimetableSnapshot, true))
        .filter((t): t is TimetableSnapshot => t !== undefined)
    : [];

  if (!sources || !infrastructure) return { input: null, schemaIssues };
  return {
    input: {
      sources,
      infrastructure,
      signalling,
      control,
      timingPoints,
      timingPointPositions,
      timetables,
      ...(signalEvidence ? { signalEvidence } : {}),
      ...(playableArea ? { playableArea } : {}),
      ...(areaTiplocs && areaTiplocs.length > 0 ? { areaTiplocs } : {}),
      ...(deferredTiplocs.length > 0 ? { deferredTiplocs } : {}),
    },
    schemaIssues,
  };
}

export function listDatasets(dataRoot: string): string[] {
  const dir = join(dataRoot, "datasets");
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "area.json")))
    .map((d) => d.name)
    .sort();
}
