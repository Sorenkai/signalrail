/**
 * Builds the signal evidence layer (SignalEvidenceFile) from OSM signals, SMART berth steps
 * and CORPUS signal timing points. Each claim (identity, position, direction, berth
 * association, track context) is assessed separately; see src/model/signalEvidence.ts.
 */
import type {
  BerthStepEvidence,
  ClaimAssessment,
  Infrastructure,
  Provenance,
  Signal,
  SignalEvidenceFile,
  SignalEvidenceRecord,
  SourceRef,
} from "../model/index.ts";
import type { SmartRow } from "../import/smart/smart.ts";
import { TrackGraph } from "../graph/trackGraph.ts";
import { parseBerth, parseSignalRef, reconcile } from "../pilot/signalBerths.ts";
import { classifySteps } from "./berthSteps.ts";

export interface EvidenceScope {
  td: string;
  signalPrefix: string;
  /** STANOX treated as in the area -> the name used to select it. */
  stanox: Record<string, string>;
}

export interface CorpusTiploc {
  TIPLOC: string;
  STANOX: string;
  NLCDESC: string;
}

export interface EvidenceInputs {
  datasetId: string;
  generated: string;
  infra: Infrastructure;
  /** Raw OSM tags per signal id, as fetched. */
  rawTags: Map<string, Record<string, string>>;
  /** SMART rows for the TD area (all of it; the scope's STANOX select the area rows). */
  smartRows: SmartRow[];
  corpus: CorpusTiploc[];
  /** Regex selecting CORPUS descriptions that name signals in this area. */
  corpusSignalPattern: RegExp;
  scope: EvidenceScope;
  sources: { osm: SourceRef; smart: SourceRef; corpus: SourceRef };
}

/** Raw OSM keys copied into rawTags: they bear on identity, direction or position. */
const KEPT_TAGS =
  /^(ref|fixme|note|railway:signal:direction|railway:signal:position|railway:signal:(main|distant|shunting|main_repeated|route|stop)(:form)?)$/;

/** Steps that test a direction or berth link, by how they bear on it. */
const POSITIVE: BerthStepEvidence["result"][] = ["consistent"];
const REVERSAL: BerthStepEvidence["result"][] = ["reversal_at_dead_end"];
const NEGATIVE: BerthStepEvidence["result"][] = ["contradicts_direction"];
const UNDECIDED: BerthStepEvidence["result"][] = [
  "consistent_alternative_heuristic",
  "unresolved_slip_diagonal",
  "no_path",
];

export function assessFromSteps(steps: BerthStepEvidence[]): ClaimAssessment {
  const has = (rs: BerthStepEvidence["result"][]) => steps.some((s) => rs.includes(s.result));
  if (has(NEGATIVE)) return has(POSITIVE) || has(REVERSAL) ? "disputed" : "contradicted";
  if (has(POSITIVE)) return "consistent";
  if (has(REVERSAL)) return "consistent_with_reversal";
  if (has(UNDECIDED)) return "unresolved";
  return "not_assessed";
}

const stepFinding = (s: BerthStepEvidence) =>
  `${s.fromBerth}->${s.toBerth} (EVENT ${s.event.raw}, ${s.stanme.trim()}): ${s.result} - ${s.explanation}`;

export function buildSignalEvidence(inp: EvidenceInputs): SignalEvidenceFile {
  const { infra, scope, sources } = inp;
  const bb = infra.bbox;
  const inBbox = (s: Signal) =>
    !bb ||
    (!!s.position &&
      s.position.lat >= bb.south &&
      s.position.lat <= bb.north &&
      s.position.lon >= bb.west &&
      s.position.lon <= bb.east);
  const signals = infra.signals.filter(inBbox);
  const areaRows = inp.smartRows.filter(
    (r) => r.TD === scope.td && scope.stanox[r.STANOX.trim()] !== undefined,
  );
  const berthIds = [
    ...new Set(areaRows.flatMap((r) => [r.FROMBERTH, r.TOBERTH]).filter((b) => b.trim())),
  ].sort();
  const berths = berthIds.map((b) => parseBerth(scope.td, b));
  const rec = reconcile(
    signals.filter((s) => s.ref),
    berths,
    scope.signalPrefix,
  );
  const byId = new Map(signals.map((s) => [s.id, s]));
  const signalByBerth = new Map<string, Signal>();
  for (const m of rec.signals)
    if (m.class === "unambiguous") signalByBerth.set(m.berths[0]!, byId.get(m.signalId)!);

  const steps = classifySteps(areaRows, {
    infra,
    signalByBerth,
    osm: sources.osm,
    smart: sources.smart,
  });
  const osmRef = (id: string): SourceRef => ({
    ...sources.osm,
    recordId: id.replace(/^osm-sig/, "node/"),
  });

  // CORPUS timing points that name a signal plate, e.g. "CARLISLE CE 404 SIGNAL".
  const namedSignals = inp.corpus.flatMap((c) => {
    const desc = c.NLCDESC.trim();
    const m = new RegExp(`\\b${scope.signalPrefix}\\s*0*(\\d+)\\b`).exec(desc);
    if (!m || !inp.corpusSignalPattern.test(desc)) return [];
    const plate = `${scope.signalPrefix}${Number(m[1])}`;
    const stanox = c.STANOX.trim();
    return [
      {
        plate,
        description: desc,
        tiploc: c.TIPLOC.trim(),
        stanox,
        osmSignalIds: signals
          .filter((s) => {
            const p = s.ref ? parseSignalRef(s.ref) : null;
            return !!p && p.suffix === "" && `${p.prefix}${p.number}` === plate;
          })
          .map((s) => s.id),
        numericBerthAtSameStanox: areaRows.some(
          (r) =>
            r.STANOX.trim() === stanox &&
            [r.FROMBERTH, r.TOBERTH].some((b) => /^\d{4}$/.test(b) && Number(b) === Number(m[1])),
        ),
        provenance: {
          evidence: "sourced" as const,
          sources: [{ ...sources.corpus, recordId: `TIPLOC ${c.TIPLOC.trim()}` }],
        },
      },
    ];
  });

  const graph = new TrackGraph(infra);
  const run = (from: string, next: string | null | undefined) => {
    const r = next ? graph.plainRun(from, next) : null;
    return r
      ? { nodeId: r.nodeId, nodeKind: r.kind ?? "?", degree: r.degree, distanceM: r.distanceM }
      : null;
  };

  const records: SignalEvidenceRecord[] = signals.map((s) => {
    const parsed = s.ref ? parseSignalRef(s.ref) : null;
    const tags = Object.fromEntries(
      Object.entries(inp.rawTags.get(s.id) ?? {}).filter(([k]) => KEPT_TAGS.test(k)),
    );
    const match = rec.signals.find((m) => m.signalId === s.id);
    const osmOnly: Provenance = { evidence: "sourced", sources: [osmRef(s.id)] };

    // --- identity ---
    const plate = parsed && parsed.suffix === "" ? `${parsed.prefix}${parsed.number}` : null;
    const corpusHits = namedSignals.filter((n) => plate && n.plate === plate);
    const dup =
      parsed &&
      rec.duplicateSignalKeys.includes(`${parsed.prefix}${parsed.number}${parsed.suffix}`);
    const identity: SignalEvidenceRecord["identity"] = !s.ref
      ? {
          value: null,
          provenance: { evidence: "unknown", sources: [osmRef(s.id)] },
          assessment: "not_assessed",
          findings: ["OSM gives no ref for this signal"],
          limitations: [],
        }
      : {
          value: s.ref,
          provenance: osmOnly,
          assessment: dup ? "ambiguous" : corpusHits.length > 0 ? "corroborated" : "single_source",
          findings: [
            `OSM ref "${s.ref}"`,
            ...(dup ? ["another OSM signal carries the same ref"] : []),
            ...corpusHits.map(
              (c) =>
                `CORPUS ${c.tiploc} "${c.description}" (STANOX ${c.stanox}) names plate ${c.plate}`,
            ),
            ...(parsed?.suffix
              ? [
                  `suffix "${parsed.suffix}" kept as published; its meaning is not stated by any source used`,
                ]
              : []),
          ],
          limitations: [
            ...(corpusHits.length > 0
              ? [
                  "CORPUS confirms that a signal with this plate exists at the named location, but has no coordinates, so it does not confirm that this OSM node is that signal; evidence stays 'sourced'",
                ]
              : []),
            "A matching SMART berth number is not evidence of identity (berths are not signals)",
          ],
        };

    // --- position ---
    const position: SignalEvidenceRecord["position"] = {
      value: s.position ?? null,
      provenance: s.position ? osmOnly : { evidence: "unknown", sources: [] },
      assessment: s.position ? "single_source" : "not_assessed",
      findings: s.position ? ["OSM node coordinates"] : [],
      limitations: [
        "No second source gives signal coordinates: SMART reports berth steps at STANOX locations (not positions; BERTHOFFSET is seconds) and CORPUS has no coordinates",
        ...(tags.fixme ? [`OSM fixme: "${tags.fixme}"`] : []),
      ],
    };

    // --- direction ---
    const mine = steps.filter((x) => x.fromSignalId === s.id || x.toSignalId === s.id);
    const tested = mine.filter((x) => x.fromSignalId && x.toSignalId);
    const dirAssessment = s.facingTowardsNodeId.value ? assessFromSteps(tested) : "not_assessed";
    const direction: SignalEvidenceRecord["direction"] = {
      value: s.facingTowardsNodeId.value,
      provenance: s.facingTowardsNodeId.provenance,
      assessment: dirAssessment,
      findings: [
        ...(tags["railway:signal:direction"]
          ? [
              `OSM railway:signal:direction=${tags["railway:signal:direction"]}, resolved against the way direction by the importer`,
            ]
          : []),
        ...tested.map(stepFinding),
      ],
      limitations: [
        "Cross-checks use SMART berth steps whose berth-signal links are number matches, and OSM switch legs inferred from geometry",
        ...(tested.length === 0 ? ["No berth step with both ends matched tests this signal"] : []),
      ],
    };

    // --- track context ---
    const ahead = s.trackNodeId ? run(s.trackNodeId, s.facingTowardsNodeId.value) : null;
    const behind =
      s.trackNodeId && s.facingTowardsNodeId.value
        ? run(s.trackNodeId, graph.behind(s.trackNodeId, s.facingTowardsNodeId.value))
        : null;
    const trackContext: SignalEvidenceRecord["trackContext"] = {
      value: { ahead, behind },
      provenance: osmOnly,
      assessment: "single_source",
      findings: [
        ...(ahead ? [`ahead: ${ahead.nodeKind} ${ahead.nodeId} at ${ahead.distanceM} m`] : []),
        ...(behind ? [`behind: ${behind.nodeKind} ${behind.nodeId} at ${behind.distanceM} m`] : []),
      ],
      limitations: ["OSM records no switch normal/reverse legs; track connections are as mapped"],
    };

    // --- berth associations ---
    const berthAssocs: SignalEvidenceRecord["berths"] = (
      match?.class === "unmatched" ? [] : (match?.berths ?? [])
    ).map((berth) => {
      const parsedBerth = parseBerth(scope.td, berth);
      const bSteps = steps.filter(
        (x) =>
          (x.fromBerth === berth && x.fromSignalId === s.id) ||
          (x.toBerth === berth && x.toSignalId === s.id),
      );
      const tested = bSteps.filter((x) => x.fromSignalId && x.toSignalId);
      const ambiguous = match!.class === "ambiguous";
      const allSteps = steps.filter((x) => x.fromBerth === berth || x.toBerth === berth);
      return {
        td: scope.td,
        berth,
        berthKind: parsedBerth.kind,
        match: ambiguous ? "ambiguous" : "unambiguous",
        stepIds: (ambiguous ? allSteps : bSteps).map((x) => x.id),
        claim: {
          value: berth,
          provenance: {
            evidence: "inferred",
            sources: [osmRef(s.id), { ...sources.smart, recordId: `${scope.td} berth ${berth}` }],
            note: `Linked only because the berth number equals the signal number (${match!.reason}). SMART does not name signals.`,
          },
          assessment: ambiguous ? "ambiguous" : assessFromSteps(tested),
          findings: [
            `match: ${match!.class} - ${match!.reason}`,
            `${allSteps.length} SMART step(s) use berth ${berth}`,
            ...tested.map(stepFinding),
          ],
          limitations: [
            "A matching number alone is not proof of identity",
            ...(tested.length === 0 ? ["No step with both berths matched tests this link"] : []),
          ],
        },
      };
    });

    return {
      signalId: s.id,
      rawRef: s.ref,
      parsedRef: parsed
        ? { prefix: parsed.prefix, number: parsed.number, suffix: parsed.suffix }
        : null,
      rawTags: tags,
      identity,
      position,
      direction,
      trackContext,
      berths: berthAssocs,
    };
  });

  const unmatchedBerths = rec.berths
    .filter((b) => b.class !== "unambiguous")
    .map((b) => ({
      td: scope.td,
      berth: b.berth.original,
      berthKind: b.berth.kind,
      match: b.class as "ambiguous" | "unmatched",
      candidateSignalIds: rec.signals
        .filter((m) => b.signals.includes(m.ref))
        .map((m) => m.signalId),
      stanox: [
        ...new Set(
          areaRows
            .filter((r) => r.FROMBERTH === b.berth.original || r.TOBERTH === b.berth.original)
            .map((r) => r.STANOX.trim()),
        ),
      ].sort(),
      reason: b.reason,
    }));

  return {
    datasetId: inp.datasetId,
    generated: inp.generated,
    method:
      "OSM signal refs reconciled with SMART berths of the scope's TD area and STANOX by the conservative number rule (src/pilot/signalBerths.ts reconcile); berth steps tested against OSM track (src/reconcile/berthSteps.ts); CORPUS signal timing points matched by plate. Claims are assessed separately (src/model/signalEvidence.ts). See docs/pilots/CARLISLE_PILOT.md.",
    inputs: [sources.osm, sources.smart, sources.corpus],
    scope,
    signals: records,
    steps,
    unmatchedBerths,
    namedSignals,
  };
}
