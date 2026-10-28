/**
 * SYNTHETIC timetable fixtures for P5 service tests (D-035). Not a real railway layout, not a
 * real timetable and not a real service: every UID, headcode, TIPLOC, time and pattern here is
 * invented for tests and labelled synthetic.
 *
 * The lifecycle layout (routeLifecycle.ts) with an entry fringe fr-a on cut-a over e0:
 *
 *   A0 ==e0 400m== A ==e1 1000m== N1 ==e2 200m== P1 ==e3 300m== N2 ==e4 400m== B ==e7== X
 *   (cut-a: outside A0, inside A)   sig0->  sig1->                    (cut-b: inside N2, outside B)
 *
 *   ra: fr-a -> sig0 over e0 (SYNTHETIC, P5)   r0: sig0 -> sig1   r1: sig1 -> sig2 (pts1 normal)
 *   r5: sig2 -> fr-b. (r3 runs sig1 -> fr-b past main signal sig2, so no train can use it whole.)
 *
 * Synthetic timetable: services run SYNORG > SYNBEF > SYNSTA > SYNJN > SYNAFT > SYNDST, where
 * SYNSTA and SYNJN are the play-area TIPLOCs. Pattern pat-syn maps SYNBEF > SYNSTA(platform 1)
 * > SYNJN > SYNAFT onto ra, r0, r1, r5 from fr-a to fr-b.
 */
import type {
  Call,
  Service,
  ServicePatternsFile,
  TimetableSnapshot,
} from "../../src/model/index.ts";
import type { ValidationInput } from "../../src/validation/validate.ts";
import { SYNTHETIC_SOURCE_ID } from "./dataset.ts";
import { simplified } from "./gameRules.ts";
import { syntheticLifecycleDataset } from "./routeLifecycle.ts";

export const SYN_AREA_TIPLOCS = ["SYNJN", "SYNSTA"];

export function syntheticTimetableDataset(): ValidationInput {
  const d = syntheticLifecycleDataset();
  d.infrastructure.nodes.find((n) => n.id === "A0")!.kind = "area_boundary";
  d.playableArea!.cuts.push({
    ...structuredClone(d.playableArea!.cuts[0]!),
    id: "cut-a",
    name: "SYNTHETIC cut at A0",
    edgeId: "e0",
    insideNodeId: "A",
    outsideNodeId: "A0",
  });
  d.gameRules!.fringeEndpoints.push({
    id: "fr-a",
    cutId: "cut-a",
    use: ["entry"],
    provenance: simplified("trains enter play at cut-a"),
  });
  d.control!.boundaries.push({
    ...structuredClone(d.control!.boundaries[0]!),
    id: "bd-2",
    edgeId: "e0",
    cutId: "cut-a",
  });
  d.signalling!.routes.push({
    id: "ra",
    ref: null,
    entrySignalId: null,
    entryFringeId: "fr-a",
    exitSignalId: "sig0",
    edgeIds: ["e0"],
    pointsRequired: [],
    overlapId: null,
    conflictsWith: [],
    provenance: simplified("route ra (P5 service tests)"),
  });
  return d;
}

export function syntheticPatterns(
  o: Partial<ServicePatternsFile["patterns"][number]> = {},
): ServicePatternsFile {
  return {
    datasetId: "synthetic",
    patterns: [
      {
        id: "pat-syn",
        description: "SYNTHETIC pattern",
        before: { tiploc: "SYNBEF" },
        through: [{ tiploc: "SYNSTA", platform: "1" }, { tiploc: "SYNJN" }],
        after: { tiploc: "SYNAFT" },
        entryFringeId: "fr-a",
        exitFringeId: "fr-b",
        routeIds: ["ra", "r0", "r1", "r5"],
        provenance: simplified("SYNTHETIC service pattern"),
        ...o,
      },
    ],
  };
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Day offsets by the I-009 rule: a time earlier on the clock than the previous is next day. */
function withOffsets(calls: Omit<Call, "dayOffset">[]): Call[] {
  let off = 0;
  let prev = -1;
  return calls.map((c) => {
    let first: number | null = null;
    for (const t of [c.arrival, c.pass, c.departure]) {
      if (t === null) continue;
      const m = toMin(t);
      if (m < prev) off++;
      prev = m;
      if (first === null) first = off;
    }
    return { ...c, dayOffset: first ?? off };
  });
}

const call = (
  tiploc: string,
  kind: Call["kind"],
  times: { arr?: string; dep?: string; pass?: string },
  platform: string | null = null,
): Omit<Call, "dayOffset"> => ({
  tiploc,
  kind,
  arrival: times.arr ?? null,
  departure: times.dep ?? null,
  pass: times.pass ?? null,
  publicArrival: null,
  publicDeparture: null,
  platform,
  line: null,
  path: null,
  activities: [],
});

/**
 * A SYNTHETIC service. `before` is the time it passes SYNBEF; SYNSTA, SYNJN and SYNAFT follow
 * at the given times (default: +5, +6, +8 minutes). `stop` makes SYNSTA a call (arr/dep).
 */
export function syntheticService(o: {
  uid: string;
  runDate: string;
  before: string;
  sta?: string;
  jn?: string;
  after?: string;
  stop?: boolean;
  platform?: string | null;
  headcode?: string;
  beforeTiploc?: string;
}): Service {
  const plus = (t: string, m: number) => {
    const v = (toMin(t) + m) % 1440;
    return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
  };
  const sta = o.sta ?? plus(o.before, 5);
  const jn = o.jn ?? plus(sta, 1);
  const after = o.after ?? plus(jn, 2);
  return {
    id: `${o.uid}:${o.runDate}`,
    uid: o.uid,
    runDate: o.runDate,
    headcode: o.headcode ?? "9Z99",
    operatorCode: null,
    category: "XX",
    powerType: null,
    stpIndicator: "P",
    calls: withOffsets([
      call("SYNORG", "origin", { dep: plus(o.before, -10) }),
      call(o.beforeTiploc ?? "SYNBEF", "intermediate", { pass: o.before }),
      call(
        "SYNSTA",
        "intermediate",
        o.stop ? { arr: sta, dep: plus(sta, 1) } : { pass: sta },
        o.platform === undefined ? "1" : o.platform,
      ),
      call("SYNJN", "intermediate", { pass: o.stop ? plus(jn, 1) : jn }),
      call("SYNAFT", "intermediate", { pass: o.stop ? plus(after, 1) : after }),
      call("SYNDST", "destination", { arr: plus(after, 10) }),
    ]),
    window: "within",
    provenance: {
      evidence: "sourced",
      sources: [{ sourceId: SYNTHETIC_SOURCE_ID, recordId: `SYNTHETIC ${o.uid}` }],
    },
  };
}

/** A SYNTHETIC dated snapshot holding `services`. */
export function syntheticSnapshot(
  date: string,
  services: Service[],
  o: { clockChangeInWindow?: boolean } = {},
): TimetableSnapshot {
  return {
    id: `synthetic-${date}`,
    date,
    extract: {
      sourceId: SYNTHETIC_SOURCE_ID,
      fileRef: null,
      extractedAt: null,
      validFrom: null,
      validTo: null,
    },
    convention: {
      kind: "area_time_window",
      windowStart: "00:00",
      timeZone: "Europe/London",
      clockChangeInWindow: o.clockChangeInWindow ?? false,
    },
    import: {
      file: "SYNTHETIC",
      schedulesRead: services.length,
      associationsRead: 0,
      skippedRecords: {},
      unknownRecordTypes: [],
      parseErrors: 0,
      areaTiplocs: [...SYN_AREA_TIPLOCS],
      deferredTiplocs: [],
      previousDayOutsideWindow: 0,
    },
    services,
    associations: [],
    excluded: [],
  };
}
