# Decision log

Each entry records what was decided, why, and how to reverse it. Newest entries go at the bottom.

## D-001: Single TypeScript package, layered by directory (2026-10-27)

**Decision:** one npm package with `src/model`, `src/import`, `src/validation`, `src/schematic`, `src/data`, `src/server` and `src/client`, plus `tools/` (CLIs) and `tests/`. Vite builds the client from `src/client`. `tsx` runs the server and tools.
**Why:** the repo was empty, and Phase 0 has one dataset. Workspaces or a monorepo would add tooling without benefit yet. The shared model is imported directly by the client, server and tools.
**Reverse when:** server and client dependencies start to conflict, or build times grow. Split into npm workspaces (`packages/model`, `apps/server`, `apps/client`).

## D-002: zod schemas as the single source of truth (2026-10-27)

**Decision:** data contracts are zod schemas, and the TypeScript types are inferred from them. Evidence rules (sources for `sourced`, two distinct sources for `verified`, notes for `inferred`/`placeholder`) are enforced inside the `Provenance` schema.
**Why:** every file on disk is validated at load time, by the same definitions the code compiles against.
**Alternative considered:** JSON Schema plus generated types. That's more portable, but it needs a codegen step. A JSON Schema can be emitted from zod later if non-TS tools need it.

## D-003: First study area is Shrewsbury (2026-10-27)

**Decision:** Phase 0 uses Shrewsbury, roughly the bbox 52.695–52.725 N (extended to 52.745 N by D-011), 2.770–2.725 W. It covers Crewe Junction, Severn Bridge Junction, Abbey Foregate and Sutton Bridge Junction signal boxes, with five radiating routes cut at the bbox edge.
**Evidence:** see [FEASIBILITY_REPORT.md](FEASIBILITY_REPORT.md#candidate-areas). In short:

- Four real, staffed signal boxes in about 2 km, confirmed by both OSM (`railway=signal_box`) and Wikipedia. That gives natural, real boundaries for four players. No other candidate measured offered this.
- It is a compact junction station with five lines (to Crewe, Chester/Wrexham, Wolverhampton, Hereford, and the Cambrian line) and moderate traffic. Wikipedia says Severn Bridge Junction handles about 300 movements a day.
- OSM coverage is usable: a connected track graph, speeds on 92% of edges, platform refs, and some signal refs carrying box prefixes (SBJ, CJ, AF, SUB).
- Mechanical semaphore signalling with a traditional diagram fits the game's style.

**Why not York:** York had the most OSM signal tagging measured (22 of 33 signals with refs), but it has 165 switches in a small bbox and is controlled from a single operating centre. That means a very large first section, and no real multi-box split.
**Why not Carlisle:** best signal-ref coverage (42 of 42), but only one box was found in OSM, so any multi-player split would be pure game design.
**Risks accepted:** OSM signal coverage at Shrewsbury is far from complete (25 nodes, 13 with refs; Severn Bridge Jn alone has about 90 levers in use). Real interlocking detail is not public.
**Reverse when:** the feasibility gaps can't be closed for Shrewsbury but can be for another area. The importer and validator are area-agnostic; add a new `data/datasets/<id>/area.json`.

## D-004: OSM via Overpass for infrastructure; dated, committed snapshots (2026-10-27)

**Decision:** fetch OSM railway data once per snapshot with `npm run data:fetch-osm`, commit the raw JSON to `data/raw/osm/`, and regenerate `infrastructure.json` from it deterministically.
**Why:** it's public with no account and ODbL-licensed, and committing keeps builds reproducible and within the Overpass usage policy. A mirror returned stale data (base 2026-05-31), so the base timestamp is recorded and checked by eye on every fetch.
**Obligation:** derived infrastructure files are ODbL (see [DATA_SOURCES.md](DATA_SOURCES.md)).

## D-005: Timetables from CIF, imported manually into fixed dated snapshots (2026-10-27)

**Decision:** parse CIF (Network Rail SCHEDULE full extract) offline into a single-day `TimetableSnapshot`, applying STP precedence (C > O > N > P). Game sessions never read live feeds.
**Why:** CIF includes freight and ECS, while the RDG feed is passenger-only. Snapshots keep sessions deterministic. Access needs a user account, so the tool takes a local file and never handles credentials.
**Open:** the parser's column offsets haven't been checked against a real extract yet ([FEASIBILITY_REPORT.md](FEASIBILITY_REPORT.md)).
**Update (2026-10-27):** the full extract has since been parsed (721,875 schedules, 0 errors), and one service (1D11, UID G38352) was checked field by field against the raw records ([FEASIBILITY_REPORT.md](FEASIBILITY_REPORT.md)). Broader checking of the offsets is still open.

## D-006: Geographic preview now; schematic diagram later (2026-10-27)

**Decision:** Phase 0 renders a geographic preview, which projects OSM coordinates to SVG. It does not draw a schematic signal-box diagram.
**Why:** a traditional schematic needs straightened, hand-tuned or algorithmic layout, plus a credible signal set. Neither is justified until the feasibility gaps close. The preview is honest about what the data contains.
**Next:** a schematic layout layer (a separate file of authored diagram coordinates per element; presentation only, with no railway facts).

## D-007: Socket.IO deferred (2026-10-27)

**Decision:** the Phase 0 server is a read-only HTTP API (`/api/health`, `/api/datasets`, `/api/datasets/:id`) using `node:http`. Socket.IO isn't installed yet.
**Why:** there is no simulation state to synchronise, and the brief says not to start gameplay. Socket.IO stays the intended transport for the server-authoritative multiplayer layer (see CLAUDE.md).

## D-008: Control areas mirror real boxes, with membership `unknown` (2026-10-27)

**Decision:** `control.json` defines four `real_signal_box` areas. Box existence is `verified` (OSM + Wikipedia). Which signals and points each box works is `unknown`, so the lists are empty.
**Why:** OSM signal refs have box-like prefixes (e.g. `SBJ20`, `CJ119`), but treating a prefix as proof of control would be an undocumented inference. If adopted, it must be recorded in [INFERRED_BEHAVIOUR.md](INFERRED_BEHAVIOUR.md) and labelled `inferred`.

## D-009: Commit the derived study-area timetable; OGL default attribution (2026-10-27)

**Decision:** the raw SCHEDULE CIF (930 MB) and CORPUS stay in git-ignored `data/private/`. The derived single-day snapshot (`timetables/2026-11-04.json`, 297 services touching the study area, with full journeys) and the CORPUS details for study-area TIPLOCs are committed. The attribution is the OGL v3.0 default statement.
**Why:** Network Rail's licence page says the feeds may be used under the Open Government Licence, which permits copying, publishing and adapting with attribution. The page gives no version and no specific attribution wording, so the OGL v3.0 default applies until Network Rail specifies otherwise.
**Snapshot date:** Wednesday 2026-11-04 is an ordinary weekday inside the extract's validity (2026-10-23 to 2027-10-23), close enough to the extract that short-term STP changes are included. It is a project choice, and another date can be imported at any time.
**Reverse when:** Network Rail states different terms, in which case move the snapshot to `data/private/`.

## D-010: Study-area TIPLOCs are a scoping list, not a geographic fact (2026-10-27)

**Decision:** `timing-points.json` `areaTiplocs` lists 15 TIPLOCs: those used by trains through Shrewsbury on the snapshot date, plus the Coton Hill entries. Their descriptions come from CORPUS. CORPUS has no coordinates, so whether each lies inside the bbox is **unverified**. Harlescott Crossing and Crewe Bank in particular may lie just north of it.
**Mapping rule:** a TIPLOC is linked to infrastructure only by an exact, unique CRS-code join (CORPUS ↔ OSM). That currently maps only SHRWBY → Shrewsbury station. No name matching is used, because "SUTTON BRIDGE JUNCTION" (the junction) and the Sutton Bridge Junction signal box are different places.

## D-011: Study bbox extended north to 52.745 N (2026-10-27)

**Decision:** move the north edge from 52.725 to 52.745 so that Harlescott Crossing (HRLSCTX, about 52.738 N), a timing point every Crewe-line train passes, lies on the track graph. The OSM snapshot was re-fetched the same day (base `2026-10-27T16:38:36Z`). The fetch query now also collects named `railway=junction|yard|level_crossing` and `landuse=railway` features, imported as `Location`s.
**Why:** a timing point beyond the graph cannot be aligned to track. Extending by about 2 km of plain line keeps the scope small.

## D-012: Inferred timing-point positions (2026-10-27)

**Decision:** the 12 study-area TIPLOCs used on the snapshot date that no source places on track get `inferredPositions` in `timing-points.json` (schema `TimingPointPosition`, always `evidence: inferred`). Each is anchored to one or more existing OSM track nodes, and its coordinates are **copied from the first anchor**: no coordinate is invented. Each entry records the method, the evidence statements, its sources (the CORPUS row and the OSM nodes and labels used) and a confidence:

- **high:** the CORPUS description names the same place as an OSM-named feature within 15 m of the anchor, and timetable order agrees with graph paths through the anchor.
- **medium:** the name only partly matches, or describes a related feature (signal box vs junction, carriage sidings vs yard). Topology agrees.
- **low:** no named OSM feature; the position is chosen from topology and timetable order only.

Details per TIPLOC: [INFERRED_BEHAVIOUR.md](INFERRED_BEHAVIOUR.md#i-002-timing-point-positions). A sourced position, if one is found later, replaces the inferred one (a TIPLOC may not have both; the validator enforces this).

## D-013: Distinct id prefixes for OSM locations and platforms (2026-10-27)

**Decision:** locations are `osm-loc-{n|w|r}<id>` and platforms `osm-plat-{n|w|r}<id>`. Track nodes stay `osm-n<id>`.
**Why:** named level crossings are both track nodes and locations, and their ids collided (the validator reported 3 `DUPLICATE_ID` errors). References in `control.json` and `timing-points.json` were updated.

## D-014: Signal-set approach (2026-10-27, owner decision)

**Decision:** signals come from the best available authoritative sources first: Network Rail data (CORPUS timing-point signals such as SHRW15/SHRW34, and SMART when accessible) and OSM, which is also used for track geometry. No signal coordinates are invented or labelled verified without evidence. Gameplay approximations for missing signals are allowed later, but must be labelled `inferred` or `placeholder` and shown distinctly. Phase 0 adds no gameplay signals.

## D-015: SMART does not supply Shrewsbury signal identities (2026-10-27)

**Finding:** SMART links no berth steps to Shrewsbury station or to any study-area timing point except Harlescott Crossing (TD area C3; see FEASIBILITY_REPORT).
**Decision:** don't derive signals or box membership from SMART for this area. Use the two Harlescott berth records only as corroboration for the inferred HRLSCTX position: they confirm Up and Down line reporting there and give no coordinates. The position stays `inferred`. Signal identities must come from other authoritative sources (D-014).

## D-016: Signal evidence layer with per-claim assessments (2026-10-27)

**Decision:** add an optional, generated dataset file `signal-evidence.json` (schema `SignalEvidenceFile`, `src/model/signalEvidence.ts`). It assesses each signal's identity, position, direction, berth association and track context **separately**. Each claim keeps its existing evidence label and gains an `assessment` (corroborated, consistent, consistent_with_reversal, single_source, ambiguous, disputed, contradicted, unresolved, not_assessed), with findings and limitations. A claim may be `verified` only if it is `corroborated`.
**Why:** the Carlisle pilot showed that a berth-number match can look right while the direction disagrees. One evidence label per signal would hide which claim is weak. Keeping this out of `infrastructure.json` means that file stays a pure OSM import (generated, never hand-edited), and Shrewsbury is unaffected (the file is optional).
**Derived Network Rail data:** the file includes the area's SMART berth rows (raw values) and CORPUS signal timing points. **Owner decision (D-019):** while the Network Rail licence is unconfirmed (`confirmed: false`), the file is kept local: git-ignored, not committed or published, and marked restricted pending licence review. This is pending confirmation, not a finding that redistribution is prohibited. If Network Rail states different terms, keep it in `data/private/` and regenerate it at build time. _(Corrected 2026-10-27: this entry previously said committing followed D-009.)_
**Reverse when:** a signalling plan or control table becomes available. That source would then give identities, positions and berths directly, at `sourced`/`verified` level.

## D-017: The seven Carlisle direction contradictions are explained, not verified (2026-10-27)

**Decision:** classify the pilot's seven contradicted signals (CE286, CE302, CE327, CE328, CE335, CE336, CE366) as `consistent_with_reversal`: trains enter dead-end bays at platforms 2, 7 and 8 and reverse (INFERRED_BEHAVIOUR I-003). CE302's direction is additionally `consistent` with a through step (`0302→0278`). No OSM direction is reversed and no claim is promoted to `verified`.
**Why:** CE302, CE327 and CE328 each stand 134–151 m in front of a buffer stop with no switch between, and face away from it. SMART pairs each arrival with an opposite-direction departure from the same berth. Reversing these signals would contradict a consistent through step (CE302) or make the recorded departure impossible (CE327/CE328 would face a buffer stop).
**Reverse when:** a TD recording or signalling plan shows that a different berth belongs to these signals.

## D-018: Proposed Carlisle playable boundary; Kingmoor deferred (2026-10-27)

**Decision:** `data/datasets/carlisle/playable-area.json` (status `proposed`, `basis: game_design`). The boundary is the OSM extract edge to the south (WCML), east (Newcastle, Settle–Carlisle) and south-west (Cumbrian Coast), plus a gameplay cut at 54.902 N on the Down/Up Main and Down/Up Goods lines, between Port Carlisle Branch Jn and Etterby Jn. Kingmoor is an optional area, `deferred`. No gameplay corrections are applied.
**Why:** OSM has no numbered signals at Kingmoor, while SMART and CORPUS show at least nine signal numbers there. Including Kingmoor now would mean placing signals without evidence. The cut uses existing nodes and removes no data.
**Reverse when:** Kingmoor signals are surveyed or sourced: set the optional area to `included` and move the north cuts to the extract boundary.

## D-019: Carlisle Phase 2 OSM refresh and supplement storage (2026-10-27)

**What was done (facts, verified against the files):**

- **Main refresh:** `data/raw/osm/carlisle-20261027T184451Z.json` (sha256 `e6c49d21…cddc9e`, OSM base `2026-10-27T18:47:20Z`). Its query is byte-identical to the pilot extract's (same bbox 54.870–54.940 N, 2.985–2.895 W). It was retrieved at 18:48:40Z from overpass-api.de after two HTTP 502 "server at capacity" responses, all recorded in the file's `fetch.attempts`. Its 2,014 elements are identical in content (tags, node lists, coordinates) to the pilot extract.
- **Supplement:** `data/raw/osm/carlisle-20261027T184451Z-supplement.json` (4.5 MB, sha256 `c75cb89a…e9f3c`, OSM base `18:46:17Z`, one HTTP 502 then 200). It has the same bbox, with documented additions: platform outlines (`out geom`), disused and abandoned railway ways, extra railway node types, stop_area relations, and relations containing the bbox's tracks.
- **Fetch method:** both were fetched with a one-off script, not `tools/fetch-osm.ts`. That tool names its output `<id>-<today>.json`, which on 2026-10-27 would have overwritten the pilot extract `carlisle-2026-10-27.json`, and it rewrites `area.json`. The hazard remains in the tool and is documented in IMPORTING.md.
- **Pilot extract kept:** `carlisle-2026-10-27.json` is unchanged (sha256 `7cbdd90e…a77c94`) and remains registered in `data/sources.json`.

**Decision (applied):** the carlisle `area.json` now names the main refresh as `osmSnapshot`, plus `osmSupplement` = the slim derivative below.
**Why:** both inputs then come from the same fetch session, 1 min 3 s apart in OSM base time. Re-importing changed nothing in `infrastructure.json` except the OSM version string and the new platform associations (D-020). A re-run of `tools/pilot-carlisle.ts` on the new infrastructure reproduces `carlisle-pilot-results.json` exactly, apart from `inputs.osm.version`.
**Reverse:** point `osmSnapshot` back to `carlisle-2026-10-27.json` and re-import.

**Slim derivative (applied):** `data/raw/osm/carlisle-20261027T184451Z-supplement-slim.json` (124 KB, sha256 `b9116307…c961582`) is produced deterministically by `tools/slim-osm-supplement.ts` from the raw supplement, which it never modifies. It keeps every node and way, and the stop_area and site relations. It keeps the 4 `route=railway` relations with members filtered to ways in the main extract. It omits 48 route relations (47 `route=train` service patterns and 1 `route=historic`), each listed with its id, name and member count in the file's `derivation.omitted`. The omitted relations' members name ways across Great Britain; nothing in the import uses them.

**Owner decisions (2026-10-27):**

1. **Raw supplement storage: keep it local.**
   - The raw 4.5 MB supplement stays git-ignored (`.gitignore`: `data/raw/osm/*-supplement.json`). It is preserved unchanged in this working copy, with its sha256 recorded in `data/sources.json` and in the slim derivative's `derivedFrom`. The slim derivative and its provenance metadata are kept.
   - A fresh clone cannot regenerate the slim derivative without obtaining the raw input, by copying it from the owner or re-fetching, which gives a different OSM base. The recorded hash identifies the exact input the derivative was made from. It does not guarantee that input remains available, and it says nothing about redistribution rights.
   - No raw snapshot is deleted or overwritten.
2. **SMART-derived files: kept local and not committed or published while the licence is unconfirmed.**
   - Network Rail's licence and redistribution terms for SMART are not yet confirmed (`licence.confirmed: false`). This is a decision pending that confirmation, not a finding that redistribution is prohibited. The files stay in place, so tools and tests keep working locally. They are marked as restricted, pending review:
     - **Bulk derived data:** `data/datasets/carlisle/signal-evidence.json`, `docs/pilots/carlisle-pilot-results.json` and `docs/pilots/carlisle-phase1-geography.json`. They are listed in `.gitignore`, which keeps them out of every clone's commits; they are already excluded from Prettier.
     - **Report and test quoting many berth ids and steps:** `docs/pilots/CARLISLE_PILOT.md` and `tests/carlisleEvidence.test.ts`. Both carry a notice and are excluded through this working copy's `.git/info/exclude`, which is local-only, so Prettier and ESLint still check them.
     - **Notice files:** `data/datasets/carlisle/RESTRICTED-SMART.md` and `docs/pilots/RESTRICTED-SMART.md` say what is withheld and why.
     - **Tracked docs that quote a few berth ids and steps in their working-tree changes:** `docs/DATA_GAPS.md` (Carlisle section), `docs/INFERRED_BEHAVIOUR.md` (I-003, I-004), and this log (D-017, D-021). They need the same review before those changes are committed. The committed D-015 mentions two Harlescott berth records but quotes no berth ids.
   - **On a fresh clone:** the excluded files are absent. `npm run data:reconcile-signals` regenerates `signal-evidence.json` from the owner's private SMART and CORPUS files, and `data:assess-geography` then works. Without those inputs, the Carlisle evidence test and the geography assessment cannot run.
   - **Revisit when** Network Rail's terms are confirmed. Then either remove the ignore and exclude entries, or move the files to `data/private/` and regenerate them at build time.

## D-020: Platform-to-track association from OSM stop positions and outlines (2026-10-27)

**Decision:** when a dataset supplies `osmSupplement`, the OSM importer links each platform to track (`src/import/osm/platformTracks.ts`). It records `Platform.trackAssociation` (method, status, stop nodes, stop_area relations, outline, edges alongside), and sets `edgeIds` only when the evidence agrees.

- **Evidence used:** a stop position (`railway=stop`) on the track with the platform's `ref`, grouped with the platform in a stop_area relation (or within 30 m without one), plus track running alongside the platform outline (at least 20 m within 3 m of it).
- **Mapped:** the stop's track and the outline agree. `edgeIds` is `sourced` when every mapped edge touches the stop node; it is `inferred` when outline geometry adds further edges on the same track.
- **Ambiguous or unresolved:** anything else; `edgeIds` stays `unknown`. Tracks alongside the outline but not the stop's track are recorded, not mapped.
- **Carlisle result:** 8 mapped (2, 5, 6, 7, 8 `sourced`; 1, 3, 4 `inferred`); the unnumbered platform area `way/132760232` is unresolved. No platform 9 exists in OSM, and none is created.

**Why:** these are OSM statements (stop positions and the station's stop_area relation `relation/1782890`), so the link is attributable. It is still OSM mapping, not verified real-world signalling.
**Shrewsbury:** it has no `osmSupplement`, so its import is unchanged (re-import checked byte-identical).
**Reverse:** remove `osmSupplement` from `area.json` and re-import.

## D-021: Slip types in junction assessment; single-slip diagonals unresolved (2026-10-27)

**Decision:** the junction model used for evidence assessment (`DirectedTrack`, rule `legs`) reads the sourced OSM `railway:switch` type of the Points at a four-edge node.

- **Any slip:** straight across is allowed.
- **`double_slip`:** both diagonals are also allowed.
- **`single_slip`:** has exactly one diagonal, but OSM does not say which, so its diagonals are forbidden in the assessment model. A movement possible only through one is reported as `unresolved_slip_diagonal` (step result) or `d` (geography). It is never counted as supported.
- **Reversal at a dead end** (I-003) now requires a head-on path under this model; a path found only under the `smooth` sensitivity rule no longer qualifies.

**Effect at Carlisle:**

- `0408→0302` changes from `reversal_at_dead_end` to `unresolved_slip_diagonal` (single slip `osm-n1460504004`).
- `0302→0407` changes from `consistent_alternative_heuristic` to `unresolved_slip_diagonal`.
- CE408's direction and berth claims become `unresolved`.
- The seven pilot contradictions keep their D-017 classifications.

**Why:** the slip type is a sourced fact; which diagonal a single slip provides is not. SMART recording a movement does not show which diagonal exists, and is not used to enable it.
**Validator:** `SLIP_TOPOLOGY`, `SWITCH_ARRANGEMENT_UNKNOWN` and `SINGLE_SLIP_DIAGONAL_UNKNOWN` (DATA_MODEL).
**Scope:** `tools/pilot-carlisle.ts` keeps its original graph-only model, so the pilot stays reproducible. This is an assessment heuristic, not an interlocking model.

## D-022: Signal type is form only; mounting and components are kept separately (R1, audit M1/M2) (2026-10-27)

**Decision:** `Signal.type` describes only the form of the signal's function-defining component: `semaphore | colour_light | light | sign | other | unknown`. The `ground` type is removed.

- Mounting is a separate evidenced field, `mounting`. It is set only from OSM `railway:signal:position` = `bridge` (gantry), `overhead` (overhead line structure) or `in_track`, and is otherwise `unknown`.
- Every `railway:signal:<category>` tag is kept as a verbatim `component` (form, design, states, height). The node's full tag set is kept as `sourceTags`.
- `classifySignal` derives type and function from the components. The schema rejects any other type or function.

**Why:**

- `GB-NR:shunting` with `:form=light` does not state a mounting, so `ground` was an inference carried under `sourced` provenance (M1). The OpenRailwayMap tagging pages (OSM wiki, read 2026-10-27) define `railway:signal:position` as `left | right` (side of track), `bridge` (signal gantry), `overhead` (attached to the catenary) and `in_track`. A low signal is stated by `railway:signal:<category>:height=dwarf`. Neither dataset has any `:height` tag.
- A neutral `light` type was chosen over `position_light`. The UK tagging page never uses "position light" as a value, so the tag does not establish the aspect style either.
- The same defect class affected banner repeaters, which were typed `colour_light`. They are now `light`.
- `colour_light` is kept for lit main and distant components. In the scheme, a lit `GB-NR:main` shows colour aspects (its listed states are red, green, yellow and double yellow). This is a reading of the tag's definition, not of track geometry.
- Subsidiary shunting aspects on main signals, junction route indicators (feather/theatre and states) and distant arms on main posts were dropped by the old model (M2). They are now kept verbatim.
- Nothing is derived from them: no aspect sequence, no routes shown by an indicator and no meaning of a subsidiary aspect.

**Effect:**

- Carlisle: 15 `ground` → `light`, and banner CE323BR `colour_light` → `light`. 2 gantry signals (CE406, CE407); 49 have unknown mounting. 21 main signals keep a shunting component, and 8 keep a route component.
- Shrewsbury: banner CJ97R `colour_light` → `light`. 2 gantry signals (CJ106, CJ119). 2 main semaphores keep their distant arm, and 7 keep a route component.
- Function counts are unchanged in both datasets.

**Compatibility:** `components` and `mounting` are required, so an infrastructure file written before R1 fails the schema and must be regenerated with `npm run data:import-osm`. Both real datasets were regenerated this way. `tests/datasetSignals.test.ts` checks that each file equals a fresh import of its recorded snapshot.
**Reverse:** restore `ground` to `SignalType` and the old `signalClass` mapping, then re-import. This would reintroduce an unsourced mounting claim.

## D-023: `simplified` evidence level for deliberate game simplifications (R1) (2026-10-27)

**Decision:** add a sixth evidence level, `simplified`, for something the game does differently from the real railway on purpose and keeps.

- It makes no claim about the real railway.
- `note` is required. It says what is simplified and what the real arrangement is, or that the real arrangement is unknown.
- `sources` are optional and cite the real data being simplified.
- The validator reports each simplification (`SIMPLIFIED_DATA`, warning). It rejects one in a source-derived layer (`SIMPLIFIED_IN_SOURCE_LAYER`, error): infrastructure (except occupancy sections, left to R2/M3), timing points, timetables and signal evidence.
- Gameplay corrections may be `simplified`.

**Why:** the existing labels could not express a deliberate design choice honestly:

- `inferred` claims a real-world fact derived by reasoning.
- `placeholder` promises replacement.
- A flag on `inferred` provenance would still read as a real-world claim to any consumer that checks only `evidence`.
- A separate level is the smallest change that consumers cannot misread. Code that treats only `sourced`/`verified` as trustworthy (e.g. the schematic preview's dashed lines) already handles it correctly.

**Migration:** none. No existing record's meaning is clearly a simplification.

- The Carlisle playable-area `gameplay_cut` cuts are labelled `inferred` with the note "Project choice: ...". The cut position is a design choice, but the same record also states a real-world `connectsTo`, so relabelling the whole record would misstate that claim. It is left for the playable-area work.
- `control.json` areas use `basis: game_design`/`real_signal_box`, which already separates design from reality.

**Compatibility:** additive. Every existing dataset parses unchanged. Exhaustive `switch`es over `EvidenceLevel` must handle the new value; there were none.
**Reverse:** remove the level and the two validator codes. No data uses it.

## D-024: Interlocking data invariants and evidence statuses (R2, audit H1/M3) (2026-10-27)

**Decision:** route and overlap validation moves to `src/validation/interlocking.ts` and enforces the invariants in DATA_MODEL "Interlocking validation" (P1–P7, S1–S5, C1–C4, O1–O3, E1–E2).

- **Statuses:** each route and overlap gets one status: `invalid`, `insufficient_evidence`, `game_rule` or `evidenced`. Errors mean the data contradicts the model. Warnings mean a fact it relies on is unknown, inferred or not modelled. Labels decide between `game_rule` and `evidenced`.
- **Schema changes,** all additive with defaults, so existing files parse unchanged:
  - `DataSource.interlockingAuthority` (default `false`; every registered source is explicitly `false`).
  - `PointsRequirement.role` (`path | flank`, default `path`).
  - A refinement on `OccupancySection`: `simulated` sections must be `inferred`/`placeholder`/`simplified`, and real kinds may not be `simplified` (M3).
- **New codes:**
  - Errors: `ROUTE_POINTS_MISMATCH`, `ROUTE_SWITCH_UNSUPPORTED`, `ROUTE_CONFLICT_INVALID`, `ROUTE_CONFLICT_ASYMMETRIC`, `ROUTE_CONFLICT_MISSING`, `INTERLOCKING_SOURCE_UNSUITABLE`, `POINTS_LIE_INVALID`.
  - Warnings: `ROUTE_SWITCH_UNRESOLVED`, `ROUTE_DIRECTION_UNKNOWN`, `ROUTE_DEPENDS_ON_INFERRED`, `ROUTE_CONFLICT_UNDETERMINED`.
  - Info: `INTERLOCKING_STATUS`.
- **Changed codes:**
  - `ROUTE_POINTS_UNSPECIFIED` goes from warning to error. A route over points with no required position would leave the points free to move under it, so missing data must not disable that constraint.
  - `IMPOSSIBLE_ROUTE` also covers revisited nodes, a self-route and an exit signal facing back. `IMPOSSIBLE_OVERLAP` also covers the overlap running behind its signal.

**Why:**

- **Statuses:** errors cover only proven contradictions. Missing facts (OSM never gives a points lie) are reported as insufficient evidence rather than passing silently or failing as invalid. Nothing is promoted to `verified` and no check is globally weakened.
- **Switch passages:** they are checked only against an evidenced lie. The geometric switch-leg heuristic in `src/reconcile/` is not used, because it is an assessment aid.
- **Directions:** only `Signal.facingTowardsNodeId` is used. SMART-derived direction assessments are never read.
- **Source authority:** it is a registry property, because suitability belongs to the source and not to each record. OSM (track layout) and the Network Rail open feeds (SMART/TD movements) cannot establish interlocking, alone or together.
- **Flank role:** without it, legitimate flank-protection requirements in a control table would be rejected as "points not on path".

**Effect:** no real dataset has routes, overlaps or occupancy sections, so validation results for Carlisle and Shrewsbury are unchanged. Every existing synthetic route test still passes.
**Limits:** passing these checks shows the data is internally consistent and honestly labelled. It does not show that a real interlocking is safe. Overlap length and release, approach and flank locking, opposing-overlap conflicts, and slip and crossing leg pairings are not modelled (DATA_GAPS).
**Reverse:** restore the previous route block in `validate.ts` and drop the three schema additions. Data written with `role: flank` or `interlockingAuthority` would then fail or lose meaning.

## D-025: One shared track-graph module; incomplete two-edge junctions are never plain track (R3, audit M7) (2026-10-27)

**Decision:** track-graph logic lives in `src/graph/`. Duplicate implementations were removed:

- `src/validation/graph.ts` moved into `src/graph/trackGraph.ts`.
- `DirectedTrack` moved out of `src/pilot/signalBerths.ts` into `src/graph/directedTrack.ts`.
- Plain-run traversal now has one implementation, replacing three:
  - `DirectedTrack.runTo`;
  - `runNodes` in `src/reconcile/geography.ts`;
  - `run` in `src/import/osm/platformTracks.ts`.
- Neighbour maps in `berthSteps.ts`, `signalEvidence.ts` and `geography.ts` are replaced.
- The interlocking validator's own neighbour, lie and passage logic is replaced by `TrackGraph.switchPassage`/`pointsLie`.

The junction classes and rules are in DATA_MODEL "Track graph".

**Where the implementations disagreed:**

- **Two-edge switch or crossing nodes.** `runTo` and the `DirectedTrack` rules passed through them as plain track. The platform-road and platform-association runs stopped there. The interlocking validator called them unresolved. The shared rule is that they are never plain track:
  - plain runs stop there;
  - `DirectedTrack` blocks them unless `incompleteJunctions: "allow"`, which is used only to report.
- **Choosing "behind".** "Behind" a signal was the first neighbour other than the one it faces, even at a node with two such neighbours. It is now the unique other neighbour, or null.
- **Parallel edges.** `runTo` chose the next step by neighbour node and could turn back along a parallel edge. `plainRun` chooses by edge.

**Evidence:** OSM tags these nodes `railway=switch`/`railway_crossing` (sourced), but only two ways are attached. A leg is missing from the data, and which two legs are mapped is unknown. Treating the node as plain track assumed a connection the data does not show. The validator already flagged every such node (`SWITCH_TOPOLOGY`/`CROSSING_TOPOLOGY`), and the Carlisle pilot listed `osm-n1460504022` as a blocker.

**Effect (deterministic before/after comparison, same inputs and `--generated 2026-10-27`):**

- **Unchanged byte for byte:**
  - Carlisle `signal-evidence.json` (all 115 steps and every claim);
  - both `infrastructure.json` files;
  - the `tools/pilot-carlisle.ts` results (graph-only model, no path used these nodes);
  - `data:validate` JSON for both datasets.
- **`docs/pilots/carlisle-phase1-geography.json`:**
  - Each `Reach` gains an `incomplete` field.
  - 40 of 324 connectivity cells change: 38 `L` → `i` and 2 `s` → none. All are traced in CARLISLE_PILOT.md to `osm-n1460504022`, `osm-n314950822`, `osm-n2464330439` and crossing `osm-n2464330250`.
  - Platform roads, topology, backlog and counts are unchanged.
- **Shrewsbury:** no reconciliation or geography outputs exist, and its import and validation are unchanged.

**Reverse:** have `DirectedTrack` pass two-edge junctions (`incompleteJunctions: "allow"` by default) and make `plainRun` treat any node with two edges as plain. This would restore the previous geography table, and with it the assumption that the missing leg does not matter.

## D-026: Operating day, CIF completeness and the Carlisle timetable snapshot (R4, audit M5/M8) (2026-10-27)

**Decision (operating day, approved by the owner):** a timetable snapshot for date D holds every service instance, whatever its origin date, with a time at a play-area TIPLOC inside [D 00:00, D+1 00:00), UK local time (`convention.kind = area_time_window`, `windowStart = 00:00`).

- **Identity:** a service instance stays `uid` + `runDate` (origin date).
- **Calls:** each call carries `dayOffset` (I-009), and `window` marks instances whose area times run across the boundary.
- **Nothing is dropped silently:**
  - Trains considered and left out are listed in `excluded` with a reason: area times outside the window, deferred area only, or superseded by an overlay outside the area.
  - Previous-day trains entirely before the window are counted.
- **Clock-change days** are flagged, not adjusted.
- **Bank holidays** come from the GOV.UK calendar (`govuk-bank-holidays`, OGL v3.0, committed snapshot). The CIF flag is kept verbatim and is `unresolved` only if the window holds a bank holiday.

**Decision (CIF):**

- The parser now reads `AA` (associations) and `CR` (change en route). It reports `TI`/`TA`/`TD` and unknown records instead of dropping them, and treats malformed or incomplete input as an error.
- Positions follow the Open Rail Data wiki field order and were confirmed on the real extract DFROC1F: 79,404 of 79,404 AA and 104,589 of 104,589 CR records fit every field, and every CR names the location record that follows it. The full extract parses with 0 errors.
- Only CR fields whose positions were verified are decoded; the rest stay in `raw`.

**Decision (Carlisle scope, approved: playable area only):**

- 29 area TIPLOCs and 27 deferred (Kingmoor) TIPLOCs (I-011). This refines the pilot's list:
  - adds London Road Jn, two Upperby/High Wapping codes and Esso Petteril Bridge;
  - moves "Carlisle Yard", Brunthill and NY DBS to deferred on timetable-neighbour evidence.
- `CARLILE` is mapped by CRS (sourced). No other link is made.

**Defect fixed:** the import kept only area schedules, so an overlay that sent a train elsewhere on the date was invisible and the permanent area schedule was used. The parser now indexes every schedule's dates, and such trains are excluded as `superseded_outside_area`. None occur at Carlisle on 2026-11-04.

**Result (`data/datasets/carlisle/timetables/2026-11-04.json`, DFROC1F):**

- **Services:** 381 (354 starting 11-04, 27 starting 11-03).
  - 254 passenger and 127 other categories (freight, ECS and so on), counted with the same category list as the pilot.
  - STP: P 365, O 13, N 3.
  - 373 within the window; 4 start before it and 4 run on after it.
- **Associations:** 105.
- **Excluded:** 24 trains of 11-04 that reach the area only after midnight, and 29 Kingmoor-only workings. 340 trains of 11-03 lie entirely before the window.
- **Other:** 54 changes en route (on 49 services); no bank-holiday flags; no clock change.
- **Reproducibility:** the import is reproducible byte for byte (`--out` comparison).

**Why:** a game session needs every train that is in the area during the day. The old origin-date snapshot included 24 trains that reach Carlisle only on 11-05, and omitted the 27 that started on 11-03 and run through after midnight.
**Shrewsbury:** its 2026-11-04 snapshot is left as built (origin-date, legacy) and flagged by `TIMETABLE_LEGACY_CONVENTION`. Re-importing it would change committed data; it is listed in DATA_GAPS.
**Reverse:** set `windowStart` to another time (supported), or restore origin-date selection in `buildSnapshot`. Snapshots record their convention, so either is detectable.

## D-027: Control-area model: real-world claims, game-design choices and handover data (R5, audit M4) (2026-10-27)

**Decision:** `control.json` gains three optional parts.

- **`controlCentres`:** real boxes and centres, with real-world claims for operational status, control method, methods of working, signalling principles and extent.
- **`externalAreas`:** track beyond a boundary.
- **Handover fields on `AreaBoundary`:** cut, boundary signals, traffic directions, handover choice, status and unresolved items.

`ControlArea` gains optional `controlCentre` (real-world claim), `operator` (design choice) and `platformIds`. The rules:

- Real-world claims (`realWorldClaim`) may not be `simplified`/`placeholder`, and are `unknown` exactly when they have no value.
- Game-design choices (`designChoice`) must be `simplified`.
- A `game_design` area may not be labelled `sourced`/`verified`.
- An unresolved boundary may not be `complete` or `sourced`/`verified`.

**Carlisle (`data/datasets/carlisle/control.json`):**

- **Real-world facts:** only that OSM maps a building named "Carlisle Power Signal Box" (sourced). Its operational status, control method, methods of working, principles and control limits are all `unknown`. The word "Power" in the name is not evidence of equipment, and the CE ref prefix and TD area CL are not evidence of limits.
- **Inferred:** the game area's membership comes from the playable-area geometry: 47 signals and 104 points on track reached from the cuts' inside nodes without crossing a cut (`npm run data:control-membership`). The five external areas beyond the cuts come from the cuts' `connectsTo` (I-006).
- **Game design (proposed):** one control area `carlisle-ws-1` for the whole playable area, operated by a human or an AI. Whether and where to split it between players is undecided.
- **Boundaries:** 12 game-design boundaries, one per playable-area cut. All are `incomplete`: boundary signals, traffic directions and the controlling centre beyond are `unknown`, and the game handover is `null` (undecided, R6).
- **Out of scope:** Kingmoor (`ext-kingmoor`, `deferred_play_area`) and the four lines beyond the extract (`outside_play`).

**Shrewsbury:** unchanged. Its file parses as before, and it has no `controlCentres`, because the repository holds no per-box sourced statement of equipment or method of working. Two observations are recorded in DATA_GAPS and not changed:

- "Mechanical" in FEASIBILITY_REPORT is not recorded per claim.
- All four boxes cite the same Wikipedia article as their second source.

**Fixture:** the synthetic dataset's game-design area was labelled `sourced`, which the new rule rejects. It is now `simplified`.
**Why:** a box being real does not say where the game should divide work, and a name or a layout does not say what equipment or rules a box uses. Keeping the three kinds of statement apart lets later work fill in sources without rewriting game choices, and stops either being mistaken for the other.
**Reverse:** all new fields are optional; drop them and the two new validation modules' checks.

## D-028: Authoritative command pipeline and safety-invariant harness (R6) (2026-10-27)

**Decision (owner-approved):** add `src/sim/`, a pure, server-side pipeline shared by human and AI operators. It is described in [ADR 0001](adr/0001-authoritative-command-pipeline.md).

- **Commands:** typed envelopes (`set_route`, `cancel_route`, `move_points`).
- **One write path:** `CommandStore.submit`, which parses, rejects repeats and stale versions, makes a pure `decide`, applies, records and publishes.
- **State:** deeply frozen; rejections never change it.
- **Log:** append-only; it includes rejections.
- **Publishing:** a `StatePublisher` interface only.

**Owner decisions on policy:**

- Sessions may clear `evidenced` and `game_rule` routes, never `insufficient_evidence` or `invalid`.
- `set_route` never moves points; operators move them first.

**Fixed fail-safe rules (literal types):** unknown occupancy counts as occupied, per-edge occupancy, instant points, and cancellation only on clear track.

**Tests:** `tests/sim.test.ts` (27) covers:

- conflicting routes;
- unproven points;
- occupied and unknown track;
- route locking;
- human/AI parity;
- no mutation on rejection;
- authority;
- incomplete evidence;
- repeated, stale and malformed commands;
- the publisher.

All of it runs on labelled synthetic fixtures.

**Not implemented:** train movement, live interlocking, Socket.IO, AI decision-making, persistence and live feeds. The read-only server is unchanged.
**Why:** to make human/AI parity and "rejections change nothing" structural (one write path, frozen state, a pure decision) rather than a matter of convention, before any gameplay code exists.
**Reverse:** `src/sim/` has no dependants; delete it and this entry.
