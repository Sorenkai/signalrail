import { describe, expect, it } from "vitest";
import { importOsm, parseMaxSpeedMph } from "../src/import/osm/importOsm.ts";
import type { OverpassResponse } from "../src/import/osm/overpass.ts";
import { Infrastructure } from "../src/model/index.ts";

/**
 * SYNTHETIC Overpass response (ids and positions invented for the test):
 * way 100: 1 - 2(signal, forward) - 3(switch) - 4 ; way 101: 3 - 5(buffer stop)
 * Node 4 lies outside the bbox, so it is an inferred area boundary.
 */
const synthetic: OverpassResponse = {
  version: 0.6,
  generator: "synthetic",
  osm3s: { timestamp_osm_base: "2026-01-01T00:00:00Z", copyright: "synthetic" },
  elements: [
    { type: "node", id: 1, lat: 52.0, lon: -2.0 },
    {
      type: "node",
      id: 2,
      lat: 52.0,
      lon: -1.999,
      tags: {
        railway: "signal",
        ref: "XX1",
        "railway:signal:direction": "forward",
        "railway:signal:main": "GB-NR:semaphore",
        "railway:signal:main:form": "semaphore",
      },
    },
    {
      type: "node",
      id: 3,
      lat: 52.0,
      lon: -1.998,
      tags: { railway: "switch", "railway:switch": "default", ref: "7" },
    },
    { type: "node", id: 4, lat: 52.0, lon: -1.9 },
    { type: "node", id: 5, lat: 51.999, lon: -1.997, tags: { railway: "buffer_stop" } },
    {
      type: "node",
      id: 6,
      lat: 52.0005,
      lon: -1.9985,
      tags: { railway: "signal", "railway:signal:direction": "backward" },
    },
    {
      type: "way",
      id: 100,
      nodes: [1, 2, 3, 4],
      tags: { railway: "rail", usage: "main", maxspeed: "40 mph" },
    },
    { type: "way", id: 101, nodes: [3, 5], tags: { railway: "rail", service: "siding" } },
    {
      type: "node",
      id: 7,
      lat: 52.0,
      lon: -1.9995,
      tags: { railway: "station", name: "Synthetic Halt", "ref:crs": "ZZZ" },
    },
    {
      type: "way",
      id: 102,
      nodes: [],
      center: { lat: 52.0001, lon: -1.9995 },
      tags: { railway: "platform", ref: "1" },
    },
  ],
};
const bbox = { south: 51.99, west: -2.01, north: 52.01, east: -1.95 };
const opts = { datasetId: "synthetic", bbox, retrieved: "2026-01-01", generated: "2026-01-01" };

describe("importOsm", () => {
  const { infrastructure: infra, report } = importOsm(synthetic, opts);

  it("produces schema-valid infrastructure", () => {
    expect(() => Infrastructure.parse(infra)).not.toThrow();
    expect(infra.version).toBe("osm:2026-01-01T00:00:00Z");
  });

  it("splits ways at significant nodes", () => {
    expect(infra.edges.map((e) => [e.from, e.to])).toEqual([
      ["osm-n1", "osm-n2"],
      ["osm-n2", "osm-n3"],
      ["osm-n3", "osm-n4"],
      ["osm-n3", "osm-n5"],
    ]);
    expect(infra.edges[0]!.lengthM).toBeGreaterThan(60);
    expect(infra.edges[0]!.maxSpeedMph?.value).toBe(40);
    expect(infra.edges[3]!.usage).toBe("siding");
  });

  it("classifies nodes, inferring boundaries only outside the bbox", () => {
    const kind = Object.fromEntries(infra.nodes.map((n) => [n.id, n.kind]));
    expect(kind).toEqual({
      "osm-n1": "end_unknown",
      "osm-n2": "plain",
      "osm-n3": "switch",
      "osm-n4": "area_boundary",
      "osm-n5": "buffer_stop",
    });
    expect(infra.nodes.find((n) => n.id === "osm-n4")!.provenance.evidence).toBe("inferred");
  });

  it("resolves signal direction along the way and keeps refs verbatim", () => {
    const sig = infra.signals.find((s) => s.ref === "XX1")!;
    expect(sig).toMatchObject({ trackNodeId: "osm-n2", type: "semaphore", function: "main" });
    expect(sig.facingTowardsNodeId.value).toBe("osm-n3");
    expect(sig.provenance.sources[0]).toMatchObject({
      sourceId: "openstreetmap",
      recordId: "node/2",
    });
  });

  it("keeps off-track signals but does not attach them to the graph", () => {
    const off = infra.signals.find((s) => s.id === "osm-sig6")!;
    expect(off.trackNodeId).toBeNull();
    expect(off.facingTowardsNodeId.value).toBeNull();
    expect(report.offTrackSignals).toBe(1);
  });

  it("never guesses points lie or platform track links", () => {
    expect(infra.points[0]!.normalTowardsNodeId).toMatchObject({
      value: null,
      provenance: { evidence: "unknown" },
    });
    expect(infra.platforms[0]!.edgeIds.value).toBeNull();
    expect(infra.platforms[0]!.id).toBe("osm-plat-w102");
    expect(infra.locations[0]!.id).toBe("osm-loc-n7");
    expect(infra.locations[0]!.codes).toEqual({ crs: "ZZZ" });
  });
});

describe("parseMaxSpeedMph", () => {
  it("handles mph, km/h and junk", () => {
    expect(parseMaxSpeedMph("75 mph")).toBe(75);
    expect(parseMaxSpeedMph("100")).toBe(62);
    expect(parseMaxSpeedMph("fast")).toBeNull();
    expect(parseMaxSpeedMph(undefined)).toBeNull();
  });
});
