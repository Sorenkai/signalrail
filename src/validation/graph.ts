import type { Infrastructure, TrackNode } from "../model/index.ts";

export type WalkResult = { ok: true; nodes: string[] } | { ok: false; reason: string };

/** Undirected adjacency view of the track graph. Edges may be traversed in either direction. */
export class TrackGraph {
  private readonly nodes = new Map<string, TrackNode>();
  private readonly incident = new Map<string, { edgeId: string; other: string }[]>();
  private readonly edgeEnds = new Map<string, [string, string]>();

  constructor(infra: Pick<Infrastructure, "nodes" | "edges">) {
    for (const n of infra.nodes) {
      this.nodes.set(n.id, n);
      this.incident.set(n.id, []);
    }
    for (const e of infra.edges) {
      this.edgeEnds.set(e.id, [e.from, e.to]);
      this.incident.get(e.from)?.push({ edgeId: e.id, other: e.to });
      this.incident.get(e.to)?.push({ edgeId: e.id, other: e.from });
    }
  }

  node(id: string) {
    return this.nodes.get(id);
  }

  degree(id: string) {
    return this.incident.get(id)?.length ?? 0;
  }

  adjacent(a: string, b: string) {
    return this.incident.get(a)?.some((i) => i.other === b) ?? false;
  }

  /** Follows edgeIds from start; each edge must touch the node reached so far. */
  walk(start: string, edgeIds: string[]): WalkResult {
    const nodes = [start];
    let at = start;
    for (const id of edgeIds) {
      const ends = this.edgeEnds.get(id);
      if (!ends) return { ok: false, reason: `unknown edge ${id}` };
      const [a, b] = ends;
      if (a === at) at = b;
      else if (b === at) at = a;
      else return { ok: false, reason: `edge ${id} does not continue from node ${at}` };
      nodes.push(at);
    }
    return { ok: true, nodes };
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
        for (const { other } of this.incident.get(n) ?? []) {
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
