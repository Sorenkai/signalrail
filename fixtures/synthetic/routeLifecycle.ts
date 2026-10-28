/**
 * SYNTHETIC route-lifecycle dataset for approach-locking, route-release and overlap tests
 * (P4, D-034). Not a real railway layout; no length, route, overlap or game rule here describes
 * a real railway or a real interlocking.
 *
 * The movement layout (movement.ts) with approach track behind sig1, and optionally an overlap
 * for r1 beyond sig2:
 *
 *   A0 ==e0 400m== A ==e1 1000m== N1 ==e2 200m== P1 ==e3 300m== N2 ==e4 400m== B ==e7 600m== X
 *   (buffer)       sig0->         sig1->          \              sig2-> <-sig4
 *                                                  \==e5 300m== N3 ==e6 500m== C (buffer)
 *
 *   r0: sig0 -> sig1 over e1 (SYNTHETIC, P4)   r1..r5 as in movement.ts
 *   ov1 (withOverlap): r1's overlap, sig2 over e4 (SYNTHETIC, P4)
 */
import type { ValidationInput } from "../../src/validation/validate.ts";
import { simplified } from "./gameRules.ts";
import { syntheticMovementDataset } from "./movement.ts";

export function syntheticLifecycleDataset(opts: { withOverlap?: boolean } = {}): ValidationInput {
  const d = syntheticMovementDataset();
  const infra = d.infrastructure;

  const a = infra.nodes.find((n) => n.id === "A")!;
  infra.nodes.push({
    ...structuredClone(a),
    id: "A0",
    position: { lat: a.position!.lat, lon: a.position!.lon - 0.004 },
  });
  a.kind = "plain";
  const e1 = infra.edges.find((e) => e.id === "e1")!;
  infra.edges.push({ ...structuredClone(e1), id: "e0", from: "A0", to: "A", lengthM: 400 });

  const sig1 = infra.signals.find((s) => s.id === "sig1")!;
  infra.signals.push({
    ...structuredClone(sig1),
    id: "sig0",
    ref: "SIG0",
    trackNodeId: "A",
    facingTowardsNodeId: { ...structuredClone(sig1.facingTowardsNodeId), value: "N1" },
  });
  d.control!.areas[0]!.signalIds.push("sig0");
  d.signalling!.routes.push({
    id: "r0",
    ref: null,
    entrySignalId: "sig0",
    exitSignalId: "sig1",
    edgeIds: ["e1"],
    pointsRequired: [],
    overlapId: null,
    conflictsWith: [],
    provenance: simplified("route r0 (P4 lifecycle tests)"),
  });

  if (opts.withOverlap) {
    d.signalling!.overlaps.push({
      id: "ov1",
      signalId: "sig2",
      edgeIds: ["e4"],
      pointsRequired: [],
      provenance: simplified("overlap ov1 beyond sig2 (P4 overlap tests)"),
    });
    d.signalling!.routes.find((r) => r.id === "r1")!.overlapId = "ov1";
  }
  return d;
}
