/**
 * Shared track-graph primitives (src/graph/, D-025). Every layout here is SYNTHETIC.
 *
 *   W --a-- S --b-- X2 --c-- P --d-- BS(buffer)        X2: a switch with only two mapped edges
 *                           P (switch, 3 edges) --e-- Y --f-- END (end_unknown)
 *   P's lie: normal -> BS side (D), reverse -> Y; toe -> X2.
 */
import { describe, expect, it } from "vitest";
import { DirectedTrack } from "../src/graph/directedTrack.ts";
import { TrackGraph, pointsLie } from "../src/graph/trackGraph.ts";
import type { Infrastructure, Points } from "../src/model/index.ts";

const prov = { evidence: "sourced" as const, sources: [{ sourceId: "synthetic-fixture" }] };
const unknown = { evidence: "unknown" as const, sources: [] };
type Kind = Infrastructure["nodes"][number]["kind"];

function layout(opts: { x2Kind?: Kind; lie?: "known" | "unknown" | "inferred" } = {}) {
  const node = (id: string, kind: Kind, lat: number, lon: number) => ({
    id,
    kind,
    position: { lat, lon },
    provenance: prov,
  });
  const edge = (id: string, from: string, to: string, lengthM = 100) => ({
    id,
    from,
    to,
    lengthM,
    usage: "main" as const,
    provenance: prov,
  });
  const lieProv =
    opts.lie === "inferred" ? { evidence: "inferred" as const, sources: [], note: "x" } : prov;
  const points: Points = {
    id: "ptsP",
    ref: null,
    trackNodeId: "P",
    switchType: "simple",
    normalTowardsNodeId:
      opts.lie === "unknown"
        ? { value: null, provenance: unknown }
        : { value: "D", provenance: lieProv },
    reverseTowardsNodeId:
      opts.lie === "unknown"
        ? { value: null, provenance: unknown }
        : { value: "Y", provenance: lieProv },
    provenance: prov,
  };
  return {
    nodes: [
      node("W", "area_boundary", 52, -1.004),
      node("S", "plain", 52, -1.003),
      node("X2", opts.x2Kind ?? "switch", 52, -1.002),
      node("P", "switch", 52, -1.001),
      node("D", "plain", 52, -1.0005),
      node("BS", "buffer_stop", 52, -1.0),
      node("Y", "plain", 51.9997, -1.0005),
      node("END", "end_unknown", 51.9995, -1.0),
    ],
    edges: [
      edge("a", "W", "S"),
      edge("b", "S", "X2"),
      edge("c", "X2", "P"),
      edge("d1", "P", "D", 50),
      edge("d2", "D", "BS", 50),
      edge("e", "P", "Y"),
      edge("f", "Y", "END"),
    ],
    points: [points],
  };
}

describe("TrackGraph.junction: explicit behaviour per node", () => {
  const g = new TrackGraph(layout());
  it("classifies ordinary track, ends, switches and incomplete junctions", () => {
    expect(g.junction("S").cls).toBe("plain");
    expect(g.junction("W").cls).toBe("end");
    expect(g.junction("BS").cls).toBe("end");
    expect(g.junction("END").cls).toBe("end");
    expect(g.junction("P")).toMatchObject({ cls: "switch", degree: 3 });
    expect(g.junction("X2")).toMatchObject({ cls: "incomplete", reason: "two_edge_junction" });
  });

  it("treats a two-edge crossing and a two-edge buffer stop as incomplete, not plain", () => {
    expect(new TrackGraph(layout({ x2Kind: "crossing" })).junction("X2").reason).toBe(
      "two_edge_junction",
    );
    expect(new TrackGraph(layout({ x2Kind: "buffer_stop" })).junction("X2").cls).toBe("incomplete");
  });
});

describe("TrackGraph.plainRun (dead ends, buffers, incomplete topology)", () => {
  const g = new TrackGraph(layout());
  it("does not pass through a two-edge switch", () => {
    const r = g.plainRun("S", "X2");
    expect(r).toMatchObject({ nodeId: "X2", kind: "switch", degree: 2, junction: "incomplete" });
    expect(r!.basis).toBe("mapped_topology");
  });

  it("stops at a switch with known topology rather than choosing a leg", () => {
    expect(g.plainRun("D", "P")).toMatchObject({ nodeId: "P", junction: "switch", distanceM: 50 });
  });

  it("finds a buffer stop behind plain track, and an unexplained end", () => {
    expect(g.plainRun("P", "D")).toMatchObject({
      nodeId: "BS",
      kind: "buffer_stop",
      distanceM: 100,
      nodes: ["P", "D", "BS"],
      edgeIds: ["d1", "d2"],
    });
    expect(g.plainRun("P", "Y")).toMatchObject({ nodeId: "END", kind: "end_unknown" });
  });

  it("returns null for a non-adjacent start or a run beyond maxM", () => {
    expect(g.plainRun("S", "P")).toBeNull();
    expect(g.plainRun("P", "D", 60)).toBeNull();
  });

  it("plainRunFrom stops at every non-plain node, including an incomplete one", () => {
    const r = g.plainRunFrom(["b"]);
    expect([...r.edges].sort()).toEqual(["a", "b"]);
    expect([...r.nodes].sort()).toEqual(["S", "W", "X2"]);
  });

  it("behind() needs exactly one other neighbour", () => {
    expect(g.behind("S", "X2")).toBe("W");
    expect(g.behind("P", "X2")).toBeNull(); // two other legs: ambiguous
    expect(g.behind("W", "S")).toBeNull(); // nothing behind an end
  });
});

describe("TrackGraph.switchPassage (evidenced lie only)", () => {
  it("accepts toe-to-leg movement and reports the position taken", () => {
    const g = new TrackGraph(layout());
    expect(g.switchPassage("X2", "P", "D")).toMatchObject({ status: "set", position: "normal" });
    expect(g.switchPassage("Y", "P", "X2")).toMatchObject({
      status: "set",
      position: "reverse",
      evidence: "sourced",
    });
  });

  it("refuses leg-to-leg movement", () => {
    const g = new TrackGraph(layout());
    expect(g.switchPassage("D", "P", "Y")).toMatchObject({ status: "leg_to_leg", toe: "X2" });
  });

  it("leaves an unknown lie unresolved, and keeps an inferred lie's evidence level", () => {
    expect(new TrackGraph(layout({ lie: "unknown" })).switchPassage("X2", "P", "D").status).toBe(
      "unresolved",
    );
    expect(new TrackGraph(layout({ lie: "inferred" })).switchPassage("X2", "P", "D")).toMatchObject(
      { status: "set", evidence: "inferred" },
    );
  });

  it("leaves an incomplete two-edge switch unresolved", () => {
    const g = new TrackGraph(layout());
    expect(g.switchPassage("S", "X2", "P")).toMatchObject({ status: "unresolved" });
  });

  it("pointsLie never promotes evidence and rejects coinciding legs", () => {
    const p = layout({ lie: "inferred" }).points[0]!;
    expect(pointsLie(p)?.evidence).toBe("inferred");
    expect(pointsLie({ ...p, reverseTowardsNodeId: { value: "D", provenance: prov } })).toBeNull();
  });
});

describe("DirectedTrack (geometric heuristic)", () => {
  it("does not route through a two-edge switch unless asked to report it", () => {
    const infra = layout();
    expect(new DirectedTrack(infra).route("W", "S", "BS", null)).toBeNull();
    const t = new DirectedTrack(infra, "legs", { incompleteJunctions: "allow" });
    const r = t.route("W", "S", "BS", null)!;
    expect(r.nodes).toEqual(["W", "S", "X2", "P", "D", "BS"]);
    expect(t.incompleteJunctionsUsed(r)).toEqual(["X2"]);
    expect(r.basis).toBe("geometric_heuristic");
  });

  it("blocks the two-edge switch under the smooth rule too", () => {
    expect(new DirectedTrack(layout(), "smooth").route("W", "S", "BS", null)).toBeNull();
  });

  it("routes over ordinary track and a complete switch", () => {
    const infra = layout({ x2Kind: "plain" });
    const r = new DirectedTrack(infra).route("W", "S", "BS", null);
    expect(r?.distanceM).toBe(400);
  });
});

describe("TrackGraph.junction: slips and crossings", () => {
  const four = (kind: Kind, switchType: Points["switchType"] | null, extraEdge = true) => {
    const node = (id: string, k: Kind, lat: number, lon: number) => ({
      id,
      kind: k,
      position: { lat, lon },
      provenance: prov,
    });
    const edge = (id: string, to: string) => ({
      id,
      from: "C",
      to,
      lengthM: 100,
      usage: "main" as const,
      provenance: prov,
    });
    return new TrackGraph({
      nodes: [
        node("C", kind, 52, -1),
        node("Wx", "plain", 52, -1.001),
        node("Ex", "plain", 52, -0.999),
        node("NE", "plain", 52.0003, -0.999),
        node("SW", "plain", 51.9997, -1.001),
      ],
      edges: [
        edge("a", "Wx"),
        edge("b", "Ex"),
        edge("c", "NE"),
        ...(extraEdge ? [edge("d", "SW")] : []),
      ],
      points: switchType
        ? [
            {
              id: "pC",
              ref: null,
              trackNodeId: "C",
              switchType,
              normalTowardsNodeId: { value: null, provenance: unknown },
              reverseTowardsNodeId: { value: null, provenance: unknown },
              provenance: prov,
            },
          ]
        : [],
    });
  };

  it("recognises sourced slip types only on four-edge nodes", () => {
    expect(four("switch", "single_slip").junction("C").cls).toBe("single_slip");
    expect(four("switch", "double_slip").junction("C").cls).toBe("double_slip");
    expect(four("switch", "single_slip", false).junction("C")).toMatchObject({
      cls: "incomplete",
      reason: "slip_wrong_degree",
    });
  });

  it("treats an untyped four-edge switch as incomplete, and a four-edge crossing as a crossing", () => {
    expect(four("switch", null).junction("C").reason).toBe("untyped_junction");
    expect(four("crossing", null).junction("C").cls).toBe("crossing");
    expect(four("crossing", null, false).junction("C").reason).toBe("crossing_wrong_degree");
  });

  it("never resolves a passage through a slip or crossing from topology alone", () => {
    expect(four("switch", "single_slip").switchPassage("Wx", "C", "Ex").status).toBe("unresolved");
    expect(four("crossing", null).switchPassage("Wx", "C", "Ex").status).toBe("unresolved");
  });
});
