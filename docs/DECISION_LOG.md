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
