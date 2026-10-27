import { z } from "zod";
import { IsoDate } from "./evidence.ts";

export const SourceAccess = z.enum([
  "public", // downloadable without an account
  "registration", // free account required; the user must obtain files or credentials
  "licensed", // paid or contract licence required
  "reference-only", // consulted by humans; not imported
]);

export const SourceStatus = z.enum(["in-use", "planned", "candidate", "rejected"]);

export const DataSource = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lower-case kebab id"),
  name: z.string().min(1),
  publisher: z.string().min(1),
  url: z.url(),
  access: SourceAccess,
  accessNotes: z.string().optional(),
  licence: z.object({
    name: z.string().min(1),
    url: z.url().optional(),
    /** True when the licence terms have been read from the publisher, not assumed. */
    confirmed: z.boolean(),
  }),
  /** Exact attribution text to display, or null if none is required/known. */
  attribution: z.string().nullable(),
  /** Restrictions such as share-alike, no branding, no endorsement. */
  obligations: z.array(z.string()).default([]),
  status: SourceStatus,
  /**
   * True only for a source that states interlocking behaviour (routes, overlaps, conflicts,
   * point requirements): a control table, a signalling plan with route tables, or equivalent.
   * Track layout (OSM) and train-movement observations (SMART, TD) do not qualify. Route and
   * overlap provenance labelled sourced/verified must cite such a source (D-024).
   */
  interlockingAuthority: z.boolean().default(false),
  /** Dates this project actually retrieved data from the source (never planned dates). */
  retrievals: z
    .array(z.object({ date: IsoDate, version: z.string(), description: z.string() }))
    .default([]),
  notes: z.string().optional(),
});
export type DataSource = z.infer<typeof DataSource>;

export const SourceRegistry = z.object({
  $comment: z.string().optional(),
  sources: z.array(DataSource),
});
export type SourceRegistry = z.infer<typeof SourceRegistry>;
