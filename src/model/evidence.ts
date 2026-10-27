import { z } from "zod";

/**
 * Evidence levels. The first five run from strongest to weakest claim about the real railway;
 * `simplified` makes no such claim. See docs/DATA_MODEL.md and DECISION_LOG D-022.
 * - sourced:     taken directly from one named, registered source
 * - verified:    sourced and independently confirmed by at least one other registered source
 * - inferred:    derived by reasoning from sourced data; `note` must state the reasoning
 * - placeholder: deliberate stand-in so software can run; `note` must say what would replace it
 * - unknown:     not known; consumers must handle it explicitly
 * - simplified:  a deliberate game simplification, kept on purpose and not a real-world fact;
 *                `note` must say what is simplified and what the real arrangement is, or that
 *                it is unknown. Sources, if any, are the real data being simplified.
 */
export const EVIDENCE_LEVELS = [
  "sourced",
  "verified",
  "inferred",
  "placeholder",
  "unknown",
  "simplified",
] as const;
export const EvidenceLevel = z.enum(EVIDENCE_LEVELS);
export type EvidenceLevel = z.infer<typeof EvidenceLevel>;

/** ISO calendar date, e.g. 2026-10-27. */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const SourceRef = z.object({
  /** Id of an entry in the source registry (data/sources.json). */
  sourceId: z.string().min(1),
  /** Identifier of the record within the source, e.g. "node/123456" for OSM. */
  recordId: z.string().optional(),
  /** Version, snapshot timestamp or edition of the source used. */
  version: z.string().optional(),
  retrieved: IsoDate.optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const Provenance = z
  .object({
    evidence: EvidenceLevel,
    sources: z.array(SourceRef).default([]),
    /** Required for inferred (reasoning), placeholder (what replaces it) and simplified. */
    note: z.string().optional(),
  })
  .superRefine((p, ctx) => {
    if ((p.evidence === "sourced" || p.evidence === "verified") && p.sources.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: `${p.evidence} evidence requires at least one source`,
      });
    }
    if (p.evidence === "verified" && new Set(p.sources.map((s) => s.sourceId)).size < 2) {
      ctx.addIssue({
        code: "custom",
        message: "verified evidence requires at least two distinct sources",
      });
    }
    if (
      (p.evidence === "inferred" || p.evidence === "placeholder" || p.evidence === "simplified") &&
      !p.note?.trim()
    ) {
      ctx.addIssue({ code: "custom", message: `${p.evidence} evidence requires a note` });
    }
  });
export type Provenance = z.infer<typeof Provenance>;

/** A single attribute whose value may be known to a different evidence level than its owner. */
export const evidenced = <T extends z.ZodType>(value: T) =>
  z.object({ value: value.nullable(), provenance: Provenance });

export const LatLon = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
export type LatLon = z.infer<typeof LatLon>;
