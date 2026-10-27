# ADR 0001: Authoritative command pipeline shared by human and AI operators

- **Status:** accepted (owner approval, 2026-10-27). Decision log: D-028.
- **Scope:** architecture, interfaces and a safety-invariant test harness (R6). Not in scope: train movement, a live interlocking engine, real-time multiplayer, AI decision-making, persistence and live feeds.

## Context

The server (`src/server/app.ts`) is a read-only dataset API. There is no runtime state, no Socket.IO and no command handling. CLAUDE.md requires a server-authoritative model in which human and AI operators pass through the same validation and state transitions. R2 to R5 provide what that pipeline needs to check against:

- route and overlap data statuses (`src/validation/interlocking.ts`);
- a shared track graph (`src/graph/`);
- control areas with explicit membership (`control.json`).

## Decision

### Authoritative state owner

A single `CommandStore` (`src/sim/pipeline.ts`) per session owns the `AuthoritativeState` (`src/sim/state.ts`).

- **Contents:** state version, points (position and detection), set routes (with locked points and occupied track), signal aspects (on/off), and per-edge occupancy.
- **Immutability:** the state is deeply frozen. Every accepted command replaces it with a new frozen object and a version one higher.
- **Static data:** the infrastructure, signalling and control data, the R2 statuses, the policy and the operator assignments form an immutable `SimWorld`.

### Command and validation boundary

Every operator, human or AI, submits a `CommandEnvelope` (`src/sim/commands.ts`): `commandId`, `operator {kind, id}`, `controlAreaId`, `expectedVersion` and `command`. The commands are `set_route`, `cancel_route` and `move_points`. `CommandStore.submit` is the only write path. In order:

1. **Parse:** zod; on failure `MALFORMED`.
2. **Repeat and stale checks:**
   - A known `commandId` with the same payload returns the original outcome as `duplicate`, without a second transition.
   - A known `commandId` with a different payload is `COMMAND_ID_REUSED`.
   - An `expectedVersion` other than the current version is `STALE`.
3. **Decide:** `decide(world, state, envelope)` is a pure function:
   - **Authority:** the operator is assigned the area, and the area contains the entry signal and every required points (`NOT_AUTHORISED`).
   - **Data status:** the route's and overlap's R2 status is allowed by the policy (`ROUTE_NOT_ESTABLISHED`).
   - **Points:** every required points is detected in the required position (`POINTS_NOT_PROVEN`, `POINTS_WRONG_POSITION`).
   - **Conflicts:** no conflicting route is set: declared, shared track or opposed points (`ROUTE_CONFLICT`).
   - **Track:** route and overlap track is proven clear, and unknown counts as occupied (`TRACK_OCCUPIED`, `TRACK_NOT_PROVEN_CLEAR`).
   - **Locking:** points held by a set route cannot move (`POINTS_LOCKED`).
4. **Apply:** an accepted decision's new state becomes current.
5. **Record:** an append-only event log entry for every submission, accepted, rejected or duplicate, with sequence number, version, operator, command, code, reason and changes.
6. **Publish:** `StatePublisher.publish({version, state, event})`.

### Human/AI parity

- `decide` never reads `operator.kind`. A test checks that human and AI envelopes, which differ only in kind, give identical decisions across a matrix of commands, states and areas.
- Operators receive an `OperatorHandle` with exactly `view()` (the frozen state) and `submit()`. There is no other reference to the store's state, and mutating the view throws.
- An AI can only submit commands. A rejected command leaves nothing to bypass, because nothing changed.
- **No exceptions are proposed.** Any future exception (e.g. a scripted "fringe" operator beyond the boundary) must be recorded here, with its reason and constraints, before it is built.

### Rejection and error semantics

- A rejection always means that nothing changed: `decide` returns no state, and the store keeps the same frozen object.
- Each rejection has one code and a human-readable reason; the codes are listed in `src/sim/commands.ts`.
- The first failing check decides the code. For example, a route blocked both by locked points and by a conflict is reported as the points failure.
- Rejections are logged and published like acceptances, so clients and audits see them.

### State transitions and event recording

- Transitions are pure, deterministic and complete: either the whole change applies or none of it does.
- The version increases only on acceptance.
- The log is append-only and records rejections and duplicates too. It is in memory for now; persistence and replay are open decisions.

### Simulation policy (explicit assumptions)

`src/sim/policy.ts` holds the game's rules. They are SIMULATION ASSUMPTIONS, not real interlocking behaviour.

- **Owner decisions:**
  - `allowedRouteStatuses`: `evidenced` and `game_rule`. `insufficient_evidence` and `invalid` cannot be allowed, and `evidenced` alone is a valid, tighter setting.
  - `routeSettingMovesPoints: false`: operators move points first.
- **Fixed fail-safe rules,** typed as literals so that no configuration can switch them off:
  - unknown occupancy is treated as occupied;
  - occupancy is held per edge;
  - points move and are detected instantly;
  - a route may be cancelled only on proven-clear track, because approach locking is not modelled.

### Future multiplayer clients

- A Socket.IO server will implement `StatePublisher`. Clients will send envelopes and receive `StateUpdate`s.
- Each client renders only the authoritative state it receives. Client-side checks are for UX and never change state.
- Per-area filtering, reconnection (resynchronising from `version`) and persistence will be designed with the server work.

## Consequences

- One code path serves humans, AI and tests. The safety invariants are tested at the decision level (`tests/sim.test.ts`).
- Real data can't clear routes yet: no dataset has routes, and every real points lie is unknown, so any route over points would be `insufficient_evidence`. That is intended. The harness uses labelled synthetic fixtures.
- Passing the harness does not certify, reproduce or prove the operational safety of any real interlocking.

## Risks and open decisions

1. **Not modelled:** train movement and occupancy changes, approach locking and timed release, overlap release, point swing time and failure, signal aspects beyond on/off, flank-protection semantics beyond holding points, and train describers.
2. **Session assignment:** how operators are assigned control areas (lobby, roles, takeover between human and AI) is undecided.
3. **Persistence:** whether the event log is persisted and used for replay or recovery is undecided.
4. **Conflicting commands:** concurrent submissions are serialised by the single store. Distributing it would need a new design.
5. **Points that are both flank and path for different routes:** these are locked by any holder. Real flank protection may be more permissive; no source defines it here.
6. **Carlisle:** the data has no routes, the playable area is one proposed game area, and all handovers are undecided (D-027). Gameplay needs those decided, and needs routes authored as labelled game rules.
