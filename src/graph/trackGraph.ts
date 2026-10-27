import type { Infrastructure, Points, Provenance, TrackEdge, TrackNode } from "../model/index.ts";

/**
 * Core track-graph primitives shared by the importer, validator, reconciliation and pilot
 * tools (DECISION_LOG D-025). Everything here reads the mapped topology only: nodes, edges and
 * the sourced Points records. Nothing here is a heuristic, and nothing establishes how a real
 * interlocking behaves. The geometric junction heuristic lives separately in directedTrack.ts.
 */

export type WalkResult = { ok: true; nodes: string[] } | { ok: false; reason: string };

/**
 * What the mapped topology says about movement through a node:
 * - plain:       ordinary track: a `plain` node with exactly two edges; trains pass straight on;
 * - end:         one edge or none (buffer stop, area boundary, unexplained end);
 * - switch:      a `switch` node with three edges; which leg is the toe is known only from an
 *                evidenced points lie (see `switchPassage`);
 * - single_slip, double_slip: a `switch` node with four edges and that sourced slip type;
 * - crossing:    a `crossing` node with four edges (a diamond);
 * - incomplete:  any other combination; `reason` says which. Two cases matter most:
 *   - two_edge_junction: a switch, crossing or other non-plain node with only two mapped edges.
 *     A leg is missing from the data, so whether the two mapped edges connect is unknown;
 *   - untyped_junction: three or more edges at a plain node, a switch with four or more edges
 *     and no slip type, or a slip type on a node that does not have four edges.
 */
export type JunctionClass =
  "plain" | "end" | "switch" | "single_slip" | "double_slip" | "crossing" | "incomplete";

export interface Junction {
  cls: JunctionClass;
  kind: TrackNode["kind"] | undefined;
  degree: number;
  reason?: "two_edge_junction" | "untyped_junction" | "slip_wrong_degree" | "crossing_wrong_degree";
  points?: Points;
}

/** Result of following plain track. `basis` says what it rests on: mapped topology only. */
export interface PlainRun {
  /** The node that ends the run: the first node that is not ordinary plain track. */
  nodeId: string;
  kind: TrackNode["kind"] | undefined;
  degree: number;
  junction: JunctionClass;
  distanceM: number;
  /** Nodes from the start (inclusive) to `nodeId` (inclusive). */
  nodes: string[];
  edgeIds: string[];
  basis: "mapped_topology";
}

/** A points lie usable for checks: both legs stated with non-unknown evidence. */
export interface PointsLie {
  normal: string;
  reverse: string;
  /** The weaker of the two legs' evidence levels; never promoted. */
  evidence: Provenance["evidence"];
}

/**
 * Movement from `from` through `node` to `to`, judged only from mapped topology and evidenced
 * points lie:
 * - through:    ordinary plain track;
 * - set:        simple points with an evidenced lie, entered or left via the toe;
 * - leg_to_leg: simple points with an evidenced lie, from one diverging leg to the other;
 * - unresolved: the data cannot decide (`why` explains). Never a pass.
 */
export type SwitchPassage =
  | { status: "through" }
  | {
      status: "set";
      points: Points;
      position: "normal" | "reverse";
      evidence: Provenance["evidence"];
    }
  | { status: "leg_to_leg"; points: Points; toe: string }
  | { status: "unresolved"; why: string; points?: Points };

const weakest = (a: Provenance["evidence"], b: Provenance["evidence"]) => {
  const order: Provenance["evidence"][] = [
    "verified",
    "sourced",
    "inferred",
    "simplified",
    "placeholder",
    "unknown",
  ];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
};

/** The points lie, or null when either leg is missing, unknown or the legs coincide. */
export function pointsLie(p: Points): PointsLie | null {
  const n = p.normalTowardsNodeId;
  const r = p.reverseTowardsNodeId;
  if (n.value === null || r.value === null) return null;
  if (n.provenance.evidence === "unknown" || r.provenance.evidence === "unknown") return null;
  if (n.value === r.value) return null;
  return {
    normal: n.value,
    reverse: r.value,
    evidence: weakest(n.provenance.evidence, r.provenance.evidence),
  };
}

/** Undirected view of the track graph. Edges may be traversed in either direction. */
export class TrackGraph {
  private readonly nodes = new Map<string, TrackNode>();
  private readonly incidentEdges = new Map<string, { edgeId: string; other: string }[]>();
  private readonly edges = new Map<string, TrackEdge>();
  private readonly pointsByNode = new Map<string, Points>();

  constructor(
    infra: Pick<Infrastructure, "nodes" | "edges"> & Partial<Pick<Infrastructure, "points">>,
  ) {
    for (const n of infra.nodes) {
      this.nodes.set(n.id, n);
      this.incidentEdges.set(n.id, []);
    }
    for (const e of infra.edges) {
      this.edges.set(e.id, e);
      this.incidentEdges.get(e.from)?.push({ edgeId: e.id, other: e.to });
      this.incidentEdges.get(e.to)?.push({ edgeId: e.id, other: e.from });
    }
    for (const p of infra.points ?? []) this.pointsByNode.set(p.trackNodeId, p);
  }

  node(id: string) {
    return this.nodes.get(id);
  }

  edge(id: string) {
    return this.edges.get(id);
  }

  pointsAt(nodeId: string) {
    return this.pointsByNode.get(nodeId);
  }

  /** Number of edges at the node (parallel edges count separately). */
  degree(id: string) {
    return this.incidentEdges.get(id)?.length ?? 0;
  }

  /** Edges at the node, in edge order, with the node at their other end. */
  incident(id: string): readonly { edgeId: string; other: string }[] {
    return this.incidentEdges.get(id) ?? [];
  }

  /** Distinct adjacent nodes, in edge order. */
  neighbours(id: string): string[] {
    return [...new Set(this.incident(id).map((i) => i.other))];
  }

  adjacent(a: string, b: string) {
    return this.incident(a).some((i) => i.other === b);
  }

  /**
   * The single neighbour of `node` other than `facing`, i.e. the track behind a signal at
   * `node` that faces `facing`. Null unless exactly one such neighbour exists.
   */
  behind(node: string, facing: string): string | null {
    const others = this.neighbours(node).filter((n) => n !== facing);
    return others.length === 1 ? others[0]! : null;
  }

  junction(id: string): Junction {
    const kind = this.node(id)?.kind;
    const degree = this.degree(id);
    const points = this.pointsAt(id);
    const base = { kind, degree, ...(points ? { points } : {}) };
    const slip =
      points?.switchType === "single_slip" || points?.switchType === "double_slip"
        ? points.switchType
        : null;
    if (degree <= 1) return { ...base, cls: "end" };
    if (degree === 2)
      return kind === "plain"
        ? { ...base, cls: "plain" }
        : { ...base, cls: "incomplete", reason: "two_edge_junction" };
    if (kind === "crossing")
      return degree === 4
        ? { ...base, cls: "crossing" }
        : { ...base, cls: "incomplete", reason: "crossing_wrong_degree" };
    if (slip)
      return degree === 4
        ? { ...base, cls: slip }
        : { ...base, cls: "incomplete", reason: "slip_wrong_degree" };
    if (kind === "switch" && degree === 3) return { ...base, cls: "switch" };
    return { ...base, cls: "incomplete", reason: "untyped_junction" };
  }

  /** Follows edgeIds from start; each edge must touch the node reached so far. */
  walk(start: string, edgeIds: string[]): WalkResult {
    const nodes = [start];
    let at = start;
    for (const id of edgeIds) {
      const e = this.edges.get(id);
      if (!e) return { ok: false, reason: `unknown edge ${id}` };
      if (e.from === at) at = e.to;
      else if (e.to === at) at = e.from;
      else return { ok: false, reason: `edge ${id} does not continue from node ${at}` };
      nodes.push(at);
    }
    return { ok: true, nodes };
  }

  /**
   * Follows ordinary plain track from `start`, leaving towards `next`, until the first node
   * that is not a `plain` node with two edges: a switch or crossing of any degree (including
   * an incomplete two-edge one), an end, or a plain junction. Null if `next` is not adjacent
   * or the run exceeds `maxM`.
   */
  plainRun(start: string, next: string, maxM = 2000): PlainRun | null {
    const first = this.incident(start).find((i) => i.other === next);
    if (!first) return null;
    const nodes = [start, next];
    const edgeIds = [first.edgeId];
    let via = first.edgeId;
    let cur = next;
    let d = this.edges.get(first.edgeId)!.lengthM ?? 0;
    while (d <= maxM) {
      const j = this.junction(cur);
      if (j.cls !== "plain")
        return {
          nodeId: cur,
          kind: j.kind,
          degree: j.degree,
          junction: j.cls,
          distanceM: Math.round(d),
          nodes,
          edgeIds,
          basis: "mapped_topology",
        };
      const nx = this.incident(cur).find((i) => i.edgeId !== via)!;
      d += this.edges.get(nx.edgeId)!.lengthM ?? 0;
      via = nx.edgeId;
      cur = nx.other;
      nodes.push(cur);
      edgeIds.push(via);
    }
    return null;
  }

  /**
   * The given edges plus all ordinary plain track continuing from their ends, stopping at
   * every node that is not a `plain` node with two edges. Returns the edges and nodes reached.
   */
  plainRunFrom(edgeIds: Iterable<string>): { edges: Set<string>; nodes: Set<string> } {
    const edges = new Set<string>();
    const nodes = new Set<string>();
    const stack = [...edgeIds];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (edges.has(id)) continue;
      const e = this.edges.get(id);
      if (!e) continue;
      edges.add(id);
      for (const n of [e.from, e.to]) {
        nodes.add(n);
        if (this.junction(n).cls === "plain") stack.push(...this.incident(n).map((i) => i.edgeId));
      }
    }
    return { edges, nodes };
  }

  /** See SwitchPassage. Uses the evidenced lie only; never geometry. */
  switchPassage(from: string, node: string, to: string): SwitchPassage {
    const j = this.junction(node);
    if (j.kind === "crossing")
      return { status: "unresolved", why: "a crossing, whose leg pairing is not modelled" };
    if (j.kind !== "switch") {
      if (j.cls === "plain" || j.cls === "end") return { status: "through" };
      return {
        status: "unresolved",
        why:
          j.degree > 2
            ? `a ${j.kind} node with ${j.degree} edges`
            : `a ${j.kind} node with only ${j.degree} mapped edges`,
      };
    }
    const p = j.points;
    if (!p) return { status: "unresolved", why: "a switch with no Points record" };
    if (p.switchType !== "simple")
      return { status: "unresolved", why: `${p.switchType} points`, points: p };
    if (j.degree !== 3)
      return {
        status: "unresolved",
        why: `simple points on a node with ${j.degree} edges`,
        points: p,
      };
    const lie = pointsLie(p);
    if (!lie)
      return {
        status: "unresolved",
        why: `points ${p.id} have no evidenced normal/reverse lie`,
        points: p,
      };
    const toe = this.neighbours(node).find((n) => n !== lie.normal && n !== lie.reverse);
    if (!toe)
      return { status: "unresolved", why: `points ${p.id} have no identifiable toe`, points: p };
    if (from !== toe && to !== toe) return { status: "leg_to_leg", points: p, toe };
    const leg = from === toe ? to : from;
    return {
      status: "set",
      points: p,
      position: leg === lie.normal ? "normal" : "reverse",
      evidence: lie.evidence,
    };
  }

  /** Connected components as lists of node ids, largest first. */
  components(): string[][] {
    const seen = new Set<string>();
    const out: string[][] = [];
    for (const start of this.nodes.keys()) {
      if (seen.has(start)) continue;
      const comp: string[] = [];
      const stack = [start];
      seen.add(start);
      while (stack.length > 0) {
        const n = stack.pop()!;
        comp.push(n);
        for (const { other } of this.incident(n)) {
          if (!seen.has(other) && this.nodes.has(other)) {
            seen.add(other);
            stack.push(other);
          }
        }
      }
      out.push(comp);
    }
    return out.sort((a, b) => b.length - a.length);
  }
}
