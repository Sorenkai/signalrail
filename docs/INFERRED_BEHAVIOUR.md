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

## Not yet inferred (deliberately)

- **Box membership from signal ref prefixes** (e.g. `SBJ` → Severn Bridge Junction): plausible, but not adopted. See DECISION_LOG D-008.
- **Routes, overlaps and locking:** none exist yet. When simulated interlocking is authored, each rule gets an entry here.
