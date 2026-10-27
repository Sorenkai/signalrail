/**
 * PILOT (read-only analysis): Carlisle signal/berth reconciliation, geometry consistency and
 * timetable profile. Reads data/datasets/carlisle/infrastructure.json and the owner-supplied
 * Network Rail files in data/private/. Writes docs/pilots/carlisle-pilot-results.json (or --out).
 *
 *   npx tsx tools/pilot-carlisle.ts [--date 2026-11-04] [--out <path>]
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { CifParser } from "../src/import/cif/parseCif.ts";
import { resolveSchedulesForDate, runsOn } from "../src/import/cif/snapshot.ts";
import { CorpusFile } from "../src/import/corpus/corpus.ts";
import { SmartFile } from "../src/import/smart/smart.ts";
import { Infrastructure } from "../src/model/index.ts";
import { DirectedTrack } from "../src/graph/directedTrack.ts";
import { parseBerth, reconcile } from "../src/pilot/signalBerths.ts";
import { RECONCILIATION_SCOPES } from "../src/reconcile/scopes.ts";
import { flags, path, readJson, writeJson } from "./lib.ts";

const date = flags().date ?? "2026-11-04";
/** Output path; defaults to the committed pilot results. */
const out = flags().out ?? "docs/pilots/carlisle-pilot-results.json";
const TD = "CL";
const PREFIX = "CE";
/** STANOX treated as inside the pilot area (shared with the Phase 1 reconciliation). */
const AREA_STANOX: Record<string, string> = RECONCILIATION_SCOPES.carlisle!.stanox;

const infra = Infrastructure.parse(readJson(path("data/datasets/carlisle/infrastructure.json")));
const smart = SmartFile.parse(readJson(path("data/private/SMARTExtract.json")));
const corpus = CorpusFile.parse(readJson(path("data/private/CORPUSExtract.json")));
const bb = infra.bbox!;
const inBbox = (p?: { lat: number; lon: number }) =>
  !!p && p.lat >= bb.south && p.lat <= bb.north && p.lon >= bb.west && p.lon <= bb.east;

// ---- 1. identifiers ----
const signalsInArea = infra.signals.filter((s) => inBbox(s.position));
const numbered = signalsInArea.filter((s) => s.ref);
const clRows = smart.BERTHDATA.filter((r) => r.TD === TD);
const areaRows = clRows.filter((r) => AREA_STANOX[r.STANOX.trim()]);
const berthIds = (rows: typeof clRows) =>
  [...new Set(rows.flatMap((r) => [r.FROMBERTH, r.TOBERTH]).filter((b) => b.trim()))].sort();
const areaBerths = berthIds(areaRows).map((b) => parseBerth(TD, b));
const allClBerths = berthIds(clRows).map((b) => parseBerth(TD, b));

const rec = reconcile(numbered, areaBerths, PREFIX);
const recAllCl = reconcile(numbered, allClBerths, PREFIX);
const count = <T extends { class: string }>(xs: T[]) => ({
  unambiguous: xs.filter((x) => x.class === "unambiguous").length,
  ambiguous: xs.filter((x) => x.class === "ambiguous").length,
  unmatched: xs.filter((x) => x.class === "unmatched").length,
});
const pct = (n: number, d: number) => (d === 0 ? null : Math.round((1000 * n) / d) / 10);

const sigCounts = count(rec.signals);
const berthCounts = count(rec.berths);
const signalBerthKinds = {
  numeric: areaBerths.filter((b) => b.kind === "numeric").length,
  lettered: areaBerths.filter((b) => b.kind === "lettered").length,
  other: areaBerths.filter((b) => b.kind === "other").length,
};

// ---- 2. geometry consistency of SMART berth steps ----
// Pilot method: graph only (no slip types), as originally run; Phase 1+ uses src/reconcile/.
const track = new DirectedTrack({ nodes: infra.nodes, edges: infra.edges });
const sigByBerth = new Map<string, (typeof numbered)[number]>();
for (const m of rec.signals.filter((m) => m.class === "unambiguous")) {
  sigByBerth.set(
    m.berths[0]!,
    numbered.find((s) => s.id === m.signalId)!,
  );
}
type StepCheck = {
  stanox: string;
  stanme: string;
  from: string;
  to: string;
  line: string;
  event: string;
  fromSignal: string | null;
  toSignal: string | null;
  /**
   * consistent: a no-reversal path leads from the first signal, in its OSM direction, to the
   *   second, arriving from behind it.
   * contradicts-direction: such a path exists only by arriving at the second signal from its
   *   facing side, so the OSM direction and the berth step disagree.
   * unresolved: no no-reversal path under the switch-leg heuristic (topology gap or heuristic).
   */
  result:
    | "consistent"
    | "contradicts-direction"
    | "unresolved"
    | "one-side-unmatched"
    | "both-unmatched"
    | "signal-direction-unknown";
  distanceM: number | null;
};
const steps: StepCheck[] = areaRows.map((r) => {
  const a = sigByBerth.get(r.FROMBERTH);
  const b = sigByBerth.get(r.TOBERTH);
  const base = {
    stanox: r.STANOX,
    stanme: r.STANME,
    from: r.FROMBERTH,
    to: r.TOBERTH,
    line: r.FROMLINE || r.TOLINE || "",
    event: r.EVENT,
    fromSignal: a?.ref ?? null,
    toSignal: b?.ref ?? null,
    distanceM: null,
  };
  if (!a && !b) return { ...base, result: "both-unmatched" };
  if (!a || !b) return { ...base, result: "one-side-unmatched" };
  if (!a.trackNodeId || !b.trackNodeId || !a.facingTowardsNodeId.value)
    return { ...base, result: "signal-direction-unknown" };
  const d = track.distance(
    a.trackNodeId,
    a.facingTowardsNodeId.value,
    b.trackNodeId,
    b.facingTowardsNodeId.value,
  );
  if (d !== null) return { ...base, result: "consistent", distanceM: d };
  const headOn = track.distance(a.trackNodeId, a.facingTowardsNodeId.value, b.trackNodeId, null);
  return {
    ...base,
    result: headOn === null ? "unresolved" : "contradicts-direction",
    distanceM: headOn,
  };
});
const stepCounts: Record<string, number> = {};
for (const s of steps) stepCounts[s.result] = (stepCounts[s.result] ?? 0) + 1;

// Per matched signal: corroborated by topology = in >=1 consistent step and no contradiction.
const corroboration = rec.signals
  .filter((m) => m.class === "unambiguous")
  .map((m) => {
    const mine = steps.filter((s) => s.fromSignal === m.ref || s.toSignal === m.ref);
    const n = (r: StepCheck["result"]) => mine.filter((s) => s.result === r).length;
    const consistent = n("consistent");
    const contradicts = n("contradicts-direction");
    const status =
      contradicts > 0
        ? "contradicted"
        : consistent > 0
          ? "corroborated-by-topology"
          : mine.length
            ? "untested-or-unresolved"
            : "no-step-with-both-ends";
    return {
      ref: m.ref,
      berth: m.berths[0],
      consistent,
      contradicts,
      unresolved: n("unresolved"),
      status,
    };
  });
const corroborationCounts: Record<string, number> = {};
for (const c of corroboration)
  corroborationCounts[c.status] = (corroborationCounts[c.status] ?? 0) + 1;

// STANOX location vs matched signal positions (name-matched OSM location where one exists).
const norm = (s: string) =>
  s
    .toUpperCase()
    .replace(/\bJN\b/g, "JUNCTION")
    .replace(/[^A-Z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const corpusByStanox = new Map<string, { tiploc: string; desc: string }[]>();
for (const c of corpus.TIPLOCDATA) {
  const s = c.STANOX.trim();
  if (s)
    corpusByStanox.set(s, [
      ...(corpusByStanox.get(s) ?? []),
      { tiploc: c.TIPLOC.trim(), desc: c.NLCDESC.trim() },
    ]);
}
const metres = (p: { lat: number; lon: number }, q: { lat: number; lon: number }) =>
  Math.round(
    Math.hypot(
      (p.lat - q.lat) * 111320,
      (p.lon - q.lon) * 111320 * Math.cos((p.lat * Math.PI) / 180),
    ),
  );
const locationChecks = Object.keys(AREA_STANOX).map((stanox) => {
  const descs = corpusByStanox.get(stanox) ?? [];
  const loc = infra.locations.find((l) => descs.some((d) => norm(d.desc) === norm(l.name)));
  const sigs = steps
    .filter((s) => s.stanox === stanox)
    .flatMap((s) => [s.fromSignal, s.toSignal])
    .filter((x): x is string => !!x);
  const uniq = [...new Set(sigs)];
  const dists = loc
    ? uniq.map((ref) => ({
        ref,
        m: metres(numbered.find((s) => s.ref === ref)!.position!, loc.position!),
      }))
    : [];
  return {
    stanox,
    smartName: AREA_STANOX[stanox],
    corpus: descs.map((d) => `${d.tiploc} ${d.desc}`),
    osmLocation: loc ? `${loc.id} ${loc.name}` : null,
    matchedSignalDistancesM: dists,
  };
});

// CORPUS signal timing points ("CARLISLE CE 404 SIGNAL", "KINGMOOR SIGNAL CE486") vs OSM and SMART.
const corpusSignals = corpus.TIPLOCDATA.flatMap((c) => {
  const m = /\bCE\s*0*(\d+)\b/.exec(c.NLCDESC);
  if (!m || !/CARLISLE|KINGMOOR/.test(c.NLCDESC)) return [];
  const n = Number(m[1]);
  const stanox = c.STANOX.trim();
  const osm = numbered.filter((x) => x.ref && /^CE0*(\d+)$/.exec(x.ref)?.[1] === String(n));
  const berthAtSameStanox = areaRows.some(
    (r) =>
      r.STANOX === stanox &&
      [r.FROMBERTH, r.TOBERTH].some((b) => /^\d{4}$/.test(b) && Number(b) === n),
  );
  const sm = rec.signals.find((x) => x.parsed.number === n && x.parsed.suffix === "");
  return [
    {
      tiploc: c.TIPLOC.trim(),
      desc: c.NLCDESC.trim(),
      stanox,
      signal: `CE${n}`,
      inOsm: osm.map((x) => x.id),
      smartBerthAtSameStanox: berthAtSameStanox,
      osmSmartMatch: sm?.class ?? "no OSM signal",
    },
  ];
});

// ---- 3. timetable profile ----
const areaTiplocs = new Set<string>();
for (const c of corpus.TIPLOCDATA) {
  const t = c.TIPLOC.trim();
  if (!t) continue;
  if (
    AREA_STANOX[c.STANOX.trim()] ||
    /^(CARLISLE|KINGMOOR|LONDON ROAD JN|BOG JN|PORT CARLISLE|PETTERIL|UPPERBY|CURROCK|CALDEW|CANAL JN|ROME STREET|ETTERBY|STAINTON)/.test(
      c.NLCDESC.trim(),
    )
  )
    areaTiplocs.add(t);
}
const parser = new CifParser(
  (s) =>
    runsOn(s, date) &&
    (s.locations.length === 0 || s.locations.some((l) => areaTiplocs.has(l.tiploc))),
);
const lines = createInterface({
  input: createReadStream(path("data/private/toc-full.CIF"), { encoding: "latin1" }),
  crlfDelay: Infinity,
});
for await (const line of lines) parser.push(line);
const cif = parser.finish();
const services = resolveSchedulesForDate(cif, date).filter((s) =>
  s.locations.some((l) => areaTiplocs.has(l.tiploc)),
);
const tally = (f: (s: (typeof services)[number]) => string) => {
  const m: Record<string, number> = {};
  for (const s of services) m[f(s)] = (m[f(s)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
};
const passengerCats = new Set([
  "OO",
  "XX",
  "XZ",
  "OL",
  "OU",
  "XC",
  "XD",
  "XI",
  "XR",
  "XU",
  "OS",
  "OW",
]);
const atStation = services.flatMap((s) =>
  s.locations.filter((l) => l.tiploc === "CARLILE").map((l) => ({ s, l })),
);
const hour = (t: string | null) => (t ? t.slice(0, 2) : null);
const perHour: Record<string, number> = {};
for (const { l } of atStation) {
  const h = hour(l.departure ?? l.arrival ?? l.pass);
  if (h) perHour[h] = (perHour[h] ?? 0) + 1;
}
const usedTiplocs: Record<string, number> = {};
for (const s of services)
  for (const l of s.locations)
    if (areaTiplocs.has(l.tiploc)) usedTiplocs[l.tiploc] = (usedTiplocs[l.tiploc] ?? 0) + 1;
const boundary: Record<string, number> = {};
for (const s of services) {
  const L = s.locations;
  const first = L.findIndex((l) => areaTiplocs.has(l.tiploc));
  const last = L.length - 1 - [...L].reverse().findIndex((l) => areaTiplocs.has(l.tiploc));
  const entry = first > 0 ? L[first - 1]!.tiploc : "(starts in area)";
  const exit = last < L.length - 1 ? L[last + 1]!.tiploc : "(ends in area)";
  const k = `${entry} -> ${exit}`;
  boundary[k] = (boundary[k] ?? 0) + 1;
}
const platforms: Record<string, number> = {};
for (const { l } of atStation)
  platforms[l.platform ?? "(none)"] = (platforms[l.platform ?? "(none)"] ?? 0) + 1;

const results = {
  generated: new Date().toISOString().slice(0, 10),
  inputs: {
    osm: { file: "data/raw/osm/carlisle-2026-10-27.json", version: infra.version, bbox: bb },
    smart: {
      file: "data/private/SMARTExtract.json",
      td: TD,
      rowsInTd: clRows.length,
      rowsInArea: areaRows.length,
      areaStanox: AREA_STANOX,
    },
    corpus: "data/private/CORPUSExtract.json",
    cif: { file: "data/private/toc-full.CIF", header: cif.header, date },
  },
  identifiers: {
    osmSignalsInBbox: signalsInArea.length,
    numberedOsmSignals: numbered.length,
    osmRefPatterns: tally0(numbered.map((s) => s.ref!.replace(/\d+/, "<n>"))),
    duplicateSignalKeys: rec.duplicateSignalKeys,
    uniqueAreaBerths: areaBerths.length,
    areaBerthKinds: signalBerthKinds,
    uniqueClBerthsAllLocations: allClBerths.length,
  },
  reconciliation: {
    signals: {
      ...sigCounts,
      denominator: numbered.length,
      unambiguousPct: pct(sigCounts.unambiguous, numbered.length),
    },
    berths: {
      ...berthCounts,
      denominator: areaBerths.length,
      unambiguousPct: pct(berthCounts.unambiguous, areaBerths.length),
      numericDenominator: signalBerthKinds.numeric,
      unambiguousPctOfNumeric: pct(berthCounts.unambiguous, signalBerthKinds.numeric),
    },
    sensitivityAllClBerths: { signals: count(recAllCl.signals) },
    signalDetail: rec.signals.map((m) => ({
      signal: m.signalId,
      ref: m.ref,
      class: m.class,
      berths: m.berths,
      reason: m.reason,
    })),
    berthDetail: rec.berths.map((b) => ({
      berth: b.berth.original,
      kind: b.berth.kind,
      class: b.class,
      signals: b.signals,
      reason: b.reason,
    })),
  },
  corpusSignals,
  consistency: { stepCounts, corroborationCounts, corroboration, steps, locationChecks },
  timetable: {
    areaTiplocs: [...areaTiplocs].sort(),
    servicesTouchingArea: services.length,
    byOperator: tally((s) => s.atocCode ?? "?"),
    byCategory: tally((s) => s.category ?? "?"),
    passengerVsOther: tally((s) =>
      passengerCats.has(s.category ?? "") ? "passenger" : "other (freight/ECS/etc)",
    ),
    carlisleStationEvents: atStation.length,
    carlisleStops: atStation.filter(({ l }) => l.arrival || l.departure).length,
    carlislePasses: atStation.filter(({ l }) => l.pass).length,
    carlislePlatforms: platforms,
    carlisleEventsPerHour: Object.fromEntries(Object.entries(perHour).sort()),
    timingPointsUsed: Object.fromEntries(Object.entries(usedTiplocs).sort((a, b) => b[1] - a[1])),
    entryExitPairs: Object.fromEntries(
      Object.entries(boundary)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25),
    ),
  },
};
function tally0(xs: string[]) {
  const m: Record<string, number> = {};
  for (const x of xs) m[x] = (m[x] ?? 0) + 1;
  return m;
}

writeJson(path(out), results);
const r = results.reconciliation;
console.log(
  `numbered OSM signals ${numbered.length}; unique area berths ${areaBerths.length} (${JSON.stringify(signalBerthKinds)})`,
);
console.log(`signals: ${JSON.stringify(r.signals)}`);
console.log(`berths:  ${JSON.stringify(r.berths)}`);
console.log(`sensitivity (all CL berths): ${JSON.stringify(r.sensitivityAllClBerths)}`);
console.log(`steps: ${JSON.stringify(stepCounts)}`);
console.log(
  `CORPUS signals: ${corpusSignals.map((c) => `${c.signal}(osm:${c.inOsm.length ? "y" : "n"},smart@stanox:${c.smartBerthAtSameStanox ? "y" : "n"})`).join(" ")}`,
);
console.log(`matched-signal corroboration: ${JSON.stringify(corroborationCounts)}`);
console.log(`services ${services.length}; ${JSON.stringify(results.timetable.passengerVsOther)}`);
console.log(`Wrote ${out}`);
