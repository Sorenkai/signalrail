import type {
  Control,
  EvidenceLevel,
  Infrastructure,
  Provenance,
  Signalling,
  SourceRegistry,
  TimetableSnapshot,
  TimingPointMapping,
  TimingPointPosition,
  LatLon,
} from "../model/index.ts";
import { EVIDENCE_LEVELS } from "../model/index.ts";
import { TrackGraph } from "./graph.ts";

export type Severity = "error" | "warning" | "info";

export interface Issue {
  severity: Severity;
  code: string;
  message: string;
  ids?: string[];
}

export interface ValidationInput {
  sources: SourceRegistry;
  infrastructure: Infrastructure;
  signalling?: Signalling;
  control?: Control;
  timingPoints?: TimingPointMapping[];
  /** Inferred track positions for TIPLOCs with no sourced mapping. */
  timingPointPositions?: TimingPointPosition[];
  /**
   * TIPLOCs inside the study area. Unmapped area TIPLOCs are warnings; other unmapped TIPLOCs
   * (the rest of each journey) are summarised as info. If omitted, every TIPLOC is in scope.
   */
  areaTiplocs?: string[];
  timetables?: TimetableSnapshot[];
  /** Synthetic sources are only legitimate in test fixtures. */
  allowSynthetic?: boolean;
}

/** Source ids with this prefix denote synthetic, non-real data. */
export const SYNTHETIC_SOURCE_PREFIX = "synthetic";

export interface EvidenceSummary {
  /** Counts of provenance records per evidence level, keyed by collection path. */
  byCollection: Record<string, Record<EvidenceLevel, number>>;
  total: Record<EvidenceLevel, number>;
}

interface FoundProvenance {
  path: string;
  ownerId: string | undefined;
  provenance: Provenance;
}

/** Walks any data structure and yields every Provenance record with its location. */
function* provenances(value: unknown, path: string, ownerId?: string): Generator<FoundProvenance> {
  if (Array.isArray(value)) {
    for (const v of value) yield* provenances(v, `${path}[]`, ownerId);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  const id =
    typeof obj.id === "string" ? obj.id : typeof obj.tiploc === "string" ? obj.tiploc : ownerId;
  for (const [k, v] of Object.entries(obj)) {
    if ((k === "provenance" || k === "membershipProvenance") && v && typeof v === "object") {
      yield { path: `${path}.${k}`, ownerId: id, provenance: v as Provenance };
    } else {
      yield* provenances(v, `${path}.${k}`, id);
    }
  }
}

const zeroCounts = () =>
  Object.fromEntries(EVIDENCE_LEVELS.map((l) => [l, 0])) as Record<EvidenceLevel, number>;

export function summariseEvidence(input: Omit<ValidationInput, "sources">): EvidenceSummary {
  const summary: EvidenceSummary = { byCollection: {}, total: zeroCounts() };
  const layers = {
    infrastructure: input.infrastructure,
    signalling: input.signalling,
    control: input.control,
    timingPoints: input.timingPoints,
    timingPointPositions: input.timingPointPositions,
    timetables: input.timetables,
  };
  for (const [name, layer] of Object.entries(layers)) {
    for (const p of provenances(layer, name)) {
      const key = p.path.replace(/\.provenance$/, "").replace(/\[\]/g, "");
      summary.byCollection[key] ??= zeroCounts();
      summary.byCollection[key][p.provenance.evidence]++;
      summary.total[p.provenance.evidence]++;
    }
  }
  return summary;
}

/** Metres between two coordinates (equirectangular; accurate to well under 1% at these scales). */
function metres(a: LatLon, b: LatLon): number {
  const k = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((a.lat - b.lat) * 111_320, (a.lon - b.lon) * 111_320 * k);
}

/** Generous bounds for Great Britain, incl. offshore islands. */
const inGreatBritain = (p: LatLon) =>
  p.lat >= 49.8 && p.lat <= 60.9 && p.lon >= -8.7 && p.lon <= 1.8;

/** A coordinate meant to coincide with a track node must be within this distance of it. */
const ALIGN_TOLERANCE_M = 1;
/** All anchors of one timing point should lie within this distance of its position. */
const TIMING_POINT_SPREAD_M = 60;

function toMinutes(t: string | null): number | null {
  if (!t) return null;
  const [h, m, s] = t.split(":");
  return Number(h) * 60 + Number(m) + (s ? 0.5 : 0);
}

export function validateDataset(input: ValidationInput): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Severity, code: string, message: string, ids?: string[]) =>
    issues.push({ severity, code, message, ...(ids ? { ids } : {}) });

  const { infrastructure: infra, signalling, control } = input;
  const timingPoints = input.timingPoints ?? [];
  const timingPointPositions = input.timingPointPositions ?? [];
  const timetables = input.timetables ?? [];

  // --- duplicate identifiers (ids are global across all entity collections) ---
  const seen = new Map<string, string>();
  const register = (collection: string, ids: string[]) => {
    for (const id of ids) {
      const prev = seen.get(id);
      if (prev)
        add("error", "DUPLICATE_ID", `"${id}" in ${collection} duplicates an id in ${prev}`, [id]);
      else seen.set(id, collection);
    }
  };
  register(
    "sources",
    input.sources.sources.map((s) => s.id),
  );
  register(
    "nodes",
    infra.nodes.map((n) => n.id),
  );
  register(
    "edges",
    infra.edges.map((e) => e.id),
  );
  register(
    "locations",
    infra.locations.map((l) => l.id),
  );
  register(
    "platforms",
    infra.platforms.map((p) => p.id),
  );
  register(
    "signals",
    infra.signals.map((s) => s.id),
  );
  register(
    "points",
    infra.points.map((p) => p.id),
  );
  register(
    "occupancySections",
    infra.occupancySections.map((o) => o.id),
  );
  if (signalling) {
    register(
      "routes",
      signalling.routes.map((r) => r.id),
    );
    register(
      "overlaps",
      signalling.overlaps.map((o) => o.id),
    );
  }
  if (control) {
    register(
      "controlAreas",
      control.areas.map((a) => a.id),
    );
    register(
      "areaBoundaries",
      control.boundaries.map((b) => b.id),
    );
  }
  for (const t of timetables) {
    const svc = new Set<string>();
    for (const s of t.services) {
      if (svc.has(s.id))
        add("error", "DUPLICATE_ID", `service "${s.id}" repeated in timetable ${t.id}`, [s.id]);
      svc.add(s.id);
    }
  }

  // --- missing references ---
  const has = {
    node: new Set(infra.nodes.map((n) => n.id)),
    edge: new Set(infra.edges.map((e) => e.id)),
    location: new Set(infra.locations.map((l) => l.id)),
    signal: new Set(infra.signals.map((s) => s.id)),
    points: new Set(infra.points.map((p) => p.id)),
    route: new Set(signalling?.routes.map((r) => r.id) ?? []),
    overlap: new Set(signalling?.overlaps.map((o) => o.id) ?? []),
    area: new Set(control?.areas.map((a) => a.id) ?? []),
    source: new Set(input.sources.sources.map((s) => s.id)),
  };
  const ref = (
    kind: keyof typeof has,
    id: string | null | undefined,
    owner: string,
    field: string,
  ) => {
    if (id == null) return;
    if (!has[kind].has(id))
      add("error", "MISSING_REFERENCE", `${owner}.${field} -> unknown ${kind} "${id}"`, [
        owner,
        id,
      ]);
  };
  for (const e of infra.edges) {
    ref("node", e.from, e.id, "from");
    ref("node", e.to, e.id, "to");
    if (e.from === e.to)
      add("error", "SELF_LOOP", `edge ${e.id} starts and ends at ${e.from}`, [e.id]);
  }
  for (const p of infra.platforms) {
    ref("location", p.locationId, p.id, "locationId");
    for (const e of p.edgeIds.value ?? []) ref("edge", e, p.id, "edgeIds");
  }
  for (const s of infra.signals) {
    ref("node", s.trackNodeId, s.id, "trackNodeId");
    ref("node", s.facingTowardsNodeId.value, s.id, "facingTowardsNodeId");
  }
  for (const p of infra.points) {
    ref("node", p.trackNodeId, p.id, "trackNodeId");
    ref("node", p.normalTowardsNodeId.value, p.id, "normalTowardsNodeId");
    ref("node", p.reverseTowardsNodeId.value, p.id, "reverseTowardsNodeId");
  }
  for (const o of infra.occupancySections)
    for (const e of o.edgeIds) ref("edge", e, o.id, "edgeIds");
  for (const r of signalling?.routes ?? []) {
    ref("signal", r.entrySignalId, r.id, "entrySignalId");
    ref("signal", r.exitSignalId, r.id, "exitSignalId");
    for (const e of r.edgeIds) ref("edge", e, r.id, "edgeIds");
    for (const p of r.pointsRequired) ref("points", p.pointsId, r.id, "pointsRequired");
    ref("overlap", r.overlapId, r.id, "overlapId");
    for (const c of r.conflictsWith) ref("route", c, r.id, "conflictsWith");
  }
  for (const o of signalling?.overlaps ?? []) {
    ref("signal", o.signalId, o.id, "signalId");
    for (const e of o.edgeIds) ref("edge", e, o.id, "edgeIds");
    for (const p of o.pointsRequired) ref("points", p.pointsId, o.id, "pointsRequired");
  }
  for (const a of control?.areas ?? []) {
    ref("location", a.signalBoxLocationId, a.id, "signalBoxLocationId");
    for (const s of a.signalIds) ref("signal", s, a.id, "signalIds");
    for (const p of a.pointsIds) ref("points", p, a.id, "pointsIds");
  }
  for (const b of control?.boundaries ?? []) {
    ref("area", b.fromAreaId, b.id, "fromAreaId");
    ref("area", b.toAreaId, b.id, "toAreaId");
    ref("edge", b.edgeId, b.id, "edgeId");
  }
  for (const m of timingPoints)
    ref("location", m.locationId, `timingPoint:${m.tiploc}`, "locationId");
  for (const t of timingPointPositions) {
    for (const n of t.trackNodeIds)
      ref("node", n, `timingPointPosition:${t.tiploc}`, "trackNodeIds");
  }

  // --- provenance: registered sources; synthetic data kept out of real datasets ---
  const layers = {
    infrastructure: infra,
    signalling,
    control,
    timingPoints,
    timingPointPositions,
    timetables,
  };
  const unknownSources = new Map<string, number>();
  const syntheticOwners: string[] = [];
  for (const [name, layer] of Object.entries(layers)) {
    for (const p of provenances(layer, name)) {
      for (const s of p.provenance.sources) {
        if (!has.source.has(s.sourceId))
          unknownSources.set(s.sourceId, (unknownSources.get(s.sourceId) ?? 0) + 1);
        if (s.sourceId.startsWith(SYNTHETIC_SOURCE_PREFIX) && p.ownerId)
          syntheticOwners.push(p.ownerId);
      }
    }
  }
  for (const [id, n] of unknownSources) {
    add(
      "error",
      "UNKNOWN_SOURCE",
      `${n} provenance record(s) cite "${id}", which is not in the source registry`,
      [id],
    );
  }
  if (syntheticOwners.length > 0 && !input.allowSynthetic) {
    add(
      "error",
      "SYNTHETIC_DATA",
      `${syntheticOwners.length} element(s) cite a synthetic source in a real dataset`,
      syntheticOwners.slice(0, 20),
    );
  }

  // --- track topology ---
  const graph = new TrackGraph(infra);
  const components = graph.components();
  if (components.length > 1) {
    const sizes = components.map((c) => c.length).sort((a, b) => b - a);
    add(
      "warning",
      "DISCONNECTED_TRACK",
      `track graph has ${components.length} disconnected parts (node counts ${sizes.join(", ")})`,
      components.slice(1).map((c) => c[0]!),
    );
  }
  const dangling = infra.nodes.filter((n) => n.kind === "end_unknown").map((n) => n.id);
  if (dangling.length > 0) {
    add(
      "warning",
      "DANGLING_TRACK_END",
      `${dangling.length} track end(s) without a buffer stop or boundary`,
      dangling,
    );
  }
  for (const n of infra.nodes) {
    const d = graph.degree(n.id);
    if (n.kind === "switch" && d !== 3 && d !== 4) {
      add(
        "warning",
        "SWITCH_TOPOLOGY",
        `switch node ${n.id} has ${d} connected edges (expected 3, or 4 for slips)`,
        [n.id],
      );
    }
    if (n.kind === "crossing" && d !== 4) {
      add(
        "warning",
        "CROSSING_TOPOLOGY",
        `crossing node ${n.id} has ${d} connected edges (expected 4)`,
        [n.id],
      );
    }
  }
  for (const p of infra.points) {
    const kind = infra.nodes.find((n) => n.id === p.trackNodeId)?.kind;
    if (kind && kind !== "switch")
      add("error", "POINTS_NOT_ON_SWITCH", `points ${p.id} sit on a ${kind} node`, [p.id]);
  }

  // --- coordinate plausibility and track alignment ---
  const nodePos = new Map(infra.nodes.filter((n) => n.position).map((n) => [n.id, n.position!]));
  const implausible: string[] = [];
  const check = (id: string, p: LatLon | undefined) => {
    if (p && !inGreatBritain(p)) implausible.push(id);
  };
  for (const n of infra.nodes) check(n.id, n.position);
  for (const l of infra.locations) check(l.id, l.position);
  for (const s of infra.signals) check(s.id, s.position);
  for (const t of timingPointPositions) check(`timingPointPosition:${t.tiploc}`, t.position);
  if (implausible.length > 0) {
    add(
      "error",
      "COORDINATE_IMPLAUSIBLE",
      `${implausible.length} coordinate(s) outside Great Britain`,
      implausible,
    );
  }
  const misaligned: string[] = [];
  for (const e of infra.edges) {
    const g = e.geometry;
    const a = nodePos.get(e.from);
    const b = nodePos.get(e.to);
    if (!g || g.length < 2 || !a || !b) continue;
    if (metres(g[0]!, a) > ALIGN_TOLERANCE_M || metres(g.at(-1)!, b) > ALIGN_TOLERANCE_M)
      misaligned.push(e.id);
  }
  for (const s of infra.signals) {
    const p = s.trackNodeId ? nodePos.get(s.trackNodeId) : undefined;
    if (p && s.position && metres(p, s.position) > ALIGN_TOLERANCE_M) misaligned.push(s.id);
  }
  if (misaligned.length > 0) {
    add(
      "error",
      "TRACK_ALIGNMENT",
      `${misaligned.length} edge/signal coordinate(s) do not meet their track nodes`,
      misaligned,
    );
  }

  // --- inferred timing-point positions ---
  const sourcedTiplocs = new Set(timingPoints.map((m) => m.tiploc));
  const seenTp = new Set<string>();
  for (const t of timingPointPositions) {
    if (seenTp.has(t.tiploc))
      add("error", "DUPLICATE_ID", `timing point ${t.tiploc} has two inferred positions`, [
        t.tiploc,
      ]);
    seenTp.add(t.tiploc);
    if (sourcedTiplocs.has(t.tiploc)) {
      add(
        "error",
        "TIMING_POINT_CONFLICT",
        `${t.tiploc} has both a sourced mapping and an inferred position`,
        [t.tiploc],
      );
    }
    if (input.areaTiplocs && !input.areaTiplocs.includes(t.tiploc)) {
      add(
        "warning",
        "TIMING_POINT_OUTSIDE_SCOPE",
        `${t.tiploc} is positioned but not listed in areaTiplocs`,
        [t.tiploc],
      );
    }
    const anchors = t.trackNodeIds.map((n) => nodePos.get(n)).filter((p): p is LatLon => !!p);
    const far = anchors.filter((p) => metres(p, t.position) > TIMING_POINT_SPREAD_M);
    if (anchors.length > 0 && metres(anchors[0]!, t.position) > ALIGN_TOLERANCE_M) {
      add(
        "error",
        "TRACK_ALIGNMENT",
        `${t.tiploc} position is not at its first anchor node ${t.trackNodeIds[0]}`,
        [t.tiploc],
      );
    } else if (far.length > 0) {
      add(
        "warning",
        "TRACK_ALIGNMENT",
        `${t.tiploc} anchors are spread over more than ${TIMING_POINT_SPREAD_M} m`,
        [t.tiploc],
      );
    }
  }

  // --- signals ---
  const offTrack = infra.signals.filter((s) => s.trackNodeId === null).map((s) => s.id);
  if (offTrack.length > 0)
    add(
      "warning",
      "SIGNAL_OFF_TRACK",
      `${offTrack.length} signal(s) not on the track graph`,
      offTrack,
    );
  const noDirection: string[] = [];
  for (const s of infra.signals) {
    const towards = s.facingTowardsNodeId.value;
    if (towards === null) noDirection.push(s.id);
    else if (s.trackNodeId && !graph.adjacent(s.trackNodeId, towards)) {
      add(
        "error",
        "SIGNAL_DIRECTION_INVALID",
        `signal ${s.id} faces ${towards}, which is not adjacent to ${s.trackNodeId}`,
        [s.id],
      );
    }
  }
  if (noDirection.length > 0) {
    add(
      "warning",
      "SIGNAL_DIRECTION_UNKNOWN",
      `${noDirection.length} signal(s) have no known direction`,
      noDirection,
    );
  }

  // --- routes & overlaps: impossible paths ---
  const signalById = new Map(infra.signals.map((s) => [s.id, s]));
  const pointsById = new Map(infra.points.map((p) => [p.id, p]));
  for (const r of signalling?.routes ?? []) {
    const entry = signalById.get(r.entrySignalId);
    const exit = signalById.get(r.exitSignalId);
    if (!entry?.trackNodeId || !exit?.trackNodeId) {
      add(
        "error",
        "IMPOSSIBLE_ROUTE",
        `route ${r.id}: entry or exit signal is not on the track graph`,
        [r.id],
      );
      continue;
    }
    const walk = graph.walk(entry.trackNodeId, r.edgeIds);
    if (!walk.ok) {
      add("error", "IMPOSSIBLE_ROUTE", `route ${r.id}: ${walk.reason}`, [r.id]);
      continue;
    }
    if (walk.nodes.at(-1) !== exit.trackNodeId) {
      add(
        "error",
        "IMPOSSIBLE_ROUTE",
        `route ${r.id}: path ends at ${walk.nodes.at(-1)}, not at exit signal ${exit.id}`,
        [r.id],
      );
    }
    if (
      entry.facingTowardsNodeId.value !== null &&
      entry.facingTowardsNodeId.value !== walk.nodes[1]
    ) {
      add(
        "error",
        "IMPOSSIBLE_ROUTE",
        `route ${r.id}: entry signal ${entry.id} faces the other way`,
        [r.id],
      );
    }
    const pathNodes = new Set(walk.nodes);
    for (const req of r.pointsRequired) {
      const p = pointsById.get(req.pointsId);
      if (p && !pathNodes.has(p.trackNodeId)) {
        add(
          "error",
          "IMPOSSIBLE_ROUTE",
          `route ${r.id}: requires points ${p.id}, which are not on its path`,
          [r.id],
        );
      }
    }
    const required = new Set(r.pointsRequired.map((q) => pointsById.get(q.pointsId)?.trackNodeId));
    for (const n of walk.nodes.slice(1, -1)) {
      if (graph.node(n)?.kind === "switch" && !required.has(n)) {
        add(
          "warning",
          "ROUTE_POINTS_UNSPECIFIED",
          `route ${r.id} passes switch ${n} without a required position`,
          [r.id, n],
        );
      }
    }
    if (r.overlapId) {
      const o = signalling!.overlaps.find((x) => x.id === r.overlapId);
      if (o && o.signalId !== r.exitSignalId) {
        add(
          "error",
          "IMPOSSIBLE_ROUTE",
          `route ${r.id}: overlap ${o.id} belongs to ${o.signalId}, not exit signal`,
          [r.id],
        );
      }
    }
  }
  for (const o of signalling?.overlaps ?? []) {
    const s = signalById.get(o.signalId);
    if (s?.trackNodeId && !graph.walk(s.trackNodeId, o.edgeIds).ok) {
      add(
        "error",
        "IMPOSSIBLE_OVERLAP",
        `overlap ${o.id} is not a contiguous path from signal ${s.id}`,
        [o.id],
      );
    }
  }

  // --- control areas ---
  const owner = new Map<string, string>();
  for (const a of control?.areas ?? []) {
    for (const id of [...a.signalIds, ...a.pointsIds]) {
      const prev = owner.get(id);
      if (prev)
        add("error", "CONTROL_OVERLAP", `${id} is controlled by both ${prev} and ${a.id}`, [id]);
      owner.set(id, a.id);
    }
    if (
      a.basis === "real_signal_box" &&
      !["sourced", "verified"].includes(a.membershipProvenance.evidence)
    ) {
      add(
        "warning",
        "UNSUPPORTED_ASSUMPTION",
        `control area ${a.id} mirrors a real signal box but its membership is ${a.membershipProvenance.evidence}`,
        [a.id],
      );
    }
  }

  // --- timetables ---
  const mapped = new Set([...timingPoints, ...timingPointPositions].map((m) => m.tiploc));
  const unmapped = new Map<string, number>();
  for (const t of timetables) {
    for (const s of t.services) {
      let prev: number | null = null;
      let wrapped = false;
      for (const c of s.calls) {
        if (!mapped.has(c.tiploc)) unmapped.set(c.tiploc, (unmapped.get(c.tiploc) ?? 0) + 1);
        for (const time of [c.arrival, c.pass, c.departure]) {
          const m = toMinutes(time);
          if (m === null) continue;
          if (prev !== null && m < prev) {
            if (!wrapped && prev - m > 12 * 60)
              wrapped = true; // crosses midnight
            else
              add(
                "error",
                "TIMETABLE_TIME_ORDER",
                `service ${s.id}: time ${time} at ${c.tiploc} goes backwards`,
                [s.id],
              );
          }
          prev = m;
        }
      }
    }
  }
  const area = input.areaTiplocs ? new Set(input.areaTiplocs) : null;
  const inArea = [...unmapped.entries()].filter(([t]) => !area || area.has(t));
  if (inArea.length > 0) {
    const list = inArea.sort((a, b) => b[1] - a[1]);
    add(
      "warning",
      "UNMAPPED_TIMETABLE_LOCATION",
      `${list.length} ${area ? "study-area " : ""}TIPLOC(s) used by timetables have no infrastructure mapping: ` +
        list
          .slice(0, 15)
          .map(([t, n]) => `${t} (${n})`)
          .join(", ") +
        (list.length > 15 ? ", ..." : ""),
      list.map(([t]) => t),
    );
  }
  const outside = unmapped.size - inArea.length;
  if (outside > 0) {
    add(
      "info",
      "OUT_OF_AREA_LOCATIONS",
      `${outside} TIPLOC(s) outside the study area appear in journeys (not modelled; expected)`,
    );
  }

  // --- unsupported assumptions: everything not sourced/verified is surfaced ---
  const weak: Record<"inferred" | "placeholder", Map<string, string[]>> = {
    inferred: new Map(),
    placeholder: new Map(),
  };
  for (const [name, layer] of Object.entries(layers)) {
    for (const p of provenances(layer, name)) {
      const ev = p.provenance.evidence;
      if (ev !== "inferred" && ev !== "placeholder") continue;
      const key = p.path.replace(/\[\]/g, "").replace(/\.provenance$/, "");
      const list = weak[ev].get(key) ?? [];
      if (p.ownerId) list.push(p.ownerId);
      weak[ev].set(key, list);
    }
  }
  for (const [path, ids] of weak.placeholder) {
    add(
      "warning",
      "PLACEHOLDER_DATA",
      `${ids.length} placeholder value(s) at ${path} must be replaced before use as real data`,
      ids,
    );
  }
  for (const [path, ids] of weak.inferred) {
    const interlocking = path.startsWith("signalling") || path.startsWith("control");
    add(
      interlocking ? "warning" : "info",
      "INFERRED_DATA",
      `${ids.length} inferred value(s) at ${path}${interlocking ? " (simulated interlocking, not real)" : ""}`,
      ids,
    );
  }

  return issues;
}
