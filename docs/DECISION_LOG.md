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

## D-029: Game-rule interlocking layer: simplified points configuration and fringe endpoints (P0) (2026-10-27)

**Decision (owner-approved architecture, R7 decisions 1–2):** add an optional, hand-authored dataset file `game-rules.json` (schema `GameRules`, `src/model/gameRules.ts`; checks in `src/validation/gameRules.ts`). It holds two kinds of deliberate game simplification, and nothing else:

- **Points rules:** a `simple` lie (normal and reverse nodes), or the explicit list of movements a `single_slip`/`double_slip` permits, each with its position.
- **Fringe endpoints:** a playable-area cut where routes may start or end without a signal. `Route` gains optional `entryFringeId`/`exitFringeId`, and `entrySignalId`/`exitSignalId` become nullable (exactly one of each per end; at least one signal; no overlap at a fringe exit).

**Rules (DATA_MODEL "Game rules", G1–G5, F1–F3):**

- Every rule is `simplified` (schema-enforced) and stays out of `infrastructure.json`.
- A rule may only fill a lie that is `unknown`. It never overrides a stated lie, so an inferred lie stays `insufficient_evidence`.
- A slip rule needs the sourced slip type.
- Only rules that pass every check are used; an invalid rule is reported and ignored, so its points stay unresolved.
- A route relying on a game-rule lie, slip passage or fringe endpoint is at best `game_rule`, never `evidenced`.
- Every R2 invariant still applies: leg-to-leg, position mismatch, missing requirement, conflicts, provenance.
- Slip movements not listed by a rule stay unresolved, and routes meeting at a slip without a declared conflict stay `ROUTE_CONFLICT_UNDETERMINED`.

**Also:**

- `pointsLie` no longer uses a lie labelled `simplified` in infrastructure. Such a lie was already a `SIMPLIFIED_IN_SOURCE_LAYER` error, but it previously reached `ROUTE_DEPENDS_ON_INFERRED`, which described a simplification as inferred.
- Missing `signalling.json` gives `SIGNALLING_ABSENT` (info), not silence.
- The simulation authorises a fringe end only through the operator's control-area boundary at that cut, and a fringe-entry route clears no signal.
- The read-only API returns `gameRules` as its own key.

**Codes:**

- Errors: `GAME_RULE_POINTS_INVALID`, `GAME_RULE_CONFLICTS_WITH_SOURCE`, `FRINGE_ENDPOINT_INVALID`.
- Info: `ROUTE_USES_GAME_RULE`, `SIGNALLING_ABSENT`.

**Why:**

- OSM never states a points lie, and states the switch type for only 4 of Carlisle's 218 points. Under R2 alone, no route over points could be anything but `insufficient_evidence`, which the policy (D-028) never clears.
- `inferred` would claim a real-world fact that no reasoning supports, and `simplified` data is banned from source layers (D-023). A separate, simplified-only layer lets the game run while every consumer can still tell game choices from source facts.
- Fringe endpoints avoid inventing boundary signals that no source identifies (D-027: all Carlisle boundary signals are `unknown`).

**Effect:**

- No dataset has `game-rules.json` yet; Carlisle routes and rules are P1.
- Shrewsbury's validation output is unchanged.
- Carlisle's only change is the new `SIGNALLING_ABSENT` info (checked against a JSON snapshot taken before the change). No schema change affects existing files: `entryFringeId`/`exitFringeId` are optional, and string signal ids still parse.

**Limits:**

- Crossings (diamonds), three-way points and untyped four-way nodes cannot be configured.
- Fringe endpoints say nothing about trains beyond the cut (P5/P6).
- Passing these checks does not show that any real interlocking is safe.

**Reverse:** delete `game-rules.json` files, `src/model/gameRules.ts` and `src/validation/gameRules.ts`; drop the optional `rules` argument of `switchPassage`/`assessInterlocking`, the fringe fields on `Route` and the fringe branch in the simulation's `authorised`. Routes that used game rules become `insufficient_evidence` (or fail the schema, if they used a fringe end).

## D-030: Carlisle MVP route set: seven game routes on the WCML Up and Down Main (P1) (2026-10-27)

**Decision:** add `data/datasets/carlisle/signalling.json` (7 routes, no overlaps) and `data/datasets/carlisle/game-rules.json` (20 points rules, 3 fringe endpoints).

- Every route and rule is `simplified`.
- **This is a small playable game model, not a verified real-world signalling plan:** no control table or other interlocking source is available, and none of these routes claims to be Carlisle Power Signal Box's.
- Track, signal positions and directions are OSM (`sourced`).
- Every points passage relies on a game rule.
- The toe of each simple rule, and the straight pairing of each slip rule, are inferred (I-012).

| Route                | From → to                           | Why it is in the MVP                                                                                                                                                |
| -------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rt-dm-fringe-ce264` | fringe `fr-wcml-south-down` → CE264 | Down trains from Penrith enter play and run to the first northbound main signal (CE264 stands at the cut)                                                           |
| `rt-dm-ce264-ce272`  | CE264 → CE272                       | Down Main running between consecutive northbound main signals (1 switch)                                                                                            |
| `rt-dm-ce272-ce286`  | CE272 → CE286                       | As above (2 switches, trailing crossover ends)                                                                                                                      |
| `rt-dm-ce286-ce323`  | CE286 → CE323                       | Down Main through Carlisle South Jn, straight across single slip `osm-n10288170`, and through platform 3                                                            |
| `rt-dm-ce323-fringe` | CE323 → fringe `fr-north-down-main` | Down Main through Carlisle North Jn, straight across single slip `osm-n7253833743`, to the north gameplay cut; OSM maps no further northbound main signal before it |
| `rt-um-fringe-ce336` | fringe `fr-north-up-main` → CE336   | Up trains from the north enter play and run to the first southbound main signal                                                                                     |
| `rt-um-ce336-ce304`  | CE336 → CE304                       | Up Main through platform 4 to CE304                                                                                                                                 |

**How the set was chosen:**

- Each candidate path follows the edges OSM tags `Down Main` / `Up Main`.
- A route was kept only if all of these hold:
  - every node it passes is plain track, a three-edge switch, or a single slip passed straight across;
  - every switch is passed toe-to-leg under I-004;
  - its end signals are OSM `main` signals facing along it;
  - no two routes share an edge, points or junction node, so C3/C4 require no declared conflicts and `conflictsWith` is empty throughout.
- Each points rule is used by exactly one route, and no rule configures points that no route uses.

**Omitted routes (exact reasons):**

- **Up Main CE304 → CE285:** it passes `osm-n2464365978` and `osm-n13915496837`, mapped as plain nodes with three edges (no `railway=switch` tag, so `untyped_junction`), then diamond crossing `osm-n3057659458`. P0 game rules cannot configure untyped nodes or crossings, and guessing their legs would invent topology.
- **Up Main CE285 → CE278 and CE278 → fringe `cut-wcml-south-up`:** both are valid on their own, but no train can reach them from an authored entry while CE304 → CE285 is blocked. Also, CE278 → south passes CE268 and ends beside CE263, both with no OSM category.
- **The result:** southbound trains can run only as far as CE304 at the south end of platform 4. There is no Up exit to the south.
- **Not attempted:** platform bays and other platforms, the Newcastle, Settle–Carlisle and Cumbrian lines, goods lines, Kingmoor (deferred), and every crossover movement between the Up and Down Main (no crossover route is authored; their points rules set only the Main line leg).
- **Overlaps:** none; no evidence exists for any overlap or its length.
- **Flank protection:** not authored. The far end of each crossover is not held as flank by the route on the other line, because a crossover has only Main-line routes authored and no source states the flank arrangement.

**Known limitations:**

- Platform 3 and 4 track associations are `inferred` (D-020, I-007). The routes use the track, not the association.
- **CE438** stands at the north Up Main cut with no OSM category, and `rt-um-fringe-ce336` runs past it: the game does not use it as a route signal.
- The local, restricted SMART evidence assesses the directions of CE286 and CE336 as `consistent_with_reversal` (D-017), and those of CE272, CE323 and CE438 as `not_assessed`. Routes use only the OSM direction (S5).
- **Boundaries:** fringe endpoints claim no real boundary signal, traffic direction or control limit, and all 12 `control.json` boundaries stay `incomplete`.
- **No timetable link yet:** the timing-point mapping is still CARLILE only (P5).

**Fix found while authoring (P0 defect):** `SIMPLIFIED_DATA` reported "0" points rules because rules are keyed by `pointsId`, not `id`. The provenance walker now names a points rule by its `pointsId`, and the P0 test asserts the count and owner.

**Tests:** `tests/carlisleRoutes.test.ts` runs on committed files only. It covers:

- the documented route table and a fingerprint of every route and rule;
- resolvable endpoints and cut crossings;
- that every passage is set only with its rule, and every simple rule agrees with I-004 (`DirectedTrack.passes`, added for this);
- slip diagonals unresolved;
- that every route is `game_rule`;
- pipeline set/lock/conflict behaviour on the real set;
- diagnostics for omitted, inferred-only and disconnected routes.

**Effect on validation:** Carlisle has 0 errors and 7 `game_rule` routes. `SIGNALLING_ABSENT` is gone, and `ROUTE_USES_GAME_RULE` (7) and `SIMPLIFIED_DATA` (routes, points rules, fringe endpoints) are added. Shrewsbury is unchanged, and `infrastructure.json` is untouched.

**Reverse:** delete the two files (Carlisle returns to `SIGNALLING_ABSENT`), or remove routes together with the rules only they use.

## D-031: Deterministic simulation clock and tick transitions (P2) (2026-10-27)

**Decision:** add a simulation clock and tick transitions to the existing `CommandStore`, described in [ADR 0001](adr/0001-authoritative-command-pipeline.md) under "Simulation clock and ticks". No parallel engine is added.

- **Clock (`src/sim/clock.ts`):** `AuthoritativeState.clock = { tick, timeMs, tickDurationMs }`.
  - Time is an integer number of milliseconds on the session timeline and is never read from the system clock.
  - `ClockConfig { startTimeMs, tickDurationMs }` is passed to `initialState`. `DEFAULT_CLOCK` is 0 ms with 1 000 ms ticks.
  - Invalid configurations throw. Advancing past `Number.MAX_SAFE_INTEGER` is refused as `TIME_OVERFLOW`.
- **Ticks (`src/sim/tick.ts`):** `CommandStore.tick({ tick: n })` applies tick _n_ only when it is the next one.
  - A tick already applied is a `duplicate` and changes nothing.
  - A skipped tick is `TICK_OUT_OF_SEQUENCE`; a bad request is `MALFORMED`.
  - `decideTick` is pure, like `decide`.
- **One serialized path:** `submit` and `tick` run one at a time on the same store, and share one event log and `seq`.
  - Every accepted input raises `version` by one, so a command based on a pre-tick version is `STALE`.
  - Commands never change the clock, and P2 ticks change nothing else.
  - Events now carry `kind` (`command` or `tick`) and `timeMs`.
- **Replay:** `replay(world, initial, inputs)` applies an ordered `SimInput` list and gives the same state and a byte-identical log every time.
- **Future contract:** `TickStage` and `TICK_STAGES`, which is empty in P2. The ADR lists the safety expectations later stages must keep: unknown occupancy is never clear, there is no movement without route and signal authority, a train never passes a signal at danger, there is no entry without valid route and points, and authority is never stale.

**Not implemented:** train movement, occupancy changes, timetable playback (including what simulation time 0 means as a date and local time), route release, a real-time tick driver, UI, AI, networking and persistence.

**Tests:** `tests/simClock.test.ts` (27, synthetic fixtures) covers:

- configuration and invalid values;
- one tick, and 10 000 ticks with no drift;
- the overflow boundary;
- duplicate, out-of-sequence and malformed ticks;
- command-then-tick and tick-then-command ordering;
- version and `seq` progression;
- unchanged state after rejected commands;
- route locking across ticks;
- that operators cannot tick;
- the publisher;
- that ticks do not touch points, routes, signals or occupancy;
- the stage contract;
- replay determinism, including under faked system time and randomness;
- a source scan for wall-clock, timer and randomness reads in `src/sim/`.

`tests/sim.test.ts` changed by one type narrowing, now that the log holds tick events too; its assertion is unchanged.

**Why:** later train movement needs a time base that is exact, replayable and serialized with operator commands, so that a train can never move on stale authority. Building that base on its own first keeps the change small and testable.

**Open:** risk 7 in ADR 0001. Because ticks raise the version, fast tick rates may make networked commands `STALE` often. Any relaxation must still refuse commands whose authority has changed.

**Reverse:** remove `clock.ts`, `tick.ts`, `ClockState` from the state, the store's `tick` and `replay`, and the event `kind`/`timeMs` fields. Nothing outside `src/sim/` and its tests depends on them.

## D-032: Deterministic train movement and derived occupancy (P3) (2026-10-28)

**Decision:** add explicitly placed trains, movement along taken routes, and occupancy derived from train footprints. The design is in [ADR 0001](adr/0001-authoritative-command-pipeline.md), "Trains, movement and occupancy", and was written before the code. No parallel engine is added: movement is a P2 tick stage.

- **Trains (`src/sim/train.ts`):** a train is:
  - a minimal directed edge path, rear to head;
  - a head offset and a length, in integer millimetres (edge length = OSM-derived `lengthM` × 1000);
  - a constant integer speed, with a sub-millimetre residue so movement never drifts;
  - the route ids it has taken (`authority`), and its last stop reason.

  Trains exist only in the initial state. Placement is validated (12 codes) and throws if invalid; the store re-checks every state it is given.

- **Occupancy:** `trackStatus` is what is known apart from trains. `occupancy` is derived from it and the train paths, and is checked after every accepted transition.
  - A train occupies every edge it touches.
  - A vacated edge returns to its `trackStatus`, so `unknown` stays unknown.
- **Movement (`src/sim/movement.ts`):** a train takes a set route only from the route's start node, with:
  - its entry signal `off` and its status allowed by the policy;
  - its points detected and locked.

  The route becomes `takenBy` the train, and the signal returns to `on`.
  - At every node crossing, the canonical `TrackGraph.switchPassage` (with game rules), points detection and locking, facing signals, edge length and occupancy are checked again.
  - Trains advance up to the first point they may not pass and stop there consistently.

- **Policy literals:** `signalAtOn: "stop_every_train"` (since D-033: `"stop_by_function"`), `signalReplacement: "on_passing"`, `trainStopping: "instant"`, `unknownEdgeLength: "impassable"`.
- **Stage contract:** `TickStage` is now `{ name, writes, run }`. `decideTick` checks after every stage that `version`, `clock` and every field the stage does not write are unchanged, and that occupancy is derived.
  - `train-movement` writes `trains`, `occupancy`, `routes` and `signals`.
  - Trains move in ascending id order, each against the state the previous one left.

**Carlisle (committed files, synthetic test trains, `tests/carlisleTrains.test.ts`):**

| Movement                                   | Result                                                                                                                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Down Main: CE264 → CE272 → CE286 → CE323   | Runs through all three routes, including straight across slip `osm-n10288170`, then stops at **CE323BR** (repeater at `on`; since D-033 it passes CE323BR and stops at CE323) |
| Down Main: CE323 → north cut               | Runs the whole route; stops at the cut's outside node (end of authority; leaving play is not modelled)                                                                        |
| Up Main: north fringe → CE336              | Enters from the fringe and crosses the cut edge; stops at **CE438** (no OSM category, at `on`)                                                                                |
| Up Main: CE336 → CE304                     | Runs the whole route; stops at CE304 (no Up route beyond it, D-030)                                                                                                           |
| Down Main from fringe `fr-wcml-south-down` | **Blocked by data:** the extract ends at the cut, so no train can stand outside it                                                                                            |

No route, rule, length, lie, category or overlap was added or changed. The route and rule fingerprints in `tests/carlisleRoutes.test.ts` still pass.

**Tests:**

- `tests/trains.test.ts` (23, synthetic `fixtures/synthetic/movement.ts`), which covers:
  - placement codes;
  - stores with inconsistent trains or occupancy;
  - movement across edges and routes;
  - the normal and reverse legs;
  - exact sub-millimetre progress;
  - signals at danger, including an intermediate signal with known and with unknown facing;
  - the authority limit at any speed;
  - withdrawn and disconnected authority (crafted);
  - unknown occupancy and unknown edge length;
  - commands refused over a train's track;
  - a second train blocked through the pipeline, and by occupancy (crafted, both id orders);
  - id ordering;
  - replay;
  - scope.
- `tests/carlisleTrains.test.ts` (6).
- `tests/simClock.test.ts`: the stage tests now use the explicit contract, and gain a test that a stage writing an unlisted field or underived occupancy is refused.

**Not implemented:** timetable spawning or integration, leaving play, route release, approach locking, aspect sequences, signal functions, braking, reversing, AI, networking, UI, new routes or infrastructure.

**Why:** movement must use the same route, points and signal checks as route setting, run inside the serialized tick, and never trust stale authority. Deriving occupancy from footprints means it can never disagree with where trains are.

**Reverse:** remove `train.ts`, `movement.ts`, the stage from `TICK_STAGES`, `trains`/`trackStatus` from the state, `takenBy` from `SetRoute`, and the four policy literals. Restore `occupancy` as the injected value. `decide` is unchanged and keeps working.

## D-033: Signal movement roles and explicit route allocation (P3.1 correctness review) (2026-10-28)

**Context:** a P3.1 review of D-032 found these problems:

1. **Signal function was ignored.** Movement read only the aspect, and only route entry signals are ever cleared. So the sourced banner repeater CE323BR was a permanent stop, as any repeater or distant inside a route would be.
2. **Unknown functions could authorise movement.** Neither the R2 assessment nor `set_route` read the entry signal's function. A route whose entry is a repeater, a stop board, or a signal with no source-stated category could be cleared and taken. Not reachable with the Carlisle data: all seven MVP routes start at main signals.
3. **An aspect could act as authority.** At a node crossing, any facing signal that was `off` was passed, even if it was off for a route the train was not taking. This was not reachable through the pipeline with valid routes, because such a route conflicts on shared track. It was still a gap in the model.
4. **Cancelling could orphan another route.** `cancel_route` always put the entry signal back `on`, even for a route already taken. Had the signal since been cleared for another route, that route would have stayed set behind a signal at `on`. This was not reachable with valid routes either.

**Decision** (design in [ADR 0001](adr/0001-authoritative-command-pipeline.md), "Route state, allocation, aspect and authority"):

- **Movement roles by function** (`SIGNAL_MOVEMENT_ROLE`, `src/sim/train.ts`). The policy literal is now `signalAtOn: "stop_by_function"`.

  | Role          | Functions                        | Effect                                                                         |
  | ------------- | -------------------------------- | ------------------------------------------------------------------------------ |
  | `worked_stop` | `main`, `shunting`               | Stops a train unless it is the `off` entry of the route taken at that crossing |
  | `no_stop`     | `distant`, `repeater`            | Passed whatever its state; never authorises a movement                         |
  | `always_stop` | `stop_board`, `other`, `unknown` | Never passed; never authorises a movement                                      |
  - Placement now forbids straddling only signals that can stop a train.
  - The function comes from the importer's `classifySignal` over source components. Nothing new is inferred, and no dataset field changes.

- **Entry signals:** `set_route` and movement both refuse a route whose entry signal is not a main or shunting signal (`ROUTE_NOT_ESTABLISHED`).
- **Signals and offered routes:** `set_route` refuses a route whose entry signal is already `off` for another offered route (`ROUTE_CONFLICT`).
- **Crossing a worked stop signal:** it is passed only as the entry of the route taken by that crossing. If it is `off` for anything else, the train stops (`NO_AUTHORITY`).
- **Cancelling:** `cancel_route` replaces the entry signal only for an offered (untaken) route.
- **Invariant:** `routeSignalIssues` checks every state the `CommandStore` accepts. A signal is `off` exactly while it is the entry of one offered route; only worked stop signals are ever `off`; and `takenBy` names an existing train.

**Carlisle (committed data unchanged; route and rule fingerprints still pass):**

- **CE323BR:** OSM tags it `railway:signal:main_repeated=GB-NR:banner`, so it is a sourced repeater. Down trains now pass it and stop at CE323. With `rt-dm-ce323-fringe` set, the same train runs on to the north cut. Its OSM `fixme` ("approximate position") no longer affects movement.
- **CE438:** its OSM node has no `railway:signal:<category>` tag, so its function is `unknown`, and Up trains from the north fringe still stop at it. Evidence needed: a source stating its function. If it is a main signal, `rt-um-fringe-ce336` passes a stop signal and must be split at it.

**Found but not changed** (needs route release, P4): route conflicts include overlap track, and cancelling a route needs clear track. A train at the exit signal of a route with an overlap could therefore never be given the onward route. No dataset has overlaps.

**Tests:**

- `tests/trains.test.ts`, synthetic, +12 tests:
  - role table;
  - a banner repeater and a distant passed at `on`;
  - placement across them;
  - main, shunting, stop-board and unknown signals in a route stop the train;
  - a running signal at danger;
  - an aspect without allocation (crafted);
  - entry signals of each non-authorising function;
  - a following train through the full route lifecycle (set, taken, held, consumed, cancelled, set anew);
  - cancelling a taken route (crafted);
  - the invariant;
  - a four-edge footprint with the tail holding track and authority;
  - points moves and routes refused under head or tail;
  - a second train kept off an edge held only by a tail (crafted).
- `tests/carlisleTrains.test.ts`: the CE323BR expectation is updated, and CE438's function is asserted.

**Not implemented:** route or overlap release, approach locking, aspects beyond `on`/`off`, permissive shunting, braking, timetable integration, UI, AI, multiplayer.

**Why:** authority must come from route allocation, not from an aspect. A signal's function must not be guessed in either direction: a sourced repeater is not a stop signal, and an unknown signal is neither passable nor able to authorise a movement.

**Reverse:** restore `signalAtOn: "stop_every_train"`. Treat every role as `worked_stop` in `crossingProblem` and placement, but keep the entry-signal check. Removing the check would let an unknown function authorise a movement.

## D-034: Approach locking and route release as explicit game rules (P4) (2026-10-28)

**Context:** in P3 a taken route stayed set until an operator cancelled it on clear track. Instant stopping stood in for approach locking. A route with an overlap could deadlock its own onward route (found in D-033).

**Decision** (design in [ADR 0001](adr/0001-authoritative-command-pipeline.md), "Route lifecycle: approach locking and release"):

- **Lifecycle phase is derived** (`routePhase`): `offered`, `taken` (`takenBy`) or `approach_locked` (new optional `SetRoute.approachLock = { commandId, lockedAtMs }`). The phase is never stored as a status. Aspect, train association, authority, occupation and release each keep one owner.
- **Approach condition** (policy literal `approachLocking: "approach_edge"`), a game abstraction:
  - a train's head is on an edge meeting the route's start node, other than the route's first edge, and it is travelling towards that node; or
  - such an edge is not proven clear apart from trains.

  One edge is used because trains stop instantly. No distance is claimed.

- **Cancelling an offered route:**
  - With nothing approaching, the route is removed and the signal goes `on`.
  - Otherwise the signal goes `on`, and the route stays approach locked: its points stay locked, and its track and overlap stay reserved for conflicts.
- **During the lock:** a repeated cancel or a re-set is `ROUTE_APPROACH_LOCKED`, a new rejection code. A duplicate `commandId` is a `duplicate`. Taken routes are never cancelled while a train is on them (`TRACK_OCCUPIED`).
- **`route-release` tick stage** (after `train-movement`; writes only `routes`; ascending id order):
  - releases a taken route once no train holds it or covers its edges, with overlap edges allowed only under an onward route the covering train holds;
  - releases an approach lock after `approachLockReleaseMs` of simulation time since the cancel (policy number; default 120 000 ms, a game setting), or as soon as nothing approaches.
  - Release never changes a signal.
- **Policy:** `routeRelease: "on_train_clearance"` (literal, whole-route release, no sectional release).
- **Overlaps:** an onward route from a route's exit signal does not conflict on track found only in that route's overlap. Opposed points still conflict. This resolves the D-033 deadlock.
- **Invariants** (`routeSignalIssues`, checked on every accepted state):
  - never taken and approach locked at once;
  - the lock time is valid and not after the clock;
  - no train stands on an approach-locked route;
  - only offered routes keep a signal `off`.

**Evidence:** none for Carlisle. No source gives approach-locking distances or times, track circuits, overlaps or control tables (DATA_GAPS). The Network Rail GIS assessment is physical-infrastructure evidence only and was not used. Everything above is `simplified` game policy (INFERRED_BEHAVIOUR, "Not yet inferred"). No Carlisle route, rule, signal category, topology or OSM data changed; the route and rule fingerprints still pass.

**Tests:**

- `tests/routeLifecycle.test.ts` (26, on the synthetic `fixtures/synthetic/routeLifecycle.ts`: approach track `e0`/`sig0`/`r0` and an optional overlap `ov1`) covers:
  - set, and cancel with and without an approaching train;
  - unknown approach track;
  - fringe-entry locks;
  - duplicate and repeated requests;
  - the time release to the millisecond, and the "nothing approaching" release (crafted);
  - cancel after the train has passed;
  - tail and stopped-train protection;
  - release that clears no signal, and re-setting;
  - overlap blocking and the onward-route exemption;
  - non-authorising signal functions;
  - two trains in both id orders;
  - replay;
  - duplicate and out-of-sequence ticks;
  - stale commands;
  - crafted invariant breaches;
  - policy literals.
- `tests/carlisleRelease.test.ts` (3, synthetic trains on committed data):
  - no reuse until cleared and set again;
  - an approach lock at CE264 held for 119 s and released at 120 s;
  - CE323BR and CE438 unchanged.
- **Updated assertions** in `tests/trains.test.ts`, `tests/carlisleTrains.test.ts` and `tests/simClock.test.ts`. They pinned P3's "no route release" behaviour or the stage list. They now assert release, `ROUTE_NOT_SET` after release, and that release clears no signal; every safety assertion is kept.

These tests prove that the model is internally consistent, not that it is faithful to Carlisle's real interlocking.

**Not implemented:**

- braking or real approach distances;
- "comes to a stand" release;
- sectional release, overlap timed release, swinging overlaps;
- re-setting an approach-locked route;
- timetable spawning, AI, multiplayer.

**Reverse:**

- remove `routeLifecycle.ts` and its stage from `TICK_STAGES`;
- remove `approachLock`, the three policy fields and `ROUTE_APPROACH_LOCKED`;
- restore cancel-as-removal and the `takenBy`-based offered checks;
- drop `onwardOverOverlap`. This restores the D-033 overlap deadlock.

## D-035: Timetable services on the operating day, with a P4 safety audit (P5) (2026-10-28)

**P4 audit, done first** (`tests/p4Audit.test.ts`, 17 tests, synthetic layouts plus one check on the committed Carlisle files):

- **1A, approach-lock release: no defect found; no code change.**
  - **Path traced:** `cancel_route` → `approachReasons` → `SetRoute.approachLock` → `routeReleaseStage` → `approachLockHold`.
  - A train counts as approaching only by its head, on an approach edge, travelling towards the start node. Its speed does not matter, so a stopped train keeps the lock. A train travelling away, or two edges back, does not count.
  - Approach track that is `unknown` or `occupied` apart from trains (`trackStatus`) keeps the lock until the time release; it is never read as clear. A route with no known start node is always treated as approached.
  - While locked, re-setting and re-cancelling the route are refused (`ROUTE_APPROACH_LOCKED`), its points stay locked (`POINTS_LOCKED`), conflicting routes are refused, and no train can take it.
- **Why the early "nothing approaching" release is unreachable at Carlisle.** An approaching train stops approaching only if one of these happens:
  - (a) it takes another route from the same start node;
  - (b) it reverses;
  - (c) it leaves play from the approach edge;
  - (d) its approach track becomes proven clear.

  None can happen today. The test shows that each of the seven Carlisle start nodes has exactly one route, which rules out (a), and that the only exit cut edge (P5) is no route's approach edge, which rules out (c). Reversing (b) is not modelled, and nothing writes `trackStatus` (d). It becomes reachable with any of: alternative routes from one signal, reversing, train removal on an approach edge, or live track-circuit status. The branch stays tested on crafted states.

- **1B, overlap exemption: hardened to fail closed; this was a weakness, not a reachable defect.**
  - **Finding:** `onwardOverOverlap` exempted any overlap edge that an onward route from the exit signal used _anywhere_ in its path. It relied on the validator, not its own check, for two facts: that the overlap belongs to that signal (O2), and that the two paths leave the signal together.
  - **Reach:** no committed dataset has an overlap. With validated data, a non-leading shared edge needs a loop in the track. So the weakness could not be reached.
  - **Change:** the exemption now requires `overlap.signalId === route.exitSignalId` and applies only to the leading run of edges that the overlap and the onward route share, in order from that signal. Any other shared edge conflicts.
  - **Unchanged:** opposed points still conflict on exempt track (swinging overlaps are not modelled), declared conflicts are never exempt, and a route's own running track is never exempt.
  - `routeConflict` is exported for tests.
  - **Tests:** the permitted onward routes (both argument orders); opposed points; an unrelated opposite-direction route; the previous route's own track; a crafted reconverging path (exempt before, refused now); an overlap owned by another signal; and two candidate onward routes in both setting orders.
  - **Remaining limit, found and not changed (outside this audit's narrow scope):** the validator's junction-node check (`ROUTE_CONFLICT_UNDETERMINED`, C3/C4) compares route paths only, not overlaps. An overlap that meets another route only at a junction node, sharing no edge and no points requirement, is therefore not flagged. No dataset has overlaps (DATA_GAPS).
  - These are game rules pending verified Carlisle overlap and interlocking data. No real Carlisle behaviour is claimed.

**Decision (P5)** (design in [ADR 0001](adr/0001-authoritative-command-pipeline.md), "Timetable services"):

- **Operating time** (`src/sim/railwayTime.ts`):
  - Simulation time 0 is the UTC instant of the snapshot window start: local `operatingDate windowStart` (00:00, D-026) in Europe/London. Simulation time stays integer milliseconds of elapsed time.
  - Local times are resolved through `Intl` with an explicit `Europe/London` zone and the pure `Date.UTC`. Nothing reads the host zone, the system clock or a timer.
  - A spring-forward local time is `nonexistent` and a fall-back hour is `ambiguous`. Neither is ever resolved by guessing.
- **Service patterns** (`service-patterns.json`, `ServicePatternsFile`, validated by `validateServicePatterns`):
  - A pattern is a hand-authored mapping from an exact run of timing points (the call before play, every area or deferred call, the call after) with optional platform and line checks, to an entry fringe, a contiguous chain of routes and an exit fringe.
  - Labelled `inferred` or `simplified`. An invalid pattern is reported and never used.
- **Service plan** (`buildServicePlan`, frozen in `SimWorld.timetable`):
  - Built once at session setup from a dated snapshot, the patterns and `TimetableSessionConfig`.
  - Every service is classified `representable`, `approximated`, `unsupported` or `invalid`, with reason codes (`SERVICE_PLAN_CODES`).
  - Snapshot errors are quarantined per service (`invalid`). A whole-snapshot error, a missing operating-day convention or a date mismatch refuses the session.
  - Train length and speed come from the session (game settings, default 200 m and 20 m/s), because the snapshot holds neither. Every runnable service records `characteristics: "session_default"`.
- **Due time** (`entryTime: "previous_timing_point"`): the service's time at the timing point before play. That is the latest sourced time at which it is still outside play (I-013).
- **Runtime** (`src/sim/services.ts`):
  - `AuthoritativeState.services` holds each runnable service as `scheduled`, `pending` (with `waiting`), `active` or `departed`. Unsupported and invalid services stay in the plan only.
  - Service trains carry `TrainState.service = { serviceId, headcode }`.
  - Two tick stages, `service-exit` (after movement, before release) and `service-entry` (last), and nothing else, change services. There is no new command: operators cannot spawn, remove or move a service.
- **Entry:** from its due time, a service enters only when the signaller has accepted it, by setting its entry fringe route (offered, status allowed, points detected and locked), and the entry track is proven clear and passes `placementIssues`.
  - The train is placed with its rear at the cut's outside node, and it takes the route at once.
  - Otherwise the service is `pending`, with the reason, and the log records each change of reason.
  - It never enters occupied or unproven track, and it is never dropped or rerouted.
  - Due services at one fringe go in plan order: due time, then service id.
- **Exit:** a service train has left play when its whole length stands on its exit fringe's cut edge, with its head at the outside node, holding the exit route. That is, its tail has passed the cut's inside node.
  - The train is removed, the routes it took are released in the same tick, and the service is `departed` once.
  - Trains placed at session setup have no service, so they still stop at the cut, as in P3.
- **Invariant** (`serviceIssues`, checked by the store on every accepted state): the services are exactly the runnable plan; an active service has exactly its train; no other service has one; times are ordered and not after the clock; no placed train uses a service train id.
- **Timetable validation:** a time of day out of range (for example `25:10`) is now `TIMETABLE_TIME_INVALID` (error). The schema checks only the shape.
- **Tool:** `npm run sim:timetable -- --dataset carlisle --date 2026-11-04 [--list] [--from HH:MM --minutes N [--set-routes]]` (IMPORTING.md).

**Carlisle result** (DFROC1F snapshot for 2026-11-04, one pattern `pat-down-wcml-through-p3`):

| Class         | Services | Why                                                                                                                              |
| ------------- | -------: | -------------------------------------------------------------------------------------------------------------------------------- |
| representable |        2 | PNTH > CARLILE platform 3, line DML (passing) > CARLCJN (no line code) > KGMRJCN > FLORSTN: 1S29 (C01656), 1S04 (C08654)         |
| approximated  |       49 | The same path, with a timetabled stop at CARLILE that is not enacted                                                             |
| unsupported   |      330 | 21 Down WCML trains using platform 1, and 4 taking the goods line at Caldew Jn (field mismatch); 305 with no pattern (see below) |
| invalid       |        0 |                                                                                                                                  |

The 305 with no pattern are:

- 101 terminating and 97 starting inside the area, and 6 that do both;
- 79 Up trains, which have no Up exit south of CE304 (D-030);
- 12 Tyne Valley or Settle–Carlisle trains, and 1 Cumbrian Coast train;
- 5 Down WCML trains via the Kingmoor yards, and 2 other Kingmoor workings;
- 2 that leave and re-enter the area.

A smaller, faithful subset was preferred: no service is forced onto the seven routes.

**Evidence:**

- **Sourced:** the timing points, times, platform and line codes (CIF).
- **Inferred (I-013):** that line DML and a blank Caldew Jn line keep the train on the Down Main through platform 3 to the north cut.
- **Simplified:** the routes (D-030), train length and speed, the due time at the fringe, acceptance by route setting, and the exit condition.

Nothing claims the timetable or the signalling is authentic or complete.

**Not implemented:** station stops and dwell times, real train length, speed, formation or braking, CIF timing load and operating characteristics, associations (joins, divides, next workings), trains starting or terminating in play, reversing, Up services, further patterns or routes, UI, AI signallers and multiplayer.

**Changed tests:** `tests/simClock.test.ts`, `tests/trains.test.ts` and `tests/routeLifecycle.test.ts` pinned the P4 stage list (two stages) and state keys. They now assert the four stages and the `services` key, and that no stage writes points or `trackStatus`. P3's "no timetable reads in `src/sim`" check now asserts that only `servicePlan.ts` and `state.ts` read timetable types. Every safety assertion is kept.

**New tests:**

- `tests/railwayTime.test.ts` (10);
- `tests/timetableServices.test.ts` (19, synthetic `fixtures/synthetic/timetable.ts`);
- `tests/carlisleTimetable.test.ts` (4: the plan fingerprint, and two overnight Down services accepted, run over all five routes and handed off in due order);
- `tests/p4Audit.test.ts` (17).

**Reverse:**

- remove `railwayTime.ts`, `servicePlan.ts`, `services.ts`, the two stages, `AuthoritativeState.services`, `TrainState.service`, `SimWorld.timetable`/`fringes`, `service-patterns.json` with its schema and validator, and `TIMETABLE_TIME_INVALID`;
- keep the 1B hardening; reverting it is a separate decision, and restores the validator-dependent exemption.

## D-036: Carlisle coverage audit, the Caldew Jn goods-line route and traversable-chain checks (P6) (2026-10-28)

**Audit first** (`tools/coverage-audit.ts`, `src/reconcile/timetableCoverage.ts`, table `docs/pilots/carlisle-p6-movement-groups.json`, report `docs/pilots/CARLISLE_P6_COVERAGE.md` and `.json`). The same planner was run on the unchanged DFROC1F snapshot for 2026-11-04. Each of the 381 services falls in exactly one of 19 movement groups, and each group names its blockers. Blocked-group sizes are upper-bound estimates, not results. Findings, by the order of investigation asked for:

- **A. Up Main (72 through services, plus 17 terminating in bays 7/8 and most Kingmoor workings): blocked by evidence at both ends.**
  - CE438 (no OSM category, function `unknown`) stands at the inside node of `cut-north-up-main`, facing into play. Every Up entry from the north stops there (D-033).
  - CE263 (also `unknown`) stands at the inside node of `cut-wcml-south-up`, facing out, so any Up exit south must pass it.
  - Between them: CE268 (`unknown`), the two three-edge nodes with no switch tag (`osm-n2464365978`, `osm-n13915496837`, no Points record) and diamond `osm-n3057659458`, which game rules cannot configure (D-029).
  - No exit was added. Treating the cut edge as an exit, moving a cut to put CE438 outside play, or typing the untyped nodes as switches would each relax a blocker without evidence.
- **B. Platform 1 (21 Down through services): blocked.** Its only southern connection passes the two-edge switch `osm-n1460504022` (D-025). It is reachable from the north cuts only, and no OSM signal is mapped on it. A minimum correction is proposed (OSM check of the missing leg, re-import); none was made.
- **C. Goods line, other lines, Kingmoor.**
  - The 4 Caldew Jn goods-line services are **implemented** (below).
  - 10 Kingmoor-yard workings follow the same in-play path but are left unsupported: their handover beyond the north cut (CIF lines UA/DA at Kingmoor Jn) is unaudited, and 6 of them end in the deferred area with no call after play. They are the next candidate once Kingmoor handover is decided (D-018).
  - Tyne Valley arrivals and Settle–Carlisle departures cross diamond `osm-n1051241139` at Petteril Bridge Jn. London Road Jn and Petteril Bridge Jn are unmapped, and the Upperby goods lines and Cumbrian Coast were not audited.
- **D. Starting or terminating in the area (159 services, plus 2 re-entering and 69 Kingmoor): not implemented.**
  - The planner has no origin or termination lifecycle; stabling, associations and reversal are not modelled.
  - The bays are shorter than the 200 m session train: 2 is 133.7 m, 7 is 151.3 m, 8 is 151.1 m and 6 is 181.9 m.
  - Bays 5 and 6 have no mapped signal.
  - Adding origin placement or train removal only to count services would be teleportation. Proposed for a later phase: origin placement with associations, terminating routes ending at platforms or buffer stops, and imported train lengths.

**Decision (implemented):**

- **Route `rt-dg-ce323-fringe`** (`simplified`). It runs from CE323 along the Down Main as `rt-dm-ce323-fringe` for ten edges, takes the reverse leg of `osm-pts2464246608` (its existing game rule's reverse already pointed at the goods line) onto the bidirectional Up & Down Goods, then the normal leg of `osm-pts2464246595` onto the Down Goods and the north cut.
  - OSM maps no signal facing northbound on this path, so `routeChainBlockers` finds none.
  - Both CE323 routes declare each other in `conflictsWith`. They share ten edges and six points, and are opposed at `osm-pts2464246608`.
  - No overlap or flank protection is authored.
- **Points rule `osm-pts2464246595`** (`simplified`, simple). Its toe faces a northbound train, oriented by I-004. Normal is the Down Goods and reverse the Up Goods, by game convention.
- **Fringe `fr-north-down-goods`** (exit) on `cut-north-down-goods`. The boundary stays `incomplete`, and no boundary signal is claimed.
- **Pattern `pat-down-wcml-p3-caldew-goods`** (`inferred`, I-014): PNTH > CARLILE (platform 3, line DML) > CARLCJN (line GL) > KGMRJCN > FLORSTN. It is disjoint from the P5 pattern by its CARLCJN line check.
- **Planner hardening:** `ROUTE_CHAIN_BLOCKED` (`routeChainBlockers`). A service is runnable only if movement could run its whole chain.
- **Validator:** `SERVICE_PATTERN_OVERLAP` refuses both patterns of an overlapping pair.
- **Movement:** policy literal `serviceRouting: "planned_chain_only"` and stop code `ROUTE_NOT_PLANNED` (ADR 0001, "P6 additions").
- **Safety issue found and handled:** with two routes from CE323, a service train would have taken whatever route was set (`nextStep` takes the first offered route). A goods service could then be run to the Down Main cut, or a Down Main service to the Down Goods cut, where it could never leave play. This was unreachable before P6, when every start node had one route. It is now prevented by planned routing and tested in both directions.

**Result** (same planner, same snapshot, `--baseline-patterns pat-down-wcml-through-p3` for "before"):

| Class         | Before (P5) |  After (P6) |
| ------------- | ----------: | ----------: |
| representable |    2 (0.5%) |    3 (0.8%) |
| approximated  |  49 (12.9%) |  52 (13.6%) |
| unsupported   | 330 (86.6%) | 326 (85.6%) |
| invalid       |           0 |           0 |

- Exactly four services changed class, all from `PATTERN_FIELD_MISMATCH` to runnable on the goods pattern: 4S01 (representable), and 4S94, 4S38 and 4S48 (approximated, with an unenacted stop at Carlisle).
- No service changed class for any other reason. The chain check and planned routing changed no P5 classification.

**Evidence:**

- **Sourced (OSM):** track, track refs, the CE323 position and direction, the switch tags at both nodes, and the Down Goods `preferred_direction=forward` northwards / Up Goods southwards (ways 238611573, 238613009).
- **Sourced (CIF):** the timing points and the GL line code.
- **Inferred (I-014):** GL at Caldew Jn means this Up & Down Goods, and a northbound train takes the Down Goods.
- **Simplified:** the route, the points rule, the fringe and planned routing.

The GIS data was not used. No `infrastructure.json`, raw OSM or CIF data changed.

**Changed tests (deliberate):**

- `carlisleRoutes.test.ts`: route table and fingerprint. The "no shared track" check became "one sharing pair, declared both ways".
- `carlisleTrains.test.ts`, `carlisleRelease.test.ts`: point lies from the seven D-030 routes, since the goods route needs `osm-pts2464246608` reverse.
- `carlisleTimetable.test.ts`: plan fingerprint, and a per-service test operator. 4S01 is due before the session starts and now runs first, on its own chain.
- `p4Audit.test.ts`: (a) is now argued from mutual conflicts, not one route per start node; the second exit cut edge was added.

**New tests:**

- `tests/carlisleGoods.test.ts` (9): direction and OSM tags, chain blockers including CE438/CE263, conflicts and locked opposed points, approach locking on cancel and time release, an end-to-end goods run and handoff exactly once followed by a Down Main train, misrouting held at CE323, release, replay, and the services that stay unsupported.
- `tests/carlisleCoverage.test.ts` (7).
- 5 synthetic tests in `tests/timetableServices.test.ts`: chain blocked by function, pattern overlap, planned routing, and placed trains unchanged.

**Reverse:** delete the route, rule, fringe and pattern, and restore `conflictsWith: []` on `rt-dm-ce323-fringe`. The chain check, overlap check and planned routing can stay; they change nothing when each start node has one route.

## D-037: Carlisle P7 evidence audit, the Kingmoor-yard handover and incomplete-junction points (P7) (2026-10-28)

**Audit first** (evidence matrix `docs/pilots/CARLISLE_P7_EVIDENCE.md`). Every P6 blocker was re-examined against the committed OSM extract, live OSM elements and their histories (OSM API, read 2026-10-28, not stored), the OSM wiki, CIF DFROC1F and CORPUS, and, locally and for corroboration only, SMART and the Network Rail GIS (its licence is still unresolved). Physical facts and signalling facts are recorded separately. Findings:

- **A. Up Main: still blocked; five independent evidence gaps.**
  - CE438, CE263 and CE268 still have no OSM category, in the snapshot and live. All three were added in 2024 from Bing aerial imagery. A SMART berth numbered 438 exists, but a berth states no function.
  - `osm-n2464365978` and `osm-n13915496837` are sourced connections: crossover ways added on 2026-06-06 share them with the Up Main. Neither is tagged as a switch, so neither has a Points record.
  - The straight-across pairing of diamond `osm-n3057659458` is sourced by way continuity, and the GIS corroborates the crossing.
  - The 72 through services need all five gaps closed; closing fewer enables none. Nothing was changed.
- **B. Platform 1: the missing leg is identified, but the movement stays blocked.**
  - The two-edge switch `osm-n1460504022` lost its third leg, Siding A (way 132760240), in OSM changeset 178027337 (2026-02-02, citing the National Electronic Sectional Appendix). Its `railway=switch` tag dates from a 2020 bulk edit.
  - The two mapped edges therefore connect, as the toe and the platform leg. Whether points remain there conflicts between sources: OSM (2026) against the GIS (2024).
  - No OSM signal is mapped on platform 1, and SMART has a station berth (301) with no OSM signal.
  - No topology was altered, and no route was authored past an incomplete junction or a probably unmapped signal.
- **C. Kingmoor: a handover is supported for the 10 goods-line workings via platform 3.**
  - Beyond `cut-north-down-goods`, the mapped Down Goods runs into the Kingmoor yard tracks without re-entering play. Beyond `cut-north-down-main`, the Down Main runs only to the extract edge.
  - So, in the mapped data, the yards are reachable from play only via the Down Goods. That agrees independently with CIF `GL` at Caldew Jn.
  - The other 59 Kingmoor workings are blocked by their in-play paths, not by the handover.
- **D. Petteril Bridge diamond (60 services cross it), the Upperby goods lines and the Cumbrian Coast.** Their physical evidence improved:
  - the diamond's pairing is sourced;
  - CORPUS names match OSM junction labels for London Road, Petteril Bridge, Currock, Bog, Upperby and Upperby Bridge;
  - the Cumbrian Coast cut directions follow from `preferred_direction` and way order.

  Every affected service also needs a lifecycle, a crossing design or a signal source, so none could be enabled.

- **E. Starts, terminations and bays (159): audit only.**
  - None of the snapshot's 105 associations is at CARLILE, so the CIF establishes no turnback or next working there.
  - CIF holds no train length or formation, so no faithful per-service length exists.
  - Nothing was implemented.

**Decision (implemented):**

- **`ServicePattern.after` may be `null`** (`src/model/servicePatterns.ts`). That means the journey ends in a deferred area beyond the exit fringe. `validateServicePatterns` accepts it only if all of these hold:
  - the last `through` call is a deferred TIPLOC;
  - some `through` call is in play;
  - the exit fringe's cut has a `control.json` boundary into a `deferred_play_area` (`deferredAreaCuts`).

  Otherwise it is `SERVICE_PATTERN_INVALID` and the pattern is dropped, so a missing control layer also fails closed. For every pattern, a deferred call between two play-area calls is now `SERVICE_PATTERN_INVALID` too: the service would leave and re-enter play. No existing pattern is affected. The planner matches such a pattern only if the service has no call after the block. A service terminating inside play still matches nothing, because no lifecycle exists. Such a pattern never overlaps a pattern that has a call after.

- **Four Carlisle patterns** (`inferred`, I-015) on the existing goods chain (`rt-dg-ce323-fringe`, exit `fr-north-down-goods`), split by Kingmoor Jn line (UA/DA) and by whether the schedule ends in the yard or continues to Floriston:
  - `pat-down-wcml-p3-goods-kgmr-up-yard-ends`;
  - `pat-down-wcml-p3-goods-kgmr-down-yard-ends`;
  - `pat-down-wcml-p3-goods-kgmr-down-yard-florstn`;
  - `pat-down-wcml-p3-goods-kgmr-up-yard-florstn`.

  No route, rule, fringe, boundary, signal or infrastructure record changed.

- **`move_points` refuses points on an `incomplete` junction** with a new rejection code, `POINTS_TOPOLOGY_INCOMPLETE` (`src/sim/pipeline.ts`). Before P7, an operator, human or AI, could "detect" a position on a two-edge switch that the model cannot interpret. Movement through such nodes was already blocked, so this was a fail-open spot, not a reachable collision.
- **Coverage tool:** `--patterns`, `--phase`, `--decision` and `--baseline-label` added. The P6 report regenerates byte for byte from today's files with the two P6 patterns, and is kept as the baseline. A P7 table and report were added (`carlisle-p7-movement-groups.json`, `CARLISLE_P7_COVERAGE.md`, `carlisle-p7-coverage.json`), and `GroupMatch.patterns` matches any of several patterns.

**Proposed, not implemented:** crossing passages. A crossing would be passed straight across only between the two edges of one source way, never diagonally, and every route pair over its two straights would be required to conflict (C3 error, and in the simulation). It is left out because it enables no service while the other blockers stand (A, D1), and because a crossing design should arrive with a movement that uses it.

**Found, not changed:** the simulation's `routeConflict` checks declared conflicts, shared edges and opposed points, but not a junction node shared without a shared edge. This cannot be reached: validator C4 caps both routes of such a pair at `insufficient_evidence`, which the policy never clears. It must be added before crossing passages are.

**Result** (same planner, same snapshot; `--baseline-patterns` with the two P6 patterns):

| Class         |  P6 |  P7 |
| ------------- | --: | --: |
| representable |   3 |  10 |
| approximated  |  52 |  55 |
| unsupported   | 326 | 316 |
| invalid       |   0 |   0 |

- **Changed class (exactly 10, all from `NO_PATTERN`):** H01259 0C50, H41962 6C37, H41964 6C37, H42002 4C31, H50097 6C01, H50099 6C04 and H50115 6M00 became representable. H41999 4C32, H50015 6X77 and H50093 4S77 became approximated, because their stop at Carlisle is not enacted.
- **Changed reason only:** three platform 1 Kingmoor workings (0C17, 4S43, 6C02) narrow from `NO_PATTERN` to `PATTERN_FIELD_MISMATCH`.

**Evidence:**

- **Sourced:** the CIF timing points and lines; the OSM topology beyond the cut; the control boundaries.
- **Inferred (I-014, I-015):** that GL is the Up & Down Goods, the Down Goods leg, and the switch passages beyond the cut.
- **Simplified:** the routes, the fringe and leaving play.
- **Not claimed:** anything about Kingmoor's lines, yard, signals or reception.

**Changed tests (deliberate):**

- `carlisleCoverage.test.ts` audits the P6 baseline on the P6 patterns.
- `carlisleTimetable.test.ts`: the plan fingerprint, and the overnight session test, where 6X77 and 6C01 now wait with 4S01 at play start and enter first. It asserts plan order, own chains and one exit each, instead of on-time entry.
- `carlisleGoods.test.ts`: yard workings are runnable only via platform 3.

**New tests:** `tests/carlisleP7.test.ts` (14) and 5 synthetic tests in `tests/timetableServices.test.ts`.

**Reverse:** delete the four patterns (their 10 services return to `NO_PATTERN`). `after: null` and the tool flags change nothing on their own. Removing `POINTS_TOPOLOGY_INCOMPLETE` restores the P6 fail-open `move_points`.
