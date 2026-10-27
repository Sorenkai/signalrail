# Inferred behaviour

Every piece of railway behaviour or data that is `inferred` rather than sourced is listed here with its reasoning. The validator reports inferred values (`INFERRED_DATA`), and this page explains them.

## I-001: Area boundaries at extract edges

- **Where:** `infrastructure.nodes[kind=area_boundary]`, set by `src/import/osm/importOsm.ts`.
- **Inference:** a track end (degree 1, with no buffer stop) that lies **outside** the study bbox is where the railway continues beyond the dataset. It's not a real end of track.
- **Reasoning:** Overpass returns whole ways that touch the bbox, so they stop at arbitrary way ends outside it. A track end inside the bbox is **not** inferred; it's reported as `end_unknown`.
- **Count (shrewsbury):** 10.

## I-002: Timing-point positions

- **Where:** `data/datasets/shrewsbury/timing-points.json` → `inferredPositions` (DECISION_LOG D-012).
- **Inference:** each TIPLOC below sits at the given OSM track node(s). The coordinates are those of the first anchor node, taken from OpenStreetMap (base `2026-10-27T16:38:36Z`). The inference is only the TIPLOC↔node association; **none of these positions is verified**.
- **Inputs:** CORPUS descriptions; OSM named `railway=junction`/`yard`/`level_crossing` features and track topology; the order in which the 2026-11-04 timetable passes the points; shortest paths on the track graph, which ignore switch direction, so they are a consistency check, not proof.
- **The full evidence statements** for each entry are in its `basis` field.

| TIPLOC    | CORPUS description           | Lat, lon (from anchor) | Anchor track node(s)                 | Confidence | Method                                                                                                                                                   |
| --------- | ---------------------------- | ---------------------- | ------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SHRWEBJ` | ENGLISH BRIDGE JUNCTION      | 52.707306, -2.745734   | `osm-n7177289405`, `osm-n2428399162` | high       | Name match to OSM railway=junction label, anchored to the switch on each running line within 3 m of it; topology checked by graph paths.                 |
| `SHRWSBJ` | SUTTON BRIDGE JUNCTION       | 52.700556, -2.743363   | `osm-n20957304`                      | high       | Name match to OSM railway=junction label, anchored to the adjacent switch; topology checked by graph paths.                                              |
| `HRLSCTX` | HARLESCOTT CROSSING          | 52.737946, -2.728542   | `osm-n1581276955`, `osm-n262539161`  | high       | Name match to OSM railway=level_crossing "Harlescott Crossing", which is mapped on both running lines.                                                   |
| `SHRWBAF` | SHREWSBURY ABBEY             | 52.709556, -2.740845   | `osm-n2953336748`, `osm-n2953336761` | medium     | Timetable role matched to OSM railway=junction "Abbey Foregate Junction"; anchored to the switch on each Wolverhampton-line track ~10 m from it.         |
| `SHRWBCJ` | SHREWSBURY CREWE JN S.B.     | 52.712432, -2.750256   | `osm-n1725224640`                    | medium     | Placed at the switch where graph paths to the Crewe and Chester boundaries diverge, 10 m from the OSM "Crewe Junction" label.                            |
| `SHRWAFS` | SHREWSBURY ABBEY FOREGATE CS | 52.709709, -2.741943   | `osm-n2953336802`                    | medium     | Placed at the first switch of the OSM siding way named "Abbey Foregate Yard" on the path from the yard to the main line.                                 |
| `SHRWBCB` | CREWE BANK R S               | 52.722887, -2.743392   | `osm-n1581276888`                    | low        | Topology only: the only siding connection on the Crewe line between Crewe Junction and Harlescott Crossing.                                              |
| `COTONH`  | COTON HILL T C               | 52.713899, -2.751200   | `osm-n2430325550`                    | low        | Topology only: the main-line connection of the siding group north-west of the station, assumed to be Coton Hill yard.                                    |
| `COTOGBR` | COTON HILL TC GBRF           | 52.713899, -2.751200   | `osm-n2430325550`                    | low        | Same as COTONH: a separate operator's code for the same yard. The specific siding is unknown, so the shared yard connection is used.                     |
| `SHRWCSS` | COLEHAM SHUNT NECK           | 52.701984, -2.742773   | `osm-n3120937280`                    | low        | Topology only: the first siding switch inside the Coleham depot connection, on the route between the main line and the depot.                            |
| `SHRW34`  | SUTTON BRIDGE JN SIG 34      | 52.702523, -2.742652   | `osm-n2953313939`                    | low        | Topology only: the main-line switch giving access to Coleham depot, which both northbound and southbound movements to the shunt neck must use.           |
| `SHRW15`  | SUTTON BRIDGE JN SIG 15      | 52.705447, -2.743949   | `osm-n14124562089`                   | low        | Topology only: a track node on the main line between English Bridge Junction and the Coleham depot connection, where an OSM main signal (no ref) stands. |

Notes:

- `COTONH` and `COTOGBR` share an anchor: they are two operators' codes for the same yard, and which siding each uses is unknown.
- `SHRW15` is anchored where an OSM main semaphore with no ref stands. That signal is **not** claimed to be signal 15.
- Coleham depot TIPLOCs `COLHLMD` and `COLHACE` appear in the timetable next to `SHRWCSS`/`SHRW34`, but are not in the study-area list (D-010). They are treated as outside the area until added.

## I-003: Reversal at a dead end explains a head-on berth step (carlisle)

- **Where:** `src/reconcile/berthSteps.ts` (`reversal_at_dead_end`); `data/datasets/carlisle/signal-evidence.json` steps and claims assessed `consistent_with_reversal`.
- **Inference:** a SMART step A→B whose only path meets signal B head-on is **not** a contradiction of B's OSM direction if all three of the following hold:
  1. B stands on a dead-end road: plain track behind B ends at a buffer stop within 400 m, with no switch between. "Plain track" is the shared plain-run rule (`TrackGraph.plainRun`, D-025): it stops at every switch or crossing, including an incomplete two-edge one, so a buffer stop beyond missing topology does not count.
  2. The step's `EVENT` has an Up/Down direction.
  3. SMART records a departure from berth B in the opposite direction.
  4. (Since D-021) the head-on path exists under the `legs` junction model with sourced slip types, not only under `smooth` or through a single slip's unrecorded diagonal.

  The train enters past the signal, stops, and leaves past it the other way. In TD practice the description then sits in the berth of the signal it will leave by.

- **Reasoning and limits:** the `EVENT` codes (A/B = arrive/depart Up, C/D = arrive/depart Down) come from the Open Rail Data wiki SMART reference. In this session the wiki page itself returned HTTP 403, so they were confirmed through a search summary of the wiki. The berth↔signal links are still number matches (I-005). This explains the data, but it does not prove the identity or the direction.
- **Count (carlisle):** 6 steps: `0286/0366→0302` (platform 2, Down arrivals, Up departures `0302→0278/0365/0407`) and `0335/0336→0327/0328` (platforms 7/8, Up arrivals, Down departures `0327/0328→0431`). _(Corrected for D-021: Phase 1 counted 7, including `0408→0302`. That step's head-on path exists only through the diagonal of single slip `osm-n1460504004`, so it is now `unresolved_slip_diagonal`.)_

## I-004: Switch legs from geometry (two rules), with sourced slip types

- **Where:** `DirectedTrack` in `src/graph/directedTrack.ts` (moved from `src/pilot/signalBerths.ts` in R3, D-025; used by `src/reconcile/`; the pilot tool keeps its original graph-only model). Every route it returns carries `basis: "geometric_heuristic"`.
- **Inference:** OSM never says which legs of a simple switch connect, and never gives the normal/reverse lie.
  - **`legs`** (default, from the pilot): at a 3-way node, the two edges with the closest bearings are the diverging pair and cannot connect to each other. At a 4-way node with no slip type, a train may go only straight on (the most nearly opposite edge).
  - **Slips (D-021):** at a 4-way node whose Points carry an OSM `railway:switch` slip type (sourced), straight across is always allowed. A `double_slip` also allows the forward diagonals. A `single_slip` has one diagonal, but OSM does not record which: its diagonals are allowed only in a separate `allow` model, used solely to report a movement as `unresolved_slip_diagonal`. Which edge counts as straight across is itself the geometric (most nearly opposite) heuristic.
  - **`smooth`** (sensitivity test): at any node of degree 3 or more, a train may leave by any edge more than 90° from its arrival edge.
  - **Incomplete two-edge junctions (D-025):** a switch or crossing with only two mapped edges has a leg missing from OSM, so whether those two edges connect is unknown. All rules block it. A separate `incomplete` model allows it, used solely to report a movement as resting on incomplete topology (geography `i`; berth step `no_path` with an explanation naming the node).
- **Use:** a result found only under `smooth` is reported as `consistent_alternative_heuristic` / `unresolved`, never as consistent. It shows a limit of the heuristic, not a real connection.
- **Known limits (carlisle):**
  - The four-way nodes are three single slips (`osm-n1460504004` at the head of platform 2, `osm-n10288170` on the Down Main at Carlisle South Jn, `osm-n7253833743` on the Down Main at Carlisle North Jn) and one double slip (`osm-n1460504024`, Siding A), all OSM-tagged.
  - `0408→0302` (Newcastle line into platform 2) and `0302→0407` need a diagonal of `osm-n1460504004`, so they stay unresolved even though SMART records them. _(Corrected for D-021: Phase 1 described these nodes' arrangement as unknown.)_
  - One untyped four-way switch, `osm-n2463938290`, lies at Kingmoor, outside the proposed playable area.
  - `0361→0366` (Currock) still depends on the `smooth` rule; no slip is involved.

## I-005: Berth ↔ signal association by number

- **Where:** `reconcile` in `src/pilot/signalBerths.ts`; `berths[].claim` in `signal-evidence.json` (always `inferred`). Identifier matching only; track traversal is in `src/graph/` (D-025).
- **Inference:** signal `CE<n>` (unique, no suffix) is linked to the single numeric berth `<n>` (leading zeros ignored) in the scope's TD area and STANOX.
- **Reasoning:** TD berths are commonly numbered after the signal they precede. But SMART does not name signals, and some berths are lettered (`A`/`B`/`X`) with no documented meaning. A matching number alone is therefore never treated as proof. Suffixed refs (`CE323BR`), lettered berths and duplicates are `ambiguous`.

## I-006: Playable-area cut destinations (carlisle)

- **Where:** `data/datasets/carlisle/playable-area.json` (`cuts[].connectsTo`, `inferred`); `platformRoads` in `src/reconcile/geography.ts`.
- **Inference (cuts):** where each line leads beyond a cut. It is taken from OSM track refs (`Down Newcastle`, `Up Midland` and so on) and from the CIF entry/exit pairs measured by the pilot (Penrith, Wetheral, Cumwhinton, Dalston). The Cumbrian Coast cut edges have no track ref.
- **Platform roads:** superseded by I-007 (D-020). In Phase 1, a platform's road was taken as the OSM track whose `ref` equals the platform ref (platforms 2, 7 and 8 only). `platformRoads` still uses that rule, but only for platforms the importer has not associated.

## I-007: Platform track edges added by outline geometry (carlisle)

- **Where:** `src/import/osm/platformTracks.ts`; `infrastructure.platforms[].edgeIds` / `trackAssociation` (D-020).
- **Sourced part:** the stop position (`railway=stop`, `ref` = platform number) lies on a track node. The station's stop_area relation `relation/1782890` groups it with the platform. These are OSM statements, so edges touching the stop node are `sourced`.
- **Inferred part:** further edges on the same track that run alongside the platform outline (at least 20 m within 3 m) are added by geometry. When any such edge is included, the platform's `edgeIds` is `inferred`.
- **Count (carlisle):** platforms 1, 3 and 4 are `inferred`; platforms 2, 5, 6, 7 and 8 are `sourced`.
- **Not mapped:** the unnumbered area `way/132760232` has no stop position and no track within 3 m. It is `unresolved` and is a stop_area member with an empty role, not `platform`.
- **Limits:**
  - Recorded but not mapped: tracks alongside an outline but not the stop's track (platform 1 beside track 2; platform 5 beside the Up Main for 28 m; platform 6 beside Collier Lane Siding).
  - None of this is verified against a signalling plan.

## I-008: Conflicts required by shared track and opposed points (validator rule)

- **Where:** `src/validation/interlocking.ts` `checkConflicts` (rule C3, D-024). It applies to any authored routes. No dataset has routes yet.
- **Inference:** two routes must be declared conflicting when either:
  - their paths share a track edge;
  - or they require the same points in opposite positions.
- **Reasoning:**
  - Route locking holds every section of a set route until it is released, so one section cannot be locked in two routes at once.
  - Points cannot be detected in two positions at once.
  - This is a general principle of route-setting interlockings. It is not taken from the control table of any particular box.
- **Limits:**
  - It is a minimum. Real control tables also list conflicts the model cannot derive, e.g. opposing overlaps, flank conflicts and approach locking. Declared conflicts beyond C3 are therefore accepted, not flagged.
  - Routes meeting only at a switch or crossing node are reported as undetermined (C4), not assumed compatible.
  - Some interlockings permit specific shared-track movements, e.g. permissive working into an occupied platform. Such a route pair would need explicit evidence and a documented exception; none is modelled.

## I-009: Day offsets of timetable calls (overnight trains)

- **Where:** `dayOffsets` in `src/import/cif/snapshot.ts`; `Call.dayOffset`; checked by `TIMETABLE_DAY_OFFSET` (D-026).
- **Inference:** CIF gives clock times only. A schedule is dated by the day the train leaves its origin, and times along a journey never go backwards. So a time earlier on the clock than the one before it means the train has passed midnight: it and every later time fall on the next day.
- **Limits:**
  - The rule assumes journeys shorter than 24 hours. The schema caps offsets at 1, so a longer journey would fail the import loudly rather than be mis-dated.
  - On a clock-change day, wall-clock times around the change are ambiguous. They are flagged (`clockChangeInWindow`), not resolved.

## I-010: Dating associations (joins, divides, next workings)

- **Where:** `buildSnapshot` in `src/import/cif/snapshot.ts`; `Association` (D-026).
- **Inference:**
  - An association's start and end dates and days-run apply to the main (base) train's origin date.
  - The associated train runs on the same day (`S`), the next day (`N`, "over next midnight") or the previous day (`P`).
  - Per main train, associated train and location, the strongest STP record applies, as for schedules (C > O > N > P), and a cancellation removes the association.
- **Reasoning:** the date-indicator values are defined relative to midnight (Open Rail Data wiki, CIF association records, read via a search summary because the wiki page returned HTTP 403). The real extract agrees: every cancellation has a blank category (17,641 of 17,641).
- **Check:** in the Carlisle snapshot, all 105 associations resolve to a known status at both ends (no `not_running` or `not_in_extract`).

## I-011: Carlisle play-area and deferred TIPLOCs

- **Where:** `data/datasets/carlisle/timing-points.json` `areaTiplocs` (29) and `deferredTiplocs` (27) (D-026).
- **Inference:** CORPUS has no coordinates, so a TIPLOC is placed in or out of the playable area from its CORPUS name and STANOX. Where the name is ambiguous, the TIPLOCs it is timetabled next to across the whole extract decide. For example:
  - `CARLAME` ("Carlisle Yard") is only ever next to `KGMRSGF`, so it is deferred with Kingmoor;
  - `CARLLRJ` (London Road Jn), missing from the pilot list, is next to `PETLBGJ` and `CARLILE` over 600 times, so it is in the area.
- **Limits:**
  - Not verified against a map or signalling plan.
  - `CARL437` (signal CE437) lies between Caldew Jn and Kingmoor Jn, and its side of the north gameplay cut is unknown. Every train using it also passes Caldew Jn, so its classification changes no snapshot.

## Not yet inferred (deliberately)

- **Box membership from signal ref prefixes** (e.g. `SBJ` → Severn Bridge Junction): plausible, but not adopted. See DECISION_LOG D-008.
- **Routes, overlaps and locking:** none exist yet. When simulated interlocking is authored, each rule gets an entry here. The validator does not derive routes, normal/reverse lies, switch leg pairings or flank protection (D-024).
- **Signal positions for berths with no OSM signal** (Carlisle `0301`, `0305`, `0306`, `0315`, `0316`, `0321`, `0365`, `0431`): not placed. They are listed in the survey backlog (CARLISLE_PILOT.md).
- **Which diagonal each single slip provides:** not inferred from SMART steps or geometry (D-021).
