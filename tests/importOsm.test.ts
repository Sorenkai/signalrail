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

/**
 * SYNTHETIC signals (ids, refs and positions invented) covering audit M1/M2: one way 200
 * through nodes 20-27, each a signal with a different OSM tag combination.
 */
describe("importOsm signal classification (audit M1, M2)", () => {
  const sig = (id: number, tags: Record<string, string>) => ({
    type: "node" as const,
    id,
    lat: 52.0,
    lon: -2.0 + id / 10000,
    tags: { railway: "signal", "railway:signal:direction": "forward", ...tags },
  });
  const signals = [
    sig(21, {
      ref: "SY21",
      "railway:signal:shunting": "GB-NR:shunting",
      "railway:signal:shunting:form": "light",
      "railway:signal:position": "left",
    }),
    sig(22, {
      ref: "SY22",
      "railway:signal:main": "GB-NR:main",
      "railway:signal:main:form": "light",
      "railway:signal:main:design": "individual",
      "railway:signal:shunting": "GB-NR:shunting",
      "railway:signal:shunting:form": "light",
      "railway:signal:route": "GB-NR:junction",
      "railway:signal:route:form": "light",
      "railway:signal:route:design": "feather",
      "railway:signal:route:states": "position_4;position_6;off",
      route_ref: "synthetic_line",
    }),
    sig(23, {
      ref: "SY23",
      "railway:signal:main": "GB-NR:main",
      "railway:signal:main:form": "light",
      "railway:signal:route": "GB-NR:junction",
      "railway:signal:route:form": "light",
      "railway:signal:route:design": "theatre",
    }),
    sig(24, {
      ref: "SY24",
      "railway:signal:main": "GB-NR:main",
      "railway:signal:main:form": "light",
      "railway:signal:position": "bridge",
    }),
    sig(25, {
      ref: "SY25",
      "railway:signal:main_repeated": "GB-NR:banner",
      "railway:signal:main_repeated:form": "light",
    }),
    sig(26, { ref: "SY26" }),
    sig(27, {
      ref: "SY27",
      "railway:signal:shunting": "GB-NR:shunting",
      "railway:signal:shunting:form": "light",
      "railway:signal:shunting:height": "dwarf",
    }),
  ];
  const data: OverpassResponse = {
    ...synthetic,
    elements: [
      { type: "node", id: 20, lat: 52.0, lon: -1.999 },
      ...signals,
      { type: "node", id: 28, lat: 52.0, lon: -1.997 },
      {
        type: "way",
        id: 200,
        nodes: [20, 21, 22, 23, 24, 25, 26, 27, 28],
        tags: { railway: "rail" },
      },
    ],
  };
  const { infrastructure } = importOsm(data, opts);
  const byRef = (ref: string) => infrastructure.signals.find((s) => s.ref === ref)!;

  it("does not classify a light shunting signal as ground-mounted", () => {
    const s = byRef("SY21");
    expect(s).toMatchObject({ type: "light", function: "shunting" });
    expect(infrastructure.signals.map((x) => x.type)).not.toContain("ground");
  });

  it("keeps mounting unknown unless the source states it", () => {
    expect(byRef("SY21").mounting).toEqual({
      value: null,
      provenance: {
        evidence: "unknown",
        sources: [],
        note: "OSM railway:signal:position=left gives no mounting (post, ground or other)",
      },
    });
    expect(byRef("SY22").mounting.value).toBeNull();
    expect(byRef("SY22").mounting.provenance.evidence).toBe("unknown");
    // A dwarf height is kept verbatim on the component, not turned into a mounting.
    expect(byRef("SY27").mounting.value).toBeNull();
    expect(byRef("SY27").components[0]!.height).toBe("dwarf");
    const gantry = byRef("SY24").mounting;
    expect(gantry.value).toBe("gantry");
    expect(gantry.provenance).toMatchObject({
      evidence: "sourced",
      sources: [{ sourceId: "openstreetmap", recordId: "node/24" }],
    });
  });

  it("preserves subsidiary and route-indicator components verbatim", () => {
    const s = byRef("SY22");
    expect(s).toMatchObject({ type: "colour_light", function: "main" });
    expect(s.components).toEqual([
      {
        category: "main",
        sourceType: "GB-NR:main",
        form: "light",
        design: "individual",
        states: null,
        height: null,
      },
      {
        category: "shunting",
        sourceType: "GB-NR:shunting",
        form: "light",
        design: null,
        states: null,
        height: null,
      },
      {
        category: "route",
        sourceType: "GB-NR:junction",
        form: "light",
        design: "feather",
        states: ["position_4", "position_6", "off"],
        height: null,
      },
    ]);
    expect(s.sourceTags).toMatchObject({ route_ref: "synthetic_line", ref: "SY22" });
  });

  it("survives serialization and schema parsing unchanged", () => {
    const roundTrip = Infrastructure.parse(JSON.parse(JSON.stringify(infrastructure)));
    expect(roundTrip.signals).toEqual(infrastructure.signals);
  });

  it("does not invent capabilities the tags do not state", () => {
    // A theatre indicator with no states tag: the indications stay unknown, not an empty list.
    const theatre = byRef("SY23").components.find((c) => c.category === "route")!;
    expect(theatre.states).toBeNull();
    // A main signal with no shunting tag gets no shunting component.
    expect(byRef("SY23").components.map((c) => c.category)).toEqual(["main", "route"]);
    // A banner repeater is lit but not a colour-light signal.
    expect(byRef("SY25")).toMatchObject({ type: "light", function: "repeater" });
    // No category tag: nothing is classified.
    expect(byRef("SY26")).toMatchObject({ type: "unknown", function: "unknown", components: [] });
  });
});
