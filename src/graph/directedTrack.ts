import type { Infrastructure, LatLon } from "../model/index.ts";
import { TrackGraph } from "./trackGraph.ts";

/**
 * Direction-aware track reachability from edge GEOMETRY: a heuristic for consistency checks
 * (e.g. testing SMART berth steps against OSM), never evidence of a real connection or of
 * interlocking behaviour. Every route it returns carries `basis: "geometric_heuristic"`.
 *
 * Movement through a node depends on its junction class (TrackGraph.junction):
 * - plain: straight on. end: no exit.
 * - switch, or an untyped junction with three edges (rule "legs"): the two edges whose departure
 *   bearings are closest form the diverging pair and may not connect to each other;
 * - single_slip / double_slip (rule "legs"): straight across (the most nearly opposite edge)
 *   always; a double slip also allows the forward diagonals, because the sourced type states
 *   that all four routes exist; a single slip has exactly one diagonal and OSM does not say
 *   which, so its diagonals are forbidden unless `singleSlipDiagonals` is "allow";
 * - crossing, or an untyped junction with four or more edges (rule "legs"): straight on only;
 * - incomplete two-edge junction (a switch or crossing with a leg missing from the data):
 *   blocked under every rule, because whether the two mapped edges connect is unknown, unless
 *   `incompleteJunctions` is "allow".
 *
 * The two "allow" options exist only to REPORT that a movement depends on an unrecorded slip
 * diagonal or on incomplete topology (`singleSlipDiagonalsUsed`, `incompleteJunctionsUsed`).
 * They never make a movement supported.
 *
 * Rule "smooth" is a sensitivity test: at any node with three or more edges, a train may leave
 * by any edge whose departure bearing is more than 90 degrees from the edge it arrived on. It
 * admits slips and coincident switches that "legs" forbids, so a path found only under
 * "smooth" shows a heuristic limitation, not a real connection.
 */
export type JunctionRule = "legs" | "smooth";

export interface TrackRoute {
  distanceM: number;
  /** Node ids from the start node to the target, inclusive. */
  nodes: string[];
  basis: "geometric_heuristic";
}

export interface DirectedTrackOptions {
  singleSlipDiagonals?: "forbid" | "allow";
  incompleteJunctions?: "forbid" | "allow";
}

const bearing = (a: LatLon, b: LatLon) => {
  const k = Math.cos((a.lat * Math.PI) / 180);
  return Math.atan2(b.lat - a.lat, (b.lon - a.lon) * k);
};
const angleDiff = (x: number, y: number) => {
  const d = Math.abs(x - y) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
};

type Out = { edge: string; to: string; bearing: number; lengthM: number };

export class DirectedTrack {
  readonly graph: TrackGraph;
  private readonly out = new Map<string, Out[]>();
  private readonly singleSlipDiagonals: "forbid" | "allow";
  private readonly incompleteJunctions: "forbid" | "allow";

  constructor(
    infra: Pick<Infrastructure, "nodes" | "edges"> & Partial<Pick<Infrastructure, "points">>,
    private readonly rule: JunctionRule = "legs",
    options: DirectedTrackOptions = {},
  ) {
    this.graph = new TrackGraph(infra);
    this.singleSlipDiagonals = options.singleSlipDiagonals ?? "forbid";
    this.incompleteJunctions = options.incompleteJunctions ?? "forbid";
    const pos = new Map(infra.nodes.map((n) => [n.id, n.position]));
    for (const e of infra.edges) {
      const g = e.geometry ?? [pos.get(e.from)!, pos.get(e.to)!];
      if (g.length < 2) continue;
      const add = (from: string, to: string, a: LatLon, b: LatLon) =>
        this.out.set(from, [
          ...(this.out.get(from) ?? []),
          { edge: e.id, to, bearing: bearing(a, b), lengthM: e.lengthM ?? 0 },
        ]);
      add(e.from, e.to, g[0]!, g[1]!);
      add(e.to, e.from, g.at(-1)!, g.at(-2)!);
    }
  }

  /** Edges a train arriving at `node` over `viaEdge` may leave by. */
  private exits(node: string, viaEdge: string): Out[] {
    const all = this.out.get(node) ?? [];
    const others = all.filter((x) => x.edge !== viaEdge);
    const arrival = all.find((x) => x.edge === viaEdge);
    if (!arrival) return others;
    const j = this.graph.junction(node);
    if (j.reason === "two_edge_junction" && this.incompleteJunctions === "forbid") return [];
    if (others.length <= 1) return others;
    if (this.rule === "smooth")
      return others.filter((x) => angleDiff(x.bearing, arrival.bearing) > Math.PI / 2);
    if ((j.cls === "single_slip" || j.cls === "double_slip") && all.length === 4) {
      const straight = this.straightOn(others, arrival.bearing);
      const diagonals = others.filter(
        (x) => x !== straight && angleDiff(x.bearing, arrival.bearing) > Math.PI / 2,
      );
      return j.cls === "double_slip" || this.singleSlipDiagonals === "allow"
        ? [straight, ...diagonals]
        : [straight];
    }
    if (all.length === 3) {
      // Diverging pair = the two edges with the smallest bearing difference.
      const pairs: [number, number][] = [
        [0, 1],
        [0, 2],
        [1, 2],
      ];
      const [i, k] = pairs.sort(
        (p, q) =>
          angleDiff(all[p[0]]!.bearing, all[p[1]]!.bearing) -
          angleDiff(all[q[0]]!.bearing, all[q[1]]!.bearing),
      )[0]!;
      const legs = new Set([all[i]!.edge, all[k]!.edge]);
      return legs.has(viaEdge) ? others.filter((x) => !legs.has(x.edge)) : others;
    }
    // Four or more edges with no slip type, or a crossing: straight on only.
    return [this.straightOn(others, arrival.bearing)];
  }

  private straightOn<T extends { bearing: number }>(others: T[], arrivalBearing: number): T {
    return [...others].sort(
      (x, y) => angleDiff(y.bearing, arrivalBearing) - angleDiff(x.bearing, arrivalBearing),
    )[0]!;
  }

  /** Single-slip nodes on `route` where it takes a diagonal rather than going straight across. */
  singleSlipDiagonalsUsed(route: TrackRoute): string[] {
    const used: string[] = [];
    for (let i = 1; i < route.nodes.length - 1; i++) {
      const node = route.nodes[i]!;
      if (this.graph.junction(node).cls !== "single_slip") continue;
      const all = this.out.get(node) ?? [];
      const arrival = all.find((x) => x.to === route.nodes[i - 1]);
      const leave = all.find((x) => x.to === route.nodes[i + 1]);
      if (!arrival || !leave || all.length !== 4) continue;
      const straight = this.straightOn(
        all.filter((x) => x !== arrival),
        arrival.bearing,
      );
      if (leave !== straight) used.push(node);
    }
    return used;
  }

  /** Incomplete two-edge junctions that `route` passes through. */
  incompleteJunctionsUsed(route: TrackRoute): string[] {
    return route.nodes
      .slice(1, -1)
      .filter((n) => this.graph.junction(n).reason === "two_edge_junction");
  }

  /**
   * Shortest no-reversal distance from `start`, leaving towards `firstStep`, to `target`,
   * arriving from the side opposite `targetFacing` (i.e. approaching the target signal from
   * behind, as a train passing it would). Returns metres or null if unreachable within maxM.
   */
  distance(
    start: string,
    firstStep: string,
    target: string,
    targetFacing: string | null,
    maxM = 6000,
  ): number | null {
    return this.route(start, firstStep, target, targetFacing, maxM)?.distanceM ?? null;
  }

  /**
   * As `distance`, but also returns the nodes passed, for evidence reporting. With
   * `headOn` true, only an arrival from the target's facing side counts (meeting it head-on).
   */
  route(
    start: string,
    firstStep: string,
    target: string,
    targetFacing: string | null,
    maxM = 6000,
    headOn = false,
  ): TrackRoute | null {
    const first = (this.out.get(start) ?? []).find((x) => x.to === firstStep);
    if (!first) return null;
    const best = new Map<string, number>();
    type Item = { node: string; via: string; from: string; d: number; path: string[] };
    const queue: Item[] = [
      { node: first.to, via: first.edge, from: start, d: first.lengthM, path: [start, first.to] },
    ];
    while (queue.length > 0) {
      queue.sort((a, b) => a.d - b.d);
      const cur = queue.shift()!;
      if (cur.d > maxM) return null;
      if (cur.node === target) {
        // Arriving from the facing side would mean meeting the signal head-on.
        const fromFacingSide = targetFacing !== null && cur.from === targetFacing;
        if (headOn ? fromFacingSide : !fromFacingSide)
          return {
            distanceM: Math.round(cur.d),
            nodes: cur.path,
            basis: "geometric_heuristic",
          };
      }
      const key = `${cur.node}|${cur.via}`;
      if ((best.get(key) ?? Infinity) <= cur.d) continue;
      best.set(key, cur.d);
      for (const x of this.exits(cur.node, cur.via))
        queue.push({
          node: x.to,
          via: x.edge,
          from: cur.node,
          d: cur.d + x.lengthM,
          path: [...cur.path, x.to],
        });
    }
    return null;
  }
}
