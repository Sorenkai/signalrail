import { describe, expect, it } from "vitest";
import { DirectedTrack } from "../src/graph/directedTrack.ts";
import { parseBerth, parseSignalRef, reconcile } from "../src/pilot/signalBerths.ts";
import type { Infrastructure } from "../src/model/index.ts";

describe("identifier parsing (originals retained)", () => {
  it("parses signal refs conservatively", () => {
    expect(parseSignalRef("CE323")).toEqual({
      original: "CE323",
      prefix: "CE",
      number: 323,
      suffix: "",
    });
    expect(parseSignalRef("CE323BR")).toMatchObject({ number: 323, suffix: "BR" });
    expect(parseSignalRef("ce007")).toMatchObject({ original: "ce007", prefix: "CE", number: 7 });
    expect(parseSignalRef("GF1A?")).toBeNull();
  });

  it("classifies berths", () => {
    expect(parseBerth("ZZ", "0323")).toMatchObject({
      kind: "numeric",
      number: 323,
      original: "0323",
    });
    expect(parseBerth("ZZ", "X323")).toMatchObject({ kind: "lettered", number: 323, letter: "X" });
    expect(parseBerth("ZZ", "COUT")).toMatchObject({ kind: "other", number: null });
  });
});

describe("reconcile (synthetic ids)", () => {
  const berths = ["0001", "0002", "A002", "0003", "0004", "X005", "COUT"].map((b) =>
    parseBerth("ZZ", b),
  );
  const signals = [
    { id: "s1", ref: "CE1" }, // unambiguous
    { id: "s2", ref: "CE2" }, // unambiguous numeric; lettered A002 reported as related
    { id: "s3a", ref: "CE3" }, // duplicate ref -> ambiguous
    { id: "s3b", ref: "CE3" },
    { id: "s4", ref: "XY4" }, // wrong prefix -> ambiguous
    { id: "s5", ref: "CE5" }, // only lettered berth -> ambiguous
    { id: "s6", ref: "CE6" }, // no berth -> unmatched
    { id: "s1r", ref: "CE1BR" }, // suffix -> ambiguous
  ];
  const r = reconcile(signals, berths, "CE");
  const cls = Object.fromEntries(r.signals.map((m) => [m.signalId, m.class]));

  it("applies the conservative tiers", () => {
    expect(cls).toEqual({
      s1: "unambiguous",
      s2: "unambiguous",
      s3a: "ambiguous",
      s3b: "ambiguous",
      s4: "ambiguous",
      s5: "ambiguous",
      s6: "unmatched",
      s1r: "ambiguous",
    });
    expect(r.duplicateSignalKeys).toEqual(["CE3"]);
  });

  it("reports berths: matched, lettered candidates, non-numeric", () => {
    const b = Object.fromEntries(r.berths.map((x) => [x.berth.original, x.class]));
    expect(b).toMatchObject({
      "0001": "unambiguous",
      A002: "ambiguous",
      X005: "ambiguous",
      COUT: "unmatched",
    });
  });
});

describe("DirectedTrack (synthetic Y)", () => {
  // T --- J (switch) --- L1 (bearing slightly left), J --- L2 (slightly right); legs may not connect.
  const node = (id: string, lat: number, lon: number) => ({
    id,
    kind: "plain" as const,
    position: { lat, lon },
    provenance: { evidence: "unknown" as const, sources: [] },
  });
  const edge = (id: string, from: string, to: string) => ({
    id,
    from,
    to,
    lengthM: 100,
    usage: "main" as const,
    provenance: { evidence: "unknown" as const, sources: [] },
  });
  const infra = {
    nodes: [
      node("T", 52, -1.003),
      node("J", 52, -1.002),
      node("L1", 52.0003, -1.001),
      node("L2", 51.9997, -1.001),
    ],
    edges: [edge("e0", "T", "J"), edge("e1", "J", "L1"), edge("e2", "J", "L2")],
  } as Pick<Infrastructure, "nodes" | "edges">;
  const t = new DirectedTrack(infra);

  it("allows toe-to-leg movement and respects the target's facing", () => {
    expect(t.distance("T", "J", "L1", null)).toBe(200);
    expect(t.distance("T", "J", "L1", "J")).toBeNull(); // would meet L1's signal head-on
  });

  it("forbids leg-to-leg movement through the switch", () => {
    expect(t.distance("L1", "J", "L2", null)).toBeNull();
    expect(t.distance("L1", "J", "T", null)).toBe(200);
  });
});
