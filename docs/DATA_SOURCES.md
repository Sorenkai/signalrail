# Data sources

The machine-readable registry is [`data/sources.json`](../data/sources.json). Every `sourceId` cited in a dataset must appear there; `npm run data:validate` enforces this. This page holds the human-readable detail.

Status as of **2026-10-27** (updated after the owner supplied SCHEDULE and CORPUS files). "Retrieved" means this project actually downloaded data. Everything else is research only.

## Summary

| Source                                         | Used for                                                                     | Access                 | Licence (confirmed?)                             | Retrieved                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| OpenStreetMap via Overpass API                 | Track geometry/topology, signals (partial), points, platforms, boxes, speeds | Public, no account     | ODbL 1.0 (yes)                                   | 2026-10-27, OSM base `2026-10-27T16:01:40Z`, Shrewsbury bbox                                                  |
| Network Rail Open Data Feeds                   | Timetable (SCHEDULE CIF), TIPLOC codes (CORPUS), TD berths (SMART)           | Free registration      | NR Data Feeds Licence → OGL (version not stated) | SCHEDULE full CIF (DFROC1F, extracted 2026-10-23) and CORPUS, supplied by the owner 2026-10-27; SMART not yet |
| RDG timetable feed / National Rail Data Portal | Fallback passenger timetable                                                 | Registration / licence | RSP data licence (not read)                      | No                                                                                                            |
| OpenRailwayMap                                 | Visual cross-check of OSM tagging                                            | Reference only         | Data ODbL; tiles not reviewed                    | No                                                                                                            |
| Network Rail Sectional Appendix                | Corroborating line names, speeds, box limits                                 | Reference only         | Not reviewed                                     | No                                                                                                            |
| Wikipedia                                      | Corroborating signal box names and status                                    | Public                 | CC BY-SA 4.0 (not re-read)                       | Read 2026-10-27 (facts only)                                                                                  |

## OpenStreetMap (`openstreetmap`)

- **URL:** https://www.openstreetmap.org/, queried through https://overpass-api.de/api/interpreter.
- **Access:** public. The Overpass usage policy (https://wiki.openstreetmap.org/wiki/Overpass_API) asks for fewer than 10,000 queries and less than 1 GB per day. So we fetch rarely and commit dated snapshots to `data/raw/osm/`.
- **Licence:** ODbL 1.0, confirmed from https://www.openstreetmap.org/copyright on 2026-10-27.
- **Attribution (required wherever the data or derived maps are shown):** "© OpenStreetMap contributors. Data available under the Open Database License (https://www.openstreetmap.org/copyright)." The client page footer and the SVG preview display this. It is generated from the registry by `src/data/attribution.ts`.
- **Share-alike:** `data/datasets/*/infrastructure.json` is a _derived database_. If it is distributed publicly or used in a public service, it must be offered under ODbL. The game's own code does not need to be. Keep derived data in separate files from authored game data (it already is), so the ODbL obligation stays limited to it.
- **Quality caveat:** OSM is crowd-sourced. It records what contributors mapped, not Network Rail records. All OSM-derived elements are labelled `sourced` (attributable), not `verified`.
- **Retrievals:** 2026-10-27, `data/raw/osm/shrewsbury-2026-10-27.json`, OSM base timestamp `2026-10-27T16:38:36Z`, from overpass-api.de, bbox 52.695–52.745 N, 2.770–2.725 W. It includes named junctions, yards and level crossings. It supersedes an earlier same-day extract (base `16:01:40Z`, smaller bbox). A mirror (overpass.private.coffee) returned a stale base (`2026-05-31`), so we discarded it and did not use it.

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
- **Committed derivatives:** `data/datasets/shrewsbury/timetables/2026-11-04.json` and the CORPUS fields in `timing-points.json`. The raw files are never committed.
- **SMART: inspected 2026-10-27.** `data/private/SMARTExtract.json` (34,298 berth rows, supplied by the owner; retrieval date from the file timestamp). `npm run data:smart-coverage` reports coverage per study-area TIPLOC. Findings are in FEASIBILITY_REPORT. In short: of the 15 study-area TIPLOCs, only Harlescott Crossing (TD area C3) has berth data. An earlier attempt to fetch SMART without a login returned HTTP 401; the project tools still hold no credentials.

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

## Manual downloads

The tools never handle credentials. Restricted files go in `data/private/`, which is git-ignored.

1. Register at https://publicdatafeeds.networkrail.co.uk/ and wait for activation.
2. Read the licence (link above) and record the attribution wording in `data/sources.json`, setting `licence.confirmed` to `true`.
3. Download the **SCHEDULE full CIF extract** (all operators) and the **CORPUS** reference file. Save them as `data/private/` + their original filenames, and note the download date.
4. Add the TIPLOC mappings for the study area to `data/datasets/shrewsbury/timing-points.json`, citing CORPUS as the source (see [IMPORTING.md](IMPORTING.md)).
5. Run `npm run data:import-cif -- --dataset shrewsbury --file data/private/<file>.CIF --date <YYYY-MM-DD> --source nr-open-data-feeds --retrieved <download date>`.
6. Derived study-area snapshots are committed under OGL (D-009). Raw extracts are never committed.
