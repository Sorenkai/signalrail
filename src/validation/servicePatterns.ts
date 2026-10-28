import type { Control, ServicePatternsFile, Signalling } from "../model/index.ts";
import type { GameRuleContext } from "./gameRules.ts";
import type { Issue, Severity } from "./validate.ts";

/**
 * (P7, D-037) Playable-area cuts whose control boundary leads into a deferred play area
 * (control.json `externalAreas[].kind = deferred_play_area`). Only a fringe on one of these cuts
 * may end a pattern whose journey terminates beyond play (`after: null`).
 */
export function deferredAreaCuts(control: Control | undefined): ReadonlySet<string> {
  const deferred = new Set(
    (control?.externalAreas ?? []).filter((e) => e.kind === "deferred_play_area").map((e) => e.id),
  );
  return new Set(
    (control?.boundaries ?? [])
      .filter((b) => b.cutId !== undefined && deferred.has(b.toAreaId))
      .map((b) => b.cutId!),
  );
}

/**
 * Service-pattern checks (service-patterns.json, P5, D-035). A pattern must name valid fringe
 * endpoints and a contiguous chain of existing routes from its entry fringe to its exit fringe,
 * and its timing points must sit on the right side of the play-area boundary. A pattern that
 * fails any check is reported here and never used by a session (servicePlan.ts), so the
 * services it would match stay unsupported: a broken mapping fails closed.
 */
export function validateServicePatterns(
  file: ServicePatternsFile | undefined,
  signalling: Signalling | undefined,
  fringes: GameRuleContext["fringes"],
  tiplocs: { area: ReadonlySet<string> | null; deferred: ReadonlySet<string> },
  /** Cuts leading into a deferred area (`deferredAreaCuts`); absent = none (fail closed). */
  deferredCuts: ReadonlySet<string> = new Set(),
): { issues: Issue[]; invalid: ReadonlySet<string> } {
  const issues: Issue[] = [];
  const invalid = new Set<string>();
  if (!file) return { issues, invalid };
  const add = (severity: Severity, code: string, id: string, message: string) => {
    issues.push({ severity, code, message: `service pattern ${id}: ${message}`, ids: [id] });
    if (severity === "error") invalid.add(id);
  };
  const routes = new Map((signalling?.routes ?? []).map((r) => [r.id, r]));
  const seen = new Set<string>();

  for (const p of file.patterns) {
    if (seen.has(p.id)) add("error", "DUPLICATE_ID", p.id, "id repeated");
    seen.add(p.id);
    for (const [end, id, use] of [
      ["entry", p.entryFringeId, "entry"],
      ["exit", p.exitFringeId, "exit"],
    ] as const) {
      const f = fringes.get(id);
      if (!f) add("error", "SERVICE_PATTERN_INVALID", p.id, `${end} fringe ${id} is not valid`);
      else if (!f.endpoint.use.includes(use))
        add("error", "SERVICE_PATTERN_INVALID", p.id, `fringe ${id} is not configured for ${use}`);
    }
    const chain = p.routeIds.map((id) => routes.get(id));
    p.routeIds.forEach((id, i) => {
      if (!chain[i]) add("error", "SERVICE_PATTERN_INVALID", p.id, `route ${id} does not exist`);
    });
    if (new Set(p.routeIds).size !== p.routeIds.length)
      add("error", "SERVICE_PATTERN_INVALID", p.id, "a route repeats in its chain");
    if (chain.every((r) => r !== undefined)) {
      const first = chain[0]!;
      const last = chain.at(-1)!;
      if (first.entryFringeId !== p.entryFringeId)
        add(
          "error",
          "SERVICE_PATTERN_INVALID",
          p.id,
          `first route ${first.id} does not start at entry fringe ${p.entryFringeId}`,
        );
      if (last.exitFringeId !== p.exitFringeId)
        add(
          "error",
          "SERVICE_PATTERN_INVALID",
          p.id,
          `last route ${last.id} does not end at exit fringe ${p.exitFringeId}`,
        );
      for (let i = 1; i < chain.length; i++) {
        const a = chain[i - 1]!;
        const b = chain[i]!;
        if (a.exitSignalId === null || a.exitSignalId !== b.entrySignalId)
          add(
            "error",
            "SERVICE_PATTERN_INVALID",
            p.id,
            `route ${b.id} does not start at the exit signal of ${a.id}`,
          );
      }
    }
    // Area membership: before and after lie outside play; the through calls inside it (or in a
    // deferred area beyond a cut). Without an area list nothing can be checked, so it is refused.
    if (!tiplocs.area)
      add("error", "SERVICE_PATTERN_INVALID", p.id, "the dataset lists no play-area TIPLOCs");
    else {
      const inArea = (t: string) => tiplocs.area!.has(t) || tiplocs.deferred.has(t);
      for (const c of [p.before, p.after])
        if (c && inArea(c.tiploc))
          add(
            "error",
            "SERVICE_PATTERN_INVALID",
            p.id,
            `${c.tiploc} is an area TIPLOC, but the pattern places it outside play`,
          );
      for (const c of p.through)
        if (!inArea(c.tiploc))
          add(
            "error",
            "SERVICE_PATTERN_INVALID",
            p.id,
            `${c.tiploc} is not an area or deferred TIPLOC`,
          );
      // (P7, D-037) The play-area calls must be contiguous: a deferred call between two of them
      // means the service leaves play and comes back, which one fringe-to-fringe chain cannot run.
      const inPlay = p.through.map((c) => tiplocs.area!.has(c.tiploc));
      if (inPlay.some((x, i) => x && inPlay.slice(0, i).some(Boolean) && !inPlay[i - 1]))
        add(
          "error",
          "SERVICE_PATTERN_INVALID",
          p.id,
          "a deferred call lies between play-area calls: the service would leave and re-enter play",
        );
      // (P7, D-037) A journey may end beyond play only in a deferred area that the exit fringe
      // leads into. A service terminating inside play (no lifecycle model) never matches.
      if (p.after === null) {
        const last = p.through.at(-1)!;
        const cut = fringes.get(p.exitFringeId)?.cut.id;
        if (!tiplocs.deferred.has(last.tiploc))
          add(
            "error",
            "SERVICE_PATTERN_INVALID",
            p.id,
            `no call after play, but the last call ${last.tiploc} is not a deferred-area TIPLOC: a service terminating in play is not modelled`,
          );
        if (!p.through.some((c) => tiplocs.area!.has(c.tiploc)))
          add("error", "SERVICE_PATTERN_INVALID", p.id, "no through call is in the play area");
        if (cut === undefined || !deferredCuts.has(cut))
          add(
            "error",
            "SERVICE_PATTERN_INVALID",
            p.id,
            `no call after play, but exit fringe ${p.exitFringeId} is not on a cut whose boundary leads into a deferred area`,
          );
      }
    }
  }
  // (P6) Two patterns over the same timing points must differ in a platform or line check that
  // no call can satisfy for both; otherwise one service could match both. Both are refused, so
  // an overlapping pair fails closed instead of a session choosing between them.
  const calls = (p: ServicePatternsFile["patterns"][number]) => [p.before, ...p.through, p.after];
  for (const [i, a] of file.patterns.entries())
    for (const b of file.patterns.slice(i + 1)) {
      const ca = calls(a);
      const cb = calls(b);
      if (ca.length !== cb.length || ca.some((c, k) => c?.tiploc !== cb[k]?.tiploc)) continue;
      const disjoint = ca.some((c, k) => {
        const d = cb[k];
        if (!c || !d) return false;
        if (c.platform !== undefined && d.platform !== undefined && c.platform !== d.platform)
          return true;
        return (
          c.lines !== undefined &&
          d.lines !== undefined &&
          !c.lines.some((l) => d.lines!.includes(l))
        );
      });
      if (!disjoint)
        for (const [p, q] of [
          [a, b],
          [b, a],
        ] as const)
          add(
            "error",
            "SERVICE_PATTERN_OVERLAP",
            p.id,
            `a service could match both this pattern and ${q.id}: same timing points, and no platform or line check tells them apart`,
          );
    }
  if (file.patterns.length > 0)
    issues.push({
      severity: "info",
      code: "SERVICE_PATTERNS",
      message: `${file.patterns.length - invalid.size} valid service pattern(s) map timetable journeys onto game routes (D-035; a mapping, not a real-world claim)`,
    });
  return { issues, invalid };
}
