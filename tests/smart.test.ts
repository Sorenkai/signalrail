import { describe, expect, it } from "vitest";
import { smartCoverage } from "../src/import/smart/smart.ts";

// SYNTHETIC SMART rows (berths and STANOX invented for the test).
const row = (TD: string, STANOX: string, FROMBERTH: string) => ({
  TD,
  FROMBERTH,
  TOBERTH: "0002",
  STANOX,
  STANME: "SYNTH",
  STEPTYPE: "B",
  EVENT: "A",
  PLATFORM: "",
  FROMLINE: "",
  TOLINE: "",
  BERTHOFFSET: "+0",
  ROUTE: "",
  COMMENT: "",
});

describe("smartCoverage", () => {
  it("groups berth rows by STANOX and reports gaps without claiming more", () => {
    const smart = {
      BERTHDATA: [
        row("ZZ", "99001", "0001"),
        row("ZY", "99001", "0003"),
        row("ZZ", "99002", "0004"),
      ],
    };
    const out = smartCoverage(smart, [
      { tiploc: "SYNA", stanox: "99001" },
      { tiploc: "SYNB", stanox: "99009" },
      { tiploc: "SYNC", stanox: null },
    ]);
    expect(out.map((c) => [c.tiploc, c.rows.length, c.tdAreas])).toEqual([
      ["SYNA", 2, ["ZY", "ZZ"]],
      ["SYNB", 0, []],
      ["SYNC", 0, []],
    ]);
  });
});
