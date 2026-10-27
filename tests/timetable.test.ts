/**
 * CIF completeness, the operating-day convention and timetable validation (R4, D-026).
 * Every schedule, UID, TIPLOC and date here is SYNTHETIC.
 */
import { describe, expect, it } from "vitest";
import { aa, bs, bx, cr, hd, li, lo, lt, record } from "../fixtures/synthetic/cif.ts";
import { CifParser, parseCif } from "../src/import/cif/parseCif.ts";
import {
  buildSnapshot,
  dayOffsets,
  ukClockChangeOn,
  type SnapshotOptions,
} from "../src/import/cif/snapshot.ts";
import { TimetableSnapshot } from "../src/model/index.ts";
import { validateTimetables } from "../src/validation/timetable.ts";

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);
const D = "2026-11-04"; // a Wednesday

/**
 * Z10001: daily, SYNA 23:50 -> SYNC 00:15 (crosses midnight).
 * Z10002: daily, SYNB 08:00 -> SYNM -> SYNC 08:20 (a change en route at SYNM).
 * Z10003: daily, SYNC 08:30 -> SYNX 09:00; joined at SYNX (JJ) by Z10008.
 * Z10007: daily, SYNX 23:50 -> SYNC 00:15: reaches the area only after midnight.
 * Z10008: daily, SYNY 08:40 -> SYNX 08:55: never touches the area.
 * Z10004: Mon-Fri, SYND 10:00 -> SYNE 10:30: only deferred TIPLOCs.
 * Z10005: daily, SYNB 12:00 -> SYNC 12:30, but an overlay on D runs SYNX -> SYNY instead.
 * Z10006: Wed only, bank-holiday flag X, SYNB 14:00 -> SYNC 14:20.
 */
function extract(extra: string[] = []) {
  return [
    hd("DFSYN01"),
    aa({
      main: "Z10003",
      assoc: "Z10008",
      from: "261101",
      to: "261130",
      category: "JJ",
      dateInd: "S",
      location: "SYNX",
      type: "P",
      stp: "P",
    }),
    aa({
      main: "Z10001",
      assoc: "Z10002",
      from: "261101",
      to: "261130",
      category: "NP",
      dateInd: "N",
      location: "SYNC",
      type: "O",
      stp: "P",
    }),
    aa({
      main: "Z10002",
      assoc: "Z19999",
      from: "261101",
      to: "261130",
      category: "VV",
      dateInd: "S",
      location: "SYNB",
      type: "P",
      stp: "P",
    }),
    bs({
      uid: "Z10001",
      from: "261101",
      to: "261130",
      days: "1111111",
      headcode: "1Z01",
      stp: "P",
    }),
    bx("ZZ"),
    lo("SYNA", "2350 ", "2350"),
    lt("SYNC", "0015 "),
    bs({
      uid: "Z10002",
      from: "261101",
      to: "261130",
      days: "1111111",
      headcode: "1Z02",
      stp: "P",
    }),
    bx("ZZ"),
    lo("SYNB", "0800 ", "0800"),
    cr("SYNM", { headcode: "2Z02", power: "DMU" }),
    li("SYNM", { pass: "0810 " }),
    lt("SYNC", "0820 "),
    bs({
      uid: "Z10003",
      from: "261101",
      to: "261130",
      days: "1111111",
      headcode: "1Z03",
      stp: "P",
    }),
    bx("ZZ"),
    lo("SYNC", "0830 ", "0830"),
    lt("SYNX", "0900 "),
    bs({
      uid: "Z10004",
      from: "261101",
      to: "261130",
      days: "1111100",
      headcode: "6Z04",
      stp: "P",
    }),
    bx("ZZ"),
    lo("SYND", "1000 ", "0000"),
    lt("SYNE", "1030 "),
    bs({
      uid: "Z10005",
      from: "261101",
      to: "261130",
      days: "1111111",
      headcode: "1Z05",
      stp: "P",
    }),
    bx("ZZ"),
    lo("SYNB", "1200 ", "1200"),
    lt("SYNC", "1230 "),
    bs({
      uid: "Z10005",
      from: "261104",
      to: "261104",
      days: "0010000",
      headcode: "1Z05",
      stp: "O",
    }),
    bx("ZZ"),
    lo("SYNX", "1200 ", "1200"),
    lt("SYNY", "1230 "),
    bs({
      uid: "Z10006",
      from: "261101",
      to: "261130",
      days: "0010000",
      headcode: "1Z06",
      stp: "P",
    }).replace(/^(.{28})./, "$1X"),
    bx("ZZ"),
    lo("SYNB", "1400 ", "1400"),
    lt("SYNC", "1420 "),
    bs({
      uid: "Z10007",
      from: "261101",
      to: "261130",
      days: "1111111",
      headcode: "1Z07",
      stp: "P",
    }),
    bx("ZZ"),
    lo("SYNX", "2350 ", "2350"),
    lt("SYNC", "0015 "),
    bs({
      uid: "Z10008",
      from: "261101",
      to: "261130",
      days: "1111111",
      headcode: "1Z08",
      stp: "P",
    }),
    bx("ZZ"),
    lo("SYNY", "0840 ", "0840"),
    lt("SYNX", "0855 "),
    ...extra,
    record("ZZ", []),
  ].join("\n");
}

const area = new Set(["SYNA", "SYNB", "SYNC", "SYNM"]);
const deferred = new Set(["SYND", "SYNE"]);

/** Parses like tools/import-cif.ts: keeps area/deferred schedules, indexes everything. */
function snapshot(opts: Partial<SnapshotOptions> = {}, text = extract()) {
  const parser = new CifParser(
    (s) =>
      s.locations.length === 0 ||
      s.locations.some((l) => area.has(l.tiploc) || deferred.has(l.tiploc)),
    { index: true },
  );
  for (const line of text.split("\n")) parser.push(line);
  const cif = parser.finish();
  return buildSnapshot(cif, D, {
    id: "syn",
    sourceId: "synthetic-fixture",
    areaTiplocs: area,
    deferredTiplocs: deferred,
    index: parser.index,
    calendar: { sourceId: "synthetic-fixture", file: "synthetic", bankHolidays: [] },
    importInfo: {
      file: "synthetic",
      schedulesRead: parser.scheduleCount,
      associationsRead: cif.associations.length,
      skippedRecords: cif.skippedRecords,
      unknownRecordTypes: cif.unknownRecordTypes,
      parseErrors: cif.errors.length,
    },
    ...opts,
  });
}

describe("CIF records: associations, change en route, completeness", () => {
  const cif = parseCif(extract());

  it("parses every association field", () => {
    expect(cif.errors).toEqual([]);
    expect(cif.associations).toHaveLength(3);
    expect(cif.associations[1]).toMatchObject({
      mainUid: "Z10001",
      assocUid: "Z10002",
      startDate: "2026-11-01",
      endDate: "2026-11-30",
      category: "NP",
      dateIndicator: "N",
      location: "SYNC",
      associationType: "O",
      stpIndicator: "P",
    });
    expect(cif.associations[1]!.daysRun).toEqual(Array(7).fill(true));
  });

  it("parses a cancellation association, which has no category", () => {
    const c = parseCif(
      aa({
        main: "Z10001",
        assoc: "Z10002",
        from: "261104",
        to: "261104",
        days: "0010000",
        location: "SYNC",
        stp: "C",
      }),
    );
    expect(c.associations[0]).toMatchObject({
      category: null,
      dateIndicator: null,
      stpIndicator: "C",
    });
  });

  it("attaches a change en route to the location that follows it", () => {
    const s = cif.schedules.find((x) => x.uid === "Z10002")!;
    expect(s.changesEnRoute).toEqual([
      expect.objectContaining({
        tiploc: "SYNM",
        locationIndex: 1,
        headcode: "2Z02",
        powerType: "DMU",
        speed: "100",
      }),
    ]);
  });

  it("reports malformed associations and keeps parsing", () => {
    const bad = parseCif(
      [
        aa({ main: "Z10001", assoc: "Z10002", from: "26XX01", location: "SYNC", stp: "P" }),
        aa({
          main: "Z10001",
          assoc: "Z10002",
          from: "261101",
          category: "QQ",
          location: "SYNC",
          stp: "P",
        }),
        aa({
          main: "1234",
          assoc: "Z10002",
          from: "261101",
          category: "JJ",
          location: "SYNC",
          stp: "P",
        }),
        bs({
          uid: "Z10001",
          from: "261101",
          to: "261130",
          days: "1111111",
          headcode: "1Z01",
          stp: "P",
        }),
        lo("SYNA", "2350 ", "2350"),
        lt("SYNC", "0015 "),
      ].join("\n"),
    );
    expect(bad.errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/invalid start date/),
      expect.stringMatching(/unknown association category "QQ"/),
      expect.stringMatching(/invalid train UID/),
    ]);
    expect(bad.associations).toHaveLength(0);
    expect(bad.schedules).toHaveLength(1);
  });

  it("reports a CR outside a schedule, a CR naming the wrong location, and a dangling CR", () => {
    expect(parseCif(cr("SYNM")).errors[0]!.message).toMatch(/CR outside/);
    const wrong = parseCif(
      [
        bs({
          uid: "Z10002",
          from: "261101",
          to: "261130",
          days: "1111111",
          headcode: "1Z02",
          stp: "P",
        }),
        lo("SYNB", "0800 ", "0800"),
        cr("SYNQ"),
        li("SYNM", { pass: "0810 " }),
        lt("SYNC", "0820 "),
      ].join("\n"),
    );
    expect(wrong.errors[0]!.message).toMatch(/CR at SYNQ is followed by LI at SYNM/);
    const dangling = parseCif(
      [
        bs({
          uid: "Z10002",
          from: "261101",
          to: "261130",
          days: "1111111",
          headcode: "1Z02",
          stp: "P",
        }),
        lo("SYNB", "0800 ", "0800"),
        cr("SYNM"),
        bs({
          uid: "Z10003",
          from: "261101",
          to: "261130",
          days: "1111111",
          headcode: "1Z03",
          stp: "P",
        }),
      ].join("\n"),
    );
    expect(dangling.errors.map((e) => e.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/not followed by a location/)]),
    );
  });

  it("flags a schedule that ends without LT, and an LO after other locations", () => {
    const cut = parseCif(
      [
        bs({
          uid: "Z10002",
          from: "261101",
          to: "261130",
          days: "1111111",
          headcode: "1Z02",
          stp: "P",
        }),
        lo("SYNB", "0800 ", "0800"),
        li("SYNM", { pass: "0810 " }),
        lo("SYNB", "0815 ", "0815"),
        record("ZZ", []),
      ].join("\n"),
    );
    expect(cut.errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/LO after other locations/),
      expect.stringMatching(/ends without an LT/),
    ]);
    expect(cut.schedules[0]!.complete).toBe(false);
  });

  it("reports TIPLOC records and unknown record types instead of dropping them", () => {
    const r = parseCif([record("TI", [[2, "SYNA   "]]), record("QX", []), extract()].join("\n"));
    expect(r.skippedRecords).toEqual({ TI: 1, QX: 1 });
    expect(r.unknownRecordTypes).toEqual(["QX"]);
  });
});

describe("operating day: area-time window from 00:00 (D-026)", () => {
  const snap = snapshot();
  const svc = (id: string) => snap.services.find((s) => s.id === id);

  it("derives day offsets from the times, rolling over at midnight", () => {
    expect(
      dayOffsets([
        { arrival: null, pass: null, departure: "23:50" },
        { arrival: "23:58", pass: null, departure: "00:02" },
        { arrival: "00:15", pass: null, departure: null },
      ]).offsets,
    ).toEqual([0, 0, 1]);
  });

  it("uses every time at an area call, so a departure after midnight counts", () => {
    // Regression: the window used only each call's first time, so a train arriving at an area
    // call at 23:58 and leaving at 00:02 was marked "within" (found by validation on real data).
    const text = extract([
      bs({
        uid: "Z10009",
        from: "261101",
        to: "261130",
        days: "1111111",
        headcode: "1Z09",
        stp: "P",
      }),
      bx("ZZ"),
      lo("SYNX", "2340 ", "2340"),
      li("SYNB", { arr: "2358 ", dep: "0002 " }),
      lt("SYNY", "0030 "),
    ]);
    const s = snapshot({}, text).services.find((x) => x.id === `Z10009:${D}`)!;
    expect(s.window).toBe("ends_after");
    expect(s.calls.map((c) => c.dayOffset)).toEqual([0, 0, 1]);
  });

  it("includes a train that started the previous day and reaches the area after midnight", () => {
    const s = svc(`Z10001:2026-11-03`)!;
    expect(s.calls.map((c) => c.dayOffset)).toEqual([0, 1]);
    expect(s.window).toBe("starts_before");
  });

  it("lists, rather than drops, a train of D that reaches the area only after the window", () => {
    expect(svc(`Z10007:${D}`)).toBeUndefined();
    expect(snap.excluded).toContainEqual(
      expect.objectContaining({ serviceId: `Z10007:${D}`, reason: "area_times_outside_window" }),
    );
    // The previous day's run of the same train is in this window, entirely after midnight.
    expect(svc(`Z10007:2026-11-03`)).toMatchObject({ window: "within" });
    // A train of D leaving the area at 23:50 and arriving back after midnight runs on past it.
    expect(svc(`Z10001:${D}`)).toMatchObject({ window: "ends_after" });
  });

  it("excludes deferred-area-only workings, with the reason", () => {
    expect(snap.excluded).toContainEqual(
      expect.objectContaining({ serviceId: `Z10004:${D}`, reason: "deferred_area_only" }),
    );
  });

  it("does not let an overlay that leaves the area be hidden by the permanent schedule", () => {
    expect(svc(`Z10005:${D}`)).toBeUndefined();
    expect(snap.excluded).toContainEqual(
      expect.objectContaining({ serviceId: `Z10005:${D}`, reason: "superseded_outside_area" }),
    );
  });

  it("keeps change-en-route records on the service, by call index", () => {
    expect(svc(`Z10002:${D}`)!.changesEnRoute).toEqual([
      expect.objectContaining({ callIndex: 1, tiploc: "SYNM", headcode: "2Z02" }),
    ]);
  });

  it("resolves associations from either side and records each partner's status", () => {
    const byCat = Object.fromEntries((snap.associations ?? []).map((a) => [a.id, a]));
    expect(byCat[`JJ:Z10003:${D}>Z10008:${D}@SYNX`]).toMatchObject({
      mainStatus: "in_snapshot",
      assocStatus: "runs_outside_snapshot",
    });
    // Next working, over next midnight: Z10001 of 11-03 forms Z10002 of 11-04.
    expect(byCat[`NP:Z10001:2026-11-03>Z10002:${D}@SYNC`]).toMatchObject({
      mainStatus: "in_snapshot",
      assocStatus: "in_snapshot",
      dateIndicator: "N",
    });
    expect(byCat[`VV:Z10002:${D}>Z19999:${D}@SYNB`]).toMatchObject({
      assocStatus: "not_in_extract",
    });
  });

  it("lets an association cancellation override the permanent association", () => {
    const s = snapshot(
      {},
      extract([
        aa({
          main: "Z10003",
          assoc: "Z10008",
          from: "261104",
          to: "261104",
          days: "0010000",
          location: "SYNX",
          stp: "C",
        }),
      ]),
    );
    expect((s.associations ?? []).some((a) => a.category === "JJ")).toBe(false);
  });

  it("keeps the bank-holiday flag and says whether it can apply", () => {
    expect(svc(`Z10006:${D}`)).toMatchObject({
      bankHolidayRunning: "X",
      bankHolidayApplicability: "not_applicable",
    });
    const onHoliday = snapshot({
      calendar: {
        sourceId: "synthetic-fixture",
        file: "synthetic",
        bankHolidays: [{ division: "synthetic", date: D, title: "Synthetic holiday" }],
      },
    });
    expect(onHoliday.services.find((s) => s.uid === "Z10006")!.bankHolidayApplicability).toBe(
      "unresolved",
    );
  });

  it("flags UK clock-change days", () => {
    expect(ukClockChangeOn("2026-10-25")).toBe(true); // clocks go back
    expect(ukClockChangeOn("2026-03-29")).toBe(true); // clocks go forward
    expect(ukClockChangeOn(D)).toBe(false);
    expect(snap.convention).toMatchObject({ windowStart: "00:00", clockChangeInWindow: false });
  });

  it("is schema-valid and passes the timetable checks with only the expected warning", () => {
    expect(() => TimetableSnapshot.parse(snap)).not.toThrow();
    const issues = validateTimetables([snap], { area, deferred });
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(codes(issues.filter((i) => i.severity === "warning"))).toEqual([
      "ASSOCIATION_UNKNOWN_SERVICE",
    ]);
  });
});

describe("timetable validation", () => {
  const fresh = () => structuredClone(snapshot());
  const errorsOf = (s: ReturnType<typeof snapshot>) =>
    validateTimetables([s], { area, deferred }).filter((i) => i.severity === "error");
  const svc = (s: ReturnType<typeof snapshot>, uid: string) =>
    s.services.find((x) => x.uid === uid)!;

  it("rejects invalid service identifiers and TIPLOCs", () => {
    const s = fresh();
    svc(s, "Z10002").id = "Z10002";
    svc(s, "Z10006").calls[0]!.tiploc = "syn-a";
    expect(codes(errorsOf(s))).toEqual(
      expect.arrayContaining(["TIMETABLE_SERVICE_ID_INVALID", "TIMETABLE_TIPLOC_INVALID"]),
    );
  });

  it("rejects times that go backwards, and day offsets that disagree with the times", () => {
    let s = fresh();
    svc(s, "Z10002").calls[1]!.pass = "07:59";
    expect(codes(errorsOf(s))).toContain("TIMETABLE_DAY_OFFSET");
    s = fresh();
    svc(s, "Z10002").calls[2]!.dayOffset = 1;
    expect(codes(errorsOf(s))).toContain("TIMETABLE_DAY_OFFSET");
  });

  it("accepts legitimate overnight running and equal consecutive times", () => {
    const s = fresh();
    const t = svc(s, "Z10002");
    t.calls[1]!.pass = "08:00"; // same minute as the departure
    expect(errorsOf(s)).toEqual([]);
    expect(svc(s, "Z10001").calls.map((c) => c.dayOffset)).toEqual([0, 1]);
  });

  it("rejects incomplete journeys", () => {
    const s = fresh();
    svc(s, "Z10002").calls.at(-1)!.arrival = null;
    expect(errorsOf(s)[0]).toMatchObject({ code: "TIMETABLE_JOURNEY_INCOMPLETE" });
  });

  it("rejects a service with no play-area time in the window, or a wrong window flag", () => {
    const s = fresh();
    svc(s, "Z10002").window = "spans";
    expect(codes(errorsOf(s))).toContain("TIMETABLE_WINDOW");
  });

  it("rejects associations that point at missing services or the wrong location", () => {
    const s = fresh();
    const a = s.associations!.find((x) => x.category === "JJ")!;
    a.assocStatus = "in_snapshot";
    a.location = "SYNQ";
    expect(codes(errorsOf(s))).toEqual(
      expect.arrayContaining(["ASSOCIATION_UNKNOWN_SERVICE", "ASSOCIATION_LOCATION"]),
    );
  });

  it("reports bank-holiday flags that are unresolved or inconsistent", () => {
    const s = fresh();
    s.calendar!.bankHolidays.push({ division: "synthetic", date: D, title: "Synthetic holiday" });
    expect(codes(errorsOf(s))).toContain("BANK_HOLIDAY_INCONSISTENT");
    delete s.calendar;
    expect(codes(validateTimetables([s], { area, deferred }))).toContain("BANK_HOLIDAY_UNRESOLVED");
  });

  it("rejects a change en route that does not match its call", () => {
    const s = fresh();
    svc(s, "Z10002").changesEnRoute![0]!.callIndex = 2;
    expect(codes(errorsOf(s))).toContain("TIMETABLE_CHANGE_EN_ROUTE");
  });

  it("reports parse errors, unknown records, scope conflicts and legacy snapshots", () => {
    const s = fresh();
    s.import!.parseErrors = 2;
    s.import!.unknownRecordTypes = ["QX"];
    const all = codes(validateTimetables([s], { area, deferred: new Set(["SYNA"]) }));
    expect(all).toEqual(
      expect.arrayContaining([
        "TIMETABLE_PARSE_ERRORS",
        "TIMETABLE_UNSUPPORTED_RECORDS",
        "TIMING_POINT_SCOPE_CONFLICT",
      ]),
    );
    const legacy = fresh();
    delete legacy.convention;
    for (const x of legacy.services) for (const c of x.calls) delete c.dayOffset;
    expect(codes(validateTimetables([legacy], { area, deferred }))).toContain(
      "TIMETABLE_LEGACY_CONVENTION",
    );
  });
});
