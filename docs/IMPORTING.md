# Import formats and data commands

All commands run from the repo root. `--dataset` defaults to `shrewsbury`.

| Command                                                                                                                   | What it does                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run data:fetch-osm -- --dataset <id> [--endpoint URL]`                                                               | Downloads an OSM extract for `area.json`'s bbox to `data/raw/osm/<id>-<date>.json` and records it in `area.json`. Network access; use sparingly.                        |
| `npm run data:import-osm -- --dataset <id>`                                                                               | Rebuilds `infrastructure.json` from the recorded raw snapshot. Deterministic.                                                                                           |
| `npm run data:import-cif -- --dataset <id> --file <CIF> --date YYYY-MM-DD --source <id> [--retrieved YYYY-MM-DD] [--all]` | Writes `timetables/<date>.json` from a manually downloaded CIF file. Streams the file. Keeps services touching `areaTiplocs` (whole journeys) unless `--all` is passed. |
| `npm run data:import-corpus -- --dataset <id> --file <CORPUS JSON> [--retrieved YYYY-MM-DD] [--tiplocs A,B,...]`          | Records CORPUS details for the study-area TIPLOCs in `timing-points.json` and maps those that join exactly on CRS.                                                      |
| `npm run data:smart-coverage -- --dataset <id> --file <SMART JSON> [--json]`                                              | Read-only report of SMART berth steps at each study-area TIPLOC's STANOX.                                                                                               |
| `npm run data:validate [-- --dataset <id>] [--verbose] [--json]`                                                          | Validates all layers. Exits 1 on errors.                                                                                                                                |
| `npm run data:preview -- --dataset <id>`                                                                                  | Writes `data/previews/<id>.svg`.                                                                                                                                        |

## Inputs

### OSM (Overpass JSON)

The query is built by `buildRailwayQuery` in `src/import/osm/overpass.ts`. It fetches all `railway=rail` ways in the bbox plus all their nodes, and the platform, station, halt, signal_box, signal, switch, buffer_stop and railway_crossing features in the bbox. The raw file is stored with the query, endpoint and retrieval date.

Tag mapping:

- `railway=switch` → switch node + `Points`
- `railway=signal` → `Signal`; `ref` copied verbatim; form/function from `railway:signal:{main,distant,shunting,minor,main_repeated,stop}[:form]`; direction from `railway:signal:direction`
- `railway=buffer_stop` / `railway_crossing` → node kinds
- `service=*` / `usage=*` → edge usage; `maxspeed` → mph
- `railway=station|halt|signal_box` with `name` → `Location`; `ref:crs`, `ref:tiploc` and `ref:stanox` are copied only if present
- `railway=platform` → `Platform`

### CIF (timetable)

A fixed-width, 80-column CIF file. Records used: `HD`, `BS`, `BX`, `LO`, `LI`, `LT`; others are counted and skipped. The column offsets are in `src/import/cif/parseCif.ts`, and the test builder `fixtures/synthetic/cif.ts` documents them by example. Files are read as Latin-1.

The snapshot for a date keeps, per train UID, the applicable schedule with the strongest STP indicator (C > O > N > P). Cancelled trains are dropped.

### CORPUS (Network Rail JSON)

`{"TIPLOCDATA": [{NLC, STANOX, TIPLOC, 3ALPHA, UIC, NLCDESC, NLCDESC16}]}`, with blank fields as `" "`. Parsed by `src/import/corpus/corpus.ts`. `3ALPHA` is the CRS code.

### SMART (Network Rail JSON)

`{"BERTHDATA": [{TD, FROMBERTH, TOBERTH, STANOX, STANME, STEPTYPE, EVENT, PLATFORM, FROMLINE, TOLINE, BERTHOFFSET, ROUTE, COMMENT}]}`. Parsed by `src/import/smart/smart.ts`. Matching is by STANOX from CORPUS. The `COMMENT` field is free text and not a reliable date.

### Timing-point mappings (authored)

`data/datasets/<id>/timing-points.json`:

```json
{
  "areaTiplocs": [
    { "tiploc": "…", "description": "…", "stanox": "…", "crs": null, "nlc": "…", "provenance": { … } }
  ],
  "mappings": [
    {
      "tiploc": "<from CORPUS>",
      "locationId": "osm-n…",
      "provenance": {
        "evidence": "sourced",
        "sources": [
          {
            "sourceId": "nr-open-data-feeds",
            "recordId": "CORPUS:<row>",
            "retrieved": "YYYY-MM-DD"
          }
        ]
      }
    }
  ]
}
```

Never guess TIPLOCs. If a mapping can't be sourced, leave it out, and the validator will report the TIPLOC as unmapped.
