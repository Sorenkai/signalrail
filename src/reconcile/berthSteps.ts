/**
 * Tests SMART train-describer berth steps against OSM track and signal directions.
 *
 * A berth step A -> B (both berths matched to signals) is tested by searching for a
 * no-reversal path that leaves signal A in its OSM direction and reaches signal B:
 * - from behind (a train approaching B to be held at it): "consistent";
 * - only head-on: the step contradicts B's direction, UNLESS the train can be shown to reverse:
 *   B stands on a dead-end road (plain track behind it ends at a buffer stop) and SMART records
 *   a departure from berth B whose direction (Up/Down) is the opposite of the arrival's. Then
 *   the step is "reversal_at_dead_end". This is an inference; see INFERRED_BEHAVIOUR I-003.
 * Switch legs are not in OSM, so the search uses the "legs" geometric heuristic first (with the
 * sourced OSM slip types: straight across always, double-slip diagonals, but no single-slip
 * diagonal), and the "smooth" rule as a sensitivity test (src/graph/directedTrack.ts). A path that exists only through a
 * single slip's unresolved diagonal is "unresolved_slip_diagonal"; one found only under
 * "smooth" is "consistent_alternative_heuristic". Neither is proof, and SMART events alone
 * never make a movement supported.
 */
import type {
  BerthStepEvidence,
  Infrastructure,
  Signal,
  SourceRef,
  StepResult,
} from "../model/index.ts";
import type { SmartRow } from "../import/smart/smart.ts";
import { DirectedTrack, type TrackRoute } from "../graph/directedTrack.ts";

/** Longest plain-track run behind a signal still treated as a platform/bay dead end. */
export const DEAD_END_MAX_M = 400;

/**
 * SMART EVENT codes (Open Rail Data wiki, SMART reference): A = arrive Up, B = depart Up,
 * C = arrive Down, D = depart Down. Up/Down are the line's designated directions, which can
 * change along a route; they are compared only within one reporting location.
 */
export function decodeEvent(raw: string): BerthStepEvidence["event"] {
  const map: Record<string, ["arrive" | "depart", "up" | "down"]> = {
    A: ["arrive", "up"],
    B: ["depart", "up"],
    C: ["arrive", "down"],
    D: ["depart", "down"],
  };
  const v = map[raw.trim().toUpperCase()];
  return { raw, kind: v?.[0] ?? null, direction: v?.[1] ?? null };
}

export interface StepContext {
  infra: Pick<Infrastructure, "nodes" | "edges" | "signals"> &
    Partial<Pick<Infrastructure, "points">>;
  /** Berth id (original spelling) -> signal, for unambiguous matches only. */
  signalByBerth: Map<string, Signal>;
  osm: SourceRef;
  smart: SourceRef;
}

export function classifySteps(rows: SmartRow[], ctx: StepContext): BerthStepEvidence[] {
  const legs = new DirectedTrack(ctx.infra, "legs");
  const slipDiagonal = new DirectedTrack(ctx.infra, "legs", { singleSlipDiagonals: "allow" });
  const smooth = new DirectedTrack(ctx.infra, "smooth");
  const incomplete = new DirectedTrack(ctx.infra, "legs", {
    singleSlipDiagonals: "allow",
    incompleteJunctions: "allow",
  });
  const graph = legs.graph;
  const kind = new Map(ctx.infra.nodes.map((n) => [n.id, n.kind]));
  const signalNodes = new Set(ctx.infra.signals.map((s) => s.trackNodeId).filter(Boolean));
  const keyNodes = (r: TrackRoute | null) =>
    r ? r.nodes.filter((n) => kind.get(n) !== "plain" || signalNodes.has(n)) : [];

  /** The track behind a signal: its single neighbour other than the one it faces. */
  const behind = (s: Signal) =>
    s.trackNodeId && s.facingTowardsNodeId.value
      ? graph.behind(s.trackNodeId, s.facingTowardsNodeId.value)
      : null;

  /** Plain track behind a signal (opposite its facing) ending at a buffer stop. */
  const deadEndBehind = (s: Signal) => {
    const back = behind(s);
    const run = back ? graph.plainRun(s.trackNodeId!, back) : null;
    return run && run.kind === "buffer_stop" && run.distanceM <= DEAD_END_MAX_M ? run : null;
  };

  /** Can a train reach `b` (either way round) by leaving `a` against a's OSM direction? */
  const reachableAgainst = (a: Signal, b: Signal) => {
    if (!a.trackNodeId || !b.trackNodeId) return false;
    const back = behind(a);
    if (!back) return false;
    return [legs, slipDiagonal, smooth].some(
      (t) => t.route(a.trackNodeId!, back, b.trackNodeId!, null) !== null,
    );
  };

  const seen = new Map<string, number>();
  return rows.map((r) => {
    const event = decodeEvent(r.EVENT);
    const baseId = `${r.TD}:${r.FROMBERTH}>${r.TOBERTH}@${r.STANOX.trim()}:${r.EVENT.trim() || "-"}`;
    const n = (seen.get(baseId) ?? 0) + 1;
    seen.set(baseId, n);
    const a = ctx.signalByBerth.get(r.FROMBERTH) ?? null;
    const b = ctx.signalByBerth.get(r.TOBERTH) ?? null;
    const record = (
      result: StepResult,
      explanation: string,
      route: TrackRoute | null = null,
    ): BerthStepEvidence => ({
      fromDirectionDiscriminates: route && a && b ? !reachableAgainst(a, b) : null,
      id: n > 1 ? `${baseId}#${n}` : baseId,
      td: r.TD,
      fromBerth: r.FROMBERTH,
      toBerth: r.TOBERTH,
      stanox: r.STANOX,
      stanme: r.STANME,
      stepType: r.STEPTYPE,
      event,
      platform: r.PLATFORM,
      fromLine: r.FROMLINE,
      toLine: r.TOLINE,
      berthOffset: r.BERTHOFFSET,
      route: r.ROUTE,
      comment: r.COMMENT,
      fromSignalId: a?.id ?? null,
      toSignalId: b?.id ?? null,
      result,
      distanceM: route?.distanceM ?? null,
      keyNodeIds: keyNodes(route),
      explanation,
      provenance: {
        evidence: a && b ? "inferred" : "sourced",
        sources: [
          { ...ctx.smart, recordId: `${r.TD} ${r.FROMBERTH}->${r.TOBERTH} STANOX ${r.STANOX}` },
          ...(a && b ? [ctx.osm] : []),
        ],
        ...(a && b
          ? {
              note: "Test of a SMART berth step against OSM track; the berth-signal links it relies on are number matches (inferred), and switch legs are a geometric heuristic.",
            }
          : {}),
      },
    });

    if (!a && !b) return record("both_unmatched", "neither berth matches a signal");
    if (!a || !b)
      return record(
        "one_side_unmatched",
        `berth ${a ? r.TOBERTH : r.FROMBERTH} matches no signal unambiguously`,
      );
    if (!a.trackNodeId || !b.trackNodeId || !a.facingTowardsNodeId.value)
      return record("signal_direction_unknown", "a signal has no track node or direction");
    const start = [a.trackNodeId, a.facingTowardsNodeId.value] as const;
    const facingB = b.facingTowardsNodeId.value;

    const behindLegs = legs.route(...start, b.trackNodeId, facingB);
    if (behindLegs)
      return record(
        "consistent",
        `path of ${behindLegs.distanceM} m leaves ${a.ref} in its OSM direction and reaches ${b.ref} from behind`,
        behindLegs,
      );
    const headOnLegs = legs.route(...start, b.trackNodeId, facingB, 6000, true);
    const deadEnd = deadEndBehind(b);
    const opposite = rows.filter(
      (x) =>
        x.TD === r.TD &&
        x.FROMBERTH === r.TOBERTH &&
        decodeEvent(x.EVENT).kind === "depart" &&
        !!event.direction &&
        decodeEvent(x.EVENT).direction !== event.direction,
    );
    const reversal = deadEnd && opposite.length > 0;
    const reversalText = () =>
      `${b.ref} stands on a dead-end road (buffer stop ${deadEnd!.distanceM} m behind it, no switch between). SMART records this arrival as ${event.direction} (EVENT ${event.raw}) and departure(s) from berth ${r.TOBERTH} as ${decodeEvent(opposite[0]!.EVENT).direction} (${opposite.map((x) => `${x.FROMBERTH}->${x.TOBERTH} EVENT ${x.EVENT}`).join(", ")})`;
    if (headOnLegs && reversal)
      return record(
        "reversal_at_dead_end",
        `path of ${headOnLegs.distanceM} m meets ${b.ref} head-on, but ${reversalText()}: consistent with a train entering past the signal and reversing out past it.`,
        headOnLegs,
      );
    // Paths that need a single slip's diagonal: the slip type is sourced, the diagonal is not.
    const viaDiagonal =
      slipDiagonal.route(...start, b.trackNodeId, facingB) ??
      (reversal ? slipDiagonal.route(...start, b.trackNodeId, facingB, 6000, true) : null);
    if (viaDiagonal)
      return record(
        "unresolved_slip_diagonal",
        `no path under the leg heuristic with sourced slip types; a ${viaDiagonal.distanceM} m path ${slipDiagonal.route(...start, b.trackNodeId, facingB) ? `reaches ${b.ref} from behind` : `meets ${b.ref} head-on into a dead end (${reversalText()})`} only through the diagonal of single slip(s) ${slipDiagonal.singleSlipDiagonalsUsed(viaDiagonal).join(", ")}. OSM gives the slip type but not which diagonal exists, so the movement stays unresolved.`,
        viaDiagonal,
      );
    const behindSmooth = smooth.route(...start, b.trackNodeId, facingB);
    const headOnSmooth = smooth.route(...start, b.trackNodeId, facingB, 6000, true);
    if (behindSmooth || (headOnSmooth && reversal))
      return record(
        "consistent_alternative_heuristic",
        behindSmooth
          ? `no path under the switch-leg heuristic; under the smooth-curvature rule a ${behindSmooth.distanceM} m path reaches ${b.ref} from behind. The junction model decides this step, so it is not proof.`
          : `no path under the switch-leg heuristic; under the smooth-curvature rule a ${headOnSmooth!.distanceM} m path meets ${b.ref} head-on, and ${reversalText()}. The junction model decides this step, so it is not proof.`,
        behindSmooth ?? headOnSmooth,
      );
    const headOn = headOnLegs ?? headOnSmooth;
    if (headOn) {
      const why = [
        deadEnd ? null : `${b.ref} is not on a dead-end road`,
        event.direction ? null : `EVENT "${r.EVENT}" has no Up/Down direction`,
        opposite.length > 0
          ? null
          : `SMART has no opposite-direction departure from berth ${r.TOBERTH}`,
      ].filter(Boolean);
      return record(
        "contradicts_direction",
        `path of ${headOn.distanceM} m reaches ${b.ref} only head-on, with no reversal explanation: ${why.join("; ")}`,
        headOn,
      );
    }
    // A path only through a switch or crossing with a leg missing from the data stays no_path.
    const viaIncomplete =
      incomplete.route(...start, b.trackNodeId, facingB) ??
      incomplete.route(...start, b.trackNodeId, facingB, 6000, true);
    if (viaIncomplete)
      return record(
        "no_path",
        `no path under either junction rule within 6 km; a ${viaIncomplete.distanceM} m path exists only through incomplete junction(s) ${incomplete.incompleteJunctionsUsed(viaIncomplete).join(", ")} (a switch or crossing with a leg missing from OSM)${incomplete.singleSlipDiagonalsUsed(viaIncomplete).length ? ` and single-slip diagonal(s) ${incomplete.singleSlipDiagonalsUsed(viaIncomplete).join(", ")}` : ""}, so the movement stays unresolved`,
        viaIncomplete,
      );
    return record(
      "no_path",
      "no no-reversal path under either junction rule within 6 km: a topology gap, a heuristic limit, a stale berth record or a wrong match",
    );
  });
}
