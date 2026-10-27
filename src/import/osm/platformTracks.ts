/**
 * Links OSM platforms to track edges using two kinds of OSM evidence:
 * 1. stop positions (railway=stop / public_transport=stop_position) on the track, whose `ref`
 *    equals the platform's ref, preferably grouped with the platform in a stop_area relation;
 * 2. the platform outline (from a supplement extract with `out geom`): track edges running
 *    alongside it for at least ALONG_MIN_M within EDGE_MAX_M of its boundary.
 * A platform is mapped only when the stop position and the outline agree on one track. Anything
 * else is ambiguous or unresolved, and its edges stay unknown. This is OSM mapping, not verified
 * signalling: it says where contributors drew the platform and its stop, nothing more.
 */
import type {
  LatLon,
  Platform,
  PlatformTrackAssociation,
  Provenance,
  SourceRef,
  TrackEdge,
  TrackNode,
} from "../../model/index.ts";
import type { OsmNode } from "./overpass.ts";
import { TrackGraph } from "../../graph/trackGraph.ts";

/** Track counts as alongside a platform within this distance of the outline boundary. */
export const EDGE_MAX_M = 3;
/** Minimum length of an edge alongside the outline for it to count. */
export const ALONG_MIN_M = 20;
/** Without a stop_area relation, a stop position must lie this close to the outline. */
export const STOP_NEAR_M = 30;

export interface SupplementElement {
  type: "node" | "way" | "relation";
  id: number;
  tags?: Record<string, string>;
  geometry?: LatLon[];
  members?: { type: string; ref: number; role: string }[];
}

export interface PlatformTrackInput {
  platform: Pick<Platform, "id" | "ref" | "provenance">;
  /** OSM element of the platform in the main extract, e.g. { type: "way", id: 132753331 }. */
  osm: { type: "node" | "way" | "relation"; id: number };
}

export interface PlatformTrackContext {
  osmNodes: Map<number, OsmNode>;
  nodes: TrackNode[];
  edges: TrackEdge[];
  supplement: { elements: SupplementElement[]; ref: SourceRef };
  main: SourceRef;
}

const k = (lat: number) => Math.cos((lat * Math.PI) / 180);
const toXY = (p: LatLon, kk: number) => [p.lon * 111_320 * kk, p.lat * 111_320] as const;

function segDist(p: readonly number[], a: readonly number[], b: readonly number[]) {
  const dx = b[0]! - a[0]!;
  const dy = b[1]! - a[1]!;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0]! - a[0]!) * dx + (p[1]! - a[1]!) * dy) / l2)) : 0;
  return Math.hypot(p[0]! - a[0]! - t * dx, p[1]! - a[1]! - t * dy);
}

function inside(p: readonly number[], poly: (readonly number[])[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi! > p[1]! !== yj! > p[1]! && p[0]! < ((xj! - xi!) * (p[1]! - yi!)) / (yj! - yi!) + xi!)
      c = !c;
  }
  return c;
}

/** Metres of `line` lying outside `outline` but within EDGE_MAX_M of its boundary. */
export function lengthAlongOutline(line: LatLon[], outline: LatLon[]): number {
  if (line.length < 2 || outline.length < 2) return 0;
  const kk = k(outline[0]!.lat);
  const poly = outline.map((p) => toXY(p, kk));
  const pts = line.map((p) => toXY(p, kk));
  let along = 0;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1]!, pts[i]!];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(len / 2));
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps;
      const p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      if (inside(p, poly)) continue;
      let d = Infinity;
      for (let j = 1; j < poly.length; j++) d = Math.min(d, segDist(p, poly[j - 1]!, poly[j]!));
      if (d <= EDGE_MAX_M) along += len / steps;
    }
  }
  return Math.round(along);
}

const wayOf = (edgeId: string) => /^osm-w(\d+)-\d+$/.exec(edgeId)?.[1] ?? null;

export function associatePlatformTracks(
  inputs: PlatformTrackInput[],
  ctx: PlatformTrackContext,
): Map<string, Pick<Platform, "edgeIds" | "trackAssociation">> {
  const graph = new TrackGraph({ nodes: ctx.nodes, edges: ctx.edges });
  const incidentIds = (n: string) => graph.incident(n).map((i) => i.edgeId);
  const supp = new Map(ctx.supplement.elements.map((e) => [`${e.type}/${e.id}`, e]));
  const stopAreas = ctx.supplement.elements.filter(
    (e) => e.type === "relation" && e.tags?.public_transport === "stop_area",
  );
  const stops = [...ctx.osmNodes.values()].filter(
    (n) =>
      (n.tags?.railway === "stop" || n.tags?.public_transport === "stop_position") &&
      graph.degree(`osm-n${n.id}`) > 0,
  );

  /** Edges at a node plus ordinary plain track continuing from them (shared plain-run rule). */
  const run = (start: string) => graph.plainRunFrom(incidentIds(start)).edges;

  const result = new Map<string, Pick<Platform, "edgeIds" | "trackAssociation">>();
  for (const { platform, osm } of inputs) {
    const key = `${osm.type}/${osm.id}`;
    const outlineEl = supp.get(key);
    const outline =
      outlineEl?.geometry && outlineEl.geometry.length >= 3 ? outlineEl.geometry : null;
    const outlineRef: SourceRef = { ...ctx.supplement.ref, recordId: key };

    const adjacent = outline
      ? ctx.edges
          .map((e) => ({ e, alongM: lengthAlongOutline(e.geometry ?? [], outline) }))
          .filter((x) => x.alongM >= ALONG_MIN_M)
      : [];

    // Stop positions with the platform's ref, preferably in a stop_area with the platform.
    const areas = stopAreas.filter((r) =>
      r.members?.some((m) => m.type === osm.type && m.ref === osm.id && m.role === "platform"),
    );
    const sameRef = platform.ref ? stops.filter((n) => n.tags?.ref === platform.ref) : [];
    const inArea = sameRef.filter((n) =>
      areas.some((r) => r.members?.some((m) => m.type === "node" && m.ref === n.id)),
    );
    const near = outline
      ? sameRef.filter(
          (n) =>
            Math.min(
              ...outline.map((p, i) =>
                i === 0
                  ? Infinity
                  : segDist(
                      toXY({ lat: n.lat, lon: n.lon }, k(n.lat)),
                      toXY(outline[i - 1]!, k(n.lat)),
                      toXY(p, k(n.lat)),
                    ),
              ),
            ) <= STOP_NEAR_M,
        )
      : [];
    const chosen = inArea.length > 0 ? inArea : near;
    const stopIds = chosen.map((n) => `osm-n${n.id}`);
    const usedAreas = inArea.length > 0 ? areas.map((r) => `relation/${r.id}`) : [];

    const stopEdges = new Set(stopIds.flatMap((s) => [...run(s)]));
    const stopWays = new Set(
      stopIds.flatMap((s) => incidentIds(s).map((e) => wayOf(e))).filter(Boolean),
    );
    const onStop = (e: TrackEdge) => stopEdges.has(e.id) || stopWays.has(wayOf(e.id));
    const adjacentEdges = adjacent
      .map(({ e, alongM }) => ({
        edgeId: e.id,
        alongM,
        onStopTrack: stopIds.length > 0 && onStop(e),
      }))
      .sort((a, b) => b.alongM - a.alongM || a.edgeId.localeCompare(b.edgeId));
    const platformEdges = adjacentEdges
      .filter((a) => a.onStopTrack)
      .map((a) => a.edgeId)
      .sort();
    // Stops on more than one disconnected track: each stop's run must contain another's edges.
    const runs = stopIds.map((s) => run(s));
    const splitStops = runs.some((r, i) => i > 0 && ![...r].some((e) => runs[0]!.has(e)));
    const otherWays = new Set(adjacentEdges.map((a) => wayOf(a.edgeId)));

    let method: PlatformTrackAssociation["method"];
    let status: PlatformTrackAssociation["status"];
    let note: string;
    if (stopIds.length > 0) {
      method = usedAreas.length > 0 ? "stop_area_and_outline" : "stop_position_and_outline";
      if (!outline) {
        status = "ambiguous";
        note =
          "Stop position found but no platform outline in the supplement; track face not confirmed.";
      } else if (splitStops) {
        status = "ambiguous";
        note = `Stop positions with ref "${platform.ref}" lie on different tracks.`;
      } else if (platformEdges.length === 0) {
        status = "ambiguous";
        note = "The stop position's track does not run alongside the platform outline.";
      } else {
        status = "mapped";
        const others = adjacentEdges.filter((a) => !a.onStopTrack);
        note =
          `Stop position(s) ${stopIds.join(", ")} with ref "${platform.ref}"` +
          (usedAreas.length
            ? ` (stop_area ${usedAreas.join(", ")})`
            : " (no stop_area; within 30 m)") +
          ` and ${platformEdges.length} edge(s) alongside the outline on the same track.` +
          (others.length
            ? ` Also alongside the outline but on another track, not mapped: ${others.map((o) => `${o.edgeId} (${o.alongM} m)`).join(", ")}.`
            : "");
      }
    } else if (adjacentEdges.length > 0) {
      method = "outline_only";
      status = otherWays.size === 1 ? "mapped" : "ambiguous";
      note =
        status === "mapped"
          ? "No stop position; one track runs alongside the outline."
          : `No stop position; ${otherWays.size} different tracks run alongside the outline.`;
    } else {
      method = "none";
      status = "unresolved";
      note = outline
        ? `No stop position${platform.ref ? ` with ref "${platform.ref}"` : " (platform has no ref)"} and no track within ${EDGE_MAX_M} m of the outline for ${ALONG_MIN_M} m.`
        : "No platform outline and no stop position.";
    }

    const mappedEdges =
      status === "mapped"
        ? method === "outline_only"
          ? adjacentEdges.map((a) => a.edgeId).sort()
          : platformEdges
        : null;
    const stopIncident = new Set(stopIds.flatMap((s) => incidentIds(s)));
    const sources: SourceRef[] = [
      ...stopIds.map((s) => ({ ...ctx.main, recordId: s.replace("osm-n", "node/") })),
      ...usedAreas.map((r) => ({ ...ctx.supplement.ref, recordId: r })),
      ...(outline ? [outlineRef] : []),
    ];
    const provenance: Provenance =
      mappedEdges === null
        ? { evidence: "unknown", sources: [], note }
        : method === "stop_area_and_outline" && mappedEdges.every((e) => stopIncident.has(e))
          ? { evidence: "sourced", sources, note }
          : {
              evidence: "inferred",
              sources,
              note: `${note} Edges beyond those touching the stop node are added by outline geometry (>=${ALONG_MIN_M} m within ${EDGE_MAX_M} m).`,
            };
    result.set(platform.id, {
      edgeIds: { value: mappedEdges, provenance },
      trackAssociation: {
        method,
        status,
        stopNodeIds: stopIds,
        stopAreaRelations: usedAreas,
        outline: outline
          ? { recordId: key, version: ctx.supplement.ref.version ?? "", vertices: outline.length }
          : null,
        adjacentEdges,
        note,
      },
    });
  }
  return result;
}
