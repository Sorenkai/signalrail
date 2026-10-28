# Network Rail GIS: feasibility and Carlisle comparison (P3.2)

Research only. Nothing in this phase changes the Carlisle dataset, the OSM snapshots, the routes, the game rules or the simulation. Inspected 2026-10-28 on branch `phase1-carlisle` at HEAD `6acbb0d`, with the P0–P3.1 work uncommitted and left untouched.

## 1. Executive recommendation

**Keep OSM as the baseline, and use the Network Rail GIS network model only for cross-checking.**

The GIS model's track geometry agrees closely with the OSM-derived Carlisle graph:

- The median offset is 0.5 m.
- No in-use OSM track is missing from the GIS.
- OSM `ref` tags give the same ELR on 207 of 234 tagged edges.

This makes the GIS a strong independent check on physical track, but it adds no geometry the project lacks. It cannot replace OSM, because:

- The GIS data is older (Map Version 44.0, week commencing 2024-01-08) than the OSM snapshot (2026-10-27). Its track status attributes are older still (2022).
- The source's own metadata says it is for internal Network Rail use. That conflicts with the OGL statement in the repository's README, so redistribution terms are unclear.
- Track identity: on parallel lines a few metres apart, a geometric match cannot reliably say which track is which. The meaning of TRID codes is not documented in the source.
- Content: it holds no signals, signal functions, platforms, buffer stops, switch types, points lies or interlocking. These are the project's biggest gaps.

A source-neutral import layer is not justified by this source alone. Revisit that if a second structured source, such as signalling plans, becomes available.

## 2. Source, vintage, licence and access

### What was inspected

| Item                              | Value                                                                                                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository                        | https://github.com/openraildata/network-rail-gis, **archived**, created 2022-06-16, last push 2024-08-15                                                                     |
| Commit used                       | `a7c2cece9df7770e68a78cd716604c96ae38cd1a` ("Add link to data on RDM", 2024-08-15)                                                                                           |
| Network model data in that commit | Shapefiles added by commit `49169bee93` (2024-04-16, "update 20240130 centre-line model")                                                                                    |
| Embedded metadata (`*.shp.xml`)   | "Map Version 44.0 (w/c 08/01/2024)", created 2024-01-30, modified 2024-01-09; titles `CNM_ADMIN.NetworkLinks`, `.NetworkNodes`, `.NetworkReferenceLines`, `.NetworkWaymarks` |
| GitHub releases                   | `20220607-01`, `20221102-01`, `20230317-01`, `20230711-01` (GeoPackages). **None contains the 2024 data**, so the shapefiles at the pinned commit were used                  |
| Retrieved                         | 2026-10-28, from `raw.githubusercontent.com` at the pinned commit. SHA-256 sums are in §8                                                                                    |
| Stored                            | `data/private/network-rail-gis/<commit>/`, which is git-ignored (`.gitignore`: `data/private/`). It is separate from `data/raw/` and from every dataset                      |

**What could not be accessed:**

- The cited WhatDoTheyKnow EIR request (https://www.whatdotheyknow.com/request/geospatial_data) returned HTTP 403 to automated fetches.
- The Rail Data Marketplace product page (https://raildata.org.uk/dashboard/dataProduct/P-d6c0c7ee-6743-4999-9b9e-d2dd39585bdb/overview) renders client-side and returned no content.
- The README's quotation of the EIR response is therefore unverified at its origin.
- The current Rail Data Marketplace data was not downloaded. That would need an account.

### Licence notes (no legal guarantee)

These statements come from different places and do not agree:

1. **Repository README:** the data was "published via the Environmental Information Regulations (EIR) by Network Rail" and released under the Open Government Licence, quoting the response: "You are encouraged to use and re-use the information … freely and flexibly … set out in the Open Government Licence".
   - There is no `LICENSE` file, and GitHub reports `license: null`.
2. **Embedded metadata of every network-model layer** (`resConst`, verbatim): "This data is for internal Network Rail use only. If it is to be passed externally that the data owner needs to be contacted. The OS copyright statement needs to be displayed when this data is used in order to comply with the Network Rail's agreement with Ordnance Survey."
   - This looks like a default internal classification carried into files that were later released under EIR. It is still a stated restriction, and it names an Ordnance Survey attribution requirement.
3. **CAVEATS.md** says the original caveats document was labelled OFFICIAL.
4. **The current Rail Data Marketplace product** is a different distribution. A secondary source, the OpenRailData wiki (https://wiki.openraildata.com/index.php/ReferenceData), says it is published under OGL. This was not verified on the Marketplace itself.
5. **Network Rail Open Data Feeds** (`nr-open-data-feeds`, DATA_SOURCES.md) are a separate licence ("Network Rail Infrastructure Limited Data Feeds Licence"). It does not cover this repository.

**Practical position:** private, local analysis appears consistent with an OGL re-use statement. The "internal use only" text and the Ordnance Survey requirement are reasons to be conservative about anything published or committed. Recommendations:

| Item                                                                                | Keep locally                                       | Commit to Git                                                                                                                                             |
| ----------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw shapefiles, CSVs, GeoPackages                                                   | Yes, in `data/private/network-rail-gis/` (ignored) | **No**                                                                                                                                                    |
| Comparison output `data/private/network-rail-gis/analysis/carlisle-comparison.json` | Yes (ignored)                                      | **No**, until the terms are confirmed                                                                                                                     |
| This report: aggregates, ELR/TRID codes and nine GIS asset ids                      | —                                                  | Reasonable. ELRs are public industry codes, and OSM already carries them. The owner should review it together with the licence decision before committing |
| `tools/nr-gis-compare.ts` (code only; reads data from a path given at run time)     | —                                                  | Yes. It contains no source data                                                                                                                           |

Before any GIS-derived value enters a dataset, the following is needed:

- **Terms:** confirm them with Network Rail or the Marketplace, including the OS attribution wording.
- **Registration:** register the source in `data/sources.json` and `docs/DATA_SOURCES.md`.
- **Attribution:** show the required attribution in the app.

The source is **not registered now**, because no dataset uses it.

No SMART-derived data is used in, or reproduced by, this report or the script.

## 3. Layers, schemas, coordinate system and data quality

The repository's README lists three groups of data: network model, organisational boundaries and ESTA. Only the network model is relevant here.

| Layer (file)                       | Records (GB) | 2024 `.dbf` fields                                                                       | Meaning (from README and CAVEATS)                                                                                                            |
| ---------------------------------- | ------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| VectorLinks (`NetworkLinks`)       | 49,274       | `OBJECTID, ASSETID, L_LINK_ID, L_SYSTEM, ELR, TRID, TRCODE, L_M_FROM, L_M_TO, SHAPE_LEN` | "Track level ELR and TRID track centre line … constructed of individual links". Polylines                                                    |
| VectorNodes (`NetworkNNodes`)      | 38,165       | `OBJECTID, ASSETID, CONNECTED_ (CONNECTED_COUNT), VERSION_NU`                            | Link ends. `CONNECTED_COUNT` is the number of links meeting there                                                                            |
| VectorReferenceLines               | 1,590        | `OBJECTID, ASSETID, L_LINK_ID, L_SYSTEM, ELR, L_M_FROM, L_M_TO, SHAPE_LEN`               | "An imaginary line … generated by creating a best fit against the main lines for each ELR", from a 2005 measure line. **Not track geometry** |
| VectorWaymarks (`NetworkWaymarks`) | 42,689       | `OBJECTID, ASSETID, M_POST_ID, M_SYSTEM, M_VAL, ELR, WAYMARK_VA`                         | Mileage waymarks per ELR (point features)                                                                                                    |

- **Fields the source does not explain:**
  - Field definitions in the `.shp.xml` files are empty, apart from `OBJECTID` and `SHAPE`.
  - TRID, TRCODE, L_SYSTEM and L_QUALITY codes are not defined in the repository.
  - The values suggest `L_SYSTEM` M/K means miles or kilometres for `L_M_FROM`/`L_M_TO`. That is inferred from the values, not stated.
- **Attribute vintage:**
  - The XML metadata lists fields the 2024 `.dbf` files do not carry, such as `SOURCE`, `TRACK_STATUS` and `L_QUALITY`.
  - Those fields exist only in `VectorLinks/AttributionTable.csv`. The repository says this is "from the release on 2022-11-02 and has not been updated since".
  - It joins by `ASSETID` to all 515 Carlisle links, but its status values are **2022 data** and are reported as such.
- **Coordinate system:** British National Grid (OSGB 1936, Airy 1830, Transverse Mercator), per every `.prj`.
  - The GitHub GeoPackage releases are reprojected to EPSG:32630 by the repository's `shp2gpkg.py` default. That is the converter's choice, not Network Rail's.
- **Positional accuracy:**
  - Per CAVEATS, ±0.5 m (x, y) only "where GMS updates have been undertaken". The baseline is the 2005 Corporate Network Model, checked against GEOGIS since 2014.
  - Carlisle's 515 links have these 2022 `SOURCE` values: OS IMAGERY 181, TRACK VIEW 146, GEOGIS 120, AERIAL SURVEY 55, ROUTE 6, BASELINE 3, OS CENTRELINE 3, FE EXTRACTION 1.
  - None says GMS, so **±0.5 m is not established for Carlisle**.
- **Conversion used here:**
  - The OS inverse Transverse Mercator projection, then the OSGB36 → WGS84 Helmert transformation, with no library.
  - Against PROJ's EPSG transformation "OSGB36 to WGS 84 (9)" (OSTN15-based, stated accuracy 1 m), the result differs by 0.73–0.79 m at three Carlisle points.
  - The difference is nearly constant (about 0.7 m north, 0.25 m east). It shifts absolute positions, but not lengths, topology or the nearest-track choice.

## 4. Carlisle coverage

- **Bbox:** the GIS covers the whole dataset bbox (54.87–54.94 N, 2.985–2.895 W) with:
  - 515 link parts (196.3 km of track centre line);
  - 414 nodes (`CONNECTED_COUNT`: 1 = 111, 2 = 13, 3 = 279, 4 = 11);
  - 14 reference lines and 78 waymarks.
- **Consistency:** at all 414 nodes, `CONNECTED_COUNT` equals the number of link ends that coincide there, so the layer is internally consistent.
- **ELRs in the bbox:** BSN, CBC3, CGJ7, ETC, KMG1, KMG2, MCG, NEC2, NGD, SAC, SCG, UCJ, ULR, WCM1.
- **2022 status of these links:** IN USE 445, UNUSED 59, MISSING IN GEOGIS 7, PRIVATE 2, DISCONNECTED 1, UNUSED AND MISSING 1.
- **Baseline re-verified:**
  - **OSM snapshot `carlisle-20261027T184451Z.json`:** 2,014 elements; 306 `railway=rail` ways (316 ways carry any `railway` tag, including 9 platforms and a signal box); 223 switch nodes; 51 signals; 9 platforms; 60 buffer stops. Slips: `single_slip` at 10288170, 1460504004 and 7253833743, and `double_slip` at 1460504024.
  - **Graph:** 483 nodes and 560 edges, 312 of them in the playable area (station and south-side junctions, play stopping at 54.902 N, Kingmoor deferred).

## 5. Comparison findings

Method (`tools/nr-gis-compare.ts`, thresholds in the script):

- Each OSM edge is sampled every 2 m. Up to 8 m at each end is trimmed (at most 25% of the length), so junctions do not dominate.
- A sample is on a GIS track within **5 m**. Another GIS track (a different ELR/TRID) within **8 m** makes the sample ambiguous.
- Edge classifications:
  - **`confirmed_match`:** at least 90% of samples are within 5 m, at least 90% are on one ELR/TRID, and at least 90% are isolated, with no other track within 8 m.
  - **`probable_match`:** at least 80% within 5 m and at least 80% consistent, but not isolated.
  - **`unresolved`:** 30% or more within 5 m, but not meeting the above.
  - **`no_match`:** under 30%.
- Track spacing: parallel running lines are a few metres apart between centres, so proximity alone never confirms a match there.
- Shared identifiers: OSM and the GIS have none, except ELR codes in OSM `ref` tags. Those serve as an independent check.

| #   | Comparison                                                                                                 | Finding                                                                                                                                                                                                                       | Class                                           | Evidence                                                                                                                                                                                                                                                                                            | Remaining uncertainty                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Track coverage, OSM → GIS                                                                                  | Every OSM edge has GIS track alongside: 0 `no_match`. In play: 2 confirmed, 246 probable, 64 unresolved                                                                                                                       | probable (most)                                 | 61 of the 64 unresolved in-play edges lie wholly within 5 m of GIS track, but switch between GIS tracks along their length (parallel lines, ELR/TRID changes). 3 are under 2 m long and could not be sampled                                                                                        | Which of two parallel tracks each OSM edge is                                                                                                                                                           |
| 2   | Track coverage, GIS → OSM                                                                                  | 5.56 km of GIS track has no OSM edge within 10 m (41 runs of 20 m or more); 3.87 km of it lies within 100 m of playable track                                                                                                 | no_match (as current track)                     | 2022 status of those runs: UNUSED 4.98 km, IN USE 0.56 km, MISSING IN GEOGIS 0.02 km. The large group, Upperby sidings UCJ/1907–1919, coincides with OSM ways tagged `railway=abandoned` (e.g. 1099929533–8), which the importer excludes by design                                                 | Whether the 0.56 km "IN USE (2022)" track exists now: UCJ/1902–1903 (~390 m; part coincides with OSM disused way 923414015), NEC2/1904 (138 m), and 27 m of UCJ/1300 lying on OSM disused way 238621923 |
| 3   | Positional agreement                                                                                       | Median offset of confirmed edges is 0.5 m, including the ~0.75 m Helmert bias                                                                                                                                                 | —                                               | Script output                                                                                                                                                                                                                                                                                       | A close fit does not prove identity                                                                                                                                                                     |
| 4   | Edge lengths                                                                                               | 241 matched in-play edges: median absolute difference 0.1 m. 6 differ materially (over 5 m and over 5%): 18–65 m edges at junctions, 6–11 m shorter in GIS                                                                    | probable (241); unresolved (6)                  | The GIS length is measured by projecting the OSM edge onto its matched GIS track. So agreement shows the geometries coincide; it is **not** an independent survey of length. The 6 outliers are where the matched track ends or changes ELR/TRID inside the edge, which is likely a method artefact | Real track-section lengths: the GIS gives link lengths, not track-circuit or section boundaries                                                                                                         |
| 5   | ELR crosswalk                                                                                              | OSM `ref` = GIS `ELR` on 207 of 234 matched edges carrying a ref                                                                                                                                                              | confirmed (ELR level)                           | Independent tags agree. Of the 23 differences, 12 are CGJ7↔WCM1 and 4 are WCM1↔KMG1, i.e. at ELR boundaries. 4 more edges have OSM `URL` against GIS `ULR`, likely an OSM tagging error                                                                                                             | Where the boundary between ELRs falls; ELR does not identify a single track                                                                                                                             |
| 6   | Track-identity crosswalk (TRID)                                                                            | Co-occurrence is regular: OSM "Up Main" with x/1100 (32 edges), "Down Main" with x/2100 (27), "Up/Down M&C" with CBC3/1100 and 2100, goods lines with 1300/2300, sidings with 19xx/29xx, and the station lines with 3101/3102 | unresolved                                      | TRID semantics are not defined in the source. The pattern is an inference from co-occurrence                                                                                                                                                                                                        | Needs a documented TRID definition before TRID is used as a track key                                                                                                                                   |
| 7   | Asset-id stability                                                                                         | `ASSETID` is present on every feature                                                                                                                                                                                         | unresolved                                      | Only one vintage was compared                                                                                                                                                                                                                                                                       | Whether ASSETIDs persist between map versions. A crosswalk keyed on them could break at the next release                                                                                                |
| 8   | Switches and crossings vs GIS junction nodes (`CONNECTED_COUNT` of 3 or more)                              | 110 in-play OSM switches and crossings: nearest GIS junction median 7 m (90th percentile 15.2 m); 52 have more than one within 15 m. 23 probable, 87 unresolved, 0 none                                                       | unresolved (mostly)                             | The GIS has 290 junction nodes in the bbox against OSM's 225 switches and crossings. Slips are split into several nodes, and unused track is included                                                                                                                                               | Node-to-node correspondence. The GIS has no switch type, toe or lie                                                                                                                                     |
| 9   | Single slip `osm-n10288170` (Carlisle South Jn, Down Main)                                                 | The GIS has a 4-way crossing node 0.5 m away (CGJ7/2100 crossed by CGJ7/3702). A separate 16.1 m link, CGJ7/3703, joins **2100 north-west of the crossing** (node 9002013172) to **3702 south-east of it** (node 9002013239)  | probable                                        | By bearing, that pairs OSM leg `osm-w126243846-5` (towards osm-n2374086076) with `osm-w301674944-2` (towards osm-n3057659458). Survey source (2022): TRACK VIEW                                                                                                                                     | Physical arrangement only. It says nothing about whether the diagonal is signalled or used. The game rule permits only the straight Down Main (D-021, I-012), which the GIS does not contradict         |
| 10  | Single slip `osm-n1460504004` (head of platform 2)                                                         | 4-way node 1.5 m away (CGJ7/3601 × CGJ7/3702). A 16.0 m link, CGJ7/3703, joins **3702 south-east** (9002013131) to **3601 north-west** (9002013069)                                                                           | probable                                        | Pairs OSM `osm-w301674944-1` (towards 10288170) with `osm-w132761145-1` (platform 2 track, `track_ref` "2"). TRACK VIEW                                                                                                                                                                             | As above                                                                                                                                                                                                |
| 11  | Single slip `osm-n7253833743` (Carlisle North Jn, Down Main)                                               | 4-way node 2.3 m away (WCM1/2100 × WCM1/3700). A 17.7 m link, WCM1/3701, joins **3700 north-west** (9002013282) to **2100 south-east** (9002013294, where 2100 becomes 3101)                                                  | probable                                        | By bearing, pairs OSM `osm-w777360528-0` with `osm-w132760242-0`. The straights agree with I-012. Survey source (2022): AERIAL SURVEY                                                                                                                                                               | The two south-east OSM legs both lie nearest 3101, so the leg-to-track match rests on bearing only                                                                                                      |
| 12  | Double slip `osm-n1460504024` (sidings)                                                                    | The sources model it differently. OSM has one 4-leg node. The GIS has two tracks (CGJ7/2900, 2901) with two diagonals (3790, 3791) crossing at a 4-way node 8.5 m away, which looks more like a scissors arrangement          | unresolved                                      | The two GIS nodes nearest the OSM node lie on different tracks only ~1.4 m apart, which is implausible for separate track centres. The GIS geometry here is probably schematic (2022 L_QUALITY −2, TRACK VIEW)                                                                                      | What the physical arrangement is. Neither source settles it                                                                                                                                             |
| 13  | Two-edge junctions (DATA_GAPS) at Bog Jn (`osm-n314950822`, `osm-n2464330439`, crossing `osm-n2464330250`) | The GIS has 3-way nodes 2.3–2.4 m from each switch, and a 4-way node 2.4 m from the crossing (SCG/2300 × UCJ/2300). All legs are IN USE (2022)                                                                                | unresolved                                      | The GIS shows the missing leg as part of an in-use running-line junction. The OSM supplement shows disused sidings there. Several double-track lines (UCJ, SCG, NGD) run parallel within metres                                                                                                     | Which OSM edge each GIS leg is, and whether the missing legs are in use today. Source vintages differ (GIS 2022/2024, OSM 2026)                                                                         |
| 14  | Two-edge switches at Petteril (`osm-n2814195214`, `osm-n10069394082`)                                      | GIS 3-way nodes 7.8–10.9 m away. At 2814195214 the third leg is NEC2/1915, UNUSED (2022)                                                                                                                                      | probable (2814195214); unresolved (10069394082) | The UNUSED leg agrees with OSM's disused siding. At 10069394082 the nearest node's legs are all IN USE, and the next has an UNUSED leg                                                                                                                                                              | As above                                                                                                                                                                                                |
| 15  | Platform 5 and 6 bay tracks                                                                                | OSM way 704349280 (to buffer stop `osm-n1460505335`) matches CGJ7/3602, and way 704349279 (to `osm-n2464339875`) matches CGJ7/3600, each at 100% consistency. Both GIS tracks end at dead-end nodes (`CONNECTED_COUNT` 1)     | probable                                        | A second source agrees they are dead-end bay tracks, as corrected in Phase 2. The GIS ends lie ~10.3–10.5 m beyond the OSM buffer stops                                                                                                                                                             | Which end position is right. The GIS has no buffer-stop object, and its 2022 survey source is TRACK VIEW with no stated accuracy                                                                        |
| 16  | Reference lines                                                                                            | 1,821 samples of matched main-line track lie a median 2.4 m and up to 48.2 m from the ELR reference line                                                                                                                      | —                                               | Confirms the CAVEATS description: illustrative, not track                                                                                                                                                                                                                                           | Not to be used for geometry or connectivity                                                                                                                                                             |

## 6. Source-responsibility matrix

| Need                                                                | Network Rail GIS (this repository)                                                                           | OSM                                                                       | Other sources (status)                                                                 | Can anything here establish it?                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Physical track geometry and connectivity                            | **Cross-check.** A track centre line with junction nodes; 2024 geometry, 2022 status; survey source per link | **Baseline.** Current (2026), complete in play, matches the GIS to ~0.5 m | —                                                                                      | Yes, for physical layout, with the parallel-track and slip caveats above |
| Track and network identifiers                                       | **Supplement.** ELR on every link; TRID/ASSETID (TRID semantics undocumented; ASSETID stability untested)    | ELR-like `ref` on 160 `railway=rail` ways; free-text `railway:track_ref`  | Sectional Appendix (registered, not imported)                                          | ELR yes. TRID or track identity not yet                                  |
| Mileages                                                            | Waymarks and link mileages (`L_M_FROM`/`L_M_TO`)                                                             | None systematically                                                       | Sectional Appendix                                                                     | Partly. Not compared in this phase                                       |
| Signals and their positions                                         | **None.** No signal layer in this repository                                                                 | 51 signals, sourced positions and refs                                    | SMART berths (restricted, local only)                                                  | OSM only                                                                 |
| Signal functions and aspects                                        | None                                                                                                         | Categories where tagged (CE438 untagged)                                  | Signalling plans (none held)                                                           | **No.** Needs signalling evidence                                        |
| Interlocking, route setting, detection and locking, overlaps, flank | None                                                                                                         | None                                                                      | Control tables or signalling plans (none held; no source with `interlockingAuthority`) | **No.** The current routes stay `simplified` game rules (D-030)          |
| Switch type, toe, normal/reverse lie                                | None (junction nodes only)                                                                                   | Slip types sourced; 214 of 218 untyped; lies unknown                      | —                                                                                      | **No.** The GIS slip links narrow the physical pairings only             |
| Platforms                                                           | None                                                                                                         | 9 platform features                                                       | —                                                                                      | OSM                                                                      |
| Sidings and buffer stops                                            | Siding track, track ends, 2022 in-use or unused status                                                       | Sidings; 60 buffer stops; disused/abandoned in the supplement             | —                                                                                      | Partly. The status disagreements are unresolved                          |
| Working timetables, timing points, operating days                   | **None**                                                                                                     | None                                                                      | NROD SCHEDULE (CIF), CORPUS (in use)                                                   | Existing timetable sources only                                          |

## 7. Recommendations for later

**Confirmed changes:** none to the Carlisle dataset. Nothing found justifies changing topology, lengths, routes or game rules.

**Candidate investigations (each needs an owner decision, and licence confirmation first):**

1. Record the GIS ELR as a second source for edge ELRs, where OSM `ref` and the GIS agree (207 edges). Flag the 23 boundary disagreements and the probable OSM `URL`/`ULR` tag error.
2. Bog Jn and Petteril two-edge junctions (findings 13–14): check against current imagery or a site source whether the GIS legs exist and are in use. Today OSM has a disused siding and the GIS (2022) has in-use running lines.
3. Single-slip diagonals (findings 9–11): if diagonals are ever wanted in game rules, the GIS slip-link pairings are a starting hypothesis. They would be `inferred`, never `sourced`, and need a signalling source before any route uses them.
4. Platform 5/6 bay ends (finding 15): resolve the ~10 m difference in where the bay tracks end before any train-length or stopping logic depends on it.
5. IN USE (2022) GIS-only track near play (finding 2): check against current imagery or a later GIS vintage.
6. If the GIS is adopted for anything, re-run against the current Rail Data Marketplace release, after confirming its terms, to get current status attributes.

**Unresolved questions, physical topology:**

- The double-slip arrangement (finding 12).
- Which parallel track each ambiguous OSM edge is (finding 1).
- What TRID means, and whether ASSETIDs are stable (findings 6–7).

**Unresolved questions, signalling and interlocking:** this source does not touch any of them.

- CE438's function.
- Points lies and switch types.
- Routes, overlaps, flank protection, detection and locking.
- Signal-to-berth links.

These still need signalling plans or control tables.

## 8. Reproducing the comparison

No new project dependency is needed. The script is TypeScript with no GIS library, run by the existing `tsx`.

```sh
# 1. Download the pinned network-model files into the git-ignored private area.
R=a7c2cece9df7770e68a78cd716604c96ae38cd1a
D=data/private/network-rail-gis/$R
mkdir -p $D && cd $D
for L in VectorLinks/NetworkLinks VectorNodes/NetworkNNodes \
         VectorReferenceLines/NetworkReferenceLines VectorWaymarks/NetworkWaymarks; do
  mkdir -p "$(dirname $L)"
  for ext in shp shx dbf prj CPG shp.xml; do
    curl -sSfL "https://raw.githubusercontent.com/openraildata/network-rail-gis/$R/network-model/$L.$ext" -o "$L.$ext"
  done
done
for f in VectorLinks/AttributionTable.csv VectorNodes/AllocationTable.csv; do
  curl -sSfL "https://raw.githubusercontent.com/openraildata/network-rail-gis/$R/network-model/$f" -o $f
done
for f in README.md CAVEATS.md; do
  curl -sSfL "https://raw.githubusercontent.com/openraildata/network-rail-gis/$R/$f" -o $f
done
shasum -a 256 */*.shp */*.dbf */*.csv   # compare with the sums below
cd -

# 2. Run the comparison (about 5 s). It writes only to data/private/.
npx tsx tools/nr-gis-compare.ts --dir data/private/network-rail-gis/$R
# -> data/private/network-rail-gis/analysis/carlisle-comparison.json
```

Expected SHA-256 sums (retrieved 2026-10-28):

```
d6a73a9c97d585c5194ae9c5979022b76fa1d5f7e143e5d6327d09d2a6c48abb  VectorLinks/NetworkLinks.shp
03376a698297c4d8dfdbb68a6acd0c58eca248a9359ac5c601f5bacfc934780d  VectorLinks/NetworkLinks.dbf
4bb9d5dc507132297d9e9318359951951d655a8c11543526d68d1c4f670f86aa  VectorNodes/NetworkNNodes.shp
cae1d934ec8430900e993619ddaa056548aeecfee3c365e001a3951c35cc227a  VectorNodes/NetworkNNodes.dbf
17d11f12a9ff108b3b3130bef3f0d7e9077224436aaaa3dd2a1e8231d409d513  VectorReferenceLines/NetworkReferenceLines.shp
e2d834cd274cbbc327ac8a2c2a64db85501b4b20dbd46e919bd1e9371c2c2f00  VectorReferenceLines/NetworkReferenceLines.dbf
19abd90e489bdb2dfdb5421933b012fa3f77a54f33d71023daea838d55e04365  VectorWaymarks/NetworkWaymarks.shp
6964e065e024c5cf32afef1a7f6586f7e75976e966f13d643d9a4d04bce01131  VectorWaymarks/NetworkWaymarks.dbf
d5a976c3cd75d7b404c275fcf566a111e7ee0be0252afff0f99f5f1ad4dd4073  VectorLinks/AttributionTable.csv
fdeea17635f6abc96be020a8272b0ccf0303693567469140d33e7103d40fb792  VectorNodes/AllocationTable.csv
```

Two consecutive runs gave byte-identical output (SHA-256 of the JSON matched).

The Helmert check (optional) used a throwaway virtual environment outside the repository. It compares the script's `helmertSamples` with:

```sh
pip install pyproj
PROJ_NETWORK=ON python -c "from pyproj.transformer import TransformerGroup as G; t=G('EPSG:27700','EPSG:4326',always_xy=True).transformers[0]; print(t.description, t.transform(337820.99, 558835.95))"
```

No tests were added. The analysis depends on a large, git-ignored, licence-uncertain download, so a test of it would not run on another checkout.

## 9. Files created or modified

- **Created (tracked paths, not staged):**
  - `docs/NETWORK_RAIL_GIS_ASSESSMENT.md` (this report)
  - `tools/nr-gis-compare.ts` (read-only research CLI)
- **Created (git-ignored, local only):**
  - `data/private/network-rail-gis/a7c2cece9df7770e68a78cd716604c96ae38cd1a/`, the downloaded source
  - `data/private/network-rail-gis/analysis/carlisle-comparison.json`
- **Not changed:**
  - `src/`, `tests/`, `fixtures/`
  - every file under `data/datasets/` and `data/raw/`
  - `data/sources.json`, `.gitignore`, and all other docs
  - routes, game rules, signal categories, point topology, platform mappings, the OSM snapshots and the simulation

  This was verified against a snapshot of the working tree taken before the phase began.
