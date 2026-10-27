/**
 * Parser for the Common Interface Format (CIF) used by Network Rail's SCHEDULE feed and the
 * RDG timetable feed. Field positions follow the CIF End User Specification (fixed-width,
 * 80-character records) as documented on the Open Rail Data wiki.
 *
 * Records read: HD, BS, BX, LO, LI, LT, CR (change en route) and AA (association). TIPLOC
 * master records (TI/TA/TD) describe locations, not trains: they are counted in
 * `skippedRecords` and reported, never silently dropped. ZZ ends the file. Any other record
 * type is counted under `skippedRecords` too and flagged by `unknownRecordTypes`.
 *
 * Field positions were checked against the real Network Rail SCHEDULE full extract DFROC1F
 * (2026-10-23): every one of its 79,404 AA and 104,589 CR records fits the positions below, and
 * every CR precedes the location record it names (DECISION_LOG D-026). Field order and value
 * meanings follow the Open Rail Data wiki's CIF pages.
 */

/** Record types this parser understands; anything else is reported as unknown. */
export const KNOWN_RECORD_TYPES = [
  "HD",
  "BS",
  "BX",
  "LO",
  "LI",
  "LT",
  "CR",
  "AA",
  "TI",
  "TA",
  "TD",
  "ZZ",
];

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

/**
 * Change en route (CR): new train attributes that apply from the location record that follows
 * it. Only fields whose positions were verified on real data are decoded; `raw` keeps the rest.
 */
export interface CifChangeEnRoute {
  tiploc: string;
  suffix: string;
  /** Index into the schedule's `locations` of the location the change applies from. */
  locationIndex: number;
  category: string | null;
  headcode: string | null;
  serviceCode: string | null;
  powerType: string | null;
  speed: string | null;
  raw: string;
}

/**
 * Association (AA): a join (JJ), divide (VV) or next working (NP) between a main (base) train
 * and an associated train at a location. Dates and days-run apply to the main train; the date
 * indicator says whether the associated train runs the same day (S), the next day (N) or the
 * previous day (P). A cancellation (STP C) carries no category.
 */
export interface CifAssociation {
  transaction: "N" | "D" | "R" | string;
  mainUid: string;
  assocUid: string;
  startDate: string;
  endDate: string | null;
  daysRun: boolean[] | null;
  category: "JJ" | "VV" | "NP" | null;
  dateIndicator: "S" | "N" | "P" | null;
  location: string;
  baseSuffix: string;
  assocSuffix: string;
  diagramType: string | null;
  associationType: "P" | "O" | null;
  stpIndicator: "C" | "N" | "O" | "P" | string;
  /** 1-based line number in the source file. */
  line: number;
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
  changesEnRoute: CifChangeEnRoute[];
  /** False when a schedule with locations ended without an LT (terminating) record. */
  complete: boolean;
  /** 1-based line number of the BS record. */
  line: number;
}

/** The dating fields of a schedule, kept for every schedule when indexing is on. */
export type CifScheduleKey = Pick<
  CifSchedule,
  "transaction" | "uid" | "runsFrom" | "runsTo" | "daysRun" | "stpIndicator"
> & { hasLocations: boolean };

export interface CifFile {
  header: CifHeader | null;
  schedules: CifSchedule[];
  associations: CifAssociation[];
  /** Records counted but not imported, by type (TI/TA/TD and any unknown type). */
  skippedRecords: Record<string, number>;
  /** Record types outside KNOWN_RECORD_TYPES. */
  unknownRecordTypes: string[];
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

function parseBasicSchedule(l: string, line: number): CifSchedule {
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
    changesEnRoute: [],
    complete: true,
    line,
  };
}

const enumOrNull = <T extends string>(v: string, allowed: readonly T[]): T | null =>
  (allowed as readonly string[]).includes(v) ? (v as T) : null;

function parseAssociation(l: string, line: number): CifAssociation {
  const startDate = cifDate(field(l, 15, 6));
  if (!startDate) throw new Error(`AA: invalid start date "${field(l, 15, 6)}"`);
  const endRaw = field(l, 21, 6);
  const endDate = endRaw.trim() ? cifDate(endRaw) : null;
  if (endRaw.trim() && !endDate) throw new Error(`AA: invalid end date "${endRaw}"`);
  const days = field(l, 27, 7);
  if (days.trim() && !/^[01]{7}$/.test(days)) throw new Error(`AA: invalid days "${days}"`);
  const category = field(l, 34, 2).trim();
  if (category && !["JJ", "VV", "NP"].includes(category))
    throw new Error(`AA: unknown association category "${category}"`);
  const mainUid = field(l, 3, 6);
  const assocUid = field(l, 9, 6);
  if (!/^[A-Z ]\d{5}$/.test(mainUid) || !/^[A-Z ]\d{5}$/.test(assocUid))
    throw new Error(`AA: invalid train UID "${mainUid}"/"${assocUid}"`);
  return {
    transaction: field(l, 2, 1),
    mainUid,
    assocUid,
    startDate,
    endDate,
    daysRun: days.trim() ? [...days].map((c) => c === "1") : null,
    category: enumOrNull(category, ["JJ", "VV", "NP"] as const),
    dateIndicator: enumOrNull(field(l, 36, 1), ["S", "N", "P"] as const),
    location: field(l, 37, 7).trim(),
    baseSuffix: field(l, 44, 1).trim(),
    assocSuffix: field(l, 45, 1).trim(),
    diagramType: trimmed(l, 46, 1),
    associationType: enumOrNull(field(l, 47, 1), ["P", "O"] as const),
    stpIndicator: field(l, 79, 1),
    line,
  };
}

/** CR repeats the BS train fields 20 columns to the left, after an 8-character location. */
function parseChangeEnRoute(l: string, locationIndex: number): CifChangeEnRoute {
  return {
    tiploc: field(l, 2, 7).trim(),
    suffix: field(l, 9, 1).trim(),
    locationIndex,
    category: trimmed(l, 10, 2),
    headcode: trimmed(l, 12, 4),
    serviceCode: trimmed(l, 21, 8),
    powerType: trimmed(l, 30, 3),
    speed: trimmed(l, 37, 3),
    raw: l.trimEnd(),
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
  readonly result: CifFile = {
    header: null,
    schedules: [],
    associations: [],
    skippedRecords: {},
    unknownRecordTypes: [],
    errors: [],
  };
  /** Schedules seen before `keep` filtering. */
  scheduleCount = 0;
  private current: CifSchedule | null = null;
  private inLocations = false;
  private pendingChange: string | null = null;
  private lineNo = 0;

  /** With `index`, every schedule's dating fields, by UID, whether kept or not. */
  readonly index = new Map<string, CifScheduleKey[]>();

  constructor(
    private readonly keep: (s: CifSchedule) => boolean = () => true,
    private readonly options: { index?: boolean } = {},
  ) {}

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
          this.current = parseBasicSchedule(l, this.lineNo);
          this.scheduleCount++;
          break;
        case "AA":
          this.flush();
          this.result.associations.push(parseAssociation(l, this.lineNo));
          break;
        case "BX":
          if (!this.current) throw new Error("BX without preceding BS");
          this.current.atocCode = trimmed(l, 11, 2);
          break;
        case "LO":
        case "LI":
        case "LT":
          if (!this.current) throw new Error(`${type} without preceding BS`);
          if (type === "LO" && this.current.locations.length > 0)
            throw new Error(`LO after other locations in schedule ${this.current.uid}`);
          this.inLocations = true;
          if (this.pendingChange !== null) {
            const cr = parseChangeEnRoute(this.pendingChange, this.current.locations.length);
            this.pendingChange = null;
            if (cr.tiploc !== field(l, 2, 7).trim())
              throw new Error(
                `CR at ${cr.tiploc} is followed by ${type} at ${field(l, 2, 7).trim()} in schedule ${this.current.uid}`,
              );
            this.current.changesEnRoute.push(cr);
          }
          this.current.locations.push(parseLocation(l));
          if (type === "LT") this.flush();
          break;
        case "CR":
          // Change en route sits between location records and applies from the next one.
          if (!this.current || !this.inLocations)
            throw new Error("CR outside a schedule's location records");
          this.pendingChange = l;
          break;
        case "ZZ":
          this.flush();
          break;
        default:
          if (!this.inLocations) this.flush();
          this.result.skippedRecords[type] = (this.result.skippedRecords[type] ?? 0) + 1;
          if (!KNOWN_RECORD_TYPES.includes(type) && !this.result.unknownRecordTypes.includes(type))
            this.result.unknownRecordTypes.push(type);
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
    if (this.current) {
      const last = this.current.locations.at(-1);
      if (this.current.locations.length > 0 && last?.record !== "LT") {
        this.current.complete = false;
        this.result.errors.push({
          line: this.current.line,
          message: `schedule ${this.current.uid} ends without an LT record`,
        });
      }
      if (this.pendingChange !== null)
        this.result.errors.push({
          line: this.lineNo,
          message: `CR in schedule ${this.current.uid} is not followed by a location`,
        });
      if (this.options.index) {
        const c = this.current;
        const list = this.index.get(c.uid) ?? [];
        list.push({
          transaction: c.transaction,
          uid: c.uid,
          runsFrom: c.runsFrom,
          runsTo: c.runsTo,
          daysRun: c.daysRun,
          stpIndicator: c.stpIndicator,
          hasLocations: c.locations.length > 0,
        });
        this.index.set(c.uid, list);
      }
      if (this.keep(this.current)) this.result.schedules.push(this.current);
    }
    this.current = null;
    this.inLocations = false;
    this.pendingChange = null;
  }
}

export function parseCif(text: string, keep?: (s: CifSchedule) => boolean): CifFile {
  const parser = new CifParser(keep);
  for (const line of text.split(/\r?\n/)) parser.push(line);
  return parser.finish();
}
