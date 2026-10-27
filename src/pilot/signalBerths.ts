/**
 * PILOT: reconciliation of OSM signal refs with SMART train-describer berth ids.
 * Used by tools/pilot-carlisle.ts and src/reconcile/. Nothing here assigns identities in a
 * dataset; it only classifies candidate correspondences for review. Track reachability lives in
 * src/graph/ (D-025). See docs/pilots/CARLISLE_PILOT.md.
 */
import type { Signal } from "../model/index.ts";

export interface ParsedSignalRef {
  original: string;
  prefix: string;
  number: number;
  /** Trailing letters after the number, e.g. "BR" in "CE323BR". Empty if none. */
  suffix: string;
}

/** "CE323" -> {prefix CE, number 323, suffix ""}; null when the ref has no number. Original kept. */
export function parseSignalRef(ref: string): ParsedSignalRef | null {
  const m = /^([A-Z]+)\s*0*(\d+)([A-Z]*)$/.exec(ref.trim().toUpperCase());
  if (!m) return null;
  return { original: ref, prefix: m[1]!, number: Number(m[2]), suffix: m[3]! };
}

export type BerthKind =
  | "numeric" // four digits, e.g. "0323"
  | "lettered" // one letter + three digits, e.g. "A178", "X104"
  | "other"; // anything else, e.g. "COUT", "LSDR"

export interface ParsedBerth {
  td: string;
  original: string;
  kind: BerthKind;
  /** Numeric part for numeric/lettered berths. */
  number: number | null;
  letter: string | null;
}

export function parseBerth(td: string, berth: string): ParsedBerth {
  const b = berth.trim().toUpperCase();
  let m = /^(\d{4})$/.exec(b);
  if (m) return { td, original: berth, kind: "numeric", number: Number(m[1]), letter: null };
  m = /^([A-Z])(\d{3})$/.exec(b);
  if (m) return { td, original: berth, kind: "lettered", number: Number(m[2]), letter: m[1]! };
  return { td, original: berth, kind: "other", number: null, letter: null };
}

export type MatchClass =
  | "unambiguous" // one plain OSM signal and one numeric berth share prefix-free number
  | "ambiguous" // a candidate exists but more than one interpretation is possible
  | "unmatched";

export interface SignalMatch {
  signalId: string;
  ref: string;
  parsed: ParsedSignalRef;
  class: MatchClass;
  /** Candidate berth ids (original spelling). */
  berths: string[];
  reason: string;
}

export interface Reconciliation {
  signals: SignalMatch[];
  /** Berths not matched unambiguously, with candidate signals if any. */
  berths: { berth: ParsedBerth; class: MatchClass; signals: string[]; reason: string }[];
  duplicateSignalKeys: string[];
}

/**
 * Conservative matching rule (tier "unambiguous"):
 *   OSM ref = <expected prefix><n> with no suffix, exactly one such OSM signal for n,
 *   and exactly one numeric berth whose value is n (leading zeros ignored).
 * Everything else with a shared number is "ambiguous": suffixed refs (e.g. BR repeaters),
 * lettered berths (A/B/X...), wrong prefix, or duplicates on either side.
 */
export function reconcile(
  signals: Pick<Signal, "id" | "ref">[],
  berths: ParsedBerth[],
  expectedPrefix: string,
): Reconciliation {
  const parsed = signals
    .filter((s): s is Pick<Signal, "id"> & { ref: string } => !!s.ref)
    .map((s) => ({ s, p: parseSignalRef(s.ref) }))
    .filter((x): x is { s: { id: string; ref: string }; p: ParsedSignalRef } => x.p !== null);

  const plainKey = (p: ParsedSignalRef) => `${p.prefix}${p.number}${p.suffix}`;
  const keyCount = new Map<string, number>();
  for (const { p } of parsed) keyCount.set(plainKey(p), (keyCount.get(plainKey(p)) ?? 0) + 1);
  const duplicateSignalKeys = [...keyCount].filter(([, n]) => n > 1).map(([k]) => k);

  const numericByNumber = new Map<number, ParsedBerth[]>();
  const letteredByNumber = new Map<number, ParsedBerth[]>();
  for (const b of berths) {
    if (b.number === null) continue;
    const m = b.kind === "numeric" ? numericByNumber : letteredByNumber;
    m.set(b.number, [...(m.get(b.number) ?? []), b]);
  }

  const signalMatches: SignalMatch[] = parsed.map(({ s, p }) => {
    const numeric = numericByNumber.get(p.number) ?? [];
    const lettered = letteredByNumber.get(p.number) ?? [];
    const candidates = [...numeric, ...lettered].map((b) => b.original);
    const base = { signalId: s.id, ref: s.ref, parsed: p, berths: candidates };
    if (candidates.length === 0)
      return { ...base, class: "unmatched", reason: "no berth with this number" };
    const reasons: string[] = [];
    if (p.prefix !== expectedPrefix) reasons.push(`prefix ${p.prefix} is not ${expectedPrefix}`);
    if (p.suffix) reasons.push(`ref has suffix "${p.suffix}"`);
    if ((keyCount.get(plainKey(p)) ?? 0) > 1) reasons.push("ref used by more than one OSM signal");
    if (numeric.length !== 1) reasons.push(`${numeric.length} numeric berths with this number`);
    if (lettered.length > 0)
      reasons.push(`also lettered berth(s) ${lettered.map((b) => b.original).join(",")}`);
    // Lettered berths alongside a single numeric berth do not block an unambiguous match of
    // the numeric berth; they are reported separately as related berths.
    const blocking = reasons.filter((r) => !r.startsWith("also lettered"));
    return blocking.length === 0
      ? {
          ...base,
          berths: numeric.map((b) => b.original),
          class: "unambiguous",
          reason:
            `numeric berth ${numeric[0]!.original} = ${p.prefix}${p.number}` +
            (lettered.length
              ? `; related lettered berth(s) ${lettered.map((b) => b.original).join(",")} not matched`
              : ""),
        }
      : { ...base, class: "ambiguous", reason: reasons.join("; ") };
  });

  const matchedBerths = new Set(
    signalMatches.filter((m) => m.class === "unambiguous").flatMap((m) => m.berths),
  );
  const berthResults = berths.map((b) => {
    if (matchedBerths.has(b.original)) {
      const sig = signalMatches.find(
        (m) => m.class === "unambiguous" && m.berths.includes(b.original),
      )!;
      return { berth: b, class: "unambiguous" as const, signals: [sig.ref], reason: "matched" };
    }
    const cands =
      b.number === null
        ? []
        : signalMatches.filter((m) => m.parsed.number === b.number).map((m) => m.ref);
    if (b.kind === "other")
      return {
        berth: b,
        class: "unmatched" as const,
        signals: [],
        reason: "non-numeric berth (not signal-numbered)",
      };
    if (cands.length > 0) {
      return {
        berth: b,
        class: "ambiguous" as const,
        signals: cands,
        reason:
          b.kind === "lettered"
            ? `lettered berth ${b.letter}${b.number}; letter meaning unknown`
            : "candidate signal is ambiguous",
      };
    }
    return {
      berth: b,
      class: "unmatched" as const,
      signals: [],
      reason: "no OSM signal with this number",
    };
  });

  return { signals: signalMatches, berths: berthResults, duplicateSignalKeys };
}
