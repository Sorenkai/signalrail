# Signal Network

A multiplayer, browser-based UK railway signalling and dispatching game, built on real, attributed infrastructure and timetable data. Players will operate neighbouring signalling areas on a traditional schematic diagram and hand trains to one another.

> **Status: data foundation.** No gameplay, simulation or interlocking yet.
>
> - Phase 0 built the data model, importers, validation and a geographic preview of the first study area (Shrewsbury).
> - A Carlisle dataset is under investigation: signal/berth reconciliation, a proposed playable area, and platform-to-track mapping. It is not playable. See [docs/pilots/CARLISLE_PILOT.md](docs/pilots/CARLISLE_PILOT.md).
>
> See [docs/FEASIBILITY_REPORT.md](docs/FEASIBILITY_REPORT.md) for what the data can credibly support.

This is a game. It is not a railway control system, and it is not affiliated with or endorsed by Network Rail, National Rail or any train operator.

## Quick start

Requires Node.js 20 or later (developed on 24).

```sh
npm install
npm run check          # typecheck, lint, format check, tests, data validation
npm run dev            # data preview page (Vite) at http://localhost:5173
npm run server         # read-only dataset API at http://localhost:3001/api/datasets/shrewsbury
```

## Scripts

| Script                                  | Purpose                                                              |
| --------------------------------------- | -------------------------------------------------------------------- |
| `npm test` / `npm run test:watch`       | Vitest                                                               |
| `npm run typecheck` / `lint` / `format` | tsc, ESLint, Prettier                                                |
| `npm run build`                         | Production client build to `dist/client`                             |
| `npm run data:validate`                 | Validate all datasets (exits 1 on errors)                            |
| `npm run data:import-osm`               | Rebuild infrastructure from the committed OSM snapshot               |
| `npm run data:preview`                  | Render `data/previews/<id>.svg`                                      |
| `npm run data:fetch-osm`                | Download a new OSM snapshot (network; use rarely)                    |
| `npm run data:import-cif`               | Build a dated timetable snapshot from a manually downloaded CIF file |
| `npm run data:import-corpus`            | Record CORPUS details for study-area TIPLOCs                         |
| `npm run data:smart-coverage`           | Report SMART berth steps per study-area TIPLOC (read-only)           |
| `npm run data:reconcile-signals`        | Build `signal-evidence.json` (needs private SMART/CORPUS files)      |
| `npm run data:assess-geography`         | Assess a dataset's `playable-area.json` (read-only on the dataset)   |

Details: [docs/IMPORTING.md](docs/IMPORTING.md).

## Layout

```
src/model/        zod schemas: evidence, sources, infrastructure, signalling, control, timetable
src/import/       OSM (Overpass), CIF, CORPUS and SMART importers
src/graph/        shared track graph: topology primitives and the geometric junction heuristic
src/validation/   dataset and interlocking validation
src/reconcile/    signal/berth evidence and playable-area assessment
src/pilot/        pilot identifier matching (signal refs and berths)
src/schematic/    SVG preview model and renderer
src/sim/          authoritative command pipeline and runtime state (docs/adr/0001); no train movement yet
src/server/       read-only HTTP API (multiplayer comes later)
src/client/       React data preview
tools/            CLI entry points
data/sources.json source registry
data/raw/         dated raw snapshots (OSM, ODbL)
data/datasets/    per-area data, one file per layer (shrewsbury; carlisle under investigation)
fixtures/synthetic/ synthetic test data (never real)
docs/             data sources, model, decisions, feasibility, gaps; docs/pilots/ area investigations
```

## Data and attribution

- Track data © OpenStreetMap contributors, available under the [Open Database License](https://www.openstreetmap.org/copyright). The files derived from it (`data/datasets/*/infrastructure.json`, `data/previews/*`) are ODbL.
- Timetable data, once imported, comes from Network Rail open data under its own licence. See [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).

Every data element carries an evidence level (`sourced`, `verified`, `inferred`, `placeholder`, `unknown`, or `simplified` for a deliberate game simplification) and its source. Real data is never fabricated or silently replaced. See [docs/DATA_MODEL.md](docs/DATA_MODEL.md).
