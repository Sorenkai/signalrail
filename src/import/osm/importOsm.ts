import type {
  Infrastructure,
  LatLon,
  Location,
  Platform,
  Points,
  Provenance,
  Signal,
  TrackEdge,
  TrackNode,
} from "../../model/index.ts";
import type { BBox, OsmNode, OsmWay, OverpassResponse } from "./overpass.ts";

export const OSM_SOURCE_ID = "openstreetmap";

export interface OsmImportOptions {
  datasetId: string;
  bbox: BBox;
  /** Date the snapshot was retrieved (YYYY-MM-DD). */
  retrieved: string;
  /** Date written into the output's `generated` field. */
  generated: string;
}

export interface OsmImportReport {
  skippedWays: { id: number; reason: string }[];
  offTrackSignals: number;
  platformsWithoutTrackLink: number;
}

const nodeId = (osmId: number) => `osm-n${osmId}`;

function haversineM(a: LatLon, b: LatLon): number {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const inBBox = (p: LatLon, b: BBox) =>
  p.lat >= b.south && p.lat <= b.north && p.lon >= b.west && p.lon <= b.east;

/** Parses OSM maxspeed for UK railways ("50 mph", or bare km/h numbers). */
export function parseMaxSpeedMph(raw: string | undefined): number | null {
  if (!raw) return null;
  const mph = /^(\d+(?:\.\d+)?)\s*mph$/i.exec(raw.trim());
  if (mph) return Number(mph[1]);
  const kmh = /^(\d+(?:\.\d+)?)$/.exec(raw.trim());
  if (kmh) return Math.round(Number(kmh[1]) / 1.609344);
  return null;
}

function edgeUsage(tags: Record<string, string>): TrackEdge["usage"] {
  switch (tags.service) {
    case "siding":
      return "siding";
    case "yard":
      return "yard";
    case "crossover":
      return "crossover";
    case "spur":
      return "spur";
    case undefined:
      break;
    default:
      return "other";
  }
  if (tags.usage === "main") return "main";
  if (tags.usage === "branch") return "branch";
  return tags.usage ? "other" : "unknown";
}

function signalClass(tags: Record<string, string>): Pick<Signal, "type" | "function"> {
  const form = (key: string) => tags[`railway:signal:${key}:form`];
  const has = (key: string) => tags[`railway:signal:${key}`] !== undefined;
  const fn: Signal["function"] = has("main")
    ? "main"
    : has("distant")
      ? "distant"
      : has("shunting") || has("minor")
        ? "shunting"
        : has("main_repeated") || has("distant_repeated")
          ? "repeater"
          : has("stop")
            ? "stop_board"
            : "unknown";
  const rawForm =
    form("main") ??
    form("distant") ??
    form("shunting") ??
    form("minor") ??
    form("main_repeated") ??
    form("stop");
  const type: Signal["type"] =
    rawForm === "semaphore"
      ? "semaphore"
      : rawForm === "light"
        ? fn === "shunting"
          ? "ground"
          : "colour_light"
        : rawForm === "sign"
          ? "sign"
          : rawForm
            ? "other"
            : "unknown";
  return { type, function: fn };
}

function switchType(raw: string | undefined): Points["switchType"] {
  switch (raw) {
    case "default":
    case "wye":
      return "simple";
    case "double_slip":
      return "double_slip";
    case "single_slip":
      return "single_slip";
    case "three_way":
      return "three_way";
    case undefined:
      return "unknown";
    default:
      return "other";
  }
}

/**
 * Converts an Overpass extract to the canonical infrastructure layer.
 *
 * Every element carries OSM provenance. Facts OSM does not express (points normal/reverse
 * lie, platform-to-track links, interlocking) are emitted as `unknown`, never guessed.
 * The only inference made is that a dangling track end outside the bbox is an area boundary.
 */
export function importOsm(
  data: OverpassResponse,
  opts: OsmImportOptions,
): { infrastructure: Infrastructure; report: OsmImportReport } {
  const version = data.osm3s.timestamp_osm_base;
  const prov = (type: string, id: number): Provenance => ({
    evidence: "sourced",
    sources: [
      { sourceId: OSM_SOURCE_ID, recordId: `${type}/${id}`, version, retrieved: opts.retrieved },
    ],
  });
  const unknown = (note?: string): Provenance => ({ evidence: "unknown", sources: [], note });

  const osmNodes = new Map<number, OsmNode>();
  for (const e of data.elements) if (e.type === "node") osmNodes.set(e.id, e);

  const report: OsmImportReport = {
    skippedWays: [],
    offTrackSignals: 0,
    platformsWithoutTrackLink: 0,
  };
  const tracks: OsmWay[] = [];
  for (const e of data.elements) {
    if (e.type !== "way" || e.tags?.railway !== "rail") continue;
    const missing = e.nodes.filter((n) => !osmNodes.has(n));
    if (missing.length > 0)
      report.skippedWays.push({ id: e.id, reason: `${missing.length} nodes missing` });
    else tracks.push(e);
  }
  tracks.sort((a, b) => a.id - b.id);

  // A node is significant (becomes a graph node) if it ends a way, is shared by ways, or is tagged.
  const useCount = new Map<number, number>();
  for (const w of tracks)
    for (const n of new Set(w.nodes)) useCount.set(n, (useCount.get(n) ?? 0) + 1);
  const significant = (w: OsmWay, i: number) => {
    const n = w.nodes[i]!;
    return (
      i === 0 ||
      i === w.nodes.length - 1 ||
      (useCount.get(n) ?? 0) > 1 ||
      !!osmNodes.get(n)?.tags?.railway
    );
  };

  const edges: TrackEdge[] = [];
  /** For each signal-bearing node: neighbour reached by travelling with/against way direction. */
  const wayNeighbours = new Map<number, { forward?: string; backward?: string }>();
  for (const w of tracks) {
    const tags = w.tags ?? {};
    const speed = parseMaxSpeedMph(tags.maxspeed);
    let start = 0;
    let seq = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      if (!significant(w, i)) continue;
      const ids = w.nodes.slice(start, i + 1);
      const geometry = ids.map((n) => ({ lat: osmNodes.get(n)!.lat, lon: osmNodes.get(n)!.lon }));
      let lengthM = 0;
      for (let k = 1; k < geometry.length; k++)
        lengthM += haversineM(geometry[k - 1]!, geometry[k]!);
      const from = nodeId(ids[0]!);
      const to = nodeId(ids[ids.length - 1]!);
      edges.push({
        id: `osm-w${w.id}-${seq++}`,
        from,
        to,
        lengthM: Math.round(lengthM * 10) / 10,
        geometry,
        usage: edgeUsage(tags),
        ...(tags.maxspeed
          ? {
              maxSpeedMph:
                speed === null
                  ? { value: null, provenance: unknown(`unparsed OSM maxspeed "${tags.maxspeed}"`) }
                  : { value: speed, provenance: prov("way", w.id) },
            }
          : {}),
        ...(tags["railway:track_ref"] ? { trackRef: tags["railway:track_ref"] } : {}),
        provenance: prov("way", w.id),
      });
      const a = wayNeighbours.get(ids[0]!) ?? {};
      a.forward = to;
      wayNeighbours.set(ids[0]!, a);
      const b = wayNeighbours.get(ids[ids.length - 1]!) ?? {};
      b.backward = from;
      wayNeighbours.set(ids[ids.length - 1]!, b);
      start = i;
    }
  }

  const degree = new Map<string, number>();
  for (const e of edges) for (const n of [e.from, e.to]) degree.set(n, (degree.get(n) ?? 0) + 1);

  const nodes: TrackNode[] = [...degree.keys()]
    .map((id) => Number(id.slice("osm-n".length)))
    .sort((a, b) => a - b)
    .map((osmId): TrackNode => {
      const n = osmNodes.get(osmId)!;
      const id = nodeId(osmId);
      const position = { lat: n.lat, lon: n.lon };
      const rw = n.tags?.railway;
      if (rw === "switch") return { id, kind: "switch", position, provenance: prov("node", osmId) };
      if (rw === "railway_crossing")
        return { id, kind: "crossing", position, provenance: prov("node", osmId) };
      if (rw === "buffer_stop")
        return { id, kind: "buffer_stop", position, provenance: prov("node", osmId) };
      if (degree.get(id) === 1) {
        return inBBox(position, opts.bbox)
          ? { id, kind: "end_unknown", position, provenance: prov("node", osmId) }
          : {
              id,
              kind: "area_boundary",
              position,
              provenance: {
                evidence: "inferred",
                sources: prov("node", osmId).sources,
                note: "Track end lies outside the extract bbox; the railway continues beyond the dataset.",
              },
            };
      }
      return { id, kind: "plain", position, provenance: prov("node", osmId) };
    });
  const onTrack = new Set(nodes.map((n) => n.id));

  const signals: Signal[] = [];
  const points: Points[] = [];
  const locations: Location[] = [];
  const platforms: Platform[] = [];

  for (const n of [...osmNodes.values()].sort((a, b) => a.id - b.id)) {
    const tags = n.tags ?? {};
    const position = { lat: n.lat, lon: n.lon };
    if (tags.railway === "signal") {
      const tn = onTrack.has(nodeId(n.id)) ? nodeId(n.id) : null;
      if (!tn) report.offTrackSignals++;
      const dir = tags["railway:signal:direction"];
      const nb = wayNeighbours.get(n.id);
      const towards =
        dir === "forward" ? nb?.forward : dir === "backward" ? nb?.backward : undefined;
      signals.push({
        id: `osm-sig${n.id}`,
        ref: tags.ref ?? null,
        trackNodeId: tn,
        facingTowardsNodeId: towards
          ? { value: towards, provenance: prov("node", n.id) }
          : {
              value: null,
              provenance: unknown(
                dir === "both"
                  ? "OSM direction=both; one signal per direction needed"
                  : dir
                    ? `OSM direction "${dir}" could not be resolved on the track graph`
                    : "OSM signal has no railway:signal:direction",
              ),
            },
        ...signalClass(tags),
        position,
        provenance: prov("node", n.id),
      });
    } else if (tags.railway === "switch" && onTrack.has(nodeId(n.id))) {
      points.push({
        id: `osm-pts${n.id}`,
        ref: tags.ref ?? null,
        trackNodeId: nodeId(n.id),
        switchType: switchType(tags["railway:switch"]),
        normalTowardsNodeId: {
          value: null,
          provenance: unknown("OSM does not record the normal lie"),
        },
        reverseTowardsNodeId: {
          value: null,
          provenance: unknown("OSM does not record the reverse lie"),
        },
        provenance: prov("node", n.id),
      });
    }
  }

  /** Named railway places that are not stations: evidence for timing-point positions. */
  const placeKind = (tags: Record<string, string>): Location["kind"] | null => {
    if (!tags.name) return null;
    if (tags.railway === "junction") return "junction";
    if (tags.railway === "yard" || tags.landuse === "railway") return "yard";
    if (tags.railway === "level_crossing") return "other";
    return null;
  };

  for (const e of data.elements) {
    const tags = e.tags ?? {};
    const rw = tags.railway;
    const place = placeKind(tags);
    if (rw !== "station" && rw !== "halt" && rw !== "signal_box" && rw !== "platform" && !place) {
      continue;
    }
    const position = e.type === "node" ? { lat: e.lat, lon: e.lon } : e.center;
    if (!position || !inBBox(position, opts.bbox)) continue;
    const ref = `${e.type[0]}${e.id}`;
    if (rw === "platform") {
      report.platformsWithoutTrackLink++;
      platforms.push({
        id: `osm-plat-${ref}`,
        ref: tags.ref ?? tags["railway:platform:ref"] ?? null,
        locationId: null,
        position,
        edgeIds: { value: null, provenance: unknown("OSM platform areas are not linked to track") },
        provenance: prov(e.type, e.id),
      });
      continue;
    }
    if (!tags.name) continue;
    locations.push({
      id: `osm-loc-${ref}`,
      name: tags.name,
      kind: place ?? (rw === "signal_box" ? "signal_box" : "station"),
      position,
      codes: {
        ...(tags["ref:tiploc"] ? { tiploc: tags["ref:tiploc"] } : {}),
        ...(tags["ref:crs"] ? { crs: tags["ref:crs"] } : {}),
        ...(tags["ref:stanox"] ? { stanox: tags["ref:stanox"] } : {}),
      },
      provenance: prov(e.type, e.id),
    });
  }
  const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
  locations.sort(byId);
  platforms.sort(byId);

  return {
    infrastructure: {
      datasetId: opts.datasetId,
      version: `osm:${version}`,
      generated: opts.generated,
      bbox: opts.bbox,
      nodes,
      edges,
      locations,
      platforms,
      signals,
      points,
      occupancySections: [],
    },
    report,
  };
}
