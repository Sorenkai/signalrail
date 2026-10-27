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

export const Platform = z.object({
  id: z.string().min(1),
  /** Platform number/letter as displayed, e.g. "4" or "4a". */
  ref: z.string().nullable(),
  locationId: z.string().nullable(),
  position: LatLon.optional(),
  /** Track edges alongside the platform faces. Empty until evidenced. */
  edgeIds: evidenced(z.array(z.string())),
  provenance: Provenance,
});
export type Platform = z.infer<typeof Platform>;

export const SignalType = z.enum([
  "semaphore",
  "colour_light",
  "ground",
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

export const Signal = z.object({
  id: z.string().min(1),
  /** Signal identity as published (e.g. a plate number), never invented. */
  ref: z.string().nullable(),
  /** Track node the signal stands at; null if the source places it off the track graph. */
  trackNodeId: z.string().nullable(),
  /** Direction of travel the signal governs: trains leaving trackNodeId towards this node. */
  facingTowardsNodeId: evidenced(z.string()),
  type: SignalType,
  function: SignalFunction,
  position: LatLon.optional(),
  provenance: Provenance,
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

/** A track circuit, axle-counter section, or a simulated occupancy section. */
export const OccupancySection = z.object({
  id: z.string().min(1),
  ref: z.string().nullable(),
  kind: z.enum(["track_circuit", "axle_counter", "simulated"]),
  edgeIds: z.array(z.string()).min(1),
  provenance: Provenance,
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
