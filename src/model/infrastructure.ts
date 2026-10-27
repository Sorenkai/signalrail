import { z } from "zod";
import { IsoDate, LatLon, Provenance, evidenced } from "./evidence.ts";

/**
 * Physical infrastructure layer. Static, versioned, and independent of timetables and
 * signalling logic. Track is a graph: nodes are places where something happens (a switch,
 * a signal, an end of track, a junction of two ways); edges are plain track between them.
 */

export const TrackNodeKind = z.enum([
  "plain", // joins edges, or carries a signal/feature
  "switch", // points; see Points for details
  "crossing", // flat (diamond) crossing of two tracks
  "buffer_stop",
  "area_boundary", // track continues beyond the dataset's extent
  "end_unknown", // track ends in the data for no recorded reason
]);

export const TrackNode = z.object({
  id: z.string().min(1),
  kind: TrackNodeKind,
  position: LatLon.optional(),
  provenance: Provenance,
});
export type TrackNode = z.infer<typeof TrackNode>;

export const TrackEdge = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  lengthM: z.number().nonnegative().optional(),
  /** Intermediate geometry from `from` to `to`, inclusive of both ends. */
  geometry: z.array(LatLon).optional(),
  usage: z.enum(["main", "branch", "siding", "yard", "crossover", "spur", "other", "unknown"]),
  maxSpeedMph: evidenced(z.number().positive()).optional(),
  trackRef: z.string().optional(),
  provenance: Provenance,
});
export type TrackEdge = z.infer<typeof TrackEdge>;

export const LocationKind = z.enum([
  "station",
  "junction",
  "signal_box",
  "yard",
  "timing_point",
  "other",
]);

export const Location = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: LocationKind,
  position: LatLon.optional(),
  /** Reference codes. Only set when sourced; never guessed. */
  codes: z
    .object({
      tiploc: z.string().optional(),
      crs: z.string().optional(),
      stanox: z.string().optional(),
    })
    .default({}),
  provenance: Provenance,
});
export type Location = z.infer<typeof Location>;

/**
 * How a platform was linked to track, when an importer attempted it. OSM mapping only: it says
 * where contributors drew the platform and its stop position, not how the railway is signalled.
 */
export const PlatformTrackAssociation = z.object({
  /**
   * stop_area_and_outline: a stop position with the platform's ref, grouped with the platform in
   *   an OSM stop_area relation, plus track running alongside the platform outline;
   * stop_position_and_outline: as above, matched by ref and proximity instead of a relation;
   * outline_only: no stop position; track alongside the outline only;
   * none: no evidence found.
   */
  method: z.enum(["stop_area_and_outline", "stop_position_and_outline", "outline_only", "none"]),
  status: z.enum(["mapped", "ambiguous", "unresolved"]),
  stopNodeIds: z.array(z.string()),
  /** OSM stop_area relations used, e.g. "relation/1782890". */
  stopAreaRelations: z.array(z.string()),
  /** The platform outline used (record id and OSM base version of the extract it came from). */
  outline: z.object({ recordId: z.string(), version: z.string(), vertices: z.number() }).nullable(),
  /** Track edges with at least the threshold length running alongside the outline. */
  adjacentEdges: z.array(
    z.object({ edgeId: z.string(), alongM: z.number(), onStopTrack: z.boolean() }),
  ),
  note: z.string(),
});
export type PlatformTrackAssociation = z.infer<typeof PlatformTrackAssociation>;

export const Platform = z.object({
  id: z.string().min(1),
  /** Platform number/letter as displayed, e.g. "4" or "4a". */
  ref: z.string().nullable(),
  locationId: z.string().nullable(),
  position: LatLon.optional(),
  /** Track edges alongside the platform faces. Empty until evidenced. */
  edgeIds: evidenced(z.array(z.string())),
  /** Present when the importer attempted a track association (see PlatformTrackAssociation). */
  trackAssociation: PlatformTrackAssociation.optional(),
  provenance: Provenance,
});
export type Platform = z.infer<typeof Platform>;

/**
 * Physical form of the signal's function-defining component (the one that sets `function`).
 * It says nothing about mounting (see `Signal.mounting`):
 * - semaphore:    the component's form is semaphore;
 * - colour_light: the component is a main or distant signal whose form is light (a lit main or
 *                 distant signal shows colour-light aspects in the source's tagging scheme);
 * - light:        any other lit component (e.g. a shunting signal or banner repeater). Neutral:
 *                 it does not say whether the aspects are position lights, colour lights or a
 *                 banner, nor whether the signal is ground-, post- or gantry-mounted;
 * - sign:         a fixed sign (e.g. a stop board);
 * - other:        a form the importer does not recognise (kept verbatim in `components`);
 * - unknown:      the source states no form.
 * There is deliberately no "ground" type: mounting is a separate, separately evidenced fact.
 */
export const SignalType = z.enum([
  "semaphore",
  "colour_light",
  "light",
  "sign",
  "other",
  "unknown",
]);
export const SignalFunction = z.enum([
  "main", // stop signal (home/starter/section/etc. - not distinguished yet)
  "distant",
  "shunting",
  "repeater",
  "stop_board", // fixed stop sign, not a worked signal
  "other",
  "unknown",
]);

/**
 * One signal component (head or indicator) as the source states it, e.g. a main aspect, a
 * shunting aspect on the same post, or a junction route indicator. Values are verbatim source
 * values, not interpretations: `states` is the source's list of possible indications, not an
 * aspect sequence, and implies nothing about when each indication is shown.
 * Every field is `null` when the source does not state it; `null` means unknown, never "none".
 */
export const SignalComponent = z.object({
  /** Source category, e.g. OSM `railway:signal:<category>`: main, distant, shunting, route... */
  category: z.string().min(1),
  /** Source type value verbatim, e.g. "GB-NR:shunting" or "GB-NR:junction". */
  sourceType: z.string().min(1),
  /** Physical form verbatim: light, semaphore, sign, ... */
  form: z.string().nullable(),
  /** Design verbatim, e.g. feather or theatre (route indicators), combined/individual lenses. */
  design: z.string().nullable(),
  /** Possible indications verbatim, e.g. ["position_1", "off"]. Never an empty list. */
  states: z.array(z.string()).min(1).nullable(),
  /** Height design verbatim (OSM `:height`, e.g. dwarf or normal). */
  height: z.string().nullable(),
});
export type SignalComponent = z.infer<typeof SignalComponent>;

/**
 * Mounting stated by the source. Absent from this list: post or ground mounting, which no
 * source imported so far states (a track side, left or right, is not a mounting).
 * - gantry:        on a signal gantry (bridge) over the track (OSM `railway:signal:position=bridge`);
 * - overhead_line: attached to the overhead line structure (OSM `position=overhead`);
 * - in_track:      in the middle of the track, e.g. on a buffer stop (OSM `position=in_track`).
 */
export const SignalMounting = z.enum(["gantry", "overhead_line", "in_track"]);
export type SignalMounting = z.infer<typeof SignalMounting>;

/** Components whose category determines each function, in order of precedence. */
const FUNCTION_CATEGORIES: [
  Exclude<z.infer<typeof SignalFunction>, "other" | "unknown">,
  string[],
][] = [
  ["main", ["main"]],
  ["distant", ["distant"]],
  ["shunting", ["shunting", "minor"]],
  ["repeater", ["main_repeated", "distant_repeated"]],
  ["stop_board", ["stop"]],
];

/**
 * The only mapping from components to `type` and `function`. A signal's type and function
 * must equal what its components support: a capability no component states is never claimed.
 */
export function classifySignal(components: SignalComponent[]): {
  type: z.infer<typeof SignalType>;
  function: z.infer<typeof SignalFunction>;
} {
  for (const [fn, categories] of FUNCTION_CATEGORIES) {
    const c = components.find((x) => categories.includes(x.category));
    if (!c) continue;
    const type =
      c.form === "semaphore"
        ? "semaphore"
        : c.form === "light"
          ? fn === "main" || fn === "distant"
            ? "colour_light"
            : "light"
          : c.form === "sign"
            ? "sign"
            : c.form
              ? "other"
              : "unknown";
    return { type, function: fn };
  }
  return { type: "unknown", function: "unknown" };
}

export const Signal = z
  .object({
    id: z.string().min(1),
    /** Signal identity as published (e.g. a plate number), never invented. */
    ref: z.string().nullable(),
    /** Track node the signal stands at; null if the source places it off the track graph. */
    trackNodeId: z.string().nullable(),
    /** Direction of travel the signal governs: trains leaving trackNodeId towards this node. */
    facingTowardsNodeId: evidenced(z.string()),
    /** Derived from `components` by `classifySignal`; see SignalType. */
    type: SignalType,
    function: SignalFunction,
    /**
     * Every component the source states, in source order. Open-world: a capability missing
     * here (e.g. no route indicator) is unknown, not absent. Empty when the source states none.
     */
    components: z.array(SignalComponent),
    /** Mounting, only when the source states it; otherwise `value: null`, evidence unknown. */
    mounting: evidenced(SignalMounting),
    /** The source record's tags verbatim (OSM: every tag on the node), for audit. */
    sourceTags: z.record(z.string(), z.string()).optional(),
    position: LatLon.optional(),
    provenance: Provenance,
  })
  .superRefine((s, ctx) => {
    const derived = classifySignal(s.components);
    if (s.type !== derived.type || s.function !== derived.function) {
      ctx.addIssue({
        code: "custom",
        message: `type/function ${s.type}/${s.function} is not supported by the signal's components (expected ${derived.type}/${derived.function})`,
      });
    }
    if (s.mounting.value !== null && s.mounting.provenance.evidence === "unknown") {
      ctx.addIssue({ code: "custom", message: "a stated mounting needs non-unknown evidence" });
    }
  });
export type Signal = z.infer<typeof Signal>;

export const Points = z.object({
  id: z.string().min(1),
  ref: z.string().nullable(),
  trackNodeId: z.string(),
  switchType: z.enum(["simple", "double_slip", "single_slip", "three_way", "other", "unknown"]),
  /** Which adjacent node the normal/reverse lie leads to. Unknown unless sourced. */
  normalTowardsNodeId: evidenced(z.string()),
  reverseTowardsNodeId: evidenced(z.string()),
  provenance: Provenance,
});
export type Points = z.infer<typeof Points>;

/**
 * A track circuit, axle-counter section, or a simulated occupancy section. A simulated section
 * is a game construct, so it is never sourced or verified: it must be inferred, placeholder or
 * simplified. A real kind claims a real section, so it may not be simplified (audit M3; D-024).
 */
export const OccupancySection = z
  .object({
    id: z.string().min(1),
    ref: z.string().nullable(),
    kind: z.enum(["track_circuit", "axle_counter", "simulated"]),
    edgeIds: z.array(z.string()).min(1),
    provenance: Provenance,
  })
  .superRefine((o, ctx) => {
    const ev = o.provenance.evidence;
    if (o.kind === "simulated" && !["inferred", "placeholder", "simplified"].includes(ev)) {
      ctx.addIssue({
        code: "custom",
        message: `a simulated occupancy section must be inferred, placeholder or simplified, not ${ev}`,
      });
    }
    if (o.kind !== "simulated" && ev === "simplified") {
      ctx.addIssue({
        code: "custom",
        message: `a ${o.kind} claims a real section and may not be simplified; use kind simulated`,
      });
    }
  });
export type OccupancySection = z.infer<typeof OccupancySection>;

export const Infrastructure = z.object({
  datasetId: z.string().min(1),
  /** Version or snapshot of the underlying data, e.g. OSM base timestamp. */
  version: z.string().min(1),
  generated: IsoDate,
  bbox: z
    .object({ south: z.number(), west: z.number(), north: z.number(), east: z.number() })
    .optional(),
  nodes: z.array(TrackNode),
  edges: z.array(TrackEdge),
  locations: z.array(Location),
  platforms: z.array(Platform),
  signals: z.array(Signal),
  points: z.array(Points),
  occupancySections: z.array(OccupancySection),
});
export type Infrastructure = z.infer<typeof Infrastructure>;
