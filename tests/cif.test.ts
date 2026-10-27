import { describe, expect, it } from "vitest";
import { CifParser, cifDate, cifTime, parseCif } from "../src/import/cif/parseCif.ts";
import { buildSnapshot, resolveSchedulesForDate } from "../src/import/cif/snapshot.ts";
import { TimetableSnapshot } from "../src/model/index.ts";
import { SYNTHETIC_CIF, record } from "../fixtures/synthetic/cif.ts";

describe("CIF field helpers", () => {
  it("parses dates and half-minute times", () => {
    expect(cifDate("261102")).toBe("2026-11-02");
    expect(cifDate("991231")).toBe("1999-12-31");
    expect(cifTime("0810H")).toBe("08:10:30");
    expect(cifTime("0812 ")).toBe("08:12");
    expect(cifTime("     ")).toBeNull();
    expect(cifTime("0000", { zeroIsNull: true })).toBeNull();
  });
});

describe("parseCif (synthetic fixture)", () => {
  const cif = parseCif(SYNTHETIC_CIF);

  it("reads the header", () => {
    expect(cif.errors).toEqual([]);
    expect(cif.header).toMatchObject({
      currentFileRef: "DFTEST1",
      updateIndicator: "F",
      extractDate: "2026-10-27",
      userStartDate: "2026-11-01",
      userEndDate: "2027-11-30",
    });
  });

  it("reads schedules and locations", () => {
    expect(cif.schedules).toHaveLength(4);
    const [p] = cif.schedules;
    expect(p).toMatchObject({
      uid: "Z90001",
      headcode: "0Z01",
      stpIndicator: "P",
      atocCode: "ZZ",
      runsFrom: "2026-11-02",
    });
    expect(p!.daysRun).toEqual([true, true, true, true, true, false, false]);
    expect(p!.locations.map((l) => l.tiploc)).toEqual(["SYNA", "SYNB", "SYNJN", "SYNC"]);
    expect(p!.locations[1]).toMatchObject({
      arrival: "08:10:30",
      departure: "08:12",
      platform: "2",
      activities: ["T"],
    });
    expect(p!.locations[2]).toMatchObject({ pass: "08:15", arrival: null, publicArrival: null });
    expect(p!.locations[3]).toMatchObject({ record: "LT", arrival: "08:25", platform: "3" });
    expect(cif.skippedRecords).toEqual({ ZZ: 1 });
  });

  it("reports location records outside a schedule", () => {
    const bad = parseCif("LISYNB    0810 0812           ");
    expect(bad.errors[0]?.message).toMatch(/without preceding BS/);
  });
});

describe("dated snapshots", () => {
  const cif = parseCif(SYNTHETIC_CIF);

  it("uses the permanent schedule on a normal day", () => {
    const s = resolveSchedulesForDate(cif, "2026-11-03");
    expect(s.map((x) => `${x.uid}:${x.stpIndicator}`)).toEqual(["Z90001:P", "Z90002:P"]);
  });

  it("applies overlays and cancellations", () => {
    expect(
      resolveSchedulesForDate(cif, "2026-11-04").find((x) => x.uid === "Z90001")?.stpIndicator,
    ).toBe("O");
    expect(resolveSchedulesForDate(cif, "2026-11-05").map((x) => x.uid)).toEqual(["Z90001"]);
  });

  it("respects days-run", () => {
    expect(resolveSchedulesForDate(cif, "2026-11-07").map((x) => x.uid)).toEqual(["Z90002"]); // Saturday
  });

  it("builds a schema-valid snapshot with provenance", () => {
    const snap = buildSnapshot(cif, "2026-11-04", { id: "syn", sourceId: "synthetic-fixture" });
    expect(() => TimetableSnapshot.parse(snap)).not.toThrow();
    const svc = snap.services.find((s) => s.uid === "Z90001")!;
    expect(svc.calls[0]).toMatchObject({ kind: "origin", departure: "08:30" });
    expect(svc.provenance.sources[0]).toMatchObject({
      recordId: "Z90001/2026-11-04/O",
      version: "DFTEST1",
    });
  });
});

describe("CifParser (streaming)", () => {
  it("applies the keep filter per schedule and keeps location-less cancellations", () => {
    const parser = new CifParser(
      (s) => s.locations.length === 0 || s.locations.some((l) => l.tiploc === "SYNB"),
    );
    for (const line of SYNTHETIC_CIF.split("\n")) parser.push(line);
    const out = parser.finish();
    expect(parser.scheduleCount).toBe(4);
    // Z90001 P calls at SYNB; its overlay does not; Z90002 P does not; Z90002 C has no locations.
    expect(out.schedules.map((s) => `${s.uid}:${s.stpIndicator}`)).toEqual([
      "Z90001:P",
      "Z90002:C",
    ]);
  });

  it("does not end a schedule at a change-en-route record", () => {
    const lines = SYNTHETIC_CIF.split("\n");
    const li = lines.findIndex((l) => l.startsWith("LISYNJN"));
    lines.splice(li, 0, record("CR", [[2, "SYNJN   "]]));
    const out = parseCif(lines.join("\n"));
    expect(out.errors).toEqual([]);
    expect(out.schedules[0]!.locations.map((l) => l.tiploc)).toEqual([
      "SYNA",
      "SYNB",
      "SYNJN",
      "SYNC",
    ]);
    expect(out.skippedRecords.CR).toBe(1);
  });
});
