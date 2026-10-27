/**
 * Platform-to-track association (src/import/osm/platformTracks.ts) and its use by the importer
 * and validator. All ids, positions and refs here are SYNTHETIC.
 */
import { describe, expect, it } from "vitest";
import { importOsm } from "../src/import/osm/importOsm.ts";
import type { OverpassResponse } from "../src/import/osm/overpass.ts";
import { lengthAlongOutline, type SupplementElement } from "../src/import/osm/platformTracks.ts";
import { Infrastructure } from "../src/model/index.ts";
import { platformRoads } from "../src/reconcile/geography.ts";
import { validateDataset } from "../src/validation/validate.ts";

// About 1 m in degrees at 52 N.
const DLAT = 1 / 111_320;
const DLON = 1 / (111_320 * Math.cos((52 * Math.PI) / 180));
const at = (xM: number, yM: number) => ({ lat: 52 + yM * DLAT, lon: -1 + xM * DLON });
const rect = (x0: number, y0: number, x1: number, y1: number) => [
  at(x0, y0),
  at(x1, y0),
  at(x1, y1),
  at(x0, y1),
  at(x0, y0),
];

describe("lengthAlongOutline", () => {
  const outline = rect(0, 0, 100, 6); // a 100 m x 6 m platform
  it("measures track running alongside the outline", () => {
    // 100 m alongside, plus up to ~2.2 m past each corner that is still within 3 m of it.
    const along = lengthAlongOutline([at(-20, -2), at(120, -2)], outline);
    expect(along).toBeGreaterThanOrEqual(100);
    expect(along).toBeLessThanOrEqual(105);
  });
  it("ignores track more than 3 m away and track inside the outline", () => {
    expect(lengthAlongOutline([at(-20, -5), at(120, -5)], outline)).toBe(0);
    expect(lengthAlongOutline([at(10, 3), at(90, 3)], outline)).toBe(0);
  });
});

/*
 * Synthetic station: track A (y = -2) and track B (y = +8) run past platform P1 (0..100 m,
 * y 0..6). Track A continues west to a switch S and a buffer stop; track C lies 40 m away.
 * Stop positions: n10 on A (ref "1"), n20 on B (ref "2"). Platform P9 has nothing near it.
 */
function synthetic(
  opts: { stopRef?: string; stopOnB?: boolean; noRelation?: boolean; signalAt25?: boolean } = {},
) {
  const node = (id: number, x: number, y: number, tags?: Record<string, string>) => ({
    type: "node" as const,
    id,
    ...at(x, y),
    ...(tags ? { tags } : {}),
  });
  const main: OverpassResponse = {
    version: 0.6,
    generator: "synthetic",
    osm3s: { timestamp_osm_base: "2026-01-01T00:00:00Z", copyright: "synthetic" },
    elements: [
      node(1, -60, -2, { railway: "buffer_stop" }),
      node(2, -30, -2),
      node(10, 50, -2, { railway: "stop", ref: opts.stopRef ?? "1" }),
      node(11, 25, -2, opts.signalAt25 ? { railway: "signal" } : undefined),
      node(3, 150, -2),
      node(4, -60, 8),
      node(20, 50, 8, { railway: "stop", ref: "2" }),
      node(5, 150, 8),
      node(6, -60, 48),
      node(7, 150, 48),
      ...(opts.stopOnB ? [node(21, 70, 8, { railway: "stop", ref: "1" })] : []),
      { type: "way", id: 100, nodes: [1, 2, 11, 10, 3], tags: { railway: "rail" } },
      {
        type: "way",
        id: 101,
        nodes: opts.stopOnB ? [4, 20, 21, 5] : [4, 20, 5],
        tags: { railway: "rail" },
      },
      { type: "way", id: 102, nodes: [6, 7], tags: { railway: "rail" } },
      {
        type: "way",
        id: 500,
        nodes: [],
        center: at(50, 3),
        tags: { railway: "platform", ref: "1" },
      },
      { type: "way", id: 501, nodes: [], center: at(50, 200), tags: { railway: "platform" } },
    ],
  };
  const supplement: SupplementElement[] = [
    { type: "way", id: 500, geometry: rect(0, 0, 100, 6), tags: { railway: "platform", ref: "1" } },
    { type: "way", id: 501, geometry: rect(0, 195, 20, 205), tags: { railway: "platform" } },
    ...(opts.noRelation
      ? []
      : [
          {
            type: "relation" as const,
            id: 900,
            tags: { public_transport: "stop_area" },
            members: [
              { type: "way", ref: 500, role: "platform" },
              { type: "node", ref: 10, role: "stop" },
              ...(opts.stopOnB ? [{ type: "node", ref: 21, role: "stop" }] : []),
            ],
          },
        ]),
  ];
  const run = (withSupplement = true) =>
    importOsm(main, {
      datasetId: "synthetic",
      bbox: { south: 51.99, west: -1.01, north: 52.01, east: -0.99 },
      retrieved: "2026-01-01",
      generated: "2026-01-01",
      ...(withSupplement
        ? { supplement: { elements: supplement, version: "S", retrieved: "2026-01-01", file: "x" } }
        : {}),
    }).infrastructure;
  return run;
}
const plat = (infra: Infrastructure, osmId: number) =>
  infra.platforms.find((p) => p.id === `osm-plat-w${osmId}`)!;

describe("associatePlatformTracks via importOsm", () => {
  it("maps a platform by stop_area + stop ref + outline, keeping other adjacent tracks out", () => {
    const infra = synthetic()();
    expect(() => Infrastructure.parse(infra)).not.toThrow();
    const p = plat(infra, 500);
    expect(p.trackAssociation).toMatchObject({
      method: "stop_area_and_outline",
      status: "mapped",
      stopNodeIds: ["osm-n10"],
      stopAreaRelations: ["relation/900"],
    });
    // Way 100 splits only at the stop node (node 2 is untagged), giving edges -0 and -1.
    expect(p.edgeIds.value).toEqual(["osm-w100-0", "osm-w100-1"]);
    // Every mapped edge touches the stop node, so the link is sourced (OSM), not verified.
    expect(p.edgeIds.provenance.evidence).toBe("sourced");
    // Track B also runs alongside the outline but is not the stop's track: recorded, not mapped.
    const other = p.trackAssociation!.adjacentEdges.filter((a) => !a.onStopTrack);
    expect(other.map((a) => a.edgeId)).toEqual(expect.arrayContaining(["osm-w101-0"]));
    expect(p.trackAssociation!.note).toMatch(/not mapped/);
  });

  it("labels the link inferred when outline geometry adds edges beyond the stop node", () => {
    // A signal at x = 25 m splits track A, so edge 1->11 runs alongside the platform for about
    // 27 m without touching the stop node: it is added by geometry, so the link is inferred.
    const p = plat(synthetic({ signalAt25: true })(), 500);
    expect(p.trackAssociation?.status).toBe("mapped");
    expect(p.edgeIds.value).toEqual(["osm-w100-0", "osm-w100-1", "osm-w100-2"]);
    expect(p.edgeIds.provenance.evidence).toBe("inferred");
    expect(p.edgeIds.provenance.note).toMatch(/outline geometry/);
  });

  it("falls back to ref and proximity without a stop_area relation", () => {
    const p = plat(synthetic({ noRelation: true })(), 500);
    expect(p.trackAssociation?.method).toBe("stop_position_and_outline");
    expect(p.trackAssociation?.status).toBe("mapped");
  });

  it("is ambiguous when stop positions with the same ref lie on different tracks", () => {
    const p = plat(synthetic({ stopOnB: true })(), 500);
    expect(p.trackAssociation?.status).toBe("ambiguous");
    expect(p.edgeIds.value).toBeNull();
    expect(p.edgeIds.provenance.evidence).toBe("unknown");
  });

  it("falls back to the outline alone when no stop has the ref, and is ambiguous if 2 tracks fit", () => {
    const p = plat(synthetic({ stopRef: "7" })(), 500);
    expect(p.trackAssociation).toMatchObject({ method: "outline_only", status: "ambiguous" });
    expect(p.edgeIds.value).toBeNull();
  });

  it("leaves a platform with no stop and no nearby track unresolved, and never invents one", () => {
    const infra = synthetic()();
    const p = plat(infra, 501);
    expect(p.trackAssociation).toMatchObject({ method: "none", status: "unresolved" });
    expect(p.edgeIds).toMatchObject({ value: null, provenance: { evidence: "unknown" } });
    expect(infra.platforms.map((x) => x.ref)).toEqual(["1", null]);
  });

  it("changes nothing when no supplement is given (existing datasets stay identical)", () => {
    const infra = synthetic()(false);
    for (const p of infra.platforms) {
      expect(p.trackAssociation).toBeUndefined();
      expect(p.edgeIds.value).toBeNull();
    }
  });

  it("feeds mapped edges to the geography assessment and flags unresolved platforms", () => {
    const infra = synthetic()();
    const roads = platformRoads(
      infra,
      infra.platforms.map((p) => p.id),
    );
    const mapped = roads.find((r) => r.ref === "1")!;
    expect(mapped).toMatchObject({ method: "importer", status: "mapped", evidence: "sourced" });
    // Connectivity along the platform track runs to the buffer stop through the switch-free run.
    expect(mapped.signalRefs).toEqual([]);
    expect(roads.find((r) => r.ref === null)?.status).toBe("unresolved");

    const issues = validateDataset({
      sources: {
        sources: [
          {
            id: "openstreetmap",
            name: "synthetic",
            publisher: "synthetic",
            url: "https://example.org/",
            access: "public",
            licence: { name: "synthetic", confirmed: false },
            attribution: null,
            obligations: [],
            status: "in-use",
            interlockingAuthority: false,
            retrievals: [],
          },
        ],
      },
      infrastructure: infra,
    });
    expect(issues.find((i) => i.code === "PLATFORM_TRACK_UNRESOLVED")?.ids).toEqual([
      "osm-plat-w501",
    ]);
    expect(issues.some((i) => i.code === "PLATFORM_TRACK_INCONSISTENT")).toBe(false);
  });
});
