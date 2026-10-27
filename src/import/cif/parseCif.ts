/**
 * Parser for the Common Interface Format (CIF) used by Network Rail's SCHEDULE feed and the
 * RDG timetable feed. Field positions follow the CIF End User Specification (fixed-width,
 * 80-character records) as documented on the Open Rail Data wiki.
 *
 * Only the records needed for game timetables are read: HD, BS, BX, LO, LI, LT. Change-en-
 * route (CR), association (AA) and TIPLOC (TI/TA/TD) records are counted and skipped.
 *
 * NOTE: positions have not yet been checked against a real extract by this project; see
 * docs/FEASIBILITY_REPORT.md. Tests use a synthetic fixture.
 */

export interface CifHeader {
  mainframeIdentity: string;
  extractDate: string | null; // ISO date
  extractTime: string | null; // HH:MM
  currentFileRef: string;
  lastFileRef: string;
  updateIndicator: "F" | "U" | string;
  userStartDate: string | null;
  userEndDate: string | null;
}

export interface CifLocation {
  record: "LO" | "LI" | "LT";
  tiploc: string;
  suffix: string;
  arrival: string | null;
  departure: string | null;
  pass: string | null;
  publicArrival: string | null;
  publicDeparture: string | null;
  platform: string | null;
  line: string | null;
  path: string | null;
  activities: string[];
}

export interface CifSchedule {
  transaction: "N" | "D" | "R" | string;
  uid: string;
  runsFrom: string; // ISO date
  runsTo: string | null; // ISO date; null for a single-day schedule with blank end date
  /** Seven flags, Monday first. */
  daysRun: boolean[];
  bankHoliday: string | null;
  status: string | null;
  category: string | null;
  headcode: string | null;
  serviceCode: string | null;
  powerType: string | null;
  timingLoad: string | null;
  speed: string | null;
  stpIndicator: "C" | "N" | "O" | "P" | string;
  atocCode: string | null;
  locations: CifLocation[];
}

export interface CifFile {
  header: CifHeader | null;
  schedules: CifSchedule[];
  skippedRecords: Record<string, number>;
  errors: { line: number; message: string }[];
}

const field = (line: string, start: number, len: number) => line.substring(start, start + len);
const trimmed = (line: string, start: number, len: number) =>
  field(line, start, len).trim() || null;

/** yymmdd -> ISO date. CIF two-digit years are 1960-2059. */
export function cifDate(yymmdd: string): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  return `${yy >= 60 ? 1900 + yy : 2000 + yy}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}

/** ddmmyy -> ISO date (header record uses day-first ordering). */
function cifHeaderDate(ddmmyy: string): string | null {
  return /^\d{6}$/.test(ddmmyy)
    ? cifDate(ddmmyy.slice(4) + ddmmyy.slice(2, 4) + ddmmyy.slice(0, 2))
    : null;
}

/** "HHMM" or "HHMMH" (H = half minute) -> "HH:MM" / "HH:MM:30". Blank or 0000 public time -> null. */
export function cifTime(raw: string, { zeroIsNull = false } = {}): string | null {
  const t = raw.trim();
  if (!/^\d{4}H?$/.test(t)) return null;
  if (zeroIsNull && t === "0000") return null;
  return `${t.slice(0, 2)}:${t.slice(2, 4)}${t.endsWith("H") ? ":30" : ""}`;
}

/** CIF activity field: up to six two-character codes. */
function activities(raw: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const code = raw.substring(i, i + 2).trim();
    if (code) out.push(code);
  }
  return out;
}

function parseHeader(l: string): CifHeader {
  return {
    mainframeIdentity: field(l, 2, 20).trim(),
    extractDate: cifHeaderDate(field(l, 22, 6)),
    extractTime: cifTime(field(l, 28, 4)),
    currentFileRef: field(l, 32, 7).trim(),
    lastFileRef: field(l, 39, 7).trim(),
    updateIndicator: field(l, 46, 1),
    userStartDate: cifHeaderDate(field(l, 48, 6)),
    userEndDate: cifHeaderDate(field(l, 54, 6)),
  };
}

function parseBasicSchedule(l: string): CifSchedule {
  const runsFrom = cifDate(field(l, 9, 6));
  if (!runsFrom) throw new Error(`invalid runs-from date "${field(l, 9, 6)}"`);
  return {
    transaction: field(l, 2, 1),
    uid: field(l, 3, 6),
    runsFrom,
    runsTo: cifDate(field(l, 15, 6)),
    daysRun: [...field(l, 21, 7).padEnd(7, "0")].map((c) => c === "1"),
    bankHoliday: trimmed(l, 28, 1),
    status: trimmed(l, 29, 1),
    category: trimmed(l, 30, 2),
    headcode: trimmed(l, 32, 4),
    serviceCode: trimmed(l, 41, 8),
    powerType: trimmed(l, 50, 3),
    timingLoad: trimmed(l, 53, 4),
    speed: trimmed(l, 57, 3),
    stpIndicator: field(l, 79, 1),
    atocCode: null,
    locations: [],
  };
}

function parseLocation(l: string): CifLocation {
  const record = field(l, 0, 2) as CifLocation["record"];
  const base = { record, tiploc: field(l, 2, 7).trim(), suffix: field(l, 9, 1).trim() };
  if (record === "LO") {
    return {
      ...base,
      arrival: null,
      departure: cifTime(field(l, 10, 5)),
      pass: null,
      publicArrival: null,
      publicDeparture: cifTime(field(l, 15, 4), { zeroIsNull: true }),
      platform: trimmed(l, 19, 3),
      line: trimmed(l, 22, 3),
      path: null,
      activities: activities(field(l, 29, 12)),
    };
  }
  if (record === "LI") {
    return {
      ...base,
      arrival: cifTime(field(l, 10, 5)),
      departure: cifTime(field(l, 15, 5)),
      pass: cifTime(field(l, 20, 5)),
      publicArrival: cifTime(field(l, 25, 4), { zeroIsNull: true }),
      publicDeparture: cifTime(field(l, 29, 4), { zeroIsNull: true }),
      platform: trimmed(l, 33, 3),
      line: trimmed(l, 36, 3),
      path: trimmed(l, 39, 3),
      activities: activities(field(l, 42, 12)),
    };
  }
  return {
    ...base,
    arrival: cifTime(field(l, 10, 5)),
    departure: null,
    pass: null,
    publicArrival: cifTime(field(l, 15, 4), { zeroIsNull: true }),
    publicDeparture: null,
    platform: trimmed(l, 19, 3),
    line: null,
    path: trimmed(l, 22, 3),
    activities: activities(field(l, 25, 12)),
  };
}

/**
 * Incremental CIF parser, so national extracts (~1 GB) can be streamed line by line.
 * `keep` is applied to each completed schedule; rejected schedules are not retained.
 * Cancellation (STP C) schedules have no location records, so a `keep` predicate that
 * filters by location must let location-less schedules through.
 */
export class CifParser {
  readonly result: CifFile = { header: null, schedules: [], skippedRecords: {}, errors: [] };
  /** Schedules seen before `keep` filtering. */
  scheduleCount = 0;
  private current: CifSchedule | null = null;
  private inLocations = false;
  private lineNo = 0;

  constructor(private readonly keep: (s: CifSchedule) => boolean = () => true) {}

  push(raw: string): void {
    this.lineNo++;
    if (raw.trim() === "") return;
    const l = raw.padEnd(80, " ");
    const type = l.slice(0, 2);
    try {
      switch (type) {
        case "HD":
          this.result.header = parseHeader(l);
          break;
        case "BS":
          this.flush();
          this.current = parseBasicSchedule(l);
          this.scheduleCount++;
          break;
        case "BX":
          if (!this.current) throw new Error("BX without preceding BS");
          this.current.atocCode = trimmed(l, 11, 2);
          break;
        case "LO":
        case "LI":
        case "LT":
          if (!this.current) throw new Error(`${type} without preceding BS`);
          this.inLocations = true;
          this.current.locations.push(parseLocation(l));
          if (type === "LT") this.flush();
          break;
        case "CR":
          // Change-en-route sits between location records; it does not end the schedule.
          this.result.skippedRecords[type] = (this.result.skippedRecords[type] ?? 0) + 1;
          break;
        default:
          if (!this.inLocations) this.flush();
          this.result.skippedRecords[type] = (this.result.skippedRecords[type] ?? 0) + 1;
      }
    } catch (e) {
      this.result.errors.push({ line: this.lineNo, message: (e as Error).message });
    }
  }

  finish(): CifFile {
    this.flush();
    return this.result;
  }

  private flush() {
    if (this.current && this.keep(this.current)) this.result.schedules.push(this.current);
    this.current = null;
    this.inLocations = false;
  }
}

export function parseCif(text: string, keep?: (s: CifSchedule) => boolean): CifFile {
  const parser = new CifParser(keep);
  for (const line of text.split(/\r?\n/)) parser.push(line);
  return parser.finish();
}
