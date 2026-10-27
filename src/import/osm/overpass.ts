/** Minimal types for Overpass API JSON output (`out body geom` / `out center`). */

export interface OsmNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

export interface OsmWay {
  type: "way";
  id: number;
  nodes: number[];
  geometry?: { lat: number; lon: number }[];
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface OsmRelation {
  type: "relation";
  id: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export type OsmElement = OsmNode | OsmWay | OsmRelation;

export interface OverpassResponse {
  version: number;
  generator: string;
  osm3s: { timestamp_osm_base: string; copyright: string };
  elements: OsmElement[];
}

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

const bboxString = (b: BBox) => `${b.south},${b.west},${b.north},${b.east}`;

/**
 * Overpass QL for an area extract. Ways are returned with their full node lists, so track
 * leaving the bbox is kept to its next way end; the importer marks such ends as boundaries.
 */
export function buildRailwayQuery(bbox: BBox): string {
  const bb = bboxString(bbox);
  return `[out:json][timeout:120];
(
  way["railway"="rail"](${bb});
)->.track;
(
  .track;
  node(w.track);
  nwr["railway"~"^(platform|station|halt|signal_box)$"](${bb});
  node["railway"~"^(signal|switch|buffer_stop|railway_crossing)$"](${bb});
  nwr["railway"~"^(junction|yard|level_crossing)$"]["name"](${bb});
  nwr["landuse"="railway"]["name"](${bb});
);
out body center;`;
}
