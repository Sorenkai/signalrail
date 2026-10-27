# Feasibility report: Phase 0

_Date: 2026-10-27. Covers what public data can credibly support, and what it cannot._

## Bottom line

- **Track layout: credible now.** OpenStreetMap gives a connected, attributed track graph for Shrewsbury, with platform positions, points locations, speed limits and the four signal boxes.
- **Signals: partly credible.** OSM has 25 signal nodes in the study area, 13 of them with published-looking refs. The real number is far higher: Wikipedia says Severn Bridge Junction alone has about 90 of its 180 levers in use. A playable signal set therefore can't come from OSM alone.
- **Interlocking (routes, locking, overlaps): not publicly evidenced.** It must be simulated and labelled `inferred`, or come from a source not yet identified.
- **Timetable: obtained.** A real snapshot for Wed 2026-11-04 comes from the Network Rail SCHEDULE full CIF (extracted 2026-10-23): 297 services touch the study area, including freight and ECS. The parser was spot-checked field by field against raw records. SHRWBY is mapped from sources. The other 12 study-area timing points used that day have **inferred** positions anchored to OSM track nodes (3 high, 3 medium, 6 low confidence; see INFERRED_BEHAVIOUR I-002). COTONDB and COTOCLS are unused that day and unplaced.

**Phase 0 data is now sufficient to start building** the simulation core against this snapshot, provided low-confidence timing points and missing signals are treated as approximations. The remaining blockers to faithful signalling are in the signal section below.

## What was actually done

| Step                                     | Result                                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OSM tagging counts for 5 candidate areas | Measured 4 (York, Shrewsbury, Worcester, Carlisle) on 2026-10-27 via overpass-api.de. Derby was rate-limited and **not measured**.                                                                                             |
| OSM snapshot, Shrewsbury                 | Downloaded 2026-10-27, OSM base `2026-10-27T16:38:36Z`, 1,565 elements (bbox extended north, D-011)                                                                                                                            |
| Import to canonical model                | 271 nodes, 311 edges (44.0 km incl. track beyond the bbox), 77 points, 25 signals, 6 platforms, 17 locations (incl. 7 named junctions/yards/crossings)                                                                         |
| Validation                               | 0 errors, 7 warnings (see below)                                                                                                                                                                                               |
| Network Rail SCHEDULE + CORPUS           | Supplied by the owner 2026-10-27; snapshot for 2026-11-04 imported. SMART was supplied later the same day and inspected (see "SMART + TD" below; D-015). _(Corrected: this row previously said SMART was not yet downloaded.)_ |
| CIF parser                               | Full extract parsed (721,875 schedules, 0 errors); one service checked field by field                                                                                                                                          |
| Sectional Appendix                       | **Not located or downloaded**                                                                                                                                                                                                  |

## Candidate areas

OSM element counts. Each bbox is about 3–4 km across; the bboxes are not normalised, so treat the counts as indicative only.

| Area       | Rail ways                          | Signals (with ref) | Switches (with ref) | Platforms (with ref) | Signal boxes | Ways with maxspeed |
| ---------- | ---------------------------------- | ------------------ | ------------------- | -------------------- | ------------ | ------------------ |
| York       | 197                                | 33 (22)            | 165 (0)             | 15 (12)              | 1            | 77                 |
| Shrewsbury | 179                                | 25 (13)            | 81 (0)              | 6 (5)                | **4**        | 167                |
| Worcester  | 94                                 | 0 (0)              | 60 (0)              | 5 (5)                | 0            | 62                 |
| Carlisle   | 179                                | 42 (42)            | 102 (0)             | 9 (8)                | 1            | 165                |
| Derby      | not measured (Overpass rate limit) |                    |                     |                      |              |                    |

None of the measured areas had `ref:tiploc` on stations, so TIPLOCs must come from CORPUS everywhere. Timetable availability is the same for every area, since the national CIF covers all of them.

Operational and multiplayer fit (from Wikipedia; OSM for box locations):

- **Shrewsbury:** four staffed mechanical boxes (Crewe Jn, Severn Bridge Jn, Abbey Foregate, Sutton Bridge Jn), five routes, and a mix of TfW and WMR passenger traffic. Clear real boundaries for 2–4 players. **Selected:** see [DECISION_LOG D-003](DECISION_LOG.md).
- **York:** very complex and high-traffic, controlled by one operating centre. Too large for a first section, and it has no real box split.
- **Carlisle:** good OSM signal coverage, but one box found. A multi-player split would be invented.
- **Worcester:** no signals mapped in OSM.

## Shrewsbury: what can be represented

| Element                     | Status        | Evidence                   | Notes                                                                                                                                                                                           |
| --------------------------- | ------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Track geometry and topology | Yes           | sourced (OSM)              | Single connected component. 14 diamond crossings, all with degree 4.                                                                                                                            |
| Area boundaries             | Yes           | inferred                   | 10 track ends outside the bbox, marked `area_boundary`                                                                                                                                          |
| Line speeds                 | Mostly        | sourced (OSM)              | 288/311 edges. Values 15–70 mph. Not cross-checked against the Sectional Appendix.                                                                                                              |
| Platforms                   | Partly        | sourced (OSM)              | Refs 3, 4, 5, 6, 7 (+1 unnumbered). This matches Wikipedia's "five in use, numbered 3–7". Platform→track link is `unknown`.                                                                     |
| Station codes               | Yes           | sourced (OSM + CORPUS)     | CRS `SHR` (OSM), TIPLOC `SHRWBY` / STANOX 64224 (CORPUS), joined on CRS                                                                                                                         |
| Signal boxes                | Yes           | verified (OSM + Wikipedia) | 4 boxes                                                                                                                                                                                         |
| Signals                     | **Partial**   | sourced (OSM)              | 25 nodes: 13 semaphore main, 5 colour-light main, 2 semaphore shunting, 1 repeater, 3 stop boards, 1 unclassified. Refs: SBJ×5, CJ×4, AF×3, SUB×1, none×12. All 25 have a resolvable direction. |
| Points                      | Location only | sourced (OSM)              | 77 switch nodes. No refs, no type, normal/reverse lie `unknown`.                                                                                                                                |
| Track circuits / occupancy  | No            | none                       | Would have to be simulated (`inferred`)                                                                                                                                                         |
| Routes, locking, overlaps   | **No**        | none                       | No public control tables identified                                                                                                                                                             |
| Box control limits          | No            | unknown                    | Ref prefixes hint at membership but are not treated as evidence (D-008)                                                                                                                         |
| Timetable                   | Yes (1 day)   | sourced (NR SCHEDULE)      | 2026-11-04, 297 services. Platforms, lines and paths are included, e.g. 1D11 at platform 3.                                                                                                     |

### Validation warnings (real data, not fixed)

- `DANGLING_TRACK_END`, `osm-n2428399152`: a track end inside the bbox with no buffer stop. Probably an unmapped buffer stop or a siding cut short in OSM. Needs checking against imagery or OpenRailwayMap; **not repaired**.
- `SWITCH_TOPOLOGY`, `osm-n1119814845` and `osm-n1581276847`: switch nodes with only two connected tracks. The diverging leg is missing or disused in OSM. **Not repaired.**
- `UNSUPPORTED_ASSUMPTION` ×4: control-area membership is unknown (by design, D-008).

## Can Network Rail data supply the missing signals?

Only partly, from what the open feeds contain:

- **CORPUS** includes a few signals that are used as timing points, e.g. `SHRW15` and `SHRW34` (Sutton Bridge Jn signals 15 and 34). These confirm that the signals exist, but give no position or direction.
- **SCHEDULE (CIF)** gives each train's platform, line and path codes. This is evidence of which routes are actually used (which platform from which direction), but not of the signals or locking behind them.
- **SMART + TD** (inspected 2026-10-27): SMART has **no berth data for Shrewsbury station or any study-area timing point except Harlescott Crossing**. Of the 15 study-area TIPLOCs, 14 have none: SHRWBY, all four box/junction points, Coleham, Abbey Foregate CS, Coton Hill and Crewe Bank. Harlescott (STANOX 64219) has two berth steps in TD area **C3**: Up 8330→8316 and Down 8325→8361 (row date 18/04/2018). C3 otherwise covers Wem and Nantwich on the Crewe line. Neighbouring routes are covered by other TD areas: `TD` (Wellington, Shifnal), `MH` (Welshpool), `CS` (Wrexham), `CE` (Crewe). **Conclusion:** SMART cannot supply signal identities for the Shrewsbury boxes. This is consistent with mechanical signalling, but SMART's absence is not proof that no train describer exists, so TD coverage is reported as "none recorded in SMART", not "none".
- **Signalling plans and control tables** are what would answer the question, and they are **not** published as open data. A request to Network Rail is possible (it is subject to Freedom of Information requests), but the outcome is uncertain.

## Signal-set approach (decided 2026-10-27, D-014)

The game needs every running signal and its routes. Options, best evidence first:

1. **Find a usable authoritative source.** Signalling Record Society diagrams, Network Rail data obtained by request, or similar. These are typically copyright, so they need permission. Best fidelity; access uncertain.
2. **Improve OSM.** Map the missing signals in OSM from on-the-ground survey or permitted imagery, under ODbL. Legitimate and attributable, but slow; it relies on contributor survey.
3. **Labelled game-design signals.** Author the missing signals and routes, labelled `inferred` (with reasoning from track layout) or `placeholder`. Show them differently in the UI, and keep every real OSM signal. Fast and honest, but not a faithful replica.

The owner's decision: use the best available authoritative sources (option 1, plus Network Rail data such as CORPUS and SMART). Use OSM for track geometry. Never invent or claim verified signal coordinates. Any gameplay approximations (option 3) must be clearly distinguished from verified data. Authoring the gameplay signals is the next phase; Phase 0 adds none.

## Risks and limitations

- OSM accuracy isn't guaranteed. Nothing OSM-derived is `verified` yet.
- The CIF parser read the full extract (721,875 schedules) with 0 errors. One service (1D11, UID G38352) was checked field by field against the raw records; broader checking is still worthwhile.
- The Open Rail Data wiki blocks automated fetches (HTTP 403), so feed details come from search summaries and must be re-checked when registering.
- The Network Rail licence page names the OGL but not its version or attribution wording. The OGL v3.0 default is used (D-009).
- Wikipedia sources disagree on box closure dates for Crewe Bank and Harlescott Crossing. These boxes are outside the current model.
