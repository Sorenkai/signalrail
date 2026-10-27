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

Runtime simulation state (train positions, occupancy, aspects, point positions, sessions) is **not** part of the dataset. It will live on the server only.

## Evidence and provenance

Every element, and every attribute whose certainty differs from its owner's, has a `Provenance`:

```ts
{ evidence: "sourced" | "verified" | "inferred" | "placeholder" | "unknown",
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
- **Signal:** `ref` (published identity, never invented), `trackNodeId` (`null` if the source puts it off the graph), `facingTowardsNodeId` (evidenced: the signal governs trains leaving its node towards this adjacent node), `type` (`semaphore | colour_light | ground | sign | other | unknown`), and `function` (`main | distant | shunting | repeater | stop_board | other | unknown`).
- **Points:** sit on a `switch` node. They have `switchType`, plus `normalTowardsNodeId` and `reverseTowardsNodeId` (evidenced; OSM never says which leg is normal).
- **OccupancySection:** `track_circuit | axle_counter | simulated` over a set of edges. Simulated sections must be labelled `inferred` or `placeholder`.

Junctions are represented by switch and crossing nodes in the graph, plus an optional `Location` of kind `junction` for the name.

## Simulated interlocking

Public map data does not prove how an interlocking behaves. Everything here defaults to `inferred` with reasoning, unless a control table or equivalent source exists.

- **Route:** `entrySignalId`, `exitSignalId`, `edgeIds` (contiguous from the entry signal's node to the exit signal's node), `pointsRequired` (`{pointsId, position: normal|reverse}`), `overlapId`, `conflictsWith`.
- **Overlap:** `signalId` (the exit signal it protects), `edgeIds` and `pointsRequired`. Only add one where evidence exists.

## Control areas

- **ControlArea:** `basis` is either `real_signal_box` (mirrors a real box; `membershipProvenance` must be sourced or verified, otherwise the validator flags an unsupported assumption) or `game_design` (a legitimate design split, with no claim about the real railway). It lists the `signalIds` and `pointsIds` the area controls.
- **AreaBoundary:** `fromAreaId`, `toAreaId`, and `edgeId`, the edge where trains are handed over.

## Timetable

- **TimetableSnapshot:** one operating `date`, plus extract metadata (`sourceId`, `fileRef`, `extractedAt`, validity) and its `services`. Game sessions use snapshots only, never live feeds.
- **Service:** `uid`, `runDate`, `headcode`, `operatorCode`, `category`, `powerType`, `stpIndicator` (the P/N/O schedule that applies on that date) and `calls`.
- **Call** (a timing point): `tiploc`, `suffix`, `kind` (origin, intermediate or destination), working times (`arrival`, `departure`, `pass`, using `HH:MM` or `HH:MM:30`), public times, `platform`, `line`, `path` and `activities`.
- **TimingPointMapping:** `tiploc` → `locationId`, with sourced provenance.
- **TimingPointPosition** (`inferredPositions`): `tiploc`, `trackNodeIds` (one per running line), `position` (copied from the first anchor node), `confidence` (high, medium or low), `method`, `basis`, and provenance that the schema forces to be `inferred`. A TIPLOC has either a mapping or an inferred position, never both.
- Mappings and inferred positions are the only links between the timetable and infrastructure layers.

## Validation

`npm run data:validate` (`src/validation/validate.ts`) reports:

| Code                                           | Severity        | Meaning                                                                                                                                                                    |
| ---------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCHEMA`, `MISSING_FILE`                       | error           | File missing or not matching the schema                                                                                                                                    |
| `DUPLICATE_ID`                                 | error           | Ids must be unique across all collections                                                                                                                                  |
| `MISSING_REFERENCE`                            | error           | Reference to a non-existent node/edge/signal/etc.                                                                                                                          |
| `UNKNOWN_SOURCE` / `SYNTHETIC_DATA`            | error           | Unregistered source / synthetic data in a real dataset                                                                                                                     |
| `DISCONNECTED_TRACK`                           | warning         | More than one connected component                                                                                                                                          |
| `DANGLING_TRACK_END`                           | warning         | `end_unknown` nodes                                                                                                                                                        |
| `SWITCH_TOPOLOGY`, `CROSSING_TOPOLOGY`         | warning         | Wrong number of connected edges                                                                                                                                            |
| `POINTS_NOT_ON_SWITCH`, `SELF_LOOP`            | error           | Structural impossibilities                                                                                                                                                 |
| `SIGNAL_OFF_TRACK`, `SIGNAL_DIRECTION_UNKNOWN` | warning         | Signal not usable for routing                                                                                                                                              |
| `SIGNAL_DIRECTION_INVALID`                     | error           | Signal faces a non-adjacent node                                                                                                                                           |
| `IMPOSSIBLE_ROUTE`, `IMPOSSIBLE_OVERLAP`       | error           | Path not contiguous, wrong end, wrong direction, foreign points                                                                                                            |
| `ROUTE_POINTS_UNSPECIFIED`                     | warning         | Route crosses a switch without a required lie                                                                                                                              |
| `CONTROL_OVERLAP`                              | error           | Element controlled by two areas                                                                                                                                            |
| `COORDINATE_IMPLAUSIBLE`                       | error           | Coordinate outside Great Britain                                                                                                                                           |
| `TRACK_ALIGNMENT`                              | error / warning | Edge geometry or signal position does not meet its track node (more than 1 m); timing-point position not at its first anchor (error) or anchors spread over 60 m (warning) |
| `TIMING_POINT_CONFLICT`                        | error           | TIPLOC has both a sourced mapping and an inferred position                                                                                                                 |
| `TIMING_POINT_OUTSIDE_SCOPE`                   | warning         | Positioned TIPLOC not in `areaTiplocs`                                                                                                                                     |
| `OUT_OF_AREA_LOCATIONS`                        | info            | Journey TIPLOCs outside the study area                                                                                                                                     |
| `UNMAPPED_TIMETABLE_LOCATION`                  | warning         | TIPLOCs with no infrastructure mapping                                                                                                                                     |
| `TIMETABLE_TIME_ORDER`                         | error           | Times go backwards (one midnight crossing allowed)                                                                                                                         |
| `UNSUPPORTED_ASSUMPTION`, `PLACEHOLDER_DATA`   | warning         | Real-box area with unevidenced membership; placeholders                                                                                                                    |
| `INFERRED_DATA`                                | info / warning  | Inferred values; a warning when they are interlocking/control                                                                                                              |

The command exits non-zero on any error.
