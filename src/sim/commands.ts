import { z } from "zod";

/**
 * Operator commands (ADR 0001, D-028). Human and AI operators use exactly these types; there
 * is no other way to request a change to authoritative state.
 */

export const OperatorRef = z.object({
  kind: z.enum(["human", "ai"]),
  id: z.string().min(1),
});
export type OperatorRef = z.infer<typeof OperatorRef>;

export const Command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_route"), routeId: z.string().min(1) }),
  z.object({ type: z.literal("cancel_route"), routeId: z.string().min(1) }),
  z.object({
    type: z.literal("move_points"),
    pointsId: z.string().min(1),
    position: z.enum(["normal", "reverse"]),
  }),
]);
export type Command = z.infer<typeof Command>;

export const CommandEnvelope = z.object({
  /** Unique per command from the issuing client; repeats are recognised, never re-applied. */
  commandId: z.string().min(1),
  operator: OperatorRef,
  /** The control area the operator acts in. */
  controlAreaId: z.string().min(1),
  /** The state version the operator based the command on; any other version is stale. */
  expectedVersion: z.number().int().min(0),
  command: Command,
});
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;

/**
 * Why a command was refused. Every code means "nothing changed".
 * - MALFORMED: the envelope does not parse.
 * - COMMAND_ID_REUSED: a known commandId arrived with a different payload.
 * - STALE: expectedVersion is not the current version.
 * - NOT_AUTHORISED: the operator is not assigned the control area, or the area does not
 *   contain the signal or points the command acts on.
 * - UNKNOWN_ELEMENT: no such route or points.
 * - ROUTE_NOT_ESTABLISHED: the route's data status is not allowed by the policy (R2).
 * - ROUTE_ALREADY_SET / ROUTE_NOT_SET: setting a set route, or cancelling one that is not set.
 * - POINTS_NOT_PROVEN: required points are not detected in a known position.
 * - POINTS_WRONG_POSITION: required points are detected in the other position.
 * - POINTS_LOCKED: points are held by a set route.
 * - POINTS_ALREADY_IN_POSITION: the move would change nothing.
 * - ROUTE_CONFLICT: a conflicting route is set.
 * - TRACK_OCCUPIED / TRACK_NOT_PROVEN_CLEAR: track is occupied, or its occupancy is unknown.
 */
export const REJECTION_CODES = [
  "MALFORMED",
  "COMMAND_ID_REUSED",
  "STALE",
  "NOT_AUTHORISED",
  "UNKNOWN_ELEMENT",
  "ROUTE_NOT_ESTABLISHED",
  "ROUTE_ALREADY_SET",
  "ROUTE_NOT_SET",
  "POINTS_NOT_PROVEN",
  "POINTS_WRONG_POSITION",
  "POINTS_LOCKED",
  "POINTS_ALREADY_IN_POSITION",
  "ROUTE_CONFLICT",
  "TRACK_OCCUPIED",
  "TRACK_NOT_PROVEN_CLEAR",
] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];
