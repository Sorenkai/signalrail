# Data sources

The machine-readable registry is [`data/sources.json`](../data/sources.json). Every `sourceId` cited in a dataset must appear there; `npm run data:validate` enforces this. This page holds the human-readable detail.

Status as of **2026-10-27** (updated after the owner supplied SCHEDULE and CORPUS files). "Retrieved" means this project actually downloaded data. Everything else is research only.

## Summary

| Source                                         | Used for                                                                     | Access                 | Licence (confirmed?)                                                | Retrieved                                                                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenStreetMap via Overpass API                 | Track geometry/topology, signals (partial), points, platforms, boxes, speeds | Public, no account     | ODbL 1.0 (yes)                                                      | 2026-10-27: Shrewsbury (base `16:38:36Z`); Carlisle pilot (base `16:59:21Z`); Carlisle Phase 2 main (base `18:47:20Z`) and supplement (base `18:46:17Z`). See `data/sources.json` |
| Network Rail Open Data Feeds                   | Timetable (SCHEDULE CIF), TIPLOC codes (CORPUS), TD berths (SMART)           | Free registration      | NR Data Feeds Licence → OGL (version not stated; **not confirmed**) | SCHEDULE full CIF (DFROC1F, extracted 2026-10-23), CORPUS and SMART, supplied by the owner 2026-10-27                                                                             |
| RDG timetable feed / National Rail Data Portal | Fallback passenger timetable                                                 | Registration / licence | RSP data licence (not read)                                         | No                                                                                                                                                                                |
| OpenRailwayMap                                 | Visual cross-check of OSM tagging                                            | Reference only         | Data ODbL; tiles not reviewed                                       | No                                                                                                                                                                                |
| Network Rail Sectional Appendix                | Corroborating line names, speeds, box limits                                 | Reference only         | Not reviewed                                                        | No                                                                                                                                                                                |
| Wikipedia                                      | Corroborating signal box names and status                                    | Public                 | CC BY-SA 4.0 (not re-read)                                          | Read 2026-10-27 (facts only)                                                                                                                                                      |
| UK bank holidays (GOV.UK)                      | Whether a snapshot window holds a bank holiday                               | Public, no account     | OGL v3.0 (yes)                                                      | 2026-10-27 (`data/raw/govuk/bank-holidays-2026-10-27.json`)                                                                                                                       |

## OpenStreetMap (`openstreetmap`)

- **URL:** https://www.openstreetmap.org/, queried through https://overpass-api.de/api/interpreter.
- **Access:** public. The Overpass usage policy (https://wiki.openstreetmap.org/wiki/Overpass_API) asks for fewer than 10,000 queries and less than 1 GB per day. So we fetch rarely and commit dated snapshots to `data/raw/osm/`.
- **Licence:** ODbL 1.0, confirmed from https://www.openstreetmap.org/copyright on 2026-10-27.
- **Attribution (required wherever the data or derived maps are shown):** "© OpenStreetMap contributors. Data available under the Open Database License (https://www.openstreetmap.org/copyright)." The client page footer and the SVG preview display this. It is generated from the registry by `src/data/attribution.ts`.
- **Share-alike:** `data/datasets/*/infrastructure.json` is a _derived database_. If it is distributed publicly or used in a public service, it must be offered under ODbL. The game's own code does not need to be. Keep derived data in separate files from authored game data (it already is), so the ODbL obligation stays limited to it.
- **Quality caveat:** OSM is crowd-sourced. It records what contributors mapped, not Network Rail records. All OSM-derived elements are labelled `sourced` (attributable), not `verified`.
- **Tags read directly from the raw snapshot (P6, D-036):** `railway:preferred_direction` and `railway:bidirectional` on the Carlisle goods-line ways 238611573, 238613009 and 238611576 (`carlisle-20261027T184451Z.json`). The importer does not carry them into `infrastructure.json`. They are cited in the provenance of `pat-down-wcml-p3-caldew-goods` and `osm-pts2464246595`, and checked in `tests/carlisleGoods.test.ts`. A preferred direction is what contributors mapped, not a statement of how the line is signalled. No new source and no new retrieval were used in P6, and the Network Rail GIS data (licence terms unclear, see NETWORK_RAIL_GIS_ASSESSMENT.md) was not used.
- **P7 reads (D-037), 2026-10-28:**
  - **What was read:** current elements and element histories for the Carlisle blocker nodes and ways, and changeset metadata (comments, stated sources, imagery used), from the OSM API v0.6 (`https://api.openstreetmap.org/api/0.6/`, public, ODbL). Also the OSM wiki page `Tag:railway=railway_crossing` (wiki text CC BY-SA 2.0; facts only).
  - **What was found:** the live elements were unchanged from the committed snapshot.
  - **How it was used:** the histories explain the platform 1 two-edge switch (Siding A removed in changeset 178027337). They are cited by element and changeset id in `docs/pilots/CARLISLE_P7_EVIDENCE.md`, the P7 movement-group table and DATA_GAPS.
  - **What was not done:** nothing was stored, no new snapshot was made, no raw file changed, and no dataset value comes from these reads.
  - **Limit:** a changeset's stated source (for example the National Electronic Sectional Appendix) is the mapper's claim, not a source this project has read.
- **Retrievals:** 2026-10-27, `data/raw/osm/shrewsbury-2026-10-27.json`, OSM base timestamp `2026-10-27T16:38:36Z`, from overpass-api.de, bbox 52.695–52.745 N, 2.770–2.725 W. It includes named junctions, yards and level crossings. It supersedes an earlier same-day extract (base `16:01:40Z`, smaller bbox). A mirror (overpass.private.coffee) returned a stale base (`2026-05-31`), so we discarded it and did not use it.
- **Carlisle retrievals (all 2026-10-27, overpass-api.de, bbox 54.870–54.940 N, 2.985–2.895 W):**
  - Pilot extract `data/raw/osm/carlisle-2026-10-27.json`, base `16:59:21Z`, sha256 `7cbdd90e…a77c94`. Kept unchanged.
  - Phase 2 main refresh `data/raw/osm/carlisle-20261027T184451Z.json`, base `18:47:20Z`, sha256 `e6c49d21…cddc9e`. Same query as the pilot; content identical to it. It is the dataset's `osmSnapshot` (D-019).
  - Phase 2 supplement `data/raw/osm/carlisle-20261027T184451Z-supplement.json`, base `18:46:17Z`, 4.5 MB, sha256 `c75cb89a…e9f3c`: platform outlines, stop_area relations and other documented additions. By owner decision (D-019), it is **kept local and git-ignored**. A fresh clone cannot regenerate the slim derivative without obtaining this raw input. Its recorded sha256 identifies the exact input, but guarantees neither its availability nor any redistribution right.
  - Its deterministic slim derivative `…-supplement-slim.json` (sha256 `b9116307…c961582`) is the dataset's `osmSupplement`. Full queries, timestamps and HTTP attempts are in each file and in `data/sources.json`.

## Network Rail Open Data Feeds (`nr-open-data-feeds`)

- **Registration:** https://publicdatafeeds.networkrail.co.uk/. You need a free account; places are first come, first served and capped at 1,000 users. Static files are downloaded with an authenticated HTTP GET.
- **Information page:** https://www.networkrail.co.uk/who-we-are/transparency-and-ethics/transparency/open-data-feeds/
- **Licence:** "Network Rail Infrastructure Limited Data Feeds Licence", which refers to the Open Government Licence: https://www.networkrail.co.uk/who-we-are/transparency-and-ethics/transparency/open-data-feeds/network-rail-infrastructure-limited-data-feeds-licence/. The summary we fetched didn't show the OGL version or an exact attribution statement. **Read the full text before publishing anything.**
- **Stated restrictions:** don't use the Network Rail, National Rail or train company brands or logos, and don't call the app "official". The client page carries a non-affiliation note.
- **Relevant feeds** (per the Open Rail Data wiki, https://wiki.openraildata.com/; the wiki returned HTTP 403 to automated fetches, so this comes from search summaries):
  - **SCHEDULE:** an ITPS extract in CIF or JSON. A full CIF extract is published each Friday, with daily updates. It includes freight and ECS, unlike the RDG feed.
  - **CORPUS:** location reference data (TIPLOC ↔ STANOX ↔ CRS ↔ NLC). Needed to map timetable TIPLOCs to infrastructure.
  - **SMART:** links train describer (TD) berths to locations. It may help identify signals in TD-covered areas. Whether Shrewsbury's mechanical boxes are TD-covered is **unknown**.
  - **BPLAN:** timing points and running times. Not yet assessed.
- **Attribution used:** "Contains public sector information licensed under the Open Government Licence v3.0." This is the OGL default, because Network Rail gives no specific wording (DECISION_LOG D-009).
- **Retrieved:** `data/private/toc-full.CIF` (SCHEDULE full extract, header `DFROC1F`, extracted 2026-10-23 20:01, valid 2026-10-23 to 2027-10-23, 721,875 schedules) and `data/private/CORPUSExtract.json` (55,981 rows). Both were downloaded by the project owner. The recorded retrieval date, 2026-10-27, is **derived from the local file timestamps**, not from a download record. Correct it only if reliable evidence shows a different date.
- **Committed derivatives:** `data/datasets/shrewsbury/timetables/2026-11-04.json`, `data/datasets/carlisle/timetables/2026-11-04.json` (DFROC1F, operating-day convention D-026) and the CORPUS fields in `timing-points.json`. The raw files are never committed.
- **Use in play (P5, D-035):** sessions run services from the Carlisle snapshot only through the hand-authored `service-patterns.json` mapping, which cites DFROC1F and OSM and is labelled `inferred` (I-013). No timetable record is altered or added: unmatched services are reported as unsupported. The licence caveat above applies to any published build that shows timetable data.
- **SMART: inspected 2026-10-27.** `data/private/SMARTExtract.json` (34,298 berth rows, supplied by the owner; retrieval date from the file timestamp). `npm run data:smart-coverage` reports coverage per study-area TIPLOC. Findings are in FEASIBILITY_REPORT. In short: of the 15 study-area TIPLOCs, only Harlescott Crossing (TD area C3) has berth data. An earlier attempt to fetch SMART without a login returned HTTP 401; the project tools still hold no credentials.
- **SMART-derived files: kept local, restricted pending licence review (owner decision, D-016 and D-019).** While Network Rail's SMART licence and redistribution terms are unconfirmed (`confirmed: false`), these are not committed or published. This is pending confirmation, not a finding that redistribution is prohibited.
  - **Git-ignored bulk data:** `data/datasets/carlisle/signal-evidence.json` (raw berth step rows), `docs/pilots/carlisle-pilot-results.json` and `docs/pilots/carlisle-phase1-geography.json`.
  - **Excluded locally** (`.git/info/exclude`, so formatting checks still apply): `docs/pilots/CARLISLE_PILOT.md` and `tests/carlisleEvidence.test.ts`.
  - **Notices:** `data/datasets/carlisle/RESTRICTED-SMART.md` and `docs/pilots/RESTRICTED-SMART.md`.
  - **Tracked docs quoting a few berth ids or steps in uncommitted changes:** DATA_GAPS (Carlisle), INFERRED_BEHAVIOUR (I-003, I-004) and DECISION_LOG (D-017, D-021). These need the same review before they are committed. The committed D-015 mentions two Harlescott berth records without quoting berth ids.

- **P7 (D-037), local corroboration only:** the evidence matrix quotes the existence of two SMART berth numbers (438, 301) and nothing else. It is subject to the same licence review before it is committed.

## Network Rail GIS network model (not registered)

- Assessed in [NETWORK_RAIL_GIS_ASSESSMENT.md](NETWORK_RAIL_GIS_ASSESSMENT.md); stored locally in git-ignored `data/private/network-rail-gis/`.
- **Licence:** unresolved. The source metadata says "internal Network Rail use only", while the repository README states OGL. Permission to publish GIS-derived values is **not** established.
- **P7 (D-037):** used only to corroborate physical findings: a three-way node 1.1 m from `osm-n1460504022`, and four-way nodes near both diamonds. Only distances and link counts are quoted, as the assessment does.
- **Not done:** no GIS value enters a dataset, a pattern, a rule or a test, and the source stays unregistered.
- **Before any published or distributed use:** confirm the terms with Network Rail or the Rail Data Marketplace, including the Ordnance Survey attribution.

## RDG timetable feed (`rdg-timetable-feed`)

- https://www.raildeliverygroup.com/our-services/rail-data/timetable-data.html
- CIF sourced from Network Rail, filtered to **passenger services only**. A weekly copy for development is available via the National Rail Data Portal. Regular feeds need a paid RSP data licence.
- This is a fallback only: a signalling game needs freight and empty-stock moves.

## OpenRailwayMap (`openrailwaymap`)

- https://www.openrailwaymap.org/. It renders OSM railway tags. Use it to eyeball tagging coverage. Don't embed its tiles until their licence and usage policy have been reviewed.

## Network Rail Sectional Appendix (`nr-sectional-appendix`)

- Official route descriptions, published as PDFs on the Network Rail website. Forum reports say they are now served through "Box". Not yet located or downloaded. Reuse terms are not reviewed, so use it only as human reference until they are.

## Wikipedia (`wikipedia`)

- https://en.wikipedia.org/wiki/Severn_Bridge_Junction and https://en.wikipedia.org/wiki/Shrewsbury_railway_station, read 2026-10-27. Only facts are used (box names, operational status, lever counts); no text is copied.
- The two articles **disagree** on when Crewe Bank and Harlescott Crossing boxes closed: 8 December 2012 vs October 2013. Recorded in [DATA_GAPS.md](DATA_GAPS.md).

## UK bank holidays (`govuk-bank-holidays`)

- **URL:** https://www.gov.uk/bank-holidays.json (public JSON, no account). Snapshot: `data/raw/govuk/bank-holidays-2026-10-27.json`, retrieved 2026-10-27, covering 2019-01-01 to 2028-12-26 for England and Wales, Scotland and Northern Ireland.
- **Licence:** Open Government Licence v3.0. The GOV.UK terms page footer states v3.0, while its body links OGL v1; v3.0 is used. Attribution: "Contains public sector information licensed under the Open Government Licence v3.0." (the OGL default; GOV.UK gives no specific wording).
- **Use:** only to decide whether a timetable snapshot window contains a bank holiday (D-026). It does not say how a CIF bank-holiday running flag applies to a train.

## Manual downloads

The tools never handle credentials. Restricted files go in `data/private/`, which is git-ignored.

1. Register at https://publicdatafeeds.networkrail.co.uk/ and wait for activation.
2. Read the licence (link above) and record the attribution wording in `data/sources.json`, setting `licence.confirmed` to `true`.
3. Download the **SCHEDULE full CIF extract** (all operators) and the **CORPUS** reference file. Save them as `data/private/` + their original filenames, and note the download date.
4. Add the TIPLOC mappings for the study area to `data/datasets/shrewsbury/timing-points.json`, citing CORPUS as the source (see [IMPORTING.md](IMPORTING.md)).
5. Run `npm run data:import-cif -- --dataset shrewsbury --file data/private/<file>.CIF --date <YYYY-MM-DD> --source nr-open-data-feeds --retrieved <download date>`.
6. Derived study-area snapshots are committed under OGL (D-009). Raw extracts are never committed.
