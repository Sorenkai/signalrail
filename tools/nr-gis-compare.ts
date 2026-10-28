/**
 * P3.2 research CLI (read-only): compares the Network Rail GIS network model
 * (github.com/openraildata/network-rail-gis, pinned commit) with the Carlisle OSM-derived
 * infrastructure. See docs/NETWORK_RAIL_GIS_ASSESSMENT.md.
 *
 *   npx tsx tools/nr-gis-compare.ts --dir data/private/network-rail-gis/<commit> \
 *     [--out data/private/network-rail-gis/analysis/carlisle-comparison.json]
 *
 * Reads the shapefiles (British National Grid) with no GIS library: a minimal .shp/.dbf
 * reader, the OS inverse Transverse Mercator projection and the OSGB36 -> WGS84 Helmert
 * transformation (a few metres' error; the report quantifies it at Carlisle). Writes nothing
 * outside --out, which belongs in the git-ignored data/private/: the source's own metadata
 * says "internal Network Rail use only" (see the report's licence section).
 *
 * Matching is geometric and never proof of a connection. Parallel running lines are a few
 * metres apart, so a nearest-track match is only `confirmed_match` where no other GIS track
 * lies nearby. Nothing here changes any dataset.
 */
import { readFileSync } from "node:fs";
import { loadDataset } from "../src/data/loadDataset.ts";
import { TrackGraph } from "../src/graph/trackGraph.ts";
import { nodesInPlay } from "../src/validation/control.ts";
import { flags, path, readJson, writeJson } from "./lib.ts";

type XY = [number, number];
type LatLon = { lat: number; lon: number };

// ---------- shapefile and dBASE readers (shape types 1/11/21 point, 3/13/23 polyline) ----------

function readShp(file: string): { type: number; parts: XY[][] }[] {
  const b = readFileSync(file);
  const end = b.readInt32BE(24) * 2;
  const out: { type: number; parts: XY[][] }[] = [];
  let p = 100;
  while (p < end) {
    const len = b.readInt32BE(p + 4) * 2;
    const c = p + 8;
    const type = b.readInt32LE(c);
    if (type === 1 || type === 11 || type === 21) {
      out.push({ type, parts: [[[b.readDoubleLE(c + 4), b.readDoubleLE(c + 12)]]] });
    } else if (type === 3 || type === 13 || type === 23) {
      const nParts = b.readInt32LE(c + 36);
      const nPoints = b.readInt32LE(c + 40);
      const starts = Array.from({ length: nParts }, (_, i) => b.readInt32LE(c + 44 + 4 * i));
      const pts = c + 44 + 4 * nParts;
      const parts: XY[][] = starts.map((s, i) => {
        const e = i + 1 < nParts ? starts[i + 1]! : nPoints;
        const part: XY[] = [];
        for (let k = s; k < e; k++)
          part.push([b.readDoubleLE(pts + 16 * k), b.readDoubleLE(pts + 16 * k + 8)]);
        return part;
      });
      out.push({ type, parts });
    } else out.push({ type, parts: [] });
    p = c + len;
  }
  return out;
}

function readDbf(file: string): Record<string, string>[] {
  const b = readFileSync(file);
  const n = b.readUInt32LE(4);
  const headerLen = b.readUInt16LE(8);
  const recordLen = b.readUInt16LE(10);
  const fields: { name: string; len: number }[] = [];
  for (let p = 32; b[p] !== 0x0d; p += 32)
    fields.push({ name: b.toString("latin1", p, p + 11).replace(/\0.*$/, ""), len: b[p + 16]! });
  const rows: Record<string, string>[] = [];
  for (let i = 0; i < n; i++) {
    let p = headerLen + i * recordLen + 1;
    const row: Record<string, string> = {};
    for (const f of fields) {
      row[f.name] = b.toString("latin1", p, p + f.len).trim();
      p += f.len;
    }
    rows.push(row);
  }
  return rows;
}

// ---------- British National Grid -> WGS84 (OS guide, Annex C; Helmert, ~2-5 m) ----------

const rad = Math.PI / 180;
export function bngToWgs84(E: number, N: number): LatLon {
  const a = 6377563.396,
    b = 6356256.909,
    F0 = 0.9996012717,
    lat0 = 49 * rad,
    lon0 = -2 * rad,
    N0 = -100000,
    E0 = 400000;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);
  const meridional = (lat: number) =>
    b *
    F0 *
    ((1 + n + 1.25 * n ** 2 + 1.25 * n ** 3) * (lat - lat0) -
      (3 * n + 3 * n ** 2 + 2.625 * n ** 3) * Math.sin(lat - lat0) * Math.cos(lat + lat0) +
      (1.875 * n ** 2 + 1.875 * n ** 3) * Math.sin(2 * (lat - lat0)) * Math.cos(2 * (lat + lat0)) -
      (35 / 24) * n ** 3 * Math.sin(3 * (lat - lat0)) * Math.cos(3 * (lat + lat0)));
  let lat = lat0;
  let M = 0;
  do {
    lat = (N - N0 - M) / (a * F0) + lat;
    M = meridional(lat);
  } while (Math.abs(N - N0 - M) >= 0.00001);
  const s = Math.sin(lat),
    c = Math.cos(lat),
    t = Math.tan(lat);
  const nu = (a * F0) / Math.sqrt(1 - e2 * s * s);
  const rho = (a * F0 * (1 - e2)) / (1 - e2 * s * s) ** 1.5;
  const eta2 = nu / rho - 1;
  const VII = t / (2 * rho * nu);
  const VIII = (t / (24 * rho * nu ** 3)) * (5 + 3 * t * t + eta2 - 9 * t * t * eta2);
  const IX = (t / (720 * rho * nu ** 5)) * (61 + 90 * t * t + 45 * t ** 4);
  const X = 1 / (c * nu);
  const XI = (1 / (c * 6 * nu ** 3)) * (nu / rho + 2 * t * t);
  const XII = (1 / (c * 120 * nu ** 5)) * (5 + 28 * t * t + 24 * t ** 4);
  const XIIA = (1 / (c * 5040 * nu ** 7)) * (61 + 662 * t * t + 1320 * t ** 4 + 720 * t ** 6);
  const dE = E - E0;
  const phi = lat - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6;
  const lam = lon0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7;
  // OSGB36 (Airy 1830) cartesian -> Helmert -> WGS84 (GRS80) geodetic.
  const nuA = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const x = nuA * Math.cos(phi) * Math.cos(lam);
  const y = nuA * Math.cos(phi) * Math.sin(lam);
  const z = nuA * (1 - e2) * Math.sin(phi);
  const sc = -20.4894e-6,
    rx = (0.1502 / 3600) * rad,
    ry = (0.247 / 3600) * rad,
    rz = (0.8421 / 3600) * rad;
  const x2 = 446.448 + (1 + sc) * x - rz * y + ry * z;
  const y2 = -125.157 + rz * x + (1 + sc) * y - rx * z;
  const z2 = 542.06 - ry * x + rx * y + (1 + sc) * z;
  const aW = 6378137,
    bW = 6356752.3141;
  const e2W = 1 - (bW * bW) / (aW * aW);
  const pp = Math.sqrt(x2 * x2 + y2 * y2);
  let la = Math.atan2(z2, pp * (1 - e2W));
  for (let i = 0; i < 10; i++) {
    const nuW = aW / Math.sqrt(1 - e2W * Math.sin(la) ** 2);
    la = Math.atan2(z2 + e2W * nuW * Math.sin(la), pp);
  }
  return { lat: la / rad, lon: Math.atan2(y2, x2) / rad };
}

// ---------- local metric frame and segment index ----------

const R_EARTH = 6371008.8;
function frame(origin: LatLon) {
  const k = Math.cos(origin.lat * rad);
  return (p: LatLon): XY => [
    (p.lon - origin.lon) * rad * R_EARTH * k,
    (p.lat - origin.lat) * rad * R_EARTH,
  ];
}
const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lineLen = (pts: XY[]) => pts.slice(1).reduce((s, p, i) => s + dist(pts[i]!, p), 0);

function project(p: XY, a: XY, b: XY): { d: number; q: XY } {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  const q: XY = [a[0] + t * dx, a[1] + t * dy];
  return { d: dist(p, q), q };
}

/** Densify a polyline every `step` metres, keeping both ends. */
function densify(pts: XY[], step: number): XY[] {
  const out: XY[] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!,
      b = pts[i]!;
    const n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let k = 1; k <= n; k++)
      out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

class SegmentIndex {
  private cells = new Map<string, [number, number][]>();
  constructor(
    readonly lines: XY[][],
    private readonly cell = 25,
  ) {
    lines.forEach((pts, owner) => {
      for (let i = 1; i < pts.length; i++) {
        const [a, b] = [pts[i - 1]!, pts[i]!];
        for (const key of this.cover(a, b)) {
          const list = this.cells.get(key) ?? [];
          list.push([owner, i]);
          this.cells.set(key, list);
        }
      }
    });
  }
  private cover(a: XY, b: XY): string[] {
    const keys: string[] = [];
    const x0 = Math.floor(Math.min(a[0], b[0]) / this.cell),
      x1 = Math.floor(Math.max(a[0], b[0]) / this.cell);
    const y0 = Math.floor(Math.min(a[1], b[1]) / this.cell),
      y1 = Math.floor(Math.max(a[1], b[1]) / this.cell);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.push(`${x},${y}`);
    return keys;
  }
  /** Nearest segment of each owner within `r` metres, nearest first. */
  near(p: XY, r: number): { owner: number; d: number; q: XY }[] {
    const best = new Map<number, { owner: number; d: number; q: XY }>();
    const n = Math.ceil(r / this.cell);
    const cx = Math.floor(p[0] / this.cell),
      cy = Math.floor(p[1] / this.cell);
    for (let x = cx - n; x <= cx + n; x++)
      for (let y = cy - n; y <= cy + n; y++)
        for (const [owner, i] of this.cells.get(`${x},${y}`) ?? []) {
          const pts = this.lines[owner]!;
          const h = project(p, pts[i - 1]!, pts[i]!);
          if (h.d <= r && (best.get(owner)?.d ?? Infinity) > h.d) best.set(owner, { owner, ...h });
        }
    return [...best.values()].sort((a, b) => a.d - b.d || a.owner - b.owner);
  }
}

// ---------- thresholds (documented in the report) ----------

/** A sample is "on" a GIS track within this distance (survey +/-0.5 m, Helmert, OSM error). */
const TOL_M = 5;
/** Another GIS track within this distance makes the match ambiguous (parallel lines ~3-4 m). */
const ISOLATION_M = 8;
/** Farther than this from any OSM edge, a GIS sample counts as GIS-only track. */
const GIS_ONLY_M = 10;
const SAMPLE_M = 2;

type Classification = "confirmed_match" | "probable_match" | "unresolved" | "no_match";

const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
};
const count = <T extends string>(xs: T[]) =>
  Object.fromEntries(
    Object.entries(
      xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {}),
    ).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

// ---------- main ----------

const args = flags();
if (!args.dir) throw new Error("--dir <path to the pinned network-rail-gis checkout> is required");
const dir = path(args.dir);
const outFile = path(args.out ?? "data/private/network-rail-gis/analysis/carlisle-comparison.json");

const { input } = loadDataset(path("data"), "carlisle");
if (!input?.playableArea) throw new Error("carlisle dataset or playable area missing");
const infra = input.infrastructure;
const graph = new TrackGraph(infra);
const inPlay = nodesInPlay(graph, input.playableArea);
const bbox = infra.bbox;
if (!bbox) throw new Error("carlisle infrastructure has no bbox");
const origin = { lat: (bbox.south + bbox.north) / 2, lon: (bbox.west + bbox.east) / 2 };
const toXY = frame(origin);
const inBbox = (p: LatLon, m = 0.002) =>
  p.lat >= bbox.south - m &&
  p.lat <= bbox.north + m &&
  p.lon >= bbox.west - m &&
  p.lon <= bbox.east + m;

// OSM way tags (for the ELR / track-ref crosswalk), from the snapshot the dataset was built from.
const area = readJson(path("data/datasets/carlisle/area.json")) as { osmSnapshot: string };
const osm = readJson(path(area.osmSnapshot)) as {
  elements: { type: string; id: number; tags?: Record<string, string> }[];
};
const wayTags = new Map(
  osm.elements.filter((e) => e.type === "way").map((e) => [e.id, e.tags ?? {}]),
);
const tagsOf = (edgeId: string) => wayTags.get(Number(/^osm-w(\d+)-/.exec(edgeId)?.[1])) ?? {};

// GIS layers clipped to the bbox.
function layer(name: string, file: string) {
  const shapes = readShp(`${dir}/${name}/${file}.shp`);
  const rows = readDbf(`${dir}/${name}/${file}.dbf`);
  if (shapes.length !== rows.length) throw new Error(`${file}: shp/dbf record counts differ`);
  return shapes.map((s, i) => ({
    row: rows[i]!,
    ll: s.parts.map((part) => part.map(([E, N]) => bngToWgs84(E, N))),
    bng: s.parts,
  }));
}
const linksAll = layer("VectorLinks", "NetworkLinks");
const links = linksAll
  .filter((l) => l.ll.some((part) => part.some((p) => inBbox(p))))
  .flatMap((l) => l.ll.map((part) => ({ row: l.row, ll: part, xy: part.map(toXY) })))
  .sort((a, b) => Number(a.row.ASSETID) - Number(b.row.ASSETID) || a.ll[0]!.lat - b.ll[0]!.lat);
const keyOf = (r: Record<string, string>) => `${r.ELR}/${r.TRID}`;
const nodes = layer("VectorNodes", "NetworkNNodes")
  .filter((n) => inBbox(n.ll[0]![0]!))
  .map((n) => ({ row: n.row, ll: n.ll[0]![0]!, xy: toXY(n.ll[0]![0]!) }));
const refLines = layer("VectorReferenceLines", "NetworkReferenceLines")
  .filter((l) => l.ll.some((part) => part.some((p) => inBbox(p))))
  .flatMap((l) => l.ll.map((part) => ({ row: l.row, xy: part.map(toXY) })));
const waymarks = layer("VectorWaymarks", "NetworkWaymarks").filter((w) => inBbox(w.ll[0]![0]!, 0));

/**
 * Per-link survey source, status and quality exist only in AttributionTable.csv, which the
 * repository states is from the 2022-11-02 release: older than the 2024 geometry. Joined by
 * ASSETID and always reported as 2022 data.
 */
function readCsv(file: string): Record<string, string>[] {
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const split = (s: string) =>
    [...s.matchAll(/("([^"]*)"|[^,]*)(,|$)/g)].slice(0, -1).map((m) => m[2] ?? m[1]!);
  const head = split(lines[0]!);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i]!, v])));
}
const attribution2022 = new Map(
  readCsv(`${dir}/VectorLinks/AttributionTable.csv`).map((r) => [
    r.ASSETID!,
    {
      source: r.SOURCE,
      trackStatus: r.TRACK_STATUS,
      quality: r.L_QUALITY,
      versionDate: r.VERSION_DATE,
    },
  ]),
);

const gisIndex = new SegmentIndex(links.map((l) => l.xy));
const refIndex = new SegmentIndex(refLines.map((l) => l.xy));
const osmEdges = infra.edges.map((e) => ({
  e,
  xy: e.geometry ? e.geometry.map(toXY) : [],
  play: inPlay.has(e.from) && inPlay.has(e.to),
}));
const osmIndex = new SegmentIndex(osmEdges.map((o) => o.xy));

// GIS link-end degree by coincident endpoints (0.5 m), compared with CONNECTED_COUNT.
const endKey = (p: XY) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;
const endDegree = new Map<string, number>();
for (const l of links)
  for (const p of [l.xy[0]!, l.xy.at(-1)!])
    endDegree.set(endKey(p), (endDegree.get(endKey(p)) ?? 0) + 1);

// 1. OSM edges against GIS track.
const edgeFindings = osmEdges
  .filter((o) => o.xy.length >= 2)
  .map((o) => {
    const len = lineLen(o.xy);
    const trim = Math.min(8, len * 0.25);
    const samples = densify(o.xy, SAMPLE_M).filter((p, i, all) => {
      const along = lineLen(all.slice(0, i + 1));
      return along >= trim && along <= len - trim;
    });
    const hits = samples.map((p) => {
      const near = gisIndex.near(p, 20);
      const first = near[0];
      const key = first ? keyOf(links[first.owner]!.row) : null;
      const other = near.find((h) => keyOf(links[h.owner]!.row) !== key);
      return { d: first?.d ?? Infinity, key, other: other?.d ?? Infinity };
    });
    const on = hits.filter((h) => h.d <= TOL_M);
    const keys = count(on.map((h) => h.key!));
    const [dominant, dominantN] = Object.entries(keys).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    const within = samples.length ? on.length / samples.length : 0;
    const consistency = on.length ? dominantN / on.length : 0;
    const isolated = hits.filter((h) => h.other > ISOLATION_M).length / Math.max(1, hits.length);
    // Length of the dominant GIS track alongside: path through the projections of all samples.
    let gisLen: number | null = null;
    if (dominant && within >= 0.8) {
      const proj = densify(o.xy, SAMPLE_M).map(
        (p) => gisIndex.near(p, 15).find((h) => keyOf(links[h.owner]!.row) === dominant)?.q ?? null,
      );
      gisLen = proj.every((q) => q !== null) ? lineLen(proj as XY[]) : null;
    }
    const classification: Classification =
      samples.length === 0
        ? "unresolved"
        : within >= 0.9 && consistency >= 0.9 && isolated >= 0.9
          ? "confirmed_match"
          : within >= 0.8 && consistency >= 0.8
            ? "probable_match"
            : within >= 0.3
              ? "unresolved"
              : "no_match";
    const t = tagsOf(o.e.id);
    return {
      edgeId: o.e.id,
      inPlay: o.play,
      usage: o.e.usage,
      lengthM: o.e.lengthM ?? null,
      osmRef: t.ref ?? null,
      osmTrackRef: t["railway:track_ref"] ?? null,
      samples: samples.length,
      withinTol: round(within, 2),
      medianOffsetM:
        median(on.map((h) => h.d)) === null ? null : round(median(on.map((h) => h.d))!),
      dominantGisTrack: dominant,
      consistency: round(consistency, 2),
      isolated: round(isolated, 2),
      gisLengthM: gisLen === null ? null : round(gisLen),
      lengthDiffM:
        gisLen === null || o.e.lengthM === undefined ? null : round(o.e.lengthM - gisLen),
      classification,
    };
  });

// 2. GIS track with no OSM edge alongside (runs of consecutive samples), per link part.
const gisOnly = links.flatMap((l) => {
  const samples = densify(l.xy, 5);
  const runs: { from: XY; to: XY; m: number }[] = [];
  let start: XY | null = null;
  let prev: XY | null = null;
  for (const p of samples) {
    const ll = {
      lat: origin.lat + p[1] / (rad * R_EARTH),
      lon: origin.lon + p[0] / (rad * R_EARTH * Math.cos(origin.lat * rad)),
    };
    const off = inBbox(ll, 0) && osmIndex.near(p, GIS_ONLY_M).length === 0;
    if (off && !start) start = p;
    if (!off && start && prev) {
      runs.push({ from: start, to: prev, m: dist(start, prev) });
      start = null;
    }
    prev = p;
  }
  if (start && prev) runs.push({ from: start, to: prev, m: dist(start, prev) });
  return runs
    .filter((r) => r.m >= 20)
    .map((r) => {
      const mid: XY = [(r.from[0] + r.to[0]) / 2, (r.from[1] + r.to[1]) / 2];
      const nearPlay = osmIndex.near(mid, 100).some((h) => osmEdges[h.owner]!.play);
      const back = (p: XY) => ({
        lat: round(origin.lat + p[1] / (rad * R_EARTH), 6),
        lon: round(origin.lon + p[0] / (rad * R_EARTH * Math.cos(origin.lat * rad)), 6),
      });
      return {
        assetId: l.row.ASSETID,
        gisTrack: keyOf(l.row),
        attribution2022: attribution2022.get(l.row.ASSETID!) ?? null,
        lengthM: round(r.m),
        from: back(r.from),
        to: back(r.to),
        within100mOfPlayableTrack: nearPlay,
      };
    });
});

// 3. OSM switches and crossings against GIS junction nodes (CONNECTED_COUNT >= 3).
const junctions = nodes.filter((n) => Number(n.row.CONNECTED_) >= 3);
const switchFindings = infra.nodes
  .filter((n) => (n.kind === "switch" || n.kind === "crossing") && n.position)
  .map((n) => {
    const p = toXY(n.position!);
    const near = junctions
      .map((j) => ({ id: j.row.ASSETID, count: Number(j.row.CONNECTED_), d: dist(p, j.xy) }))
      .filter((j) => j.d <= 40)
      .sort((a, b) => a.d - b.d);
    const within15 = near.filter((j) => j.d <= 15);
    const classification: Classification =
      within15.length === 1 && near.filter((j) => j.d <= 30).length === 1
        ? "probable_match"
        : within15.length >= 1
          ? "unresolved"
          : near.length > 0
            ? "unresolved"
            : "no_match";
    return {
      nodeId: n.id,
      kind: n.kind,
      inPlay: inPlay.has(n.id),
      osmDegree: graph.degree(n.id),
      nearestGisJunctions: near.slice(0, 4).map((j) => ({ ...j, d: round(j.d) })),
      classification,
    };
  });

// 4. Local GIS structure around named OSM nodes (slips, platform 5/6 bay buffer stops).
const SLIPS = ["osm-n10288170", "osm-n1460504004", "osm-n7253833743", "osm-n1460504024"];
const BAY_STOPS = ["osm-n1460505335", "osm-n2464339875"];
/** Junctions mapped with only two edges in OSM (DATA_GAPS: a leg missing from OSM). */
const TWO_EDGE_JUNCTIONS = [
  "osm-n314950822",
  "osm-n2464330439",
  "osm-n2814195214",
  "osm-n10069394082",
  "osm-n2464330250",
];
const bearing = (a: XY, b: XY) =>
  round((Math.atan2(b[0] - a[0], b[1] - a[1]) / rad + 360) % 360, 0);
function localStructure(nodeId: string, r: number) {
  const n = infra.nodes.find((x) => x.id === nodeId)!;
  const p = toXY(n.position!);
  const osmLegs = graph.incident(nodeId).map((i) => {
    const e = osmEdges.find((o) => o.e.id === i.edgeId)!;
    const pts = e.e.from === nodeId ? e.xy : [...e.xy].reverse();
    return {
      edgeId: i.edgeId,
      to: i.other,
      bearing: bearing(pts[0]!, pts[Math.min(3, pts.length - 1)]!),
    };
  });
  const gisNodes = nodes
    .map((g) => ({
      assetId: g.row.ASSETID,
      count: Number(g.row.CONNECTED_),
      d: dist(p, g.xy),
      xy: g.xy,
    }))
    .filter((g) => g.d <= r)
    .sort((a, b) => a.d - b.d)
    .map((g) => ({
      assetId: g.assetId,
      connectedCount: g.count,
      endpointDegree: endDegree.get(endKey(g.xy)) ?? 0,
      d: round(g.d),
      bearingFromOsmNode: bearing(p, g.xy),
      legs: links
        .filter((l) => dist(l.xy[0]!, g.xy) < 0.5 || dist(l.xy.at(-1)!, g.xy) < 0.5)
        .map((l) => {
          const pts = dist(l.xy[0]!, g.xy) < 0.5 ? l.xy : [...l.xy].reverse();
          return {
            assetId: l.row.ASSETID,
            gisTrack: keyOf(l.row),
            bearing: bearing(pts[0]!, pts[Math.min(1, pts.length - 1)]!),
            lengthM: round(lineLen(pts)),
            attribution2022: attribution2022.get(l.row.ASSETID!) ?? null,
          };
        }),
    }));
  const tracksNear = count(gisIndex.near(p, 15).map((h) => keyOf(links[h.owner]!.row)));
  return {
    nodeId,
    kind: n.kind,
    osmLegs,
    gisTracksWithin15m: tracksNear,
    gisNodesWithin: gisNodes,
  };
}

// 5. ELR / track-ref crosswalk on matched edges.
const matched = edgeFindings.filter(
  (f) => f.classification === "confirmed_match" || f.classification === "probable_match",
);
const elrPairs = count(
  matched.filter((f) => f.osmRef).map((f) => `${f.osmRef} ~ ${f.dominantGisTrack!.split("/")[0]}`),
);
const trackRefPairs = count(
  matched.filter((f) => f.osmTrackRef).map((f) => `${f.osmTrackRef} ~ ${f.dominantGisTrack}`),
);

// 6. Reference lines are not track: offset of matched OSM main-line samples to them.
const refOffsets = matched
  .filter((f) => f.usage === "main")
  .flatMap((f) => densify(osmEdges.find((o) => o.e.id === f.edgeId)!.xy, 20))
  .map((p) => refIndex.near(p, 500)[0]?.d ?? Infinity)
  .filter(Number.isFinite);

const byClass = (xs: { classification: Classification; inPlay: boolean }[]) => ({
  all: count(xs.map((x) => x.classification)),
  inPlay: count(xs.filter((x) => x.inPlay).map((x) => x.classification)),
});
const lengthChecks = matched.filter((f) => f.lengthDiffM !== null && f.inPlay);
const material = lengthChecks.filter(
  (f) => Math.abs(f.lengthDiffM!) > Math.max(5, 0.05 * f.lengthM!),
);

const result = {
  generated: "nr-gis-compare (P3.2)",
  source: { dir: args.dir, thresholds: { TOL_M, ISOLATION_M, GIS_ONLY_M, SAMPLE_M } },
  gisInBbox: {
    linkParts: links.length,
    linkLengthKm: round(links.reduce((s, l) => s + lineLen(l.xy), 0) / 1000, 2),
    lengthKmByElr: Object.fromEntries(
      Object.entries(
        links.reduce<Record<string, number>>(
          (m, l) => ((m[l.row.ELR!] = (m[l.row.ELR!] ?? 0) + lineLen(l.xy) / 1000), m),
          {},
        ),
      )
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, round(v, 2)]),
    ),
    attribution2022: {
      missingFrom2022Table: links.filter((l) => !attribution2022.has(l.row.ASSETID!)).length,
      bySource: count(
        links.map((l) => attribution2022.get(l.row.ASSETID!)?.source ?? "(not in 2022 table)"),
      ),
      byTrackStatus: count(
        links.map((l) => attribution2022.get(l.row.ASSETID!)?.trackStatus ?? "(not in 2022 table)"),
      ),
    },
    nodes: nodes.length,
    nodesByConnectedCount: count(nodes.map((n) => n.row.CONNECTED_!)),
    connectedCountAgreesWithEndpoints: nodes.filter(
      (n) => Number(n.row.CONNECTED_) === (endDegree.get(endKey(n.xy)) ?? 0),
    ).length,
    referenceLines: refLines.length,
    waymarksByElr: count(waymarks.map((w) => w.row.ELR!)),
  },
  osmInBbox: { edges: osmEdges.length, inPlayEdges: osmEdges.filter((o) => o.play).length },
  edges: { summary: byClass(edgeFindings), findings: edgeFindings },
  lengths: {
    checkedInPlay: lengthChecks.length,
    medianAbsDiffM: round(median(lengthChecks.map((f) => Math.abs(f.lengthDiffM!))) ?? 0),
    medianRatio: round(
      median(lengthChecks.map((f) => f.lengthM! / (f.lengthM! - f.lengthDiffM!))) ?? 0,
      4,
    ),
    material: material.map((f) => ({
      edgeId: f.edgeId,
      lengthM: f.lengthM,
      gisLengthM: f.gisLengthM,
      diffM: f.lengthDiffM,
    })),
  },
  medianOffsetConfirmedM: round(
    median(
      edgeFindings
        .filter((f) => f.classification === "confirmed_match")
        .map((f) => f.medianOffsetM!),
    ) ?? 0,
    2,
  ),
  gisOnly: {
    runs: gisOnly.length,
    lengthKm: round(gisOnly.reduce((s, r) => s + r.lengthM, 0) / 1000, 2),
    nearPlayLengthKm: round(
      gisOnly.filter((r) => r.within100mOfPlayableTrack).reduce((s, r) => s + r.lengthM, 0) / 1000,
      2,
    ),
    list: gisOnly,
  },
  switches: { summary: byClass(switchFindings), findings: switchFindings },
  slips: SLIPS.map((id) => localStructure(id, 40)),
  bayBufferStops: BAY_STOPS.map((id) => localStructure(id, 30)),
  twoEdgeJunctions: TWO_EDGE_JUNCTIONS.map((id) => localStructure(id, 15)),
  crosswalk: { osmRefVsGisElr: elrPairs, osmTrackRefVsGisTrack: trackRefPairs },
  referenceLineOffsetM: {
    samples: refOffsets.length,
    median: round(median(refOffsets) ?? 0),
    max: round(Math.max(...refOffsets)),
  },
  helmertSamples: links.slice(0, 3).map((l, i) => {
    const raw = linksAll.find((x) => x.row === l.row)!.bng[0]![0]!;
    return { i, E: raw[0], N: raw[1], wgs84: bngToWgs84(raw[0], raw[1]) };
  }),
};
writeJson(outFile, result);
console.log(
  JSON.stringify(
    {
      ...result,
      edges: result.edges.summary,
      switches: result.switches.summary,
      gisOnly: { ...result.gisOnly, list: undefined },
      slips: undefined,
      bayBufferStops: undefined,
    },
    null,
    2,
  ),
);
console.log(`\nwritten: ${outFile}`);
