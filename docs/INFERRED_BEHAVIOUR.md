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

## I-012: Switch toes and slip straight pairings used to orient the Carlisle MVP game rules

- **Where:** `data/datasets/carlisle/game-rules.json` (P1, D-030), checked by `tests/carlisleRoutes.test.ts`.
- **What is inferred, and what is not:** each points rule is a `simplified` game rule. Its lie is not a real-world claim, and the real lie stays `unknown` in `infrastructure.json`. Only the _orientation_ of each rule rests on inference:
  - **Simple points (18):** OSM gives neither a toe nor a switch type. The toe is taken from the I-004 `legs` heuristic: the two edges with the closest departure bearings are the diverging legs, and the third edge is the toe. Each MVP route passes toe-to-leg under this heuristic, never leg-to-leg (`DirectedTrack.passes`, tested in both directions). Normal = the Main line leg and reverse = the other leg is a game convention.
  - **Single slips (2; the slip type is sourced):**
    - Carlisle South Jn `osm-n10288170`: the Down Main straight `osm-n3057659457 ↔ osm-n2374086076` is one continuous OSM way (`way/126243846`) through the node, with edges 180° apart.
    - Carlisle North Jn `osm-n7253833743`: the Down Main straight `osm-n1460409473 ↔ osm-n3720819849`. Both edges are tagged `Down Main` and lie 178° apart, and the node's other two edges form one continuous way (`way/777360528`), which is the other straight.
    - Only these straight movements are permitted. No diagonal is inferred (D-021).
- **Limits:**
  - Bearings come from mapped geometry. A short, oddly drawn edge could mislead the heuristic.
  - The real switch could be a three-way or some other arrangement that OSM does not tag.
  - The convention that normal is the Main line leg is not a statement about Carlisle's interlocking.
- **Reverse:** remove the rules (and the routes that need them) from `game-rules.json` and `signalling.json`.

## I-013: Which Carlisle timetable services run on the Down Main game routes

- **Where:** `data/datasets/carlisle/service-patterns.json`, pattern `pat-down-wcml-through-p3` (P5, D-035), checked by `tests/carlisleTimetable.test.ts`.
- **Sourced (CIF DFROC1F, 2026-11-04 snapshot):**
  - the timing points PNTH > CARLILE > CARLCJN > KGMRJCN > FLORSTN, and their times;
  - CARLILE platform `3` and line `DML`;
  - CARLCJN's line code: blank on 51 services, `GL` on 4.
- **Sourced (OSM):** the WCML south cut leads towards Penrith, and the Down Main runs through platform 3 to the north gameplay cut towards Kingmoor.
- **Inferred:**
  - that CIF line `DML` at CARLILE is the Down Main the game routes follow;
  - that a blank line code at Caldew Jn keeps the train on the Down Main to the north cut, while `GL` takes the goods line (those 4 services are excluded);
  - that CIF platform 3 is the OSM track the routes use (the platform association is itself inferred, I-007).
- **Not inferred:**
  - the real route, signal or path of any train;
  - where a train is between Penrith and the cut;
  - whether a train passing Kingmoor Jn uses the Down Main beyond the cut.

  Platform 1 Down trains (21) are not mapped onto platform 3.

- **Limits:**
  - Not verified against a signalling plan, a Sectional Appendix line diagram or TRUST berth data.
  - The routes themselves are `simplified` game routes (D-030).
- **Reverse:** delete the pattern; every service becomes unsupported (`NO_PATTERN`).

## I-014: Which Carlisle timetable services take the Caldew Jn goods line, and that they leave on the Down Goods

- **Where:** `data/datasets/carlisle/service-patterns.json` pattern `pat-down-wcml-p3-caldew-goods`, route `rt-dg-ce323-fringe` and points rule `osm-pts2464246595` (P6, D-036). Checked by `tests/carlisleGoods.test.ts`.
- **Sourced (CIF DFROC1F, 2026-11-04):** the timing points PNTH > CARLILE > CARLCJN > KGMRJCN > FLORSTN, CARLILE platform 3 and line DML, and CARLCJN line `GL`, on 4 services with no Kingmoor yard call.
- **Sourced (OSM):**
  - Between platform 3 and the north cut, the only connection from the Down Main onto a goods line is switch `osm-n2464246608` (`railway=switch`), facing for a northbound train, onto way 238611576 (`railway:track_ref=Up & Down Goods`, `railway:bidirectional=regular`).
  - That line ends at switch `osm-n2464246595`, whose two legs are the Down Goods (way 238611573, `preferred_direction=forward`, running north from the switch) and the Up Goods (way 238613009, `forward`, running south into it).
- **Inferred:**
  - that CIF `GL` at Caldew Jn (CARLCJN, which has no OSM location) is this Up & Down Goods;
  - that a northbound train takes the Down Goods leg, its sourced preferred direction;
  - the toe of the new points rule, by the I-004 heuristic (as I-012);
  - platform 3's track association (I-007), as for I-013.
- **Not inferred:**
  - the real route, signal aspects or interlocking;
  - the real lie of either switch;
  - what happens beyond the cut;
  - which line Kingmoor-yard workings use beyond it. Those 10 services stay unsupported.
- **Reverse:** delete the pattern; its 4 services return to `PATTERN_FIELD_MISMATCH`.

## I-015: Kingmoor-yard goods workings leave play on the Down Goods, and may end beyond it

- **Where:** the four `pat-down-wcml-p3-goods-kgmr-*` patterns in `data/datasets/carlisle/service-patterns.json` (P7, D-037), checked by `tests/carlisleP7.test.ts`. Evidence matrix: `docs/pilots/CARLISLE_P7_EVIDENCE.md`, section C.
- **Sourced (CIF DFROC1F, 2026-11-04):** 10 services run PNTH > CARLILE (platform 3, line DML) > CARLCJN (line GL) > KGMRJCN (line UA or DA) > Kingmoor yard TIPLOCs (deferred, I-011). 6 end there (CARLILY, CARLAME), and 4 continue via KGMR490 to FLORSTN.
- **Sourced (OSM, mapped topology):**
  - Beyond `cut-north-down-goods`, the Down Goods connects onward into the Kingmoor yard tracks without re-entering play.
  - Beyond `cut-north-down-main`, the Down Main runs only to the extract edge.
- **Sourced (control.json, game design):** all four north cuts lead into `ext-kingmoor`, a `deferred_play_area`.
- **Inferred:**
  - In play, the same as I-014: GL is the Up & Down Goods, and a northbound train takes the Down Goods.
  - That the Down Goods cut is where these trains leave play. The yards are reachable from play only through it, by the I-004 heuristic for the switch passages beyond the cut, which no source states. This agrees independently with GL at Caldew Jn.
- **Game simplification (not inference):** the train leaves play at the fringe. For the 6 schedules that end in the yard, the journey's end lies beyond play (`after: null`). Nothing at Kingmoor is simulated.
- **Not inferred:**
  - which track or line (CIF UA/DA) the train uses beyond the cut;
  - how the yard receives it;
  - any signal, route or lie at Kingmoor;
  - any formation or onward working.
- **Reverse:** delete the four patterns; their 10 services return to `NO_PATTERN`.

## Not yet inferred (deliberately)

- **P7 (D-037), not inferred:** that points still exist at the platform 1 two-edge switch `osm-n1460504022`, or that they do not. OSM history shows its third leg (Siding A) was removed in February 2026, and the GIS (2024) still shows a junction. The node stays incomplete, and its points are refused by `move_points`. Not inferred either: switch types for the untyped Up Main junctions; the functions of CE438, CE263 or CE268 from their SMART berths or positions; diamond passages; and TIPLOC positions from CORPUS name matches (possible by the I-002 method, not done).
- **P6 game policy (D-036), not inference:**
  - **Planned routing:** a service train takes only routes of its planned chain (`serviceRouting: "planned_chain_only"`).
  - **Traversable chains:** a chain with a facing stop or unknown-function signal inside a route is unsupported (`ROUTE_CHAIN_BLOCKED`).
  - Neither claims how a real driver, signaller or train describer handles a wrong route. An unknown signal function is never upgraded to passable to make a chain run (CE438, CE263, CE268).

- **Box membership from signal ref prefixes** (e.g. `SBJ` → Severn Bridge Junction): plausible, but not adopted. See DECISION_LOG D-008.
- **Routes, overlaps and locking:** no real route, overlap or locking is inferred. The Carlisle MVP routes (D-030) are `simplified` game routes, not inferences; only the orientation of their points rules is inferred (I-012). Any future inferred interlocking rule gets an entry here. Train movement and occupancy (D-032, D-033) infer nothing about the real railway either: replacement on passing, the three signal movement roles, instant stopping and whole-edge occupancy are `simplified` simulation policy (ADR 0001), not claims about Carlisle or any other real interlocking. The roles rest only on what a function means in general, not on any location: a distant or repeater signal has no stop indication, so it is not a stop signal. A signal with no source-stated function is kept as a stop, and is never given a function. Approach locking and route release (P4, D-034) infer nothing either. The one-edge approach zone, the 120 s release time, whole-route release on train clearance, and the rule that an onward route does not conflict with the previous route's overlap are `simplified` game policy. No approach-locking distance, release time, track circuit, overlap or control-table entry is known for Carlisle or any other dataset, and none is derived from geometry, signal positions, train movements or the Network Rail GIS layers. The validator does not derive routes, normal/reverse lies, switch leg pairings or flank protection (D-024).
- **Signal positions for berths with no OSM signal** (Carlisle `0301`, `0305`, `0306`, `0315`, `0316`, `0321`, `0365`, `0431`): not placed. They are listed in the survey backlog (CARLISLE_PILOT.md).
- **Which diagonal each single slip provides:** not inferred from SMART steps or geometry (D-021).
- **P5 timetable simplifications (D-035): game policy, not inference.** None of these claims how a real train runs or how a real signaller accepts one:
  - **Due time:** a service is due at its entry fringe from its time at the timing point before play (at Carlisle, Penrith). No timing exists at the cut.
  - **Train length and speed:** session game settings (default 200 m, 20 m/s) for every train. The snapshot holds no train length, and CIF speed and timing load are not imported.
  - **Entry:** a train enters only when the signaller has set its entry fringe route on proven-clear track. Its rear appears at the cut's outside node.
  - **Exit:** a train leaves play once it stands wholly on the exit cut edge, head at the outside node.
  - **Station calls:** timetabled stops in play are not enacted. Trains stop only at signals.
