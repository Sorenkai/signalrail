# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product

Signal Network is a multiplayer, browser-based UK railway signalling and dispatching game. Players control signalling areas on a traditional schematic diagram: they set routes, clear signals, operate points, and pass trains between control areas. The trains run to real, dated timetables over real railway infrastructure. Authenticity comes first, and gameplay is built on top of faithful data.

## Data integrity (non-negotiable)

- Never fabricate real-world infrastructure (track layout, signals, points, berths, TIPLOCs, line speeds) or timetable data (schedules, headcodes, calling patterns, dates).
- Never silently replace missing or unparseable real data with synthetic data. If something is unavailable, mark the gap and surface it in data, UI, or logs. Do not invent a value that looks plausible.
- Synthetic data is allowed only in tests and fixtures, and it must be clearly named and labelled as synthetic.

Every infrastructure and timetable record carries one of these evidence labels:

| Label | Meaning |
|---|---|
| `sourced` | Taken directly from a named, attributable source |
| `verified` | Sourced and independently confirmed by a second source |
| `inferred` | Derived by reasoning from sourced data; the reasoning is documented |
| `placeholder` | A deliberate stand-in so the game can run; must be replaced |
| `unknown` | Not known; consumers must handle it explicitly |

Labels must survive the whole pipeline from import to runtime. Do not drop or upgrade a label without new evidence.

## Architecture boundaries

Keep these four layers separate in both modules and types. A lower layer never depends on a higher one:

1. **Physical infrastructure**: track, signals, points, track circuits, and their geography/schematic positions. Static and versioned.
2. **Timetable data**: dated schedules imported from source feeds. Static per date and independent of the infrastructure model, apart from location references.
3. **Simulated interlocking**: route definitions, locking, and conflicts, built from infrastructure. Where real control tables are not available, the logic is `inferred` and must be documented.
4. **Runtime simulation state**: train positions, occupancy, signal aspects, point positions, and player sessions. Mutable and server-owned.

## Stack

TypeScript (strict) throughout, React + Vite for the client, Node.js + Socket.IO for the server, SVG for the schematic diagram, and Vitest for tests. Do not depart from this without recording the reason in an ADR (see Documentation).

## Multiplayer model

The server is authoritative. Clients send action *requests* (set route, cancel route, move points, accept train, and so on). The server checks every request against interlocking rules, track occupancy, point detection/locking, and the requesting player's control-area permissions before it changes state. It then broadcasts the resulting state. Clients never mutate simulation state themselves. Client-side checks are only for UX.

## Testing and checks

- Every bug fix and every behaviour change to interlocking or simulation logic gets a regression test.
- Before reporting work as done, run the relevant tests, the type check, and lint. Report any check that failed or could not be run, and say why.
- Build/test/lint commands go here once `package.json` exists.

## Data sources and licensing

- Record every external data source in `docs/data-sources.md` with its name, URL, licence, required attribution text, retrieval date, and usage restrictions.
- Check a source's licence before importing it. Do not commit data whose licence forbids redistribution. Fetch it at build or run time instead.
- Show the required attributions in the app.

## Documentation

Detailed technical facts belong in `docs/`, not in this file:

- `docs/adr/`: architecture decision records, one per significant decision, including any departure from the stack above.
- `docs/data-gaps.md`: known missing or `placeholder`/`unknown` data, by area.
- `docs/inferred-behaviour.md`: every piece of railway behaviour or interlocking logic that is `inferred` rather than sourced, with its reasoning.

Update these in the same change that introduces the decision, gap, or inference. Reusable multi-step workflows (for example, importing a new area or adding a data source) belong in `.claude/skills/`.

## Working style

- Read the existing code and docs before changing anything. Extend what is there instead of rewriting it.
- Work in small, coherent increments, each one leaving the build and tests green.
- When asked to implement, implement. Do not stop at a plan unless a plan was requested.
