# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product

Signal Network is a multiplayer, browser-based UK railway signalling and dispatching game. Players control signalling areas on a traditional schematic diagram: they set routes, clear signals, operate points, and pass trains between control areas. The trains run to real, dated timetables over real railway infrastructure. Authenticity comes first, and gameplay is built on top of faithful data.

## Data integrity (non-negotiable)

- Never fabricate real-world infrastructure (track layout, signals, points, berths, TIPLOCs, line speeds) or timetable data (schedules, headcodes, calling patterns, dates).
- Never silently replace missing or unparseable real data with synthetic data. If something is unavailable, mark the gap and surface it in data, UI, or logs. Do not invent a value that looks plausible.
- Synthetic data is allowed only in tests and fixtures, and it must be clearly named and labelled as synthetic.

Every infrastructure and timetable record carries one of these evidence labels:

| Label         | Meaning                                                                        |
| ------------- | ------------------------------------------------------------------------------ |
| `sourced`     | Taken directly from a named, attributable source                               |
| `verified`    | Sourced and independently confirmed by a second source                         |
| `inferred`    | Derived by reasoning from sourced data; the reasoning is documented            |
| `placeholder` | A deliberate stand-in so the game can run; must be replaced                    |
| `unknown`     | Not known; consumers must handle it explicitly                                 |
| `simplified`  | A deliberate game simplification, kept on purpose; no real-world claim (D-023) |

Labels must survive the whole pipeline from import to runtime. Do not drop or upgrade a label without new evidence.

## Architecture boundaries

Keep these four layers separate in both modules and types. A lower layer never depends on a higher one:

1. **Physical infrastructure**: track, signals, points, track circuits, and their geography/schematic positions. Static and versioned.
2. **Timetable data**: dated schedules imported from source feeds. Static per date and independent of the infrastructure model, apart from location references.
3. **Simulated interlocking**: route definitions, locking, and conflicts, built from infrastructure. Where real control tables are not available, the logic is `inferred` and must be documented.
4. **Runtime simulation state**: train positions, occupancy, signal aspects, point positions, and player sessions. Mutable and server-owned.

Code map: `src/model/` (zod schemas, the single source of truth), `src/import/{osm,cif,corpus,smart}/` (source → canonical), `src/graph/` (shared track graph: topology primitives and the geometric junction heuristic), `src/validation/` (dataset and interlocking checks), `src/reconcile/` (signal/berth evidence and playable-area assessment), `src/pilot/` (pilot identifier matching), `src/schematic/` (SVG preview model), `src/sim/` (authoritative command pipeline and runtime state, ADR 0001; no train movement yet), `src/server/`, `src/client/`, `tools/` (CLIs), `fixtures/synthetic/` (test-only, labelled synthetic). Each dataset in `data/datasets/<id>/` stores one file per layer: `infrastructure.json` (generated from `data/raw/`, never hand-edited), `signalling.json`, `control.json`, `timing-points.json` (study-area TIPLOCs, sourced mappings, inferred positions), `timetables/<date>.json`, plus the area definition `area.json` and the optional, generated `signal-evidence.json` and game-design `playable-area.json` (see `docs/DATA_MODEL.md`).

## Stack

TypeScript (strict) throughout, React + Vite for the client, Node.js + Socket.IO for the server, SVG for the schematic diagram, and Vitest for tests. Do not depart from this without recording the reason in an ADR (see Documentation).

## Multiplayer model

The server is authoritative. Clients send action _requests_ (set route, cancel route, move points, accept train, and so on). The server checks every request against interlocking rules, track occupancy, point detection/locking, and the requesting player's control-area permissions before it changes state. It then broadcasts the resulting state. Clients never mutate simulation state themselves. Client-side checks are only for UX.

## Testing and checks

- Every bug fix and every behaviour change to interlocking or simulation logic gets a regression test.
- Before reporting work as done, run the relevant tests, the type check, and lint. Report any check that failed or could not be run, and say why.
- Commands (npm, Node ≥ 20):
  - `npm run check`: typecheck, lint, format check, tests, data validation (run before reporting done)
  - `npm test` (Vitest); single file `npx vitest run tests/cif.test.ts`; single test `npx vitest run -t "applies overlays"`
  - `npm run typecheck`, `npm run lint`, `npm run format`, `npm run build`
  - `npm run dev` (client preview, Vite), `npm run server` (read-only dataset API on :3001)
  - `npm run data:validate`, `data:import-osm`, `data:preview`, `data:import-corpus`, `data:import-cif`, `data:smart-coverage`, `data:fetch-osm` (network; rarely): see `docs/IMPORTING.md`

## Data sources and licensing

- Record every external data source in `data/sources.json` (machine-readable, enforced by the validator) and `docs/DATA_SOURCES.md` with its name, URL, licence, required attribution text, retrieval date, and usage restrictions.
- Check a source's licence before importing it. Do not commit data whose licence forbids redistribution. Fetch it at build or run time instead.
- Show the required attributions in the app.

## Documentation

Detailed technical facts belong in `docs/`, not in this file:

- `docs/DECISION_LOG.md`: numbered decisions (D-nnn) with reasons and how to reverse them, including any departure from the stack above. Architecture decision records with fuller context live in `docs/adr/`.
- `docs/DATA_MODEL.md`: schemas, evidence rules, validation codes. `docs/FEASIBILITY_REPORT.md`: what the data can credibly support. `docs/IMPORTING.md`: import formats and data commands.
- `docs/DATA_GAPS.md`: known missing or `placeholder`/`unknown` data, by area.
- `docs/INFERRED_BEHAVIOUR.md`: every piece of railway behaviour or interlocking logic that is `inferred` rather than sourced, with its reasoning.

Update these in the same change that introduces the decision, gap, or inference. Reusable multi-step workflows (for example, importing a new area or adding a data source) belong in `.claude/skills/`.

## Working style

- Read the existing code and docs before changing anything. Extend what is there instead of rewriting it.
- Work in small, coherent increments, each one leaving the build and tests green.
- When asked to implement, implement. Do not stop at a plan unless a plan was requested.

## Real-World Railway Dispatching Authenticity

Signal Network must simulate British railway signalling and signaller work, not generic train traffic management.

### Infrastructure and Data

- Base railway layouts on sourced real-world infrastructure.
- Use sourced working timetable data wherever available.
- Preserve source references, retrieval details, and provenance for infrastructure and timetable data.
- Distinguish sourced facts, independently corroborated facts, evidence-based inferences, deliberate simplifications, and unknown behaviour.
- Never invent infrastructure, signalling rules, or operational facts and present them as real.
- Missing data must remain explicitly unknown or inferred; do not silently fill gaps with plausible guesses.

### Signalling and Operations

- Research the actual control method, signalling principles, and interlocking behaviour applicable to the selected railway area before implementing location-specific logic.
- Model route setting, track-circuit occupancy, point detection, conflicting routes, route locking, signal aspects, train movements, and control-area handovers according to the available evidence.
- Treat AI signallers as operators subject to the same operating rules, route restrictions, and safety constraints as human players.
- Make simplified or simulated behaviour explicit, documented, and configurable where appropriate.
- Do not assume that different British signal boxes or control areas use identical equipment, procedures, or operating rules.
- Do not infer a real interlocking's detailed behaviour solely from track geometry, signal locations, or train movements when the evidence is insufficient.

### Safety and Verification

- Add automated tests for signalling safety invariants, conflicting routes, point and occupancy constraints, route locking, signal clearance, and realistic operating scenarios as applicable.
- Ensure that human and AI actions pass through the same authoritative signalling validation and state-transition rules.
- Never allow missing or uncertain real-world data to silently disable a safety constraint in the simulation.
- Do not claim that Signal Network is a certified or operationally safe replica of a real railway interlocking.

### Project-Wide Consistency

- Before implementing a substantial feature, inspect relevant existing code, data models, datasets, source records, documentation, tests, and architectural decisions.
- Consider the impact of changes across the whole project, not only the files directly involved.
- Preserve existing work and established provenance. Do not overwrite raw source data or discard changes without explicit approval.
- When identifying inconsistencies or missing functionality, distinguish confirmed defects from suspected issues and limitations caused by incomplete evidence.
- Do not undertake broad refactors or unrelated changes without approval. Report significant cross-project issues and propose a plan first.
- Update relevant tests and documentation when behaviour, data models, assumptions, or evidence classifications change.
