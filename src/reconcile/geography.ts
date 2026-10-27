/**
 * Assessment of a proposed playable area against the infrastructure: which platform roads
 * plausibly exist, whether trains can move between entries, platforms and exits, which
 * topology problems lie inside, and what signalling the sources show but OSM lacks.
 * Read-only: nothing here edits infrastructure. Results feed docs, not runtime.
 */
import type { Infrastructure, LatLon, PlayableArea, SignalEvidenceFile } from "../model/index.ts";
import { DirectedTrack } from "../graph/directedTrack.ts";
import { TrackGraph } from "../graph/trackGraph.ts";

/**
 * Track within this distance of a platform's position is listed as a nearby candidate. The
 * extract holds only platform centroids (no outlines), so proximity cannot identify the face.
 */
export const PLATFORM_ROAD_MAX_M = 15;

const metres = (a: LatLon, b: LatLon) => {
  const k = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((a.lat - b.lat) * 111_320, (a.lon - b.lon) * 111_320 * k);
};

/** Distance from p to segment ab, metres (local planar approximation). */
function segmentDistance(p: LatLon, a: LatLon, b: LatLon) {
  const k = Math.cos((p.lat * Math.PI) / 180);
  const P = [p.lon * k, p.lat];
  const A = [a.lon * k, a.lat];
  const B = [b.lon * k, b.lat];
  const dx = B[0]! - A[0]!;
  const dy = B[1]! - A[1]!;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, ((P[0]! - A[0]!) * dx + (P[1]! - A[1]!) * dy) / len2));
  return metres(p, { lon: (A[0]! + t * dx) / k, lat: A[1]! + t * dy });
}

export interface PlatformRoad {
  platformId: string;
  ref: string | null;
  /**
   * importer: the platform's edgeIds from the OSM import (stop positions + outline; see
   *   Platform.trackAssociation), with its evidence level;
   * track_ref: no import association; OSM track edges whose ref equals the platform ref;
   * unknown: neither. `nearbyEdges` are listed for survey only and are not tested.
   */
  method: "importer" | "track_ref" | "unknown";
  status: "mapped" | "ambiguous" | "unresolved";
  evidence: string;
  edgeIds: string[];
  nearbyEdges: { edgeId: string; trackRef: string | null; distanceM: number }[];
  /**
   * OSM signals on the platform track: the platform edges and the plain track continuing from
   * them up to the first switch, crossing or end. Empty means none is MAPPED, not none exists.
   */
  signalRefs: string[];
}

export function platformRoads(infra: Infrastructure, platformIds: string[]): PlatformRoad[] {
  const pos = new Map(infra.nodes.map((n) => [n.id, n.position]));
  const graph = new TrackGraph(infra);
  const sigByNode = new Map<string, string[]>();
  for (const s of infra.signals)
    if (s.trackNodeId)
      sigByNode.set(s.trackNodeId, [...(sigByNode.get(s.trackNodeId) ?? []), s.ref ?? s.id]);
  return infra.platforms
    .filter((p) => platformIds.includes(p.id))
    .map((p) => {
      const nearbyEdges = p.position
        ? infra.edges
            .map((e) => {
              const g = e.geometry ?? [pos.get(e.from)!, pos.get(e.to)!];
              let d = Infinity;
              for (let i = 1; i < g.length; i++)
                d = Math.min(d, segmentDistance(p.position!, g[i - 1]!, g[i]!));
              return {
                edgeId: e.id,
                trackRef: e.trackRef ?? null,
                distanceM: Math.round(d * 10) / 10,
              };
            })
            .filter((x) => x.distanceM <= PLATFORM_ROAD_MAX_M)
            .sort((a, b) => a.distanceM - b.distanceM)
        : [];
      const assoc = p.trackAssociation;
      const byRef = p.ref ? infra.edges.filter((e) => e.trackRef === p.ref).map((e) => e.id) : [];
      const method: PlatformRoad["method"] = assoc
        ? "importer"
        : byRef.length > 0
          ? "track_ref"
          : "unknown";
      const edgeIds = assoc ? (p.edgeIds.value ?? []) : byRef;
      const signalRefs = [...graph.plainRunFrom(edgeIds).nodes]
        .flatMap((n) => sigByNode.get(n) ?? [])
        .sort();
      return {
        platformId: p.id,
        ref: p.ref,
        method,
        status: assoc ? assoc.status : byRef.length > 0 ? "mapped" : "unresolved",
        evidence: assoc ? p.edgeIds.provenance.evidence : byRef.length > 0 ? "inferred" : "unknown",
        edgeIds,
        nearbyEdges,
        signalRefs,
      };
    });
}

/**
 * Shortest metres under each junction model (src/graph/directedTrack.ts). All are geometric
 * heuristics, not verified routing:
 * - legs: switch-leg rule with sourced slip types, no single-slip diagonal, no incomplete junction;
 * - slipDiagonal: also allows single-slip diagonals, so a path found only here is UNRESOLVED;
 * - incomplete: also passes switches/crossings with a leg missing from the data (two mapped
 *   edges), so a path found only here is UNRESOLVED (D-025);
 * - smooth: sensitivity rule only.
 */
export type Reach = {
  legs: number | null;
  slipDiagonal: number | null;
  incomplete: number | null;
  smooth: number | null;
};

export interface Connectivity {
  /** Entry cut -> platform (mapped platforms only): metres to enter a platform edge. */
  entryToPlatform: Record<string, Record<string, Reach>>;
  /** Platform ref -> exit cut: shortest metres leaving the area over the cut edge. */
  platformToExit: Record<string, Record<string, Reach>>;
  /** Entry cut -> exit cut without reversal. */
  through: Record<string, Record<string, Reach>>;
}

const MAX_M = 12_000;

export function connectivity(
  infra: Infrastructure,
  area: PlayableArea,
  roads: PlatformRoad[],
): Connectivity {
  const tracks = {
    legs: new DirectedTrack(infra, "legs"),
    slipDiagonal: new DirectedTrack(infra, "legs", { singleSlipDiagonals: "allow" }),
    incomplete: new DirectedTrack(infra, "legs", {
      singleSlipDiagonals: "allow",
      incompleteJunctions: "allow",
    }),
    smooth: new DirectedTrack(infra, "smooth"),
  };
  const edge = new Map(infra.edges.map((e) => [e.id, e]));
  const reach = (f: (t: DirectedTrack) => number | null): Reach => ({
    legs: f(tracks.legs),
    slipDiagonal: f(tracks.slipDiagonal),
    incomplete: f(tracks.incomplete),
    smooth: f(tracks.smooth),
  });
  const min = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x !== null);
    return v.length ? Math.min(...v) : null;
  };
  // Entering a platform edge e in either direction = arriving at one end from the other.
  const enter = (t: DirectedTrack, start: string, first: string, eId: string) => {
    const e = edge.get(eId)!;
    return min([
      t.route(start, first, e.to, e.from, MAX_M, true)?.distanceM ?? null,
      t.route(start, first, e.from, e.to, MAX_M, true)?.distanceM ?? null,
    ]);
  };
  const leave = (t: DirectedTrack, start: string, first: string, c: (typeof area.cuts)[number]) =>
    t.route(start, first, c.outsideNodeId, c.insideNodeId, MAX_M, true)?.distanceM ?? null;
  const label = (r: PlatformRoad) => `platform ${r.ref ?? r.platformId}`;

  const out: Connectivity = { entryToPlatform: {}, platformToExit: {}, through: {} };
  const tested = roads.filter((r) => r.status === "mapped" && r.edgeIds.length > 0);
  for (const c of area.cuts) {
    out.entryToPlatform[c.id] = {};
    out.through[c.id] = {};
    for (const r of tested)
      out.entryToPlatform[c.id]![label(r)] = reach((t) =>
        min(r.edgeIds.map((x) => enter(t, c.outsideNodeId, c.insideNodeId, x))),
      );
    for (const x of area.cuts)
      if (x.id !== c.id)
        out.through[c.id]![x.id] = reach((t) => leave(t, c.outsideNodeId, c.insideNodeId, x));
  }
  for (const r of tested) {
    out.platformToExit[label(r)] = {};
    for (const c of area.cuts)
      out.platformToExit[label(r)]![c.id] = reach((t) =>
        min(
          r.edgeIds.flatMap((x) => {
            const e = edge.get(x)!;
            return [leave(t, e.from, e.to, c), leave(t, e.to, e.from, c)];
          }),
        ),
      );
  }
  return out;
}

export interface TopologyIssue {
  kind:
    | "dangling_end"
    | "switch_too_few_edges"
    | "crossing_too_few_edges"
    | "four_way_switch"
    | "single_slip"
    | "double_slip"
    | "buffer_stop";
  nodeId: string;
  position: LatLon | null;
  detail: string;
}

/** Topology findings among nodes accepted by `inside`. Buffer stops are listed, not faulted. */
export function topologyIssues(
  infra: Infrastructure,
  inside: (p: LatLon) => boolean,
): TopologyIssue[] {
  const graph = new TrackGraph(infra);
  const issues: TopologyIssue[] = [];
  for (const n of infra.nodes) {
    if (!n.position || !inside(n.position)) continue;
    const d = graph.degree(n.id);
    const u = graph
      .incident(n.id)
      .map(({ edgeId }) => {
        const e = graph.edge(edgeId)!;
        return `${e.usage}${e.trackRef ? `:${e.trackRef}` : ""}`;
      })
      .join(", ");
    const add = (kind: TopologyIssue["kind"], detail: string) =>
      issues.push({ kind, nodeId: n.id, position: n.position ?? null, detail });
    if (n.kind === "end_unknown") add("dangling_end", `track ends with no buffer stop (${u})`);
    if (n.kind === "switch" && d < 3) add("switch_too_few_edges", `switch with ${d} edges (${u})`);
    if (n.kind === "crossing" && d < 4)
      add("crossing_too_few_edges", `crossing with ${d} edges (${u})`);
    const st = graph.pointsAt(n.id)?.switchType;
    if (n.kind === "switch" && d >= 4) {
      if (st === "single_slip" && d === 4)
        add(
          "single_slip",
          `single slip (OSM railway:switch=single_slip, sourced): both straight routes exist; which one diagonal route the slip provides is not recorded, so diagonal movements stay unresolved (${u})`,
        );
      else if (st === "double_slip" && d === 4)
        add(
          "double_slip",
          `double slip (OSM railway:switch=double_slip, sourced): both straight routes and both diagonals exist (${u})`,
        );
      else
        add(
          "four_way_switch",
          `${d} edges meet at one switch node with switch type "${st ?? "none"}"; arrangement unknown (${u})`,
        );
    }
    if (n.kind === "buffer_stop") add("buffer_stop", u);
  }
  return issues;
}

export interface BacklogItem {
  priority: "P1" | "P2" | "P3";
  kind:
    | "missing_signal"
    | "named_signal_not_in_osm"
    | "platform_without_signal"
    | "platform_track_unresolved"
    | "topology";
  subject: string;
  evidence: string;
  task: string;
}

/**
 * Survey backlog. Priority reflects operational importance in the playable area:
 * P1 = platform working at the station or a main-line junction signal in the area;
 * P2 = other movements inside the area; P3 = lettered berths of unknown meaning, sidings,
 * and the optional Kingmoor area.
 */
export function surveyBacklog(
  evidence: SignalEvidenceFile,
  roads: PlatformRoad[],
  topology: TopologyIssue[],
  playableStanox: Set<string>,
): BacklogItem[] {
  const items: BacklogItem[] = [];
  for (const b of evidence.unmatchedBerths) {
    if (b.berthKind === "other") continue;
    const steps = evidence.steps.filter((s) => s.fromBerth === b.berth || s.toBerth === b.berth);
    const inArea = b.stanox.some((s) => playableStanox.has(s));
    const platforms = [...new Set(steps.map((s) => s.platform.trim()).filter(Boolean))].sort();
    const lines = [
      ...new Set(
        steps
          .flatMap((s) => [s.fromLine, s.toLine])
          .map((l) => l.trim())
          .filter(Boolean),
      ),
    ].sort();
    const atStation = steps.some((s) => s.stanox.trim() === "09161");
    const priority: BacklogItem["priority"] =
      !inArea || b.berthKind === "lettered"
        ? "P3"
        : platforms.length > 0 || atStation
          ? "P1"
          : "P2";
    items.push({
      priority,
      kind: "missing_signal",
      subject: `${b.td} berth ${b.berth}`,
      evidence: `${b.match}: ${b.reason}; ${steps.length} SMART step(s) at STANOX ${b.stanox.join("/")}${platforms.length ? `; platforms ${platforms.join(",")}` : ""}${lines.length ? `; lines ${lines.join(",")}` : ""}`,
      task:
        b.berthKind === "lettered"
          ? "Establish what the letter means and whether a separate signal exists (signalling plan or TD recording)"
          : `Find and position signal ${evidence.scope.signalPrefix}${Number(b.berth)} if it exists (survey, imagery, signalling plan); do not place it from the berth alone`,
    });
  }
  for (const n of evidence.namedSignals.filter((x) => x.osmSignalIds.length === 0))
    items.push({
      // In-play STANOX: P1. A STANOX the TD scope never uses: location unknown, P2. Else the
      // signal belongs to a deferred area (e.g. Kingmoor): P3.
      priority: playableStanox.has(n.stanox)
        ? "P1"
        : evidence.scope.stanox[n.stanox] === undefined
          ? "P2"
          : "P3",
      kind: "named_signal_not_in_osm",
      subject: n.plate,
      evidence: `CORPUS ${n.tiploc} "${n.description}" (STANOX ${n.stanox}); numeric berth at same STANOX: ${n.numericBerthAtSameStanox ? "yes" : "no"}`,
      task:
        evidence.scope.stanox[n.stanox] === undefined
          ? `Locate ${n.plate}: its STANOX is not used by any SMART ${evidence.scope.td} berth step, so even its area is unconfirmed; not in OSM`
          : `Position ${n.plate} (CORPUS timing point); not in OSM`,
    });
  for (const r of roads) {
    if (r.status !== "mapped")
      items.push({
        priority: "P1",
        kind: "platform_track_unresolved",
        subject: `platform ${r.ref ?? r.platformId}`,
        evidence:
          r.method === "importer"
            ? `OSM association ${r.status}: no usable stop position and/or track alongside the outline`
            : `no OSM track carries ref "${r.ref ?? ""}"; near ${r.nearbyEdges.map((e) => `${e.edgeId} (${e.distanceM} m)`).join(", ") || "no track"}`,
        task: "Establish whether this is a train platform face and which track it serves (imagery, survey)",
      });
    else if (r.signalRefs.length === 0)
      items.push({
        priority: "P1",
        kind: "platform_without_signal",
        subject: `platform ${r.ref}`,
        evidence: `no OSM signal is mapped on the platform track (${r.edgeIds.join(", ")} and its plain continuation; association ${r.method}, ${r.evidence}). This does not show that no real signal exists.`,
        task: "Survey the platform starting signal(s)",
      });
  }
  for (const t of topology.filter((x) => x.kind !== "buffer_stop" && x.kind !== "double_slip"))
    items.push({
      priority: t.kind === "four_way_switch" || t.kind === "single_slip" ? "P1" : "P2",
      kind: "topology",
      subject: `${t.kind} ${t.nodeId}`,
      evidence: t.detail,
      task:
        t.kind === "single_slip"
          ? "Establish which diagonal the single slip provides (imagery or a signalling plan); do not infer it from train movements"
          : t.kind === "four_way_switch"
            ? "Establish the switch arrangement (which legs connect) from imagery or a plan"
            : "Check against imagery whether the track continues, ends at a buffer or the OSM mapping is incomplete",
    });
  const order = { P1: 0, P2: 1, P3: 2 };
  return items.sort(
    (a, b) => order[a.priority] - order[b.priority] || a.subject.localeCompare(b.subject),
  );
}
