import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  Dataset,
  GameplayCorrection,
  Provenance,
  Signal,
  SourceRegistry,
} from "../src/model/index.ts";
import { syntheticDataset } from "../fixtures/synthetic/dataset.ts";

describe("Provenance", () => {
  it("requires sources for sourced and verified evidence", () => {
    expect(Provenance.safeParse({ evidence: "sourced", sources: [] }).success).toBe(false);
    expect(
      Provenance.safeParse({ evidence: "sourced", sources: [{ sourceId: "x" }] }).success,
    ).toBe(true);
  });

  it("requires two distinct sources for verified evidence", () => {
    const one = {
      evidence: "verified",
      sources: [{ sourceId: "a" }, { sourceId: "a", recordId: "2" }],
    };
    expect(Provenance.safeParse(one).success).toBe(false);
    expect(
      Provenance.safeParse({ ...one, sources: [{ sourceId: "a" }, { sourceId: "b" }] }).success,
    ).toBe(true);
  });

  it("requires a note for inferred and placeholder evidence", () => {
    for (const evidence of ["inferred", "placeholder"]) {
      expect(Provenance.safeParse({ evidence, sources: [] }).success).toBe(false);
      expect(Provenance.safeParse({ evidence, sources: [], note: "why" }).success).toBe(true);
    }
  });

  it("requires a note for a deliberate simplification, which needs no source", () => {
    expect(Provenance.safeParse({ evidence: "simplified", sources: [] }).success).toBe(false);
    expect(
      Provenance.safeParse({
        evidence: "simplified",
        note: "points move instantly in the game; real swing time is unknown",
      }).success,
    ).toBe(true);
  });

  it("allows unknown with no sources", () => {
    expect(Provenance.safeParse({ evidence: "unknown" }).success).toBe(true);
  });

  it("rejects undefined evidence levels", () => {
    expect(Provenance.safeParse({ evidence: "real", sources: [{ sourceId: "x" }] }).success).toBe(
      false,
    );
  });
});

describe("Dataset schema", () => {
  it("parses the synthetic dataset", () => {
    expect(() => Dataset.parse(syntheticDataset())).not.toThrow();
  });

  it("rejects an edge with no provenance", () => {
    const d = syntheticDataset();
    // @ts-expect-error deliberately invalid
    delete d.infrastructure.edges[0].provenance;
    expect(Dataset.safeParse(d).success).toBe(false);
  });
});

describe("source registry", () => {
  it("data/sources.json matches the schema", () => {
    const json = JSON.parse(readFileSync(new URL("../data/sources.json", import.meta.url), "utf8"));
    const reg = SourceRegistry.parse(json);
    expect(reg.sources.length).toBeGreaterThan(0);
  });
});

/** SYNTHETIC signal used to probe the Signal schema; not a real signal. */
const syntheticSignal = () => {
  const prov = { evidence: "sourced" as const, sources: [{ sourceId: "synthetic-fixture" }] };
  return {
    id: "sig-x",
    ref: "SYX",
    trackNodeId: "N1",
    facingTowardsNodeId: { value: "N2", provenance: prov },
    type: "light",
    function: "shunting",
    components: [
      {
        category: "shunting",
        sourceType: "GB-NR:shunting",
        form: "light",
        design: null,
        states: null,
        height: null,
      },
    ],
    mounting: { value: null, provenance: { evidence: "unknown", sources: [] } },
    provenance: prov,
  };
};

describe("Signal schema (audit M1, M2)", () => {
  it("accepts a light shunting signal with unknown mounting", () => {
    expect(Signal.safeParse(syntheticSignal()).success).toBe(true);
  });

  it("has no ground type: mounting is not part of the signal type", () => {
    expect(Signal.safeParse({ ...syntheticSignal(), type: "ground" }).success).toBe(false);
  });

  it("rejects a type or function that the components do not support", () => {
    expect(Signal.safeParse({ ...syntheticSignal(), type: "colour_light" }).success).toBe(false);
    expect(Signal.safeParse({ ...syntheticSignal(), function: "main" }).success).toBe(false);
    expect(
      Signal.safeParse({ ...syntheticSignal(), components: [], function: "shunting" }).success,
    ).toBe(false);
  });

  it("rejects a stated mounting without evidence, and an empty list of states", () => {
    const s = syntheticSignal();
    expect(
      Signal.safeParse({ ...s, mounting: { value: "gantry", provenance: s.mounting.provenance } })
        .success,
    ).toBe(false);
    expect(
      Signal.safeParse({ ...s, components: [{ ...s.components[0]!, states: [] }] }).success,
    ).toBe(false);
  });
});

describe("GameplayCorrection provenance", () => {
  const correction = (evidence: string) => ({
    id: "gc-1",
    kind: "add_buffer_stop",
    targetIds: ["N1"],
    description: "SYNTHETIC correction",
    status: "proposed",
    provenance: { evidence, sources: [{ sourceId: "synthetic-fixture" }], note: "why" },
  });

  it("accepts a simplification but never a source fact", () => {
    expect(GameplayCorrection.safeParse(correction("simplified")).success).toBe(true);
    expect(GameplayCorrection.safeParse(correction("sourced")).success).toBe(false);
  });
});
