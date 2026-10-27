# Data model

The schemas are in `src/model/` (zod; TypeScript types are inferred from them). A dataset lives in `data/datasets/<id>/`, with **one file per layer**, so physical infrastructure, timetable data and signalling logic never mix.

| Layer                   | File                     | Schema                    | Changes when                       |
| ----------------------- | ------------------------ | ------------------------- | ---------------------------------- |
| Area definition         | `area.json`              | `tools/lib.ts AreaConfig` | The study area or snapshot changes |
| Physical infrastructure | `infrastructure.json`    | `Infrastructure`          | Re-import from source              |
| Simulated interlocking  | `signalling.json`        | `Signalling`              | Routes or overlaps are authored    |
| Control areas           | `control.json`           | `Control`                 | Player areas change                |
| Timetable ↔ infra links | `timing-points.json`     | `TimingPointMapping[]`    | TIPLOCs are mapped                 |
| Timetable snapshots     | `timetables/<date>.json` | `TimetableSnapshot`       | A new dated snapshot is imported   |
| Signal evidence         | `signal-evidence.json`   | `SignalEvidenceFile`      | Reconciliation is re-run (tool)    |
| Playable area           | `playable-area.json`     | `PlayableArea`            | The game-design boundary changes   |

Runtime simulation state (train positions, occupancy, aspects, point positions, sessions) is **not** part of the dataset. It will live on the server only.

`area.json` (`AreaConfig`) holds the dataset id, the bbox, `osmSnapshot` (the raw main extract) and optionally `osmSupplement`. The supplement is a committed extract for the same bbox with platform outlines and stop_area relations, used for platform-to-track association (D-019, D-020).

## Evidence and provenance

Every element, and every attribute whose certainty differs from its owner's, has a `Provenance`:

```ts
{ evidence: "sourced" | "verified" | "inferred" | "placeholder" | "unknown" | "simplified",
  sources: [{ sourceId, recordId?, version?, retrieved? }],
  note?: string }
```

| Level         | Meaning                                     | Schema rule                  |
| ------------- | ------------------------------------------- | ---------------------------- |
| `sourced`     | Taken from one registered source            | ≥1 source                    |
| `verified`    | Confirmed by a second, independent source   | ≥2 _distinct_ `sourceId`s    |
| `inferred`    | Derived by reasoning                        | `note` states the reasoning  |
| `placeholder` | Stand-in so software runs; must be replaced | `note` says what replaces it |
| `unknown`     | Not known; consumers must handle it         | none                         |
| `simplified`  | Deliberate game simplification (D-023)      | `note` says what and why     |

`simplified` is not a weaker kind of evidence. It makes **no claim about the real railway**: it marks something the game does differently on purpose and keeps (unlike `placeholder`, which must be replaced). Its `note` states what is simplified and what the real arrangement is, or that the real arrangement is unknown. Any `sources` cite the real data being simplified. The validator reports every simplification (`SIMPLIFIED_DATA`). It rejects one in a source-derived layer (`infrastructure.json`, timing points, timetables, signal evidence) with `SIMPLIFIED_IN_SOURCE_LAYER`, except occupancy sections, whose handling R2 decides. No existing record has been relabelled `simplified` (D-023).

- Attribute-level evidence uses `{ value, provenance }` (`evidenced()` in `src/model/evidence.ts`). For example, a signal's direction can be `unknown` while the signal itself is `sourced`.
- `sourceId` must exist in `data/sources.json`. Synthetic test data cites `synthetic-fixture`, which the validator rejects in real datasets.
- OSM data is `sourced`, not `verified`: it is attributable but crowd-sourced.

## Infrastructure

Track is an **undirected graph**. Nodes are places where something happens; edges are plain track between them.

- **TrackNode:** `kind` is `plain | switch | crossing | buffer_stop | area_boundary | end_unknown`, plus an optional lat/lon position.
  - `area_boundary` = the track continues beyond the dataset (inferred from the extract bbox).
  - `end_unknown` = the track ends in the data with no recorded reason (a validation warning).
- **TrackEdge:** `from`, `to`, `lengthM`, `geometry` (lat/lon polyline, both ends included), `usage` (`main | branch | siding | yard | crossover | spur | other | unknown`), `maxSpeedMph` (evidenced), `trackRef`.
- **Location:** a station, junction, signal box, yard or timing point. `codes` holds `tiploc`, `crs` and `stanox`, and is only set when sourced.
- **Platform:** `ref` (as displayed), `locationId`, and `edgeIds` (evidenced; `unknown` until a source links the platform face to track).
  - Optional `trackAssociation` (D-020), set only when the import is given an OSM supplement (`area.json` `osmSupplement`).
  - It records `method`: `stop_area_and_outline | stop_position_and_outline | outline_only | none`.
  - It records `status`: `mapped | ambiguous | unresolved`.
  - It also records the stop-position nodes, the stop_area relations, the outline (record id, OSM version, vertex count) and every edge alongside the outline (`alongM`, `onStopTrack`).
  - `edgeIds` is set only when `status` is `mapped`. It is `sourced` when all mapped edges touch the stop node, and `inferred` when outline geometry adds edges (INFERRED_BEHAVIOUR I-007). This is OSM mapping, not verified signalling.
- **Signal:** `ref` (published identity, never invented), `trackNodeId` (`null` if the source puts it off the graph), `facingTowardsNodeId` (evidenced: the signal governs trains leaving its node towards this adjacent node), `type`, `function`, `components`, `mounting` and `sourceTags` (D-022).
  - **components:** every signal component the source states, in source order, as `{ category, sourceType, form, design, states, height }`. OSM: one per `railway:signal:<category>` key, with `:form`, `:design`, `:states` (split on `;`) and `:height` verbatim. Examples: a main aspect (`main`, `GB-NR:main`), a shunting aspect on the same post (`shunting`, `GB-NR:shunting`), and a junction route indicator (`route`, `GB-NR:junction`, design `feather` or `theatre`, states such as `position_1;off`).
    - `null` means the source does not say; it never means "none". `states` is never an empty list.
    - The list is open-world. A capability missing from it (e.g. no route indicator) is unknown, not absent.
    - `states` is the source's list of possible indications. It is not an aspect sequence, and implies nothing about when each indication is shown or what the interlocking requires.
    - A `shunting` component on a main signal records that OSM tags a shunting aspect at the same place. It does not establish what moves that aspect authorises (calling-on, shunt, permissive and so on).
  - **function** (`main | distant | shunting | repeater | stop_board | other | unknown`) comes from the highest-precedence component: `main`, `distant`, `shunting`/`minor`, `main_repeated`/`distant_repeated`, `stop`. Otherwise it is `unknown`.
  - **type** (`semaphore | colour_light | light | sign | other | unknown`) is the form of that same component. It says nothing about mounting.
    - `semaphore`: the form is semaphore.
    - `colour_light`: a main or distant component whose form is light. In the source's tagging scheme, a lit main or distant signal shows colour-light aspects.
    - `light`: any other lit component, e.g. a shunting signal or banner repeater. It is neutral: it does not say whether the aspects are position lights, colour lights or a banner, and does not say how the signal is mounted.
    - `sign`: a fixed sign; `other`: an unrecognised form (kept verbatim in `components`); `unknown`: no form stated.
    - There is **no `ground` type**. Mounting is a separate, separately evidenced fact.
    - `classifySignal` (`src/model/infrastructure.ts`) is the only mapping from components to type and function. The schema rejects a signal whose type or function differs from what its components support.
  - **mounting** (evidenced): `gantry` (OSM `railway:signal:position=bridge`), `overhead_line` (`position=overhead`) or `in_track` (`position=in_track`). Otherwise `value: null` with `unknown` evidence. OSM `left`/`right` gives the side of the track, not the mounting. No imported source states post or ground mounting. A `:height` such as `dwarf` stays verbatim on its component and is not turned into a mounting.
  - **sourceTags** (optional): the source record's tags verbatim (OSM: every tag on the node, including `route_ref` and `fixme`), for audit.
- **Points:** sit on a `switch` node. They have `switchType`, plus `normalTowardsNodeId` and `reverseTowardsNodeId` (evidenced; OSM never says which leg is normal).
  - `switchType` comes from OSM `railway:switch` (`single_slip`, `double_slip`, `three_way`, `default`/`wye` → `simple`); otherwise `unknown`.
  - A slip's type is sourced, but which diagonal a single slip provides is not (D-021).
- **OccupancySection:** `track_circuit | axle_counter | simulated` over a set of edges. Simulated sections must be `inferred`, `placeholder` or `simplified`; real kinds may not be `simplified` (schema-enforced, R2). No dataset has occupancy sections yet.

Junctions are represented by switch and crossing nodes in the graph, plus an optional `Location` of kind `junction` for the name.

## Track graph (`src/graph/`, D-025)

One shared module reads the mapped topology. Every importer, validator, reconciliation and pilot tool uses it.

- **`TrackGraph`** (`trackGraph.ts`): mapped topology only, never a heuristic.
  - `degree`, `incident`, `neighbours`, `adjacent`, `walk` (contiguous edge list) and `components`.
  - `behind(node, facing)`: the single other neighbour, or null if there is none or more than one.
  - `junction(node)` classifies each node:

    | Class                       | Meaning                                     |
    | --------------------------- | ------------------------------------------- |
    | `plain`                     | A plain node with two edges: ordinary track |
    | `end`                       | At most one edge                            |
    | `switch`                    | A switch with three edges                   |
    | `single_slip`/`double_slip` | Four edges with that sourced type           |
    | `crossing`                  | Four edges                                  |
    | `incomplete`                | Anything else, with a `reason` (below)      |

    The `incomplete` reasons are `two_edge_junction` (a switch, crossing or other non-plain node with two edges: a leg is missing from the data), `untyped_junction`, `slip_wrong_degree` and `crossing_wrong_degree`.

  - `plainRun(start, next)` and `plainRunFrom(edges)` follow only `plain` nodes. They therefore stop at every switch or crossing, including an incomplete two-edge one, and never choose a leg. Results carry `basis: "mapped_topology"`.
  - `switchPassage(from, node, to)` judges a movement through simple points only from an evidenced normal/reverse lie: `set` (with the position and the lie's evidence level, never promoted), `leg_to_leg`, or `unresolved`. Slips, crossings and incomplete junctions are always `unresolved`.
- **`DirectedTrack`** (`directedTrack.ts`): the geometric junction heuristic (INFERRED_BEHAVIOUR I-004). Its routes carry `basis: "geometric_heuristic"`.
  - It blocks incomplete two-edge junctions under every rule.
  - The `singleSlipDiagonals: "allow"` and `incompleteJunctions: "allow"` options exist only to report that a movement depends on them.
- Graph connectivity never establishes an interlocking rule. The interlocking validator uses only `TrackGraph` and evidenced lies; it never uses `DirectedTrack`.

## Simulated interlocking

Public map data does not prove how an interlocking behaves. Everything here defaults to `inferred` with reasoning, unless a control table or equivalent source exists.

- **Route:** `entrySignalId`, `exitSignalId`, `edgeIds` (contiguous from the entry signal's node to the exit signal's node), `pointsRequired` (`{pointsId, position: normal|reverse, role: path|flank}`), `overlapId`, `conflictsWith`.
- **Overlap:** `signalId` (the exit signal it protects), `edgeIds` (contiguous from that signal's node, beyond it) and `pointsRequired`. Only add one where evidence exists.
- **PointsRequirement `role`** (D-024; default `path`, so older files parse unchanged): `path` points lie on the route or overlap and set its course; `flank` points lie off the path and are held for flank protection. Flank requirements are checked for consistency only, never derived.

### Interlocking validation (R2, D-024)

Implemented in `src/validation/interlocking.ts` (`assessInterlocking`). These checks test that interlocking **data** is internally consistent with the infrastructure model and honestly evidenced. Passing them does not show that a real interlocking is safe, and the simulated interlocking is not a certified or operationally safe replica.

**Outcome of each route and overlap.** Every route and overlap gets one status, worst first:

| Status                  | Meaning                                                                                                                         | Validator severity                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `invalid`               | The data contradicts the model: it cannot be right whatever the missing facts turn out to be                                    | error                                                |
| `insufficient_evidence` | Nothing contradicts it, but a fact it depends on is `unknown`, `inferred` or `placeholder`, or the topology model cannot decide | warning                                              |
| `game_rule`             | Consistent, and explicitly labelled `inferred` (reasoning) or `simplified` (deliberate game rule): not a real-world claim       | `INFERRED_DATA` / `SIMPLIFIED_DATA` warning (as now) |
| `evidenced`             | Consistent, every fact it depends on is `sourced`/`verified`, and its own provenance cites a source able to establish it        | none                                                 |

Uncertainty never upgrades a status: an `unknown` fact gives `insufficient_evidence`, never `evidenced`, and nothing is relabelled `verified`. Statuses are computed by the validator. They are not stored in the dataset.

**Points and paths.** A path is walked from its start node over `edgeIds`. At each node it passes through:

- **P1** (error `IMPOSSIBLE_ROUTE`/`IMPOSSIBLE_OVERLAP`): the edges must be contiguous, start at the entry (or overlap) signal's node, end at the exit signal's node (routes), and never revisit a node.
- **P2** (error `ROUTE_POINTS_UNSPECIFIED`, previously a warning): a path through a `switch` node needs a `path` requirement for the Points on that node. Without one, nothing would hold the points under the route.
- **P3** (error `IMPOSSIBLE_ROUTE`): a `path` requirement must name Points on a node the path passes through. A `flank` requirement must name Points **off** the path.
- **P4** (error `ROUTE_POINTS_MISMATCH`): the same Points may not be required in two positions by one route or overlap.
- **P5** (simple switch with an evidenced lie, i.e. both `normalTowardsNodeId` and `reverseTowardsNodeId` set, on a 3-edge node): the remaining neighbour is the toe.
  - Error `ROUTE_SWITCH_UNSUPPORTED`: the path goes leg to leg (normal ↔ reverse), not via the toe.
  - Error `ROUTE_POINTS_MISMATCH`: the required position differs from the leg the path takes.
- **P6** (warning `ROUTE_SWITCH_UNRESOLVED`, insufficient evidence): the passage cannot be checked when:
  - the lie is unknown or half known;
  - the switch is a slip, three-way, `other` or `unknown` type;
  - the node has no Points record;
  - the path crosses a `crossing` node;
  - or the path passes a `plain` node with more than two edges.

  The validator never uses the geometric "legs" heuristic in `src/reconcile/`, which is an assessment aid and not evidence.

- **P7** (warning `ROUTE_DEPENDS_ON_INFERRED`): a check passed only because of a lie or direction that is `inferred` or `placeholder`.
- **POINTS_LIE_INVALID** (error, infrastructure): a stated lie must name a node adjacent to the Points' node, and the normal and reverse nodes must differ.

**Signals and direction.**

- **S1** (error `IMPOSSIBLE_ROUTE`): entry and exit signals must be on the track graph and must differ.
- **S2**: the entry signal must face the first node of the path.
  - Error `IMPOSSIBLE_ROUTE` if it faces elsewhere.
  - Warning `ROUTE_DIRECTION_UNKNOWN` if its direction is `unknown`.
- **S3**: the exit signal must face onward, i.e. not back towards the path's previous node (it governs the next movement in the same direction).
  - Error if it faces back.
  - Warning `ROUTE_DIRECTION_UNKNOWN` if unknown.
- **S4**: an overlap's first edge must lead in its signal's facing direction.
  - Error `IMPOSSIBLE_OVERLAP` if it goes the other way.
  - Warning `ROUTE_DIRECTION_UNKNOWN` if unknown.
- **S5**: route validation uses only `Signal.facingTowardsNodeId`. Direction assessments in `signal-evidence.json`, which come from SMART train movements, are never read.

**Conflicting routes.**

- **C1** (error `ROUTE_CONFLICT_INVALID`): a route may not conflict with itself. `MISSING_REFERENCE` covers unknown ids.
- **C2** (error `ROUTE_CONFLICT_ASYMMETRIC`): if A lists B, B must list A.
- **C3** (error `ROUTE_CONFLICT_MISSING`): two routes must be declared conflicting if either:
  - their paths share an edge (one track section cannot be locked in two routes at once; INFERRED_BEHAVIOUR I-008);
  - or they require the same Points in opposite positions (both cannot be held).
- **C4** (warning `ROUTE_CONFLICT_UNDETERMINED`): two routes that pass through the same switch or crossing node without sharing an edge, and are not declared conflicting. Whether they foul each other (e.g. on a diamond) needs geometry the model does not hold, so this is reported, not assumed compatible.
- Declared conflicts that cannot be derived are accepted. Control tables list more than shared track and points, e.g. opposing overlaps and flank conflicts.

**Overlaps.**

- **O1**: P1 to P7 apply to an overlap's path from its signal's node.
- **O2** (error): a route's overlap must belong to the route's exit signal, and must not double back over the route's last edge.
- **O3**: a proven contradiction is an error (`IMPOSSIBLE_OVERLAP`, `ROUTE_POINTS_MISMATCH`, `ROUTE_SWITCH_UNSUPPORTED`). An overlap that merely cannot be checked is a warning (`ROUTE_SWITCH_UNRESOLVED`, `ROUTE_DIRECTION_UNKNOWN`).
- Overlap length, release and swinging overlaps are not modelled.

**Provenance.**

- **E1** (error `INTERLOCKING_SOURCE_UNSUITABLE`): a route or overlap labelled `sourced` must cite a registered source with `interlockingAuthority: true`, such as a control table or signalling plan with route tables. A `verified` one needs two distinct such sources. No source in `data/sources.json` has it yet.
  - OSM states track layout and signal positions, not interlocking.
  - The Network Rail open feeds hold SMART and TD movement observations, which show what happened, not what the interlocking permits.
  - Neither can establish a route, alone or together.
- **E2**: `inferred`, `simplified` and `placeholder` routes may cite any registered source as the data their reasoning starts from. They count as `game_rule` or `insufficient_evidence`, never `evidenced`.

**Simulated occupancy.**

- **M3** (schema): an `OccupancySection` of kind `simulated` must be `inferred`, `placeholder` or `simplified`. A `track_circuit` or `axle_counter` section may not be `simplified`, because it claims a real section.

## Control areas

`control.json` holds three kinds of statement, each with its own label rules (D-027):

| Kind               | Shape                                                  | Labels allowed                                                                                                     |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Real-world claim   | `{ value, provenance, limitations }`                   | `sourced`/`verified`/`inferred` with a value, or `unknown` with `value: null`; never `simplified` or `placeholder` |
| Game-design choice | `{ value, status, rationale, provenance }`             | `simplified` only (D-023); `status` is `proposed` or `adopted`                                                     |
| Unresolved item    | an `unknown` claim, a `null` choice, or `unresolved[]` | never presented as `sourced`/`verified` or `complete`                                                              |

- **ControlCentre** (optional `controlCentres`): a real box or operating centre. It has `name`, `locationId` and `provenance`, which evidences existence only. Its real-world claims are:
  - `operationalStatus`;
  - `controlMethod`: `mechanical_lever_frame | entrance_exit_panel | individual_function_switch_panel | vdu_workstation | other`;
  - `methodsOfWorking`: `absolute_block | track_circuit_block | tokenless_block | electric_token_block | one_train_working | other`;
  - `signallingPrinciples`: the source's own wording;
  - `extent`: control limits, in words.

  These are categories only. A value is set only from a source, never from a box's name, the track layout or signal-ref prefixes.

- **ControlArea:** `basis` is either `real_signal_box` (mirrors a real box; `membershipProvenance` must be sourced or verified, otherwise the validator flags an unsupported assumption) or `game_design` (a legitimate design split, with no claim about the real railway). It lists the `signalIds` and `pointsIds` the area controls, plus optional `platformIds`.
  - **Optional:** `controlCentre` (real-world claim: which centre's limits contain the members) and `operator` (design choice: `human | ai | human_or_ai`).
  - A `game_design` area's `provenance` and `membershipProvenance` may not be `sourced` or `verified` (`GAME_DESIGN_AS_FACT`).
- **ExternalArea** (optional `externalAreas`): track beyond a boundary that the game does not let players operate.
  - `kind`: `outside_play` or `deferred_play_area`.
  - `controlCentre`: a real-world claim, usually `unknown`.
- **AreaBoundary:** `fromAreaId`, `toAreaId` (a control or external area), and `edgeId`, the edge where trains are handed over.
  - **Handover data (R5, all optional):**
    - `cutId`: the playable-area cut;
    - `boundarySignalIds`: real-world claim;
    - `trafficDirections`: real-world claim, `into_from_area` / `out_of_from_area`;
    - `handover`: a design choice of permitted directions and who offers and accepts trains, or `null` while undecided;
    - `status`: `complete | incomplete`;
    - `unresolved[]`: required when incomplete.
  - A boundary is `complete` only when none of these is unknown or undecided. It may be labelled `sourced`/`verified` only when complete (`BOUNDARY_UNRESOLVED_AS_COMPLETE`).

**Control validation** (`src/validation/control.ts`):

| Code                                            | Severity        | Meaning                                                                                                                                        |
| ----------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `DUPLICATE_ID`                                  | error           | Ids of areas, boundaries, centres and external areas are unique across all collections                                                         |
| `MISSING_REFERENCE`                             | error           | Unknown location, platform, signal, cut, centre, or boundary end                                                                               |
| `CONTROL_OVERLAP`                               | error           | An element in two areas                                                                                                                        |
| `CONTROL_MEMBERSHIP`                            | error / warning | A member outside the playable area (track reached from the cuts' inside nodes without crossing a cut) / an in-play signal or points in no area |
| `BOUNDARY_INCONSISTENT`                         | error           | Boundary edge differs from its cut's edge, or neither end is a game control area                                                               |
| `BOUNDARY_MISSING`                              | warning         | A playable-area cut with no boundary                                                                                                           |
| `GAME_DESIGN_AS_FACT`                           | error           | Game-design area labelled sourced/verified                                                                                                     |
| `BOUNDARY_UNRESOLVED_AS_COMPLETE`               | error           | Marked complete, or labelled sourced/verified, while something is unknown or undecided                                                         |
| `CONTROL_CENTRE_UNKNOWN`, `BOUNDARY_INCOMPLETE` | info            | Lists the unknown claims and incomplete boundaries                                                                                             |

## Timetable

- **TimetableSnapshot:** one session `date`, plus extract metadata (`sourceId`, `fileRef`, `extractedAt`, validity) and its `services`. Game sessions use snapshots only, never live feeds.
  - Since D-026 a snapshot also records:
    - `convention`: the operating day, below;
    - `calendar`: bank holidays near the date, from `govuk-bank-holidays`;
    - `import`: the file, schedules and associations read, records not imported, parse errors, and the area and deferred TIPLOCs used;
    - `associations`;
    - `excluded`: every service considered and left out, with its reason.
  - Older snapshots without `convention` hold the services whose origin date is `date` (validator `TIMETABLE_LEGACY_CONVENTION`). Shrewsbury's is one.
- **Operating day (D-026).** `area_time_window`, `windowStart` `00:00`, `Europe/London`. A snapshot for date D holds every service instance, whatever its origin date, that has a time at an area TIPLOC inside [D 00:00, D+1 00:00) local time.
  - **Identity:** a service instance is `uid` + `runDate`, the origin date by which CIF dates the schedule.
  - **Window:** `window` records whether the instance's area times also fall before (`starts_before`), after (`ends_after`) or both sides of (`spans`) the window.
  - **Excluded:**
    - a train of D whose area times all fall after the window: `area_times_outside_window`;
    - one in the window only at deferred-area TIPLOCs: `deferred_area_only`;
    - one whose area schedule is overridden that day by a stronger STP schedule elsewhere: `superseded_outside_area`.

    Previous-day trains whose area times all fall before the window belong to D−1's snapshot and are only counted (`import.previousDayOutsideWindow`).

  - **Times:** UK local wall-clock time, as in CIF. A window holding a clock change is flagged (`clockChangeInWindow`), not adjusted.
- **Service:** `uid`, `runDate` (origin date), `headcode`, `operatorCode`, `category`, `powerType`, `stpIndicator` (the P/N/O schedule that applies on that date) and `calls`.
  - `bankHolidayRunning`: the CIF value verbatim.
  - `bankHolidayApplicability`: `not_applicable` when the window holds no bank holiday in any UK division; otherwise `unresolved`.
  - `window`.
  - `changesEnRoute`: CIF CR records, with the call index they apply from, decoded category, headcode, service code, power type and speed, and the `raw` record.
- **Call** (a timing point): `tiploc`, `suffix`, `kind` (origin, intermediate or destination), working times (`arrival`, `departure`, `pass`, using `HH:MM` or `HH:MM:30`), public times, `platform`, `line`, `path`, `activities` and `dayOffset`.
  - `dayOffset` gives the day of the call's first time relative to `runDate` (0 or 1, I-009). A later time in the same call that reads earlier on the clock is on the next day.
- **Association** (CIF AA, resolved for the snapshot): `category` (`JJ` join, `VV` divide, `NP` next working), `mainServiceId`, `assocServiceId`, `location` and suffixes, `dateIndicator` (`S`/`N`/`P`), `associationType` and `stpIndicator`.
  - `mainStatus`/`assocStatus` is each one of `in_snapshot`, `runs_outside_snapshot`, `not_running` or `not_in_extract`.
  - Dating rule: the association's dates apply to the main train; the associated train's date follows the date indicator (I-010). Per pair and location, the strongest STP record applies, and a cancellation removes it.
- **TimingPointMapping:** `tiploc` → `locationId`, with sourced provenance.
- **TimingPointPosition** (`inferredPositions`): `tiploc`, `trackNodeIds` (one per running line), `position` (copied from the first anchor node), `confidence` (high, medium or low), `method`, `basis`, and provenance that the schema forces to be `inferred`. A TIPLOC has either a mapping or an inferred position, never both.
- **deferredTiplocs** (timing-points.json): TIPLOCs of areas outside the playable scope, each with a `reason`.
- Mappings and inferred positions are the only links between the timetable and infrastructure layers.

**Timetable validation** (`src/validation/timetable.ts`). It checks consistency with CIF semantics, never operational plausibility. Legitimate behaviour passes: equal consecutive times, a midnight crossing, and a departure after midnight at a call reached before it.

| Code                                                                                   | Severity             | Meaning                                                                                                                                   |
| -------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `TIMETABLE_SERVICE_ID_INVALID`, `TIMETABLE_TIPLOC_INVALID`                             | error                | UID not a letter or space plus 5 digits; id not `uid:runDate`; TIPLOC not 1–7 capitals or digits                                          |
| `TIMETABLE_JOURNEY_INCOMPLETE`                                                         | error                | No origin with a departure, no destination with an arrival, an origin or destination mid-journey, or an intermediate call with no time    |
| `TIMETABLE_TIME_ORDER`, `TIMETABLE_DAY_OFFSET`                                         | error                | Times go backwards once day offsets are applied; stored offsets disagree with the times (legacy snapshots: one midnight crossing allowed) |
| `TIMETABLE_WINDOW`                                                                     | error                | No area time inside the window, or a wrong `window` flag                                                                                  |
| `TIMETABLE_CHANGE_EN_ROUTE`                                                            | error                | A change en route does not match its call                                                                                                 |
| `ASSOCIATION_UNKNOWN_SERVICE`                                                          | error / warning      | Error: a status contradicts the snapshot, or neither end is in it. Warning: an end is `not_running` or `not_in_extract`                   |
| `ASSOCIATION_LOCATION`                                                                 | error                | An in-snapshot end does not call at the association location (with suffix)                                                                |
| `BANK_HOLIDAY_UNRESOLVED` / `BANK_HOLIDAY_INCONSISTENT`                                | warning / error      | A flagged service on a bank holiday or with no calendar / an applicability that contradicts the calendar                                  |
| `TIMETABLE_PARSE_ERRORS`, `TIMETABLE_UNSUPPORTED_RECORDS`, `TIMETABLE_SKIPPED_RECORDS` | error, warning, info | The import had parse errors / met unknown record types / did not import TIPLOC master records                                             |
| `TIMETABLE_EXCLUDED_CONFLICT`, `TIMING_POINT_SCOPE_CONFLICT`                           | error                | A service both kept and excluded / a TIPLOC both area and deferred                                                                        |
| `TIMETABLE_LEGACY_CONVENTION`, `TIMETABLE_CLOCK_CHANGE`                                | warning              | Snapshot predates D-026 / a clock change falls in the window                                                                              |

## Signal evidence (optional, `signal-evidence.json`)

Generated by `npm run data:reconcile-signals` (`src/reconcile/`), never hand-edited. It annotates the infrastructure layer and does not change it. It records, for each signal, **separate claims**. Corroborating one claim never upgrades another: a confirmed identity says nothing about position.

| Claim            | Value                                      | Typical evidence                                                    |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| `identity`       | the OSM ref, raw                           | `sourced` (OSM); `corroborated` when CORPUS names the same plate    |
| `position`       | lat/lon                                    | `sourced` (OSM), `single_source`; no other source has coordinates   |
| `direction`      | node the signal faces towards              | `sourced` (OSM); assessed against SMART berth steps                 |
| `trackContext`   | what plain track ends at, ahead and behind | `sourced` (OSM)                                                     |
| `berths[].claim` | the berth id, raw                          | always `inferred`: a berth is linked to a signal only by its number |

Each claim is `{ value, provenance, assessment, findings[], limitations[] }`. `assessment` is independent of the evidence level:

| Assessment                 | Meaning                                                                   |
| -------------------------- | ------------------------------------------------------------------------- |
| `corroborated`             | A second, independent source states the same claim                        |
| `consistent`               | A cross-check agreed (e.g. a berth step fits the track in this direction) |
| `consistent_with_reversal` | Agrees only if trains reverse at a dead end (INFERRED_BEHAVIOUR I-003)    |
| `single_source`            | Only one source; nothing to test against                                  |
| `ambiguous`                | More than one interpretation fits (suffixes, lettered berths, duplicates) |
| `disputed`                 | Some cross-checks agree and others contradict                             |
| `contradicted`             | Cross-checks contradict it and no alternative explanation was found       |
| `unresolved`               | Tested, but the test could not decide (e.g. junction-heuristic limits)    |
| `not_assessed`             | No test was possible                                                      |

Schema rule: a claim may be `verified` only if its assessment is `corroborated`. CORPUS naming a plate (e.g. `CARLISLE CE 404 SIGNAL`) corroborates the identity but cannot place it, because CORPUS has no coordinates. Such identities therefore stay `sourced`.

The file also holds every SMART step in scope (`steps[]`, all raw fields kept, `EVENT` decoded, a `result` and an `explanation`), the berths with no unambiguous signal (`unmatchedBerths[]`), and CORPUS signal timing points (`namedSignals[]`). Step results: `consistent`, `consistent_alternative_heuristic`, `unresolved_slip_diagonal` (a path exists only through a single slip's unrecorded diagonal; D-021), `reversal_at_dead_end`, `contradicts_direction`, `no_path`, `signal_direction_unknown`, `one_side_unmatched`, `both_unmatched` (see `src/model/signalEvidence.ts`). `consistent_alternative_heuristic`, `unresolved_slip_diagonal` and `no_path` make a claim `unresolved`; none of them supports it. A `no_path` whose only path runs through an incomplete two-edge junction says so in its explanation, and keeps that path's distance and key nodes (D-025). `trackContext` ahead/behind is `TrackGraph.plainRun`: it ends at the first non-plain node, including an incomplete one.

## Playable area (optional, `playable-area.json`)

A **game-design** definition (`basis: "game_design"`, `status: proposed | adopted`). It makes no claim about the real railway.

- **cuts:** where trains enter and leave play. Each cut is an edge with inside and outside nodes. `extract_boundary` cuts must end at an `area_boundary` node; `gameplay_cut` cuts are a project choice on track that continues in the data.
- **includedLocationIds**, **platformIds** and **optionalAreas** (e.g. a deferred Kingmoor).
- **gameplayCorrections:** any gameplay-only change (add a connection, a buffer stop, switch legs and so on). Each is `placeholder`, `inferred` or `simplified` (schema-enforced), lists its targets, and is never applied to `infrastructure.json`. Source geometry and corrections therefore stay distinguishable.

## Validation

`npm run data:validate` (`src/validation/validate.ts`) reports:

| Code                                                                            | Severity        | Meaning                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCHEMA`, `MISSING_FILE`                                                        | error           | File missing or not matching the schema                                                                                                                                    |
| `DUPLICATE_ID`                                                                  | error           | Ids must be unique across all collections                                                                                                                                  |
| `MISSING_REFERENCE`                                                             | error           | Reference to a non-existent node/edge/signal/etc.                                                                                                                          |
| `UNKNOWN_SOURCE` / `SYNTHETIC_DATA`                                             | error           | Unregistered source / synthetic data in a real dataset                                                                                                                     |
| `DISCONNECTED_TRACK`                                                            | warning         | More than one connected component                                                                                                                                          |
| `DANGLING_TRACK_END`                                                            | warning         | `end_unknown` nodes                                                                                                                                                        |
| `SWITCH_TOPOLOGY`, `CROSSING_TOPOLOGY`                                          | warning         | Wrong number of connected edges                                                                                                                                            |
| `POINTS_NOT_ON_SWITCH`, `SELF_LOOP`                                             | error           | Structural impossibilities                                                                                                                                                 |
| `SIGNAL_OFF_TRACK`, `SIGNAL_DIRECTION_UNKNOWN`                                  | warning         | Signal not usable for routing                                                                                                                                              |
| `SIGNAL_DIRECTION_INVALID`                                                      | error           | Signal faces a non-adjacent node                                                                                                                                           |
| `SIGNAL_CLASS_UNKNOWN`                                                          | info            | Signals with no source-stated category, so type and function are `unknown`                                                                                                 |
| `IMPOSSIBLE_ROUTE`, `IMPOSSIBLE_OVERLAP`                                        | error           | Path not contiguous, revisits a node, wrong start or end, entry/exit/overlap faces the wrong way, path points off the path or flank points on it (P1, P3, S1–S4, O2)       |
| `ROUTE_POINTS_UNSPECIFIED`                                                      | error           | Route or overlap passes points without a `path` requirement (P2; a warning before R2)                                                                                      |
| `ROUTE_POINTS_MISMATCH`                                                         | error           | Required position disagrees with the leg taken, or points required both ways (P4, P5)                                                                                      |
| `ROUTE_SWITCH_UNSUPPORTED`                                                      | error           | Path runs leg to leg through simple points with an evidenced lie (P5)                                                                                                      |
| `ROUTE_SWITCH_UNRESOLVED`                                                       | warning         | Passage cannot be checked: lie unknown, slip/three-way/unknown type, crossing, no Points record, untyped junction (P6)                                                     |
| `ROUTE_DIRECTION_UNKNOWN`                                                       | warning         | Entry, exit or overlap signal direction unknown (S2–S4)                                                                                                                    |
| `ROUTE_DEPENDS_ON_INFERRED`                                                     | warning         | A check passed only on an inferred or placeholder lie or direction (P7)                                                                                                    |
| `ROUTE_CONFLICT_INVALID`, `ROUTE_CONFLICT_ASYMMETRIC`, `ROUTE_CONFLICT_MISSING` | error           | Self-conflict; one-sided declaration; shared track or opposed points without a declared conflict (C1–C3)                                                                   |
| `ROUTE_CONFLICT_UNDETERMINED`                                                   | warning         | Routes meet at a switch or crossing without shared track and are not declared conflicting (C4)                                                                             |
| `INTERLOCKING_SOURCE_UNSUITABLE`                                                | error           | Sourced/verified route or overlap without enough `interlockingAuthority` sources (E1)                                                                                      |
| `POINTS_LIE_INVALID`                                                            | error           | Normal/reverse lie names a non-adjacent node, or the same node twice                                                                                                       |
| `INTERLOCKING_STATUS`                                                           | info            | Count of routes and overlaps per status (data checks only; not a safety case)                                                                                              |
| `CONTROL_OVERLAP`                                                               | error           | Element controlled by two areas                                                                                                                                            |
| `COORDINATE_IMPLAUSIBLE`                                                        | error           | Coordinate outside Great Britain                                                                                                                                           |
| `TRACK_ALIGNMENT`                                                               | error / warning | Edge geometry or signal position does not meet its track node (more than 1 m); timing-point position not at its first anchor (error) or anchors spread over 60 m (warning) |
| `TIMING_POINT_CONFLICT`                                                         | error           | TIPLOC has both a sourced mapping and an inferred position                                                                                                                 |
| `TIMING_POINT_OUTSIDE_SCOPE`                                                    | warning         | Positioned TIPLOC not in `areaTiplocs`                                                                                                                                     |
| `OUT_OF_AREA_LOCATIONS`                                                         | info            | Journey TIPLOCs outside the study area                                                                                                                                     |
| `UNMAPPED_TIMETABLE_LOCATION`                                                   | warning         | TIPLOCs with no infrastructure mapping                                                                                                                                     |
| `TIMETABLE_*`, `ASSOCIATION_*`, `BANK_HOLIDAY_*`, `TIMING_POINT_SCOPE_CONFLICT` | see above       | Timetable snapshot checks; see "Timetable validation" (D-026)                                                                                                              |
| `UNSUPPORTED_ASSUMPTION`, `PLACEHOLDER_DATA`                                    | warning         | Real-box area with unevidenced membership; placeholders                                                                                                                    |
| `INFERRED_DATA`                                                                 | info / warning  | Inferred values; a warning when they are interlocking/control                                                                                                              |
| `SIMPLIFIED_DATA`                                                               | warning         | Deliberate game simplifications (`simplified`): reported so they are never read as real behaviour                                                                          |
| `SIMPLIFIED_IN_SOURCE_LAYER`                                                    | error           | A `simplified` record in infrastructure (except occupancy sections), timing points, timetables or signal evidence                                                          |
| `SIGNAL_EVIDENCE_CONFLICT`                                                      | warning         | A signal claim is `contradicted` or `disputed`                                                                                                                             |
| `SIGNAL_EVIDENCE_OPEN`                                                          | info            | Signal claims that are `unresolved`, `ambiguous` or only `consistent_with_reversal`                                                                                        |
| `PLAYABLE_AREA_CUT`                                                             | error           | A cut's edge does not join its nodes, or an `extract_boundary` cut does not end at an `area_boundary` node                                                                 |
| `GAMEPLAY_CORRECTION`                                                           | warning         | Gameplay corrections marked `applied` on top of source data                                                                                                                |
| `SLIP_TOPOLOGY`                                                                 | warning         | Points typed `single_slip`/`double_slip` on a node that does not have 4 edges                                                                                              |
| `SWITCH_ARRANGEMENT_UNKNOWN`                                                    | warning         | A four-edge switch node with no slip type: which legs connect is unknown                                                                                                   |
| `SINGLE_SLIP_DIAGONAL_UNKNOWN`                                                  | info            | Single slips: straight routes known, the one diagonal not recorded (diagonal movements unresolved)                                                                         |
| `PLATFORM_TRACK_UNRESOLVED`                                                     | warning         | A platform with a `trackAssociation` but no stop position or adjacent track                                                                                                |
| `PLATFORM_TRACK_AMBIGUOUS`                                                      | warning         | A platform whose stop positions and outline disagree, or whose outline touches several tracks                                                                              |
| `PLATFORM_TRACK_INCONSISTENT`                                                   | error           | A platform whose `edgeIds` contradict its association status                                                                                                               |

The command exits non-zero on any error.
