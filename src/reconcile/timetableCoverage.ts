import { z } from "zod";
import type { Call, Service, TimetableSnapshot } from "../model/index.ts";
import type { ServiceClass, TimetablePlan } from "../sim/servicePlan.ts";

/**
 * Timetable coverage audit (P6, DECISION_LOG D-036): groups every service of a session's plan by
 * the movement it needs, using a hand-authored, ordered table of movement groups, and names
 * what blocks each group. It READS the plan built by buildServicePlan and the snapshot; it never
 * changes a classification, and a group's blockers are documentation, not simulation input.
 *
 * Group counts are what the snapshot contains. For an unsupported group they are an ESTIMATE of
 * what removing its blockers could unlock (an upper bound: every service in the group would
 * still need a pattern whose timing points match exactly); they are not results. Only the
 * planner's own classification, rerun after a change, is a result.
 */

const Evidence = z.enum(["sourced", "inferred", "unknown", "simplified"]);

export const CoverageBlocker = z.object({
  id: z.string().min(1),
  /** What kind of gap blocks the movement. */
  kind: z.enum([
    "unknown_signal_function",
    "untyped_junction",
    "incomplete_junction",
    "crossing_not_configurable",
    "slip_diagonal_unknown",
    "no_signal_mapped",
    "platform_too_short",
    "lifecycle_not_modelled",
    "beyond_cut",
    "location_unmapped",
    "not_audited",
  ]),
  /** Evidence level of the fact that blocks (e.g. "unknown": the signal's function is unknown). */
  evidence: Evidence,
  summary: z.string().min(1),
  /** Ids of the infrastructure, route or timetable records concerned. */
  records: z.array(z.string()).default([]),
  needed: z.string().min(1),
  /** The minimum change that would remove the blocker, if the needed evidence arrives. */
  proposedChange: z.string().min(1),
});
export type CoverageBlocker = z.infer<typeof CoverageBlocker>;

const CallMatch = z.object({
  tiploc: z.string().min(1),
  platform: z.array(z.string().nullable()).optional(),
  lines: z.array(z.string().nullable()).optional(),
});

/** Conditions on a service; every condition given must hold. */
export const GroupMatch = z.object({
  /** Where the service's area calls lie in its journey. */
  kind: z.array(z.enum(["through", "starts", "terminates", "internal"])).optional(),
  /** Matched by a valid service pattern (the plan's patternId). */
  pattern: z.string().optional(),
  /** (P7) Matched by any of these service patterns. */
  patterns: z.array(z.string()).min(1).optional(),
  /** The call before / after the area block (through or partial journeys only). */
  before: z.array(z.string()).optional(),
  after: z.array(z.string()).optional(),
  /** Each listed call must appear among the area calls, with the given fields. */
  has: z.array(CallMatch).optional(),
  /** At least one area call is at one of these TIPLOCs. */
  hasAny: z.array(z.string()).optional(),
  /** No area call is at any of these TIPLOCs. */
  lacks: z.array(z.string()).optional(),
  /** The service passes through the area more than once. */
  reenters: z.boolean().optional(),
});
export type GroupMatch = z.infer<typeof GroupMatch>;

export const MOVEMENT_FAMILIES = [
  "down_main",
  "up_main",
  "platform_1",
  "goods_line",
  "other_lines",
  "kingmoor",
  "internal_start_termination",
  "unresolved",
] as const;

export const MovementGroup = z.object({
  id: z.string().min(1),
  family: z.enum(MOVEMENT_FAMILIES),
  label: z.string().min(1),
  match: GroupMatch,
  /** Blocker ids (empty for a group the game can run). */
  blockers: z.array(z.string()),
  note: z.string().optional(),
});
export type MovementGroup = z.infer<typeof MovementGroup>;

export const MovementGroupsFile = z.object({
  $comment: z.string().optional(),
  datasetId: z.string().min(1),
  blockers: z.array(CoverageBlocker),
  /** Ordered: a service belongs to the first group it matches. */
  groups: z.array(MovementGroup).min(1),
});
export type MovementGroupsFile = z.infer<typeof MovementGroupsFile>;

export interface ServiceFeatures {
  kind: "through" | "starts" | "terminates" | "internal";
  blocks: number;
  before: string | null;
  after: string | null;
  /** Calls at play-area or deferred TIPLOCs. */
  areaCalls: Call[];
}

export function serviceFeatures(s: Service, inArea: (tiploc: string) => boolean): ServiceFeatures {
  const flags = s.calls.map((c) => inArea(c.tiploc));
  const first = flags.indexOf(true);
  const last = flags.lastIndexOf(true);
  const blocks = flags.filter((f, i) => f && (i === 0 || !flags[i - 1])).length;
  const starts = first === 0;
  const terminates = last === s.calls.length - 1;
  return {
    kind:
      first < 0
        ? "through"
        : starts && terminates
          ? "internal"
          : starts
            ? "starts"
            : terminates
              ? "terminates"
              : "through",
    blocks,
    before: first > 0 ? s.calls[first - 1]!.tiploc : null,
    after: last >= 0 && last + 1 < s.calls.length ? s.calls[last + 1]!.tiploc : null,
    areaCalls: s.calls.filter((c) => inArea(c.tiploc)),
  };
}

export function groupMatches(m: GroupMatch, f: ServiceFeatures, patternId: string | null): boolean {
  if (m.kind && !m.kind.includes(f.kind)) return false;
  if (m.pattern !== undefined && m.pattern !== patternId) return false;
  if (m.patterns !== undefined && (patternId === null || !m.patterns.includes(patternId)))
    return false;
  if (m.before && (f.before === null || !m.before.includes(f.before))) return false;
  if (m.after && (f.after === null || !m.after.includes(f.after))) return false;
  if (m.reenters !== undefined && m.reenters !== f.blocks > 1) return false;
  const tiplocs = new Set(f.areaCalls.map((c) => c.tiploc));
  if (m.hasAny && !m.hasAny.some((t) => tiplocs.has(t))) return false;
  if (m.lacks && m.lacks.some((t) => tiplocs.has(t))) return false;
  for (const want of m.has ?? [])
    if (
      !f.areaCalls.some(
        (c) =>
          c.tiploc === want.tiploc &&
          (want.platform === undefined || want.platform.includes(c.platform)) &&
          (want.lines === undefined || want.lines.includes(c.line)),
      )
    )
      return false;
  return true;
}

export interface CoverageService {
  serviceId: string;
  headcode: string | null;
  classification: ServiceClass;
  reasons: string[];
  patternId: string | null;
  observedPath: string;
  groupId: string | null;
}

export interface CoverageGroupSummary {
  id: string;
  family: MovementGroup["family"];
  label: string;
  blockers: string[];
  services: number;
  byClass: Record<ServiceClass, number>;
  /** Distinct timing-point sequences: at least one exact pattern each would be needed. */
  distinctPaths: number;
  /** For a group with blockers: services it could unlock, an upper-bound estimate. */
  estimateIfUnblocked: number | null;
}

export interface CoverageAudit {
  snapshotId: string;
  total: number;
  byClass: Record<ServiceClass, number>;
  byFamily: Record<(typeof MOVEMENT_FAMILIES)[number], Record<ServiceClass, number>>;
  groups: CoverageGroupSummary[];
  /** Services matching no group: the table is incomplete (must be empty to pass the test). */
  unmatched: string[];
  /** Groups whose members are runnable although the group names blockers, or the reverse. */
  inconsistent: string[];
  services: CoverageService[];
}

const zero = (): Record<ServiceClass, number> => ({
  representable: 0,
  approximated: 0,
  unsupported: 0,
  invalid: 0,
});

/** Pure: the same plan, snapshot and table always give the same audit. */
export function auditCoverage(
  plan: TimetablePlan,
  snapshot: TimetableSnapshot,
  table: MovementGroupsFile,
): CoverageAudit {
  const file = MovementGroupsFile.parse(table);
  const known = new Set(file.blockers.map((b) => b.id));
  for (const g of file.groups)
    for (const b of g.blockers)
      if (!known.has(b)) throw new Error(`group ${g.id} names unknown blocker ${b}`);
  const area = new Set([
    ...(snapshot.import?.areaTiplocs ?? []),
    ...(snapshot.import?.deferredTiplocs ?? []),
  ]);
  const byId = new Map(snapshot.services.map((s) => [s.id, s]));
  const services: CoverageService[] = plan.entries.map((e) => {
    const s = byId.get(e.serviceId);
    const f = s ? serviceFeatures(s, (t) => area.has(t)) : null;
    const g = f ? file.groups.find((x) => groupMatches(x.match, f, e.patternId)) : undefined;
    return {
      serviceId: e.serviceId,
      headcode: e.headcode,
      classification: e.classification,
      reasons: [...new Set(e.reasons.map((r) => r.code))],
      patternId: e.patternId,
      observedPath: e.observedPath,
      groupId: g?.id ?? null,
    };
  });
  services.sort((a, b) => (a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0));
  const byClass = zero();
  const byFamily = Object.fromEntries(MOVEMENT_FAMILIES.map((f) => [f, zero()])) as Record<
    (typeof MOVEMENT_FAMILIES)[number],
    Record<ServiceClass, number>
  >;
  const groupOf = new Map(file.groups.map((g) => [g.id, g]));
  for (const s of services) {
    byClass[s.classification]++;
    if (s.groupId) byFamily[groupOf.get(s.groupId)!.family][s.classification]++;
  }
  const inconsistent: string[] = [];
  const groups = file.groups.map((g): CoverageGroupSummary => {
    const members = services.filter((s) => s.groupId === g.id);
    const c = zero();
    for (const s of members) c[s.classification]++;
    const runnable = c.representable + c.approximated;
    if ((g.blockers.length > 0 && runnable > 0) || (g.blockers.length === 0 && c.unsupported > 0))
      inconsistent.push(g.id);
    return {
      id: g.id,
      family: g.family,
      label: g.label,
      blockers: g.blockers,
      services: members.length,
      byClass: c,
      distinctPaths: new Set(members.map((s) => s.observedPath)).size,
      estimateIfUnblocked: g.blockers.length > 0 ? c.unsupported : null,
    };
  });
  return {
    snapshotId: plan.snapshotId,
    total: services.length,
    byClass,
    byFamily,
    groups,
    unmatched: services.filter((s) => s.groupId === null).map((s) => s.serviceId),
    inconsistent,
    services,
  };
}
