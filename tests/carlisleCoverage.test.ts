/**
 * The P6 coverage audit (DECISION_LOG D-036) on the committed Carlisle files: every service of
 * the 2026-11-04 snapshot falls in exactly one movement group of
 * docs/pilots/carlisle-p6-movement-groups.json, no runnable service sits in a blocked group, and
 * the committed report docs/pilots/carlisle-p6-coverage.json is what the tool produces today.
 * Since P7 (D-037) the P6 report is a reproducible baseline: it is rebuilt from today's files
 * with the two P6 patterns only (`--patterns`), and the P7 report (carlisle-p7-*.json) is
 * checked the same way with every pattern. Regenerate both with `npm run data:coverage`
 * (IMPORTING.md) after any planner or data change.
 *
 * The audit reads the planner; it decides nothing. Blocked-group sizes are estimates.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { syntheticService } from "../fixtures/synthetic/timetable.ts";
import { loadDataset } from "../src/data/loadDataset.ts";
import {
  MovementGroupsFile,
  auditCoverage,
  groupMatches,
  serviceFeatures,
} from "../src/reconcile/timetableCoverage.ts";
import { DEFAULT_POLICY, createWorld, timetableSessionConfig } from "../src/sim/index.ts";

const { input } = loadDataset("data", "carlisle");
const d = structuredClone(input!);
delete d.signalEvidence;
const snapshot = d.timetables!.find((t) => t.date === "2026-11-04")!;
const table = MovementGroupsFile.parse(
  JSON.parse(readFileSync("docs/pilots/carlisle-p6-movement-groups.json", "utf8")),
);
const committed = JSON.parse(readFileSync("docs/pilots/carlisle-p6-coverage.json", "utf8"));
/** The patterns of the P6 baseline (D-036); P7 adds four (D-037). */
const P6_PATTERNS = ["pat-down-wcml-through-p3", "pat-down-wcml-p3-caldew-goods"];

const plan = (patternIds?: string[]) => {
  const patterns = structuredClone(d.servicePatterns!);
  if (patternIds) patterns.patterns = patterns.patterns.filter((p) => patternIds.includes(p.id));
  return createWorld(
    {
      infrastructure: d.infrastructure,
      signalling: d.signalling!,
      control: d.control!,
      sources: d.sources,
      gameRules: d.gameRules!,
      playableArea: d.playableArea!,
      timetable: { snapshot, patterns, config: timetableSessionConfig("2026-11-04") },
    },
    DEFAULT_POLICY,
    {},
  ).timetable!;
};
const audit = auditCoverage(plan(P6_PATTERNS), snapshot, table);

describe("Carlisle coverage audit (2026-11-04), P6 baseline", () => {
  it("puts every service in one group, and no runnable service in a blocked group", () => {
    expect(audit.total).toBe(381);
    expect(audit.unmatched).toEqual([]);
    expect(audit.inconsistent).toEqual([]);
    expect(audit.groups.find((g) => g.id === "unclassified")!.services).toBe(0);
    expect(audit.groups.reduce((n, g) => n + g.services, 0)).toBe(381);
  });

  it("matches the committed report", () => {
    expect(committed.current.byClass).toEqual(audit.byClass);
    expect(committed.byFamily).toEqual(audit.byFamily);
    expect(committed.groups).toEqual(audit.groups);
    expect(committed.services).toEqual(audit.services);
    expect(committed.blockers).toEqual(table.blockers);
    expect(committed.patterns).toEqual(P6_PATTERNS);
    expect(committed.baseline.byClass).toEqual({
      representable: 2,
      approximated: 49,
      unsupported: 330,
      invalid: 0,
    });
  });

  it("measures the P6 change on the unchanged snapshot: only the goods line gains, by 4", () => {
    const before = auditCoverage(plan(["pat-down-wcml-through-p3"]), snapshot, table);
    const changed = audit.services.filter((s) => {
      const b = before.services.find((x) => x.serviceId === s.serviceId)!;
      return b.classification !== s.classification || b.groupId !== s.groupId;
    });
    expect(changed.map((s) => [s.headcode, s.classification, s.groupId])).toEqual([
      // By service id: H37962, H49630, H49635, H57939.
      ["4S48", "approximated", "goods-caldew"],
      ["4S01", "representable", "goods-caldew"],
      ["4S94", "approximated", "goods-caldew"],
      ["4S38", "approximated", "goods-caldew"],
    ]);
    // Before P6 the same four were unsupported for a field mismatch, in the same group table.
    for (const s of changed) {
      const b = before.services.find((x) => x.serviceId === s.serviceId)!;
      expect(b).toMatchObject({
        classification: "unsupported",
        reasons: ["PATTERN_FIELD_MISMATCH"],
      });
    }
    expect(audit.byFamily.goods_line).toEqual({
      representable: 1,
      approximated: 3,
      unsupported: 0,
      invalid: 0,
    });
  });

  it("records the blocked families as unsupported, with their estimated sizes", () => {
    const unsupported = Object.fromEntries(
      Object.entries(audit.byFamily).map(([f, c]) => [f, c.unsupported]),
    );
    expect(unsupported).toEqual({
      down_main: 0,
      up_main: 72,
      platform_1: 21,
      goods_line: 0,
      other_lines: 3,
      kingmoor: 69,
      internal_start_termination: 159,
      unresolved: 2,
    });
  });
});

describe("movement-group matching (synthetic services)", () => {
  const inArea = (t: string) => t === "SYNSTA" || t === "SYNJN";
  const svc = syntheticService({ uid: "Z00001", runDate: "2026-11-04", before: "06:00" });

  it("reads a through service's calls either side of the area, and its field checks", () => {
    const f = serviceFeatures(svc, inArea);
    expect(f).toMatchObject({ kind: "through", blocks: 1, before: "SYNBEF", after: "SYNAFT" });
    expect(groupMatches({ before: ["SYNBEF"], has: [{ tiploc: "SYNSTA" }] }, f, null)).toBe(true);
    expect(groupMatches({ has: [{ tiploc: "SYNSTA", platform: ["9"] }] }, f, null)).toBe(false);
    expect(groupMatches({ kind: ["starts"] }, f, null)).toBe(false);
    expect(groupMatches({ pattern: "pat-x" }, f, "pat-y")).toBe(false);
    expect(groupMatches({ lacks: ["SYNJN"] }, f, null)).toBe(false);
  });

  it("tells starting, terminating and internal services apart", () => {
    const cut = (from: number, to: number) => ({ ...svc, calls: svc.calls.slice(from, to) });
    const n = svc.calls.length;
    const sta = svc.calls.findIndex((c) => c.tiploc === "SYNSTA");
    const jn = svc.calls.findIndex((c) => c.tiploc === "SYNJN");
    expect(serviceFeatures(cut(sta, n), inArea)).toMatchObject({ kind: "starts", before: null });
    expect(serviceFeatures(cut(0, jn + 1), inArea)).toMatchObject({
      kind: "terminates",
      after: null,
    });
    expect(serviceFeatures(cut(sta, jn + 1), inArea).kind).toBe("internal");
  });

  it("refuses a table that names an unknown blocker", () => {
    const bad = structuredClone(table);
    bad.groups[0]!.blockers = ["B-DOES-NOT-EXIST"];
    expect(() => auditCoverage(plan(P6_PATTERNS), snapshot, bad)).toThrow(
      /unknown blocker B-DOES-NOT-EXIST/,
    );
  });
});
