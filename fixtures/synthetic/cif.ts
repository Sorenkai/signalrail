/**
 * SYNTHETIC CIF builder for tests. Produces fixed-width 80-column records from explicit
 * column offsets, so tests document the CIF layout they assume. Not real timetable data.
 */
export function record(type: string, fields: [start: number, value: string][]): string {
  const chars = (type + " ".repeat(78)).split("");
  for (const [start, value] of fields)
    for (let i = 0; i < value.length; i++) chars[start + i] = value[i]!;
  return chars.join("");
}

export const hd = (fileRef: string, extract = "271026", start = "011126", end = "301127") =>
  record("HD", [
    [2, "SYNTHETIC-FIXTURE"],
    [22, extract],
    [28, "2130"],
    [32, fileRef],
    [39, "       "],
    [46, "F"],
    [47, "B"],
    [48, start],
    [54, end],
  ]);

export const bs = (o: {
  uid: string;
  from: string;
  to: string;
  days: string;
  headcode: string;
  stp: string;
  tx?: string;
}) =>
  record("BS", [
    [2, o.tx ?? "N"],
    [3, o.uid],
    [9, o.from],
    [15, o.to],
    [21, o.days],
    [29, "P"],
    [30, "OO"],
    [32, o.headcode],
    [41, "99999999"],
    [50, "DMU"],
    [79, o.stp],
  ]);

export const bx = (atoc: string) => record("BX", [[11, atoc]]);

export const lo = (tiploc: string, dep: string, pubDep: string, platform = "") =>
  record("LO", [
    [2, tiploc.padEnd(8)],
    [10, dep.padEnd(5)],
    [15, pubDep],
    [19, platform.padEnd(3)],
    [29, "TB"],
  ]);

export const li = (
  tiploc: string,
  o: { arr?: string; dep?: string; pass?: string; platform?: string },
) =>
  record("LI", [
    [2, tiploc.padEnd(8)],
    [10, (o.arr ?? "").padEnd(5)],
    [15, (o.dep ?? "").padEnd(5)],
    [20, (o.pass ?? "").padEnd(5)],
    [25, o.arr ? o.arr.slice(0, 4) : "0000"],
    [29, o.dep ? o.dep.slice(0, 4) : "0000"],
    [33, (o.platform ?? "").padEnd(3)],
    [42, o.pass ? "  " : "T "],
  ]);

export const lt = (tiploc: string, arr: string, platform = "") =>
  record("LT", [
    [2, tiploc.padEnd(8)],
    [10, arr.padEnd(5)],
    [15, arr.slice(0, 4)],
    [19, platform.padEnd(3)],
    [25, "TF"],
  ]);

/** A small synthetic extract: one permanent service, an overlay, and a cancellation. */
export const SYNTHETIC_CIF = [
  hd("DFTEST1"),
  // Z90001 runs Mon-Fri; permanent.
  bs({ uid: "Z90001", from: "261102", to: "261127", days: "1111100", headcode: "0Z01", stp: "P" }),
  bx("ZZ"),
  lo("SYNA", "0800 ", "0800", "1"),
  li("SYNB", { arr: "0810H", dep: "0812 ", platform: "2" }),
  li("SYNJN", { pass: "0815 " }),
  lt("SYNC", "0825 ", "3"),
  // Overlay on Wed 2026-11-04 changes the departure time.
  bs({ uid: "Z90001", from: "261104", to: "261104", days: "0010000", headcode: "0Z01", stp: "O" }),
  bx("ZZ"),
  lo("SYNA", "0830 ", "0830", "1"),
  lt("SYNC", "0855 ", "3"),
  // Z90002 runs daily but is cancelled on Thu 2026-11-05.
  bs({ uid: "Z90002", from: "261102", to: "261127", days: "1111111", headcode: "0Z02", stp: "P" }),
  bx("ZZ"),
  lo("SYNC", "2350 ", "2350"),
  lt("SYNA", "0015 "),
  bs({ uid: "Z90002", from: "261105", to: "261105", days: "0001000", headcode: "    ", stp: "C" }),
  record("ZZ", []),
].join("\n");

/** SYNTHETIC association record (AA), at the column offsets verified on the real extract. */
export const aa = (o: {
  main: string;
  assoc: string;
  from: string;
  to?: string;
  days?: string;
  category?: string;
  dateInd?: string;
  location: string;
  baseSuffix?: string;
  assocSuffix?: string;
  type?: string;
  stp: string;
  tx?: string;
}) =>
  record("AA", [
    [2, o.tx ?? "N"],
    [3, o.main],
    [9, o.assoc],
    [15, o.from],
    [21, o.to ?? "      "],
    [27, o.days ?? "1111111"],
    [34, o.category ?? "  "],
    [36, o.dateInd ?? " "],
    [37, o.location.padEnd(7)],
    [44, o.baseSuffix ?? " "],
    [45, o.assocSuffix ?? " "],
    [46, "T"],
    [47, o.type ?? " "],
    [79, o.stp],
  ]);

/** SYNTHETIC change-en-route record (CR): BS train fields 20 columns to the left. */
export const cr = (
  tiploc: string,
  o: { category?: string; headcode?: string; power?: string; speed?: string } = {},
) =>
  record("CR", [
    [2, tiploc.padEnd(8)],
    [10, o.category ?? "OO"],
    [12, o.headcode ?? "1Z99"],
    [21, "99999999"],
    [30, (o.power ?? "EMU").padEnd(3)],
    [37, o.speed ?? "100"],
  ]);
