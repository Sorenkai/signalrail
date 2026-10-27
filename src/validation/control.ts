import type { Control, Infrastructure, PlayableArea, Provenance } from "../model/index.ts";
import type { TrackGraph } from "../graph/trackGraph.ts";
import type { Issue, Severity } from "./validate.ts";

/**
 * Control-area checks (DATA_MODEL "Control areas", D-027): references, membership consistency,
 * and the separation of real-world claims, game-design choices and unresolved items.
 * Duplicate ids and the existing CONTROL_OVERLAP / UNSUPPORTED_ASSUMPTION checks stay in
 * validate.ts.
 */

const factual = (p: Provenance) => p.evidence === "sourced" || p.evidence === "verified";

/** Track nodes inside play: reached from the cuts' inside nodes without crossing a cut edge. */
export function nodesInPlay(graph: TrackGraph, playable: PlayableArea): Set<string> {
  const cutEdges = new Set(playable.cuts.map((c) => c.edgeId));
  const seen = new Set<string>();
  const stack = playable.cuts.map((c) => c.insideNodeId);
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seen.has(n) || !graph.node(n)) continue;
    seen.add(n);
    for (const i of graph.incident(n)) if (!cutEdges.has(i.edgeId)) stack.push(i.other);
  }
  return seen;
}

export function validateControl(
  control: Control | undefined,
  infra: Infrastructure,
  graph: TrackGraph,
  playable: PlayableArea | undefined,
): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Severity, code: string, message: string, ids?: string[]) =>
    issues.push({ severity, code, message, ...(ids ? { ids } : {}) });
  if (!control) return issues;

  const centres = new Set((control.controlCentres ?? []).map((c) => c.id));
  const areas = new Set(control.areas.map((a) => a.id));
  const external = new Set((control.externalAreas ?? []).map((x) => x.id));
  const locations = new Set(infra.locations.map((l) => l.id));
  const platforms = new Set(infra.platforms.map((p) => p.id));
  const signals = new Set(infra.signals.map((s) => s.id));
  const cuts = new Map((playable?.cuts ?? []).map((c) => [c.id, c]));
  const missing = (owner: string, field: string, id: string) =>
    add("error", "MISSING_REFERENCE", `${owner}.${field} -> unknown "${id}"`, [owner, id]);

  // --- control centres: real-world facts only ---
  for (const c of control.controlCentres ?? []) {
    if (c.locationId && !locations.has(c.locationId)) missing(c.id, "locationId", c.locationId);
    const claims = {
      operationalStatus: c.operationalStatus,
      controlMethod: c.controlMethod,
      methodsOfWorking: c.methodsOfWorking,
      signallingPrinciples: c.signallingPrinciples,
      extent: c.extent,
    };
    const unknown = Object.entries(claims)
      .filter(([, v]) => v.provenance.evidence === "unknown")
      .map(([k]) => k);
    if (unknown.length > 0)
      add("info", "CONTROL_CENTRE_UNKNOWN", `${c.id} (${c.name}): unknown ${unknown.join(", ")}`, [
        c.id,
      ]);
  }

  // --- control areas ---
  for (const a of control.areas) {
    if (a.signalBoxLocationId && !locations.has(a.signalBoxLocationId))
      missing(a.id, "signalBoxLocationId", a.signalBoxLocationId);
    for (const p of a.platformIds ?? []) if (!platforms.has(p)) missing(a.id, "platformIds", p);
    const cc = a.controlCentre?.value;
    if (cc && !centres.has(cc)) missing(a.id, "controlCentre", cc);
    if (a.basis === "game_design") {
      for (const [field, p] of [
        ["provenance", a.provenance],
        ["membershipProvenance", a.membershipProvenance],
      ] as const)
        if (factual(p))
          add(
            "error",
            "GAME_DESIGN_AS_FACT",
            `control area ${a.id} is a game-design area, but its ${field} is ${p.evidence}: a design decision is not a sourced fact`,
            [a.id],
          );
    }
  }

  // --- external areas ---
  for (const x of control.externalAreas ?? []) {
    const cc = x.controlCentre.value;
    if (cc && !centres.has(cc)) missing(x.id, "controlCentre", cc);
  }

  // --- boundaries ---
  const incomplete: string[] = [];
  for (const b of control.boundaries) {
    if (!areas.has(b.fromAreaId) && !external.has(b.fromAreaId))
      missing(b.id, "fromAreaId", b.fromAreaId);
    if (!areas.has(b.toAreaId) && !external.has(b.toAreaId)) missing(b.id, "toAreaId", b.toAreaId);
    if (!areas.has(b.fromAreaId) && !areas.has(b.toAreaId))
      add(
        "error",
        "BOUNDARY_INCONSISTENT",
        `boundary ${b.id} joins two areas the game does not control`,
        [b.id],
      );
    for (const s of b.boundarySignalIds?.value ?? [])
      if (!signals.has(s)) missing(b.id, "boundarySignalIds", s);
    if (b.cutId) {
      const cut = cuts.get(b.cutId);
      if (!cut) missing(b.id, "cutId", b.cutId);
      else if (cut.edgeId !== b.edgeId)
        add(
          "error",
          "BOUNDARY_INCONSISTENT",
          `boundary ${b.id} is on ${b.edgeId}, but cut ${b.cutId} is on ${cut.edgeId}`,
          [b.id],
        );
    }
    // Unresolved items must not be presented as established.
    const open = [
      ...(b.unresolved ?? []),
      ...(b.boundarySignalIds?.provenance.evidence === "unknown" ? ["boundary signals"] : []),
      ...(b.trafficDirections?.provenance.evidence === "unknown" ? ["traffic directions"] : []),
      ...(b.handover === null ? ["handover"] : []),
    ];
    if (b.status === "complete" && open.length > 0)
      add(
        "error",
        "BOUNDARY_UNRESOLVED_AS_COMPLETE",
        `boundary ${b.id} is marked complete but leaves ${open.join(", ")} unresolved`,
        [b.id],
      );
    if (factual(b.provenance) && (open.length > 0 || b.status !== "complete"))
      add(
        "error",
        "BOUNDARY_UNRESOLVED_AS_COMPLETE",
        `boundary ${b.id} is labelled ${b.provenance.evidence} but is not complete (${open.join(", ") || "status not complete"})`,
        [b.id],
      );
    if (b.status === "incomplete") incomplete.push(b.id);
  }

  if (incomplete.length > 0)
    add(
      "info",
      "BOUNDARY_INCOMPLETE",
      `${incomplete.length} boundary(ies) are incomplete; each lists what is unresolved`,
      incomplete,
    );

  // --- membership against the playable area ---
  if (playable && control.areas.some((a) => a.basis === "game_design")) {
    const inPlay = nodesInPlay(graph, playable);
    const signalNode = new Map(infra.signals.map((s) => [s.id, s.trackNodeId]));
    const pointsNode = new Map(infra.points.map((p) => [p.id, p.trackNodeId]));
    const assigned = new Set<string>();
    for (const a of control.areas) {
      const outside = [
        ...a.signalIds.filter((s) => !inPlay.has(signalNode.get(s) ?? "")),
        ...a.pointsIds.filter((p) => !inPlay.has(pointsNode.get(p) ?? "")),
      ];
      if (outside.length > 0)
        add(
          "error",
          "CONTROL_MEMBERSHIP",
          `control area ${a.id} includes ${outside.length} element(s) outside the playable area`,
          [a.id, ...outside.slice(0, 10)],
        );
      for (const id of [...a.signalIds, ...a.pointsIds]) assigned.add(id);
    }
    const unassigned = [
      ...infra.signals.filter((s) => s.trackNodeId && inPlay.has(s.trackNodeId)).map((s) => s.id),
      ...infra.points.filter((p) => inPlay.has(p.trackNodeId)).map((p) => p.id),
    ].filter((id) => !assigned.has(id));
    if (unassigned.length > 0)
      add(
        "warning",
        "CONTROL_MEMBERSHIP",
        `${unassigned.length} signal(s)/points inside the playable area belong to no control area`,
        unassigned.slice(0, 20),
      );
    const cutBoundaries = new Set(control.boundaries.map((b) => b.cutId).filter(Boolean));
    const noBoundary = playable.cuts.filter((c) => !cutBoundaries.has(c.id)).map((c) => c.id);
    if (noBoundary.length > 0)
      add(
        "warning",
        "BOUNDARY_MISSING",
        `${noBoundary.length} playable-area cut(s) have no control boundary`,
        noBoundary,
      );
  }
  return issues;
}
