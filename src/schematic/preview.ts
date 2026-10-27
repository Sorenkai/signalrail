import type { Infrastructure, LatLon } from "../model/index.ts";

/**
 * Geographic track preview: projects real coordinates onto a canvas. It is a data-inspection
 * view, not the game's schematic signal-box diagram (which needs a separate, straightened
 * layout - see docs/DECISION_LOG.md D-006). Shows only what the dataset contains.
 */

export interface PreviewModel {
  width: number;
  height: number;
  tracks: { id: string; points: string; usage: string; evidence: string }[];
  signals: {
    id: string;
    x: number;
    y: number;
    label: string | null;
    dx: number;
    dy: number;
    kind: string;
  }[];
  points: { id: string; x: number; y: number }[];
  boundaries: { id: string; x: number; y: number }[];
  /** The dataset's study bbox, in canvas coordinates. */
  studyArea: { x: number; y: number; w: number; h: number } | null;
  labels: { id: string; x: number; y: number; text: string; kind: string }[];
  /** Timetable timing points; `inferred` ones must be drawn distinctly from sourced ones. */
  timingPoints: {
    tiploc: string;
    x: number;
    y: number;
    inferred: boolean;
    confidence: string | null;
  }[];
  caption: string;
  attribution: string;
}

export function buildPreview(
  infra: Infrastructure,
  opts: {
    width?: number;
    attribution: string;
    margin?: number;
    timingPoints?: {
      tiploc: string;
      position: LatLon;
      inferred: boolean;
      confidence: string | null;
    }[];
  },
): PreviewModel {
  const width = opts.width ?? 1200;
  const margin = opts.margin ?? 40;
  const coords: LatLon[] = infra.edges.flatMap((e) => e.geometry ?? []);
  // Canvas covers all geometry (ways run past the study bbox to their next end).
  const lats = [
    ...coords.map((c) => c.lat),
    ...(infra.bbox ? [infra.bbox.south, infra.bbox.north] : []),
  ];
  const lons = [
    ...coords.map((c) => c.lon),
    ...(infra.bbox ? [infra.bbox.west, infra.bbox.east] : []),
  ];
  const b = {
    south: Math.min(...lats),
    north: Math.max(...lats),
    west: Math.min(...lons),
    east: Math.max(...lons),
  };
  const kx = Math.cos((((b.south + b.north) / 2) * Math.PI) / 180);
  const spanX = (b.east - b.west) * kx;
  const spanY = b.north - b.south;
  const scale = (width - 2 * margin) / spanX;
  const height = Math.round(spanY * scale + 2 * margin);
  const xy = (p: LatLon) => ({
    x: Math.round((margin + (p.lon - b.west) * kx * scale) * 10) / 10,
    y: Math.round((margin + (b.north - p.lat) * scale) * 10) / 10,
  });
  const nodePos = new Map(
    infra.nodes.filter((n) => n.position).map((n) => [n.id, xy(n.position!)]),
  );

  return {
    width,
    height,
    tracks: infra.edges.map((e) => ({
      id: e.id,
      usage: e.usage,
      evidence: e.provenance.evidence,
      points: (e.geometry ?? [])
        .map(xy)
        .map((p) => `${p.x},${p.y}`)
        .join(" "),
    })),
    signals: infra.signals
      .filter((s) => s.position)
      .map((s) => {
        const p = xy(s.position!);
        const to = s.facingTowardsNodeId.value
          ? nodePos.get(s.facingTowardsNodeId.value)
          : undefined;
        const len = to ? Math.hypot(to.x - p.x, to.y - p.y) || 1 : 1;
        return {
          id: s.id,
          ...p,
          label: s.ref,
          kind: s.function,
          dx: to ? ((to.x - p.x) / len) * 10 : 0,
          dy: to ? ((to.y - p.y) / len) * 10 : 0,
        };
      }),
    points: infra.points.flatMap((pt) => {
      const p = nodePos.get(pt.trackNodeId);
      return p ? [{ id: pt.id, ...p }] : [];
    }),
    boundaries: infra.nodes
      .filter((n) => n.kind === "area_boundary" && n.position)
      .map((n) => ({ id: n.id, ...xy(n.position!) })),
    studyArea: infra.bbox
      ? (() => {
          const nw = xy({ lat: infra.bbox.north, lon: infra.bbox.west });
          const se = xy({ lat: infra.bbox.south, lon: infra.bbox.east });
          return { x: nw.x, y: nw.y, w: se.x - nw.x, h: se.y - nw.y };
        })()
      : null,
    labels: [
      ...infra.locations
        .filter((l) => l.position)
        .map((l) => ({ id: l.id, ...xy(l.position!), text: l.name, kind: l.kind })),
      ...infra.platforms
        .filter((pl) => pl.position && pl.ref)
        .map((pl) => ({ id: pl.id, ...xy(pl.position!), text: `P${pl.ref}`, kind: "platform" })),
    ],
    timingPoints: (opts.timingPoints ?? []).map((t) => ({
      tiploc: t.tiploc,
      ...xy(t.position),
      inferred: t.inferred,
      confidence: t.confidence,
    })),
    caption: `${infra.datasetId} - geographic track preview from ${infra.version}. Not a signalling diagram; only elements present in the data are drawn.`,
    attribution: opts.attribution,
  };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Standalone SVG document for the preview (used by the CLI; the client renders the model with React). */
export function renderPreviewSvg(m: PreviewModel): string {
  const h = m.height + 40;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${m.width} ${h}" width="${m.width}" height="${h}" font-family="sans-serif">`,
    `<rect width="100%" height="100%" fill="#10151c"/>`,
    ...(m.studyArea
      ? [
          `<rect x="${m.studyArea.x}" y="${m.studyArea.y}" width="${m.studyArea.w}" height="${m.studyArea.h}" fill="none" stroke="#3a4656" stroke-dasharray="6 4"><title>study area bbox</title></rect>`,
        ]
      : []),
    `<g fill="none" stroke-linecap="round">`,
    ...m.tracks.map(
      (t) =>
        `<polyline points="${t.points}" stroke="${t.usage === "main" || t.usage === "branch" ? "#e8e8e8" : "#7a8696"}" stroke-width="${t.usage === "main" ? 2.5 : 1.5}"${t.evidence === "sourced" || t.evidence === "verified" ? "" : ' stroke-dasharray="4 3"'}><title>${esc(t.id)}</title></polyline>`,
    ),
    `</g>`,
    ...m.points.map(
      (p) =>
        `<circle cx="${p.x}" cy="${p.y}" r="2.5" fill="#4fb3ff"><title>${esc(p.id)}</title></circle>`,
    ),
    ...m.boundaries.map(
      (p) =>
        `<rect x="${p.x - 4}" y="${p.y - 4}" width="8" height="8" fill="none" stroke="#ffb347"><title>area boundary ${esc(p.id)}</title></rect>`,
    ),
    ...m.signals.map(
      (s) =>
        `<g><line x1="${s.x}" y1="${s.y}" x2="${s.x + s.dx}" y2="${s.y + s.dy}" stroke="#ff5a5a" stroke-width="2"/>` +
        `<circle cx="${s.x}" cy="${s.y}" r="3.5" fill="${s.kind === "distant" ? "#ffd84f" : "#ff5a5a"}"><title>${esc(s.id)}</title></circle>` +
        (s.label
          ? `<text x="${s.x + 5}" y="${s.y - 5}" font-size="10" fill="#ffb0b0">${esc(s.label)}</text>`
          : "") +
        `</g>`,
    ),
    ...m.labels.map(
      (l) =>
        `<text x="${l.x}" y="${l.y}" font-size="${l.kind === "platform" ? 9 : 12}" fill="${l.kind === "signal_box" ? "#ffd84f" : "#9fe0a0"}" text-anchor="middle">${esc(l.text)}</text>`,
    ),
    ...m.timingPoints.map(
      (t) =>
        `<g><rect x="${t.x - 4}" y="${t.y - 4}" width="8" height="8" transform="rotate(45 ${t.x} ${t.y})" fill="${t.inferred ? "none" : "#c58cff"}" stroke="#c58cff" stroke-width="1.5"${t.inferred ? ' stroke-dasharray="2 1.5"' : ""}><title>${esc(t.tiploc)}${t.inferred ? ` (inferred, ${esc(t.confidence ?? "")} confidence)` : " (sourced)"}</title></rect>` +
        `<text x="${t.x + 7}" y="${t.y + 3}" font-size="9" fill="#d9b8ff">${esc(t.tiploc)}${t.inferred ? "?" : ""}</text></g>`,
    ),
    `<text x="10" y="${m.height + 14}" font-size="11" fill="#c0c8d0">${esc(m.caption)}</text>`,
    `<text x="10" y="${m.height + 30}" font-size="11" fill="#c0c8d0">${esc(m.attribution)}</text>`,
    `</svg>`,
  ];
  return out.join("\n") + "\n";
}
