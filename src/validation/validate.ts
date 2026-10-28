import type {
  Control,
  GameRules,
  PlayableArea,
  SignalEvidenceFile,
  EvidenceLevel,
  Infrastructure,
  Provenance,
  ServicePatternsFile,
  Signalling,
  SourceRegistry,
  TimetableSnapshot,
  TimingPointMapping,
  TimingPointPosition,
  LatLon,
} from "../model/index.ts";
import { EVIDENCE_LEVELS } from "../model/index.ts";
import { TrackGraph } from "../graph/trackGraph.ts";
import { assessInterlocking } from "./interlocking.ts";
import { validateTimetables } from "./timetable.ts";
import { validateControl } from "./control.ts";
import { resolveGameRules } from "./gameRules.ts";
import { deferredAreaCuts, validateServicePatterns } from "./servicePatterns.ts";

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
  /** TIPLOCs of areas outside the playable scope (timing-points.json deferredTiplocs). */
  deferredTiplocs?: string[];
  timetables?: TimetableSnapshot[];
  /** Per-claim signal evidence (signal-evidence.json), if the dataset has one. */
  signalEvidence?: SignalEvidenceFile;
  /** Proposed playable geography (playable-area.json), if the dataset has one. */
  playableArea?: PlayableArea;
  /** Hand-authored game rules (game-rules.json, D-029), if the dataset has them. */
  gameRules?: GameRules;
  /** Hand-authored timetable-to-route mapping (service-patterns.json, D-035), if any. */
  servicePatterns?: ServicePatternsFile;
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
    typeof obj.id === "string"
      ? obj.id
      : typeof obj.tiploc === "string"
        ? obj.tiploc
        : typeof obj.signalId === "string"
          ? obj.signalId
          : // Game-rule points configurations (D-029) are keyed by the Points they configure.
            typeof obj.pointsId === "string" && "provenance" in obj
            ? obj.pointsId
            : ownerId;
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
    signalEvidence: input.signalEvidence,
    playableArea: input.playableArea,
    gameRules: input.gameRules,
    servicePatterns: input.servicePatterns,
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
  if (input.gameRules)
    register(
      "fringeEndpoints",
      input.gameRules.fringeEndpoints.map((f) => f.id),
    );
  if (control) {
    register(
      "controlAreas",
      control.areas.map((a) => a.id),
    );
    register(
      "areaBoundaries",
      control.boundaries.map((b) => b.id),
    );
    register(
      "controlCentres",
      (control.controlCentres ?? []).map((c) => c.id),
    );
    register(
      "externalAreas",
      (control.externalAreas ?? []).map((x) => x.id),
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
    platform: new Set(infra.platforms.map((p) => p.id)),
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
  // Boundary area references (control or external areas) are checked in control.ts.
  for (const b of control?.boundaries ?? []) ref("edge", b.edgeId, b.id, "edgeId");
  for (const m of timingPoints)
    ref("location", m.locationId, `timingPoint:${m.tiploc}`, "locationId");
  for (const t of timingPointPositions) {
    for (const n of t.trackNodeIds)
      ref("node", n, `timingPointPosition:${t.tiploc}`, "trackNodeIds");
  }

  const evidence = input.signalEvidence;
  for (const r of evidence?.signals ?? []) {
    ref("signal", r.signalId, `signalEvidence:${r.signalId}`, "signalId");
    for (const run of [r.trackContext.value?.ahead, r.trackContext.value?.behind])
      ref("node", run?.nodeId, `signalEvidence:${r.signalId}`, "trackContext");
  }
  for (const st of evidence?.steps ?? []) {
    ref("signal", st.fromSignalId, `signalEvidenceStep:${st.id}`, "fromSignalId");
    ref("signal", st.toSignalId, `signalEvidenceStep:${st.id}`, "toSignalId");
    for (const n of st.keyNodeIds) ref("node", n, `signalEvidenceStep:${st.id}`, "keyNodeIds");
  }
  const playable = input.playableArea;
  const edgeById = new Map(infra.edges.map((e) => [e.id, e]));
  for (const c of playable?.cuts ?? []) {
    ref("edge", c.edgeId, c.id, "edgeId");
    ref("node", c.insideNodeId, c.id, "insideNodeId");
    ref("node", c.outsideNodeId, c.id, "outsideNodeId");
    const e = edgeById.get(c.edgeId);
    const ends = e ? [e.from, e.to].sort().join("|") : null;
    if (e && ends !== [c.insideNodeId, c.outsideNodeId].sort().join("|"))
      add(
        "error",
        "PLAYABLE_AREA_CUT",
        `cut ${c.id}: edge ${c.edgeId} does not join its inside and outside nodes`,
        [c.id],
      );
    if (
      c.kind === "extract_boundary" &&
      infra.nodes.find((n) => n.id === c.outsideNodeId)?.kind !== "area_boundary"
    )
      add(
        "error",
        "PLAYABLE_AREA_CUT",
        `cut ${c.id} is an extract_boundary but ${c.outsideNodeId} is not an area_boundary node`,
        [c.id],
      );
  }
  for (const l of playable?.includedLocationIds ?? [])
    ref("location", l, "playableArea", "includedLocationIds");
  for (const p of playable?.platformIds ?? []) ref("platform", p, "playableArea", "platformIds");
  for (const o of playable?.optionalAreas ?? [])
    for (const l of o.locationIds) ref("location", l, `playableArea:${o.id}`, "locationIds");
  for (const g of playable?.gameplayCorrections ?? [])
    for (const t of g.targetIds) {
      if (!has.node.has(t) && !has.edge.has(t) && !has.signal.has(t))
        add("error", "MISSING_REFERENCE", `${g.id}.targetIds -> unknown element "${t}"`, [g.id, t]);
    }
  const applied = playable?.gameplayCorrections.filter((g) => g.status === "applied") ?? [];
  if (applied.length > 0)
    add(
      "warning",
      "GAMEPLAY_CORRECTION",
      `${applied.length} gameplay correction(s) applied on top of source data`,
      applied.map((g) => g.id),
    );

  // --- signal evidence: contradicted or disputed claims are surfaced, never hidden ---
  if (evidence) {
    const claims = evidence.signals.flatMap((r) => [
      ...(["identity", "position", "direction", "trackContext"] as const).map((k) => ({
        id: r.signalId,
        k,
        c: r[k],
      })),
      ...r.berths.map((b) => ({ id: r.signalId, k: `berth ${b.berth}`, c: b.claim })),
    ]);
    for (const c of claims.filter(
      (x) => x.c.assessment === "contradicted" || x.c.assessment === "disputed",
    ))
      add("warning", "SIGNAL_EVIDENCE_CONFLICT", `${c.id} ${c.k} is ${c.c.assessment}`, [c.id]);
    const weak = claims.filter((x) =>
      ["unresolved", "ambiguous", "consistent_with_reversal"].includes(x.c.assessment),
    );
    if (weak.length > 0)
      add(
        "info",
        "SIGNAL_EVIDENCE_OPEN",
        `${weak.length} signal claim(s) unresolved, ambiguous or consistent only with reversal`,
        [...new Set(weak.map((x) => x.id))],
      );
  }

  // --- provenance: registered sources; synthetic data kept out of real datasets ---
  const layers = {
    infrastructure: infra,
    signalling,
    control,
    timingPoints,
    timingPointPositions,
    timetables,
    signalEvidence: evidence,
    playableArea: playable,
    gameRules: input.gameRules,
    servicePatterns: input.servicePatterns,
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
  // A stated lie must name two different nodes adjacent to the points' node.
  for (const p of infra.points) {
    const legs = [p.normalTowardsNodeId.value, p.reverseTowardsNodeId.value];
    const bad = legs.filter((n) => n !== null && !graph.adjacent(p.trackNodeId, n));
    if (bad.length > 0 || (legs[0] !== null && legs[0] === legs[1])) {
      add(
        "error",
        "POINTS_LIE_INVALID",
        `points ${p.id}: ${bad.length > 0 ? `lie names ${bad.join(", ")}, not adjacent to ${p.trackNodeId}` : "normal and reverse name the same node"}`,
        [p.id],
      );
    }
  }

  // --- slips: the type is sourced from OSM; a single slip's diagonal is not ---
  const pointsAt = new Map(infra.points.map((p) => [p.trackNodeId, p]));
  for (const p of infra.points) {
    const slip = p.switchType === "single_slip" || p.switchType === "double_slip";
    const d = graph.degree(p.trackNodeId);
    if (slip && d !== 4)
      add(
        "warning",
        "SLIP_TOPOLOGY",
        `${p.switchType} ${p.trackNodeId} has ${d} connected edges (a slip needs 4)`,
        [p.trackNodeId],
      );
  }
  const unknownFourWay = infra.nodes
    .filter((n) => n.kind === "switch" && graph.degree(n.id) === 4)
    .filter((n) => {
      const t = pointsAt.get(n.id)?.switchType;
      return t !== "single_slip" && t !== "double_slip";
    })
    .map((n) => n.id);
  if (unknownFourWay.length > 0)
    add(
      "warning",
      "SWITCH_ARRANGEMENT_UNKNOWN",
      `${unknownFourWay.length} four-edge switch node(s) have no slip type; which legs connect is unknown`,
      unknownFourWay,
    );
  const singleSlips = infra.points
    .filter((p) => p.switchType === "single_slip" && graph.degree(p.trackNodeId) === 4)
    .map((p) => p.trackNodeId);
  if (singleSlips.length > 0)
    add(
      "info",
      "SINGLE_SLIP_DIAGONAL_UNKNOWN",
      `${singleSlips.length} single slip(s): straight routes known; which diagonal each provides is not recorded, so diagonal movements are unresolved`,
      singleSlips,
    );

  // --- platform to track associations (when an importer attempted them) ---
  for (const p of infra.platforms) {
    const a = p.trackAssociation;
    if (!a) continue;
    for (const s of a.stopNodeIds) ref("node", s, p.id, "trackAssociation.stopNodeIds");
    for (const e of a.adjacentEdges) ref("edge", e.edgeId, p.id, "trackAssociation.adjacentEdges");
    if (a.status === "mapped" && !p.edgeIds.value?.length)
      add("error", "PLATFORM_TRACK_INCONSISTENT", `platform ${p.id} is mapped but has no edges`, [
        p.id,
      ]);
    if (a.status !== "mapped" && p.edgeIds.value !== null)
      add("error", "PLATFORM_TRACK_INCONSISTENT", `platform ${p.id} is ${a.status} but has edges`, [
        p.id,
      ]);
  }
  const platformStatus = (st: string) =>
    infra.platforms.filter((p) => p.trackAssociation?.status === st).map((p) => p.id);
  if (platformStatus("unresolved").length > 0)
    add(
      "warning",
      "PLATFORM_TRACK_UNRESOLVED",
      `${platformStatus("unresolved").length} platform(s) have no track association (no stop position or adjacent track)`,
      platformStatus("unresolved"),
    );
  if (platformStatus("ambiguous").length > 0)
    add(
      "warning",
      "PLATFORM_TRACK_AMBIGUOUS",
      `${platformStatus("ambiguous").length} platform(s) have conflicting track evidence`,
      platformStatus("ambiguous"),
    );

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
  const unclassified = infra.signals.filter((s) => s.function === "unknown").map((s) => s.id);
  if (unclassified.length > 0) {
    add(
      "info",
      "SIGNAL_CLASS_UNKNOWN",
      `${unclassified.length} signal(s) have no source-stated category; type and function unknown`,
      unclassified,
    );
  }

  // --- game rules (src/validation/gameRules.ts; DATA_MODEL "Game rules", D-029) ---
  const gameRules = resolveGameRules(infra, graph, input.gameRules, input.playableArea);
  issues.push(...gameRules.issues);

  // --- routes, overlaps and conflicts (src/validation/interlocking.ts; DATA_MODEL, D-024) ---
  if (!signalling) {
    add(
      "info",
      "SIGNALLING_ABSENT",
      "no signalling configuration loaded (signalling.json absent or unparsed): the dataset defines no routes or overlaps, so nothing can be cleared. This records a gap, not that the area needs none",
    );
  }
  const interlocking = assessInterlocking(
    infra,
    signalling,
    input.sources,
    graph,
    gameRules.context,
  );
  issues.push(...interlocking.issues);
  if (interlocking.assessments.length > 0) {
    const counts: Record<string, number> = {};
    for (const a of interlocking.assessments)
      counts[`${a.kind} ${a.status}`] = (counts[`${a.kind} ${a.status}`] ?? 0) + 1;
    add(
      "info",
      "INTERLOCKING_STATUS",
      `interlocking data: ${Object.entries(counts)
        .map(([k, n]) => `${n} ${k}`)
        .join(", ")} (data checks only; not a safety case)`,
    );
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

  issues.push(...validateControl(control, infra, graph, input.playableArea));

  // --- service patterns (src/validation/servicePatterns.ts; D-035) ---
  issues.push(
    ...validateServicePatterns(
      input.servicePatterns,
      signalling,
      gameRules.context.fringes,
      {
        area: input.areaTiplocs ? new Set(input.areaTiplocs) : null,
        deferred: new Set(input.deferredTiplocs ?? []),
      },
      deferredAreaCuts(input.control),
    ).issues,
  );

  // --- timetables ---
  const mapped = new Set([...timingPoints, ...timingPointPositions].map((m) => m.tiploc));
  const unmapped = new Map<string, number>();
  for (const t of timetables)
    for (const s of t.services)
      for (const c of s.calls)
        if (!mapped.has(c.tiploc)) unmapped.set(c.tiploc, (unmapped.get(c.tiploc) ?? 0) + 1);
  const area = input.areaTiplocs ? new Set(input.areaTiplocs) : null;
  issues.push(
    ...validateTimetables(timetables, { area, deferred: new Set(input.deferredTiplocs ?? []) }),
  );
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
  const weak: Record<"inferred" | "placeholder" | "simplified", Map<string, string[]>> = {
    inferred: new Map(),
    placeholder: new Map(),
    simplified: new Map(),
  };
  for (const [name, layer] of Object.entries(layers)) {
    for (const p of provenances(layer, name)) {
      const ev = p.provenance.evidence;
      if (ev !== "inferred" && ev !== "placeholder" && ev !== "simplified") continue;
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
  // Source-derived layers describe the real railway; a game simplification never belongs there.
  // Occupancy sections are left to R2 (audit M3), which decides how simulated sections are held.
  const sourceLayer = (path: string) =>
    /^(infrastructure|timingPoints|timingPointPositions|timetables|signalEvidence)\b/.test(path) &&
    !path.startsWith("infrastructure.occupancySections");
  for (const [path, ids] of weak.simplified) {
    if (sourceLayer(path)) {
      add(
        "error",
        "SIMPLIFIED_IN_SOURCE_LAYER",
        `${ids.length} simplified value(s) at ${path}: source-derived layers hold real-world data only`,
        ids,
      );
    } else {
      add(
        "warning",
        "SIMPLIFIED_DATA",
        `${ids.length} deliberate game simplification(s) at ${path} (not real-world behaviour)`,
        ids,
      );
    }
  }
  for (const [path, ids] of weak.inferred) {
    const interlocking = path.startsWith("signalling");
    const control = path.startsWith("control");
    add(
      interlocking || control ? "warning" : "info",
      "INFERRED_DATA",
      `${ids.length} inferred value(s) at ${path}${interlocking ? " (simulated interlocking, not real)" : control ? " (control configuration, not a sourced fact)" : ""}`,
      ids,
    );
  }

  return issues;
}
