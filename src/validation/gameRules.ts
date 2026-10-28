import type {
  AreaCut,
  FringeEndpoint,
  GameRules,
  Infrastructure,
  PlayableArea,
  PointsGameRule,
} from "../model/index.ts";
import type { TrackGraph } from "../graph/trackGraph.ts";
import type { Issue, Severity } from "./validate.ts";

/**
 * Game-rule checks (game-rules.json, DATA_MODEL "Game rules", D-029). Only rules that pass
 * every check reach the context; an invalid rule is reported and then ignored, so the points
 * it would configure stay unresolved and a route over them is never clearable.
 */

export interface GameRuleContext {
  /** Valid points rules by Points id. */
  points: ReadonlyMap<string, PointsGameRule>;
  /** Valid fringe endpoints by id, with the cut each sits on. */
  fringes: ReadonlyMap<string, { endpoint: FringeEndpoint; cut: AreaCut }>;
}

export const NO_GAME_RULES: GameRuleContext = { points: new Map(), fringes: new Map() };

/** Most passages a slip of each type can have: two straight across plus its diagonals. */
const MAX_PASSAGES = { single_slip: 3, double_slip: 4 } as const;

export function resolveGameRules(
  infra: Infrastructure,
  graph: TrackGraph,
  rules: GameRules | undefined,
  playable: PlayableArea | undefined,
): { issues: Issue[]; context: GameRuleContext } {
  const issues: Issue[] = [];
  const add = (severity: Severity, code: string, message: string, ids: string[]) =>
    issues.push({ severity, code, message, ids });
  if (!rules) return { issues, context: NO_GAME_RULES };

  const pointsById = new Map(infra.points.map((p) => [p.id, p]));
  const points = new Map<string, PointsGameRule>();
  const configured = new Set<string>();
  for (const rule of rules.points) {
    const id = rule.pointsId;
    const invalid = (why: string) =>
      add("error", "GAME_RULE_POINTS_INVALID", `game rule for points ${id}: ${why}`, [id]);
    if (configured.has(id)) {
      invalid("configured more than once");
      points.delete(id);
      continue;
    }
    configured.add(id);
    const p = pointsById.get(id);
    if (!p) {
      add("error", "MISSING_REFERENCE", `gameRules.points -> unknown points "${id}"`, [id]);
      continue;
    }
    // A game rule fills an unknown; it never overrides or competes with a source fact.
    const stated = [p.normalTowardsNodeId, p.reverseTowardsNodeId].filter(
      (l) => l.value !== null || l.provenance.evidence !== "unknown",
    );
    if (stated.length > 0) {
      add(
        "error",
        "GAME_RULE_CONFLICTS_WITH_SOURCE",
        `game rule for points ${id}: the infrastructure already states a lie (${stated[0]!.provenance.evidence}); a game rule may only configure points whose lie is unknown`,
        [id],
      );
      continue;
    }
    const node = p.trackNodeId;
    const degree = graph.degree(node);
    const neighbours = graph.neighbours(node);
    if (graph.node(node)?.kind !== "switch") {
      invalid(`node ${node} is not a switch node`);
      continue;
    }
    if (neighbours.length !== degree) {
      invalid(`node ${node} has parallel edges, so a neighbour does not identify one leg`);
      continue;
    }
    if (rule.switchType === "simple") {
      if (p.switchType !== "simple" && p.switchType !== "unknown") {
        invalid(`configured simple, but the infrastructure says ${p.switchType}`);
        continue;
      }
      if (degree !== 3) {
        invalid(`simple points need a node with 3 edges; ${node} has ${degree}`);
        continue;
      }
      const legs = [rule.normalTowardsNodeId, rule.reverseTowardsNodeId];
      const off = legs.filter((n) => !graph.adjacent(node, n));
      if (off.length > 0) {
        invalid(`lie names ${off.join(", ")}, not adjacent to ${node}`);
        continue;
      }
      if (legs[0] === legs[1]) {
        invalid("normal and reverse name the same node");
        continue;
      }
    } else {
      // Slips: the slip type must be the sourced one; an untyped four-way node is not configured.
      if (p.switchType !== rule.switchType) {
        invalid(
          `configured ${rule.switchType}, but the infrastructure says ${p.switchType}; a slip rule needs the sourced slip type`,
        );
        continue;
      }
      if (degree !== 4) {
        invalid(`a slip needs a node with 4 edges; ${node} has ${degree}`);
        continue;
      }
      const pairs = new Set<string>();
      const problems: string[] = [];
      for (const { between } of rule.passages) {
        const [a, b] = between;
        if (a === b) problems.push(`passage ${a}-${b} starts and ends at the same node`);
        else if (!graph.adjacent(node, a) || !graph.adjacent(node, b))
          problems.push(`passage ${a}-${b} names a node not adjacent to ${node}`);
        const key = [a, b].sort().join("|");
        if (pairs.has(key)) problems.push(`passage ${a}-${b} is listed twice`);
        pairs.add(key);
      }
      if (rule.passages.length > MAX_PASSAGES[rule.switchType])
        problems.push(
          `${rule.passages.length} passages; a ${rule.switchType} has at most ${MAX_PASSAGES[rule.switchType]}`,
        );
      if (problems.length > 0) {
        invalid(problems.join("; "));
        continue;
      }
    }
    points.set(id, rule);
  }

  const cuts = new Map((playable?.cuts ?? []).map((c) => [c.id, c]));
  const fringes = new Map<string, { endpoint: FringeEndpoint; cut: AreaCut }>();
  const usedCuts = new Set<string>();
  for (const f of rules.fringeEndpoints) {
    const invalid = (why: string) =>
      add("error", "FRINGE_ENDPOINT_INVALID", `fringe endpoint ${f.id}: ${why}`, [f.id]);
    if (!playable) {
      invalid("the dataset has no playable-area.json, so there is no cut to stand on");
      continue;
    }
    const cut = cuts.get(f.cutId);
    if (!cut) {
      invalid(`unknown playable-area cut "${f.cutId}"`);
      continue;
    }
    if (usedCuts.has(f.cutId)) {
      invalid(`cut ${f.cutId} already has a fringe endpoint`);
      continue;
    }
    usedCuts.add(f.cutId);
    const e = graph.edge(cut.edgeId);
    const ends = e ? [e.from, e.to].sort().join("|") : null;
    if (ends !== [cut.insideNodeId, cut.outsideNodeId].sort().join("|")) {
      invalid(`cut ${cut.id}'s edge ${cut.edgeId} does not join its inside and outside nodes`);
      continue;
    }
    if (new Set(f.use).size !== f.use.length) {
      invalid("use lists a direction twice");
      continue;
    }
    fringes.set(f.id, { endpoint: f, cut });
  }

  return { issues, context: { points, fringes } };
}
