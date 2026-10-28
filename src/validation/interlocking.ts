import type {
  Infrastructure,
  Points,
  PointsRequirement,
  Provenance,
  Route,
  Signal,
  Signalling,
  SourceRegistry,
} from "../model/index.ts";
import type { TrackGraph } from "../graph/trackGraph.ts";
import type { Issue, Severity } from "./validate.ts";
import { NO_GAME_RULES, type GameRuleContext } from "./gameRules.ts";

/**
 * Interlocking data invariants (docs/DATA_MODEL.md "Interlocking validation", D-024).
 *
 * These checks test that route and overlap data agree with the infrastructure model and are
 * honestly evidenced. They do not show that a real interlocking is safe. Only evidenced facts
 * are used: an unknown points lie or signal direction gives `insufficient_evidence`, never a
 * pass, and the geometric switch-leg heuristic in src/reconcile/ is deliberately not used.
 *
 * Game rules (game-rules.json, D-029) may stand in for an unknown points lie and for a signal at
 * the edge of play. A route or overlap that relies on one is at best `game_rule`, never
 * `evidenced`, and only rules that passed resolveGameRules are used.
 */

/** Worst first. See the status table in docs/DATA_MODEL.md. */
export type InterlockingStatus = "invalid" | "insufficient_evidence" | "game_rule" | "evidenced";

export interface InterlockingAssessment {
  kind: "route" | "overlap";
  id: string;
  status: InterlockingStatus;
  /** The issues that decided the status, plus the provenance reason when there are none. */
  reasons: string[];
}

/** Warning codes meaning "cannot be established from the model", not "contradicted". */
export const INSUFFICIENT_EVIDENCE_CODES = new Set([
  "ROUTE_DIRECTION_UNKNOWN",
  "ROUTE_SWITCH_UNRESOLVED",
  "ROUTE_DEPENDS_ON_INFERRED",
  "ROUTE_CONFLICT_UNDETERMINED",
]);

const RANK: Record<InterlockingStatus, number> = {
  invalid: 0,
  insufficient_evidence: 1,
  game_rule: 2,
  evidenced: 3,
};
const worse = (a: InterlockingStatus, b: InterlockingStatus) => (RANK[a] <= RANK[b] ? a : b);

/** A fact counts as established only when stated with sourced or verified evidence. */
const established = (p: Provenance) => p.evidence === "sourced" || p.evidence === "verified";
/** A value that is present but rests on reasoning or a stand-in. */
const weak = (p: Provenance) => p.evidence === "inferred" || p.evidence === "placeholder";

/** A direction usable for checks: null when absent or labelled unknown. */
function direction(s: Signal): { towards: string | null; weak: boolean } {
  const f = s.facingTowardsNodeId;
  if (f.value === null || f.provenance.evidence === "unknown")
    return { towards: null, weak: false };
  return { towards: f.value, weak: weak(f.provenance) };
}

interface Walked {
  kind: "route" | "overlap";
  id: string;
  nodes: string[];
  edgeIds: string[];
  pointsRequired: PointsRequirement[];
}

export function assessInterlocking(
  infra: Infrastructure,
  signalling: Signalling | undefined,
  sources: SourceRegistry,
  graph: TrackGraph,
  rules: GameRuleContext = NO_GAME_RULES,
): { issues: Issue[]; assessments: InterlockingAssessment[] } {
  const issues: Issue[] = [];
  const findings = new Map<string, Issue[]>();
  /** Game rules each route or overlap relies on (D-029): caps its status at game_rule. */
  const gameRuleUse = new Map<string, string[]>();
  const usesGameRule = (owner: string, what: string) =>
    gameRuleUse.set(owner, [...(gameRuleUse.get(owner) ?? []), what]);
  const add = (severity: Severity, code: string, message: string, owner: string, ids: string[]) => {
    const issue: Issue = { severity, code, message, ids: [owner, ...ids] };
    issues.push(issue);
    const list = findings.get(owner) ?? [];
    list.push(issue);
    findings.set(owner, list);
  };
  if (!signalling) return { issues, assessments: [] };

  const signalById = new Map(infra.signals.map((s) => [s.id, s]));
  const pointsById = new Map(infra.points.map((p) => [p.id, p]));
  const overlapById = new Map(signalling.overlaps.map((o) => [o.id, o]));
  const authority = new Set(
    sources.sources.filter((s) => s.interlockingAuthority).map((s) => s.id),
  );

  /** P5/P6/P7: passage through one interior node, from `from` to `to`. */
  function checkPassage(w: Walked, from: string, node: string, to: string) {
    const label = `${w.kind} ${w.id}`;
    const passage = graph.switchPassage(from, node, to, rules.points);
    if (passage.status === "through") return;
    const p = passage.points;
    const req = p && w.pointsRequired.find((q) => q.pointsId === p.id && q.role === "path");
    if (p && !req) {
      add(
        "error",
        "ROUTE_POINTS_UNSPECIFIED",
        `${label} passes points ${p.id} without a required position`,
        w.id,
        [p.id],
      );
    }
    if (passage.status === "unresolved") {
      add(
        "warning",
        "ROUTE_SWITCH_UNRESOLVED",
        `${label} passes ${node}: ${passage.why}; the passage cannot be checked`,
        w.id,
        [node],
      );
      return;
    }
    if (passage.status === "leg_to_leg") {
      add(
        "error",
        "ROUTE_SWITCH_UNSUPPORTED",
        `${label} runs leg to leg through points ${passage.points.id} (${from} -> ${to}) without using the toe ${passage.toe}`,
        w.id,
        [passage.points.id],
      );
      return;
    }
    if (req && req.position !== passage.position) {
      add(
        "error",
        "ROUTE_POINTS_MISMATCH",
        `${label} requires points ${passage.points.id} ${req.position} but its path takes the ${passage.position} leg`,
        w.id,
        [passage.points.id],
      );
    }
    if (passage.evidence === "simplified") {
      usesGameRule(w.id, `game-rule lie of points ${passage.points.id} (simplified)`);
    } else if (passage.evidence !== "sourced" && passage.evidence !== "verified") {
      add(
        "warning",
        "ROUTE_DEPENDS_ON_INFERRED",
        `${label} relies on the lie of points ${passage.points.id}, which is only ${passage.evidence}`,
        w.id,
        [passage.points.id],
      );
    }
  }

  /** P3/P4: requirements name points on (path) or off (flank) the path, each once. */
  function checkRequirements(w: Walked) {
    const label = `${w.kind} ${w.id}`;
    const onPath = new Set(w.nodes);
    const seen = new Map<string, string>();
    for (const q of w.pointsRequired) {
      const prev = seen.get(q.pointsId);
      if (prev && prev !== q.position) {
        add(
          "error",
          "ROUTE_POINTS_MISMATCH",
          `${label} requires points ${q.pointsId} both normal and reverse`,
          w.id,
          [q.pointsId],
        );
      }
      seen.set(q.pointsId, q.position);
      const p = pointsById.get(q.pointsId);
      if (!p) continue; // MISSING_REFERENCE
      if (q.role === "path" && !onPath.has(p.trackNodeId)) {
        add(
          "error",
          w.kind === "route" ? "IMPOSSIBLE_ROUTE" : "IMPOSSIBLE_OVERLAP",
          `${label}: requires points ${p.id}, which are not on its path (mark flank protection as role "flank")`,
          w.id,
          [p.id],
        );
      }
      if (q.role === "flank" && onPath.has(p.trackNodeId)) {
        add(
          "error",
          w.kind === "route" ? "IMPOSSIBLE_ROUTE" : "IMPOSSIBLE_OVERLAP",
          `${label}: flank points ${p.id} lie on its own path`,
          w.id,
          [p.id],
        );
      }
    }
  }

  /** P1: contiguous, from `start`, no node visited twice. */
  function walkPath(
    kind: "route" | "overlap",
    id: string,
    start: string,
    edgeIds: string[],
    pointsRequired: PointsRequirement[],
  ): Walked | null {
    const code = kind === "route" ? "IMPOSSIBLE_ROUTE" : "IMPOSSIBLE_OVERLAP";
    const walk = graph.walk(start, edgeIds);
    if (!walk.ok) {
      add("error", code, `${kind} ${id}: ${walk.reason}`, id, []);
      return null;
    }
    if (new Set(walk.nodes).size !== walk.nodes.length) {
      add("error", code, `${kind} ${id}: path visits a node twice`, id, []);
      return null;
    }
    return { kind, id, nodes: walk.nodes, edgeIds, pointsRequired };
  }

  /** E1: sourced/verified interlocking data must cite a source that can establish it. */
  function checkProvenance(kind: "route" | "overlap", id: string, p: Provenance) {
    if (!established(p)) return;
    const able = new Set(p.sources.map((s) => s.sourceId).filter((s) => authority.has(s)));
    const need = p.evidence === "verified" ? 2 : 1;
    if (able.size < need) {
      add(
        "error",
        "INTERLOCKING_SOURCE_UNSUITABLE",
        `${kind} ${id} is ${p.evidence} but cites ${need === 2 ? "fewer than two distinct sources" : "no source"} able to establish interlocking (interlockingAuthority); track layout and train movements do not`,
        id,
        p.sources.map((s) => s.sourceId),
      );
    }
  }

  // --- overlaps ---
  const overlapPaths = new Map<string, Walked>();
  for (const o of signalling.overlaps) {
    checkProvenance("overlap", o.id, o.provenance);
    const s = signalById.get(o.signalId);
    if (!s) continue; // MISSING_REFERENCE
    if (!s.trackNodeId) {
      add(
        "error",
        "IMPOSSIBLE_OVERLAP",
        `overlap ${o.id}: signal is not on the track graph`,
        o.id,
        [s.id],
      );
      continue;
    }
    const w = walkPath("overlap", o.id, s.trackNodeId, o.edgeIds, o.pointsRequired);
    if (!w) continue;
    overlapPaths.set(o.id, w);
    const dir = direction(s); // S4
    if (dir.towards === null) {
      add(
        "warning",
        "ROUTE_DIRECTION_UNKNOWN",
        `overlap ${o.id}: direction of signal ${s.id} is unknown`,
        o.id,
        [s.id],
      );
    } else if (dir.towards !== w.nodes[1]) {
      add(
        "error",
        "IMPOSSIBLE_OVERLAP",
        `overlap ${o.id} runs towards ${w.nodes[1]}, behind signal ${s.id} (which faces ${dir.towards})`,
        o.id,
        [s.id],
      );
    } else if (dir.weak) {
      add(
        "warning",
        "ROUTE_DEPENDS_ON_INFERRED",
        `overlap ${o.id} relies on an inferred direction of signal ${s.id}`,
        o.id,
        [s.id],
      );
    }
    checkRequirements(w);
    for (let i = 1; i < w.nodes.length - 1; i++)
      checkPassage(w, w.nodes[i - 1]!, w.nodes[i]!, w.nodes[i + 1]!);
  }

  // --- routes ---
  const routePaths = new Map<string, Walked>();
  for (const r of signalling.routes) {
    checkProvenance("route", r.id, r.provenance);
    const entry = r.entrySignalId === null ? null : signalById.get(r.entrySignalId);
    const exit = r.exitSignalId === null ? null : signalById.get(r.exitSignalId);
    if (entry === undefined || exit === undefined) continue; // MISSING_REFERENCE
    // F1-F3: a fringe end must name a valid endpoint configured for that use (D-029).
    const fringe = (end: "entry" | "exit", id: string | undefined) => {
      if (id === undefined) return null;
      const f = rules.fringes.get(id);
      if (!f)
        add(
          "error",
          "FRINGE_ENDPOINT_INVALID",
          `route ${r.id}: ${end} fringe endpoint "${id}" is not a valid configured endpoint`,
          r.id,
          [id],
        );
      else if (!f.endpoint.use.includes(end))
        add(
          "error",
          "FRINGE_ENDPOINT_INVALID",
          `route ${r.id}: fringe endpoint ${id} is not configured for ${end}`,
          r.id,
          [id],
        );
      else return f;
      return undefined;
    };
    const entryFringe = fringe("entry", r.entryFringeId);
    const exitFringe = fringe("exit", r.exitFringeId);
    if (entryFringe === undefined || exitFringe === undefined) continue;
    if ((entry && !entry.trackNodeId) || (exit && !exit.trackNodeId)) {
      add(
        "error",
        "IMPOSSIBLE_ROUTE",
        `route ${r.id}: entry or exit signal is not on the track graph`,
        r.id,
        [],
      );
      continue;
    }
    if (entry && exit && entry.id === exit.id) {
      add(
        "error",
        "IMPOSSIBLE_ROUTE",
        `route ${r.id}: entry and exit are the same signal`,
        r.id,
        [],
      );
      continue;
    }
    // A fringe entry starts outside the cut and crosses the cut edge first.
    const start = entry ? entry.trackNodeId! : entryFringe!.cut.outsideNodeId;
    const w = walkPath("route", r.id, start, r.edgeIds, r.pointsRequired);
    if (!w) continue;
    const end = w.nodes.at(-1)!;
    if (entryFringe && r.edgeIds[0] !== entryFringe.cut.edgeId) {
      add(
        "error",
        "IMPOSSIBLE_ROUTE",
        `route ${r.id}: starts at fringe ${entryFringe.endpoint.id} but does not cross cut edge ${entryFringe.cut.edgeId} first`,
        r.id,
        [],
      );
      continue;
    }
    const target = exit ? exit.trackNodeId! : exitFringe!.cut.outsideNodeId;
    if (end !== target || (exitFringe && r.edgeIds.at(-1) !== exitFringe.cut.edgeId)) {
      add(
        "error",
        "IMPOSSIBLE_ROUTE",
        exit
          ? `route ${r.id}: path ends at ${end}, not at exit signal ${exit.id}`
          : `route ${r.id}: path does not end by crossing cut edge ${exitFringe!.cut.edgeId} to ${target}`,
        r.id,
        [],
      );
      continue;
    }
    routePaths.set(r.id, w);
    for (const f of [entryFringe, exitFringe])
      if (f) usesGameRule(r.id, `fringe endpoint ${f.endpoint.id} at cut ${f.cut.id} (simplified)`);

    // S2: the entry signal faces along the path. A fringe entry has no signal to check.
    if (entry) {
      const din = direction(entry);
      if (din.towards === null) {
        add(
          "warning",
          "ROUTE_DIRECTION_UNKNOWN",
          `route ${r.id}: direction of entry signal ${entry.id} is unknown`,
          r.id,
          [entry.id],
        );
      } else if (din.towards !== w.nodes[1]) {
        add(
          "error",
          "IMPOSSIBLE_ROUTE",
          `route ${r.id}: entry signal ${entry.id} faces the other way`,
          r.id,
          [entry.id],
        );
      } else if (din.weak) {
        add(
          "warning",
          "ROUTE_DEPENDS_ON_INFERRED",
          `route ${r.id} relies on an inferred direction of entry signal ${entry.id}`,
          r.id,
          [entry.id],
        );
      }
    }
    // S3: the exit signal faces onward, not back along the route. A fringe exit has none.
    if (exit) {
      const dout = direction(exit);
      if (dout.towards === null) {
        add(
          "warning",
          "ROUTE_DIRECTION_UNKNOWN",
          `route ${r.id}: direction of exit signal ${exit.id} is unknown`,
          r.id,
          [exit.id],
        );
      } else if (dout.towards === w.nodes.at(-2)) {
        add(
          "error",
          "IMPOSSIBLE_ROUTE",
          `route ${r.id}: exit signal ${exit.id} faces back along the route`,
          r.id,
          [exit.id],
        );
      } else if (dout.weak) {
        add(
          "warning",
          "ROUTE_DEPENDS_ON_INFERRED",
          `route ${r.id} relies on an inferred direction of exit signal ${exit.id}`,
          r.id,
          [exit.id],
        );
      }
    }

    checkRequirements(w);
    for (let i = 1; i < w.nodes.length - 1; i++)
      checkPassage(w, w.nodes[i - 1]!, w.nodes[i]!, w.nodes[i + 1]!);

    // O2: the overlap belongs to the exit signal and continues beyond it.
    const o = r.overlapId ? overlapById.get(r.overlapId) : undefined;
    if (o && (!exit || o.signalId !== exit.id)) {
      add(
        "error",
        "IMPOSSIBLE_ROUTE",
        `route ${r.id}: overlap ${o.id} belongs to ${o.signalId}, not exit signal ${exit?.id ?? "(none: fringe exit)"}`,
        r.id,
        [o.id],
      );
    } else if (o && o.edgeIds[0] === r.edgeIds.at(-1)) {
      add(
        "error",
        "IMPOSSIBLE_ROUTE",
        `route ${r.id}: overlap ${o.id} doubles back over the route's last edge`,
        r.id,
        [o.id],
      );
    } else if (o && graph.node(end)?.kind === "switch") {
      add(
        "warning",
        "ROUTE_SWITCH_UNRESOLVED",
        `route ${r.id}: exit signal ${exit?.id} stands on switch ${end}; the passage into overlap ${o.id} cannot be checked`,
        r.id,
        [end],
      );
    }
  }

  // --- conflicts ---
  checkConflicts(signalling.routes, routePaths, pointsById, graph, add);

  for (const [owner, what] of gameRuleUse)
    add(
      "info",
      "ROUTE_USES_GAME_RULE",
      `${owner} relies on ${what.join(", ")}: a game rule, not a real-world claim`,
      owner,
      [],
    );

  // --- statuses ---
  const statusOf = (
    kind: "route" | "overlap",
    id: string,
    provenance: Provenance,
  ): InterlockingAssessment => {
    const own = findings.get(id) ?? [];
    const errors = own.filter((i) => i.severity === "error");
    const gaps = own.filter((i) => INSUFFICIENT_EVIDENCE_CODES.has(i.code));
    if (errors.length > 0)
      return { kind, id, status: "invalid", reasons: errors.map((i) => i.message) };
    if (gaps.length > 0)
      return { kind, id, status: "insufficient_evidence", reasons: gaps.map((i) => i.message) };
    const ev = provenance.evidence;
    const gameRules = gameRuleUse.get(id) ?? [];
    // Relying on a game rule never yields evidenced, whatever the route's own label says.
    if (gameRules.length > 0 && ev !== "placeholder" && ev !== "unknown")
      return {
        kind,
        id,
        status: "game_rule",
        reasons: [`relies on ${gameRules.join(", ")}`, `labelled ${ev}`],
      };
    if (ev === "inferred" || ev === "simplified")
      return { kind, id, status: "game_rule", reasons: [`labelled ${ev}: ${provenance.note}`] };
    if (ev === "placeholder" || ev === "unknown")
      return {
        kind,
        id,
        status: "insufficient_evidence",
        reasons: [`labelled ${ev}${provenance.note ? `: ${provenance.note}` : ""}`],
      };
    return { kind, id, status: "evidenced", reasons: [`${ev} from an interlocking source`] };
  };
  const overlapStatus = new Map(
    signalling.overlaps.map((o) => [o.id, statusOf("overlap", o.id, o.provenance)]),
  );
  const routeStatus = signalling.routes.map((r) => {
    const a = statusOf("route", r.id, r.provenance);
    const o = r.overlapId ? overlapStatus.get(r.overlapId) : undefined;
    // A route is no better established than the overlap it relies on.
    if (o && RANK[o.status] < RANK[a.status]) {
      return {
        ...a,
        status: worse(a.status, o.status),
        reasons: [...a.reasons, `overlap ${o.id} is ${o.status}`],
      };
    }
    return a;
  });
  return { issues, assessments: [...routeStatus, ...overlapStatus.values()] };
}

/** C1-C4. */
function checkConflicts(
  routes: Route[],
  paths: Map<string, Walked>,
  pointsById: Map<string, Points>,
  graph: TrackGraph,
  add: (severity: Severity, code: string, message: string, owner: string, ids: string[]) => void,
) {
  const byId = new Map(routes.map((r) => [r.id, r]));
  for (const r of routes) {
    for (const c of new Set(r.conflictsWith)) {
      if (c === r.id) {
        add(
          "error",
          "ROUTE_CONFLICT_INVALID",
          `route ${r.id} lists itself as a conflict`,
          r.id,
          [],
        );
        continue;
      }
      const other = byId.get(c);
      if (other && !other.conflictsWith.includes(r.id)) {
        add(
          "error",
          "ROUTE_CONFLICT_ASYMMETRIC",
          `route ${r.id} conflicts with ${c}, but ${c} does not list ${r.id}`,
          r.id,
          [c],
        );
      }
    }
  }
  const junction = (n: string) => {
    const k = graph.node(n)?.kind;
    return k === "switch" || k === "crossing";
  };
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const a = routes[i]!;
      const b = routes[j]!;
      const pa = paths.get(a.id);
      const pb = paths.get(b.id);
      const declared = a.conflictsWith.includes(b.id) || b.conflictsWith.includes(a.id);
      if (declared) continue;
      const reasons: string[] = [];
      if (pa && pb) {
        const shared = pa.edgeIds.filter((e) => pb.edgeIds.includes(e));
        if (shared.length > 0) reasons.push(`share track ${shared.join(", ")}`);
      }
      for (const qa of a.pointsRequired) {
        const qb = b.pointsRequired.find((q) => q.pointsId === qa.pointsId);
        if (qb && qb.position !== qa.position && pointsById.has(qa.pointsId))
          reasons.push(`require points ${qa.pointsId} ${qa.position} and ${qb.position}`);
      }
      if (reasons.length > 0) {
        for (const [owner, other] of [
          [a.id, b.id],
          [b.id, a.id],
        ] as const) {
          add(
            "error",
            "ROUTE_CONFLICT_MISSING",
            `routes ${a.id} and ${b.id} ${reasons.join("; ")} but are not declared conflicting`,
            owner,
            [other],
          );
        }
        continue;
      }
      if (!pa || !pb) continue;
      const nodesB = new Set(pb.nodes);
      const common = pa.nodes.filter((n) => nodesB.has(n) && junction(n));
      if (common.length > 0) {
        for (const [owner, other] of [
          [a.id, b.id],
          [b.id, a.id],
        ] as const) {
          add(
            "warning",
            "ROUTE_CONFLICT_UNDETERMINED",
            `routes ${a.id} and ${b.id} both pass ${common.join(", ")} without sharing track; whether they foul each other is not modelled, and they are not declared conflicting`,
            owner,
            [other],
          );
        }
      }
    }
  }
}
