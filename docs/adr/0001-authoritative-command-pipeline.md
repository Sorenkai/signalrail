# ADR 0001: Authoritative command pipeline shared by human and AI operators

- **Status:** accepted (owner approval, 2026-10-27). Decision log: D-028; clock and ticks (P2): D-031; trains (P3, P3.1): D-032, D-033; route lifecycle (P4): D-034.
- **Scope:** architecture, interfaces and a safety-invariant test harness (R6). Not in scope: train movement, a live interlocking engine, real-time multiplayer, AI decision-making, persistence and live feeds.

## Context

The server (`src/server/app.ts`) is a read-only dataset API. There is no runtime state, no Socket.IO and no command handling. CLAUDE.md requires a server-authoritative model in which human and AI operators pass through the same validation and state transitions. R2 to R5 provide what that pipeline needs to check against:

- route and overlap data statuses (`src/validation/interlocking.ts`);
- a shared track graph (`src/graph/`);
- control areas with explicit membership (`control.json`).

## Decision

### Authoritative state owner

A single `CommandStore` (`src/sim/pipeline.ts`) per session owns the `AuthoritativeState` (`src/sim/state.ts`).

- **Contents:** state version, simulation clock (P2), points (position and detection), set routes (with locked points and occupied track), signal aspects (on/off), and per-edge occupancy.
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
   - **Authority:** the operator is assigned the area, and the area contains the entry signal and every required points (`NOT_AUTHORISED`). A route end at a fringe endpoint (D-029) belongs to the area only if the area has a `control.json` boundary at that cut with `fromAreaId` equal to the area. A route from a fringe endpoint has no entry signal and clears none.
   - **Data status:** the route's and overlap's R2 status is allowed by the policy, and its entry signal (if any) is a main or shunting signal (D-033) (`ROUTE_NOT_ESTABLISHED`).
   - **Points:** every required points is detected in the required position (`POINTS_NOT_PROVEN`, `POINTS_WRONG_POSITION`).
   - **Conflicts:** no conflicting route is set: declared, shared track or opposed points; and the entry signal is not already `off` for another offered route (D-033) (`ROUTE_CONFLICT`).
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
- The version increases only on acceptance, of a command or a tick (P2, below).
- The log is append-only and records rejections and duplicates too. It is in memory for now; persistence is an open decision. Replay from an ordered input list is defined below.

### Simulation clock and ticks (P2, D-031)

**Simulation time** (`src/sim/clock.ts`) is separate from wall-clock time:

- **Representation:** an integer number of milliseconds on the session timeline, held in `AuthoritativeState.clock` as `{ tick, timeMs, tickDurationMs }`.
  - Integers, so repeated ticks never accumulate floating-point drift. After _n_ ticks, `timeMs` is exactly `start + n × tickDurationMs`.
  - Milliseconds, because CIF times have a 30 s resolution (30 000 ms exactly), and later train movement will need sub-second steps.
  - Every value must be a non-negative safe integer (`Number.isSafeInteger`). Advancing beyond `Number.MAX_SAFE_INTEGER` is refused as `TIME_OVERFLOW`; the clock never wraps or loses precision.
- **Configuration:** `ClockConfig { startTimeMs, tickDurationMs }` is given to `initialState`. `DEFAULT_CLOCK` (0 ms, 1 000 ms ticks) is the one named default; there are no other clock constants. An invalid configuration throws at session creation.
- **What time 0 means:** nothing yet. Mapping simulation time to timetable dates and UK local times (D-026, including clock-change days) is deferred to timetable playback.
- **No hidden inputs:** nothing in `src/sim/` reads system time, timers, frame rate, or random numbers. A test enforces this by scanning the source. Whatever drives ticks in real time (a server interval, later) only _requests_ them; the result depends on the request alone.

**Tick semantics** (`src/sim/tick.ts`):

- A tick request is `{ tick: n }`. Its identity is the tick number: tick _n_ moves the clock from tick *n*−1 to _n_ and advances `timeMs` by exactly `tickDurationMs`.
- `decideTick(world, state, request)` is pure, like `decide`:
  - **Next tick** (`n = current + 1`): accepted.
  - **Already applied** (`n ≤ current`): `duplicate`. Nothing changes, and time never advances twice for the same tick.
  - **Skips ticks** (`n > current + 1`): rejected as `TICK_OUT_OF_SEQUENCE`. Catching up means requesting each tick in turn.
  - **Not a positive safe integer:** `MALFORMED`. **Past the safe range:** `TIME_OVERFLOW`.
- Ticks are not operator commands. `OperatorHandle` has no tick method, so no human or AI operator can advance time. Only the session owner of the `CommandStore` calls `tick`.

**One serialized transition path:** `CommandStore.submit` (commands) and `CommandStore.tick` (ticks) are the only write paths. Both run synchronously on one store, so every input is fully decided, applied, recorded and published before the next one starts. The order of inputs is the order of calls, and nothing interleaves inside a transition.

- **Commands** apply at the current simulation time and never change the clock.
- **Ticks** never change points, routes, signals or occupancy in P2.
- **Versions:** every accepted input, command or tick, raises `version` by exactly one. A command based on a version from before a tick is therefore `STALE`. This is deliberate: once ticks move trains, an operator must never act on authority computed from a superseded state.
- **Events:** command and tick events share one log and one `seq` counter. Every event records its `kind` (`command` or `tick`), the `version` and `timeMs` after it, and its outcome. Rejections and duplicates are logged and published exactly as for commands.
- **Atomicity:** a tick is all-or-nothing. If any part of a tick transition throws, the store keeps the previous state object and records nothing.

**Deterministic replay:** `replay(world, initial, inputs)` feeds an ordered list of `SimInput`s (`{ kind: "command", envelope }` or `{ kind: "tick", request }`) to a fresh store. The same world, initial state and inputs always give a deep-equal final state and a byte-identical event log. This holds because:

- `decide` and `decideTick` are pure;
- state is rebuilt by spreading in a fixed order;
- the store's only memory beyond the state is the set of processed command ids, which the input list also rebuilds.

Persisting the input list for recovery is still undecided (risk 3).

**Tick-transition contract for later phases:** `decideTick` advances the clock first, then runs `TICK_STAGES` in order. A `TickStage` receives the world and the state with the clock already advanced. It returns a new state and its change descriptions. It may not change `version` or `clock`; `decideTick` checks this and throws, which leaves the store unchanged. **`TICK_STAGES` is empty in P2.** Later stages (train movement, occupancy, timed release) must keep these safety expectations, which P2 records but does not implement:

- Unknown occupancy is never clear.
- Train movement validates the set route and the signal authority it is moving under.
- A train never passes a signal at danger.
- A train never enters a protected section unless the required route and points state are valid: set, locked, and detected.
- Stages run inside the same serialized transition, against the state left by the last command, so a train cannot move using stale authority. A stage must not cache state between ticks.
- A stage that finds a safety invariant broken must fail loudly (throw), not repair state quietly.

**Deferred to later phases:** train movement, occupancy changes, timetable playback (and its mapping of simulation time to dates and local times), route release (approach locking, time-of-operation and sectional release), a real-time tick driver, Socket.IO publishing, and persistence of the input list. Train movement and occupancy are added in P3, and approach locking and route release (as game rules; no sectional release) in P4, below.

### Trains, movement and occupancy (P3, D-032)

P3 moves explicitly placed trains through the existing pipeline. It adds no timetable spawning, route release, approach locking, aspect sequences or new infrastructure. None of it reproduces, certifies or proves the behaviour of any real interlocking, Carlisle's included.

**Distances** are integer millimetres. An edge's length is `round(lengthM × 1000)`.

- `lengthM` is computed by the OSM importer from the mapped geometry (haversine, rounded to 0.1 m). It is an approximation of mapped track, not a surveyed length.
- An edge with no `lengthM`, or a length below 1 mm, has an unknown footprint. No train may stand on it or enter it (`EDGE_LENGTH_UNKNOWN`). No length is ever estimated or defaulted.

**Train state** (`src/sim/train.ts`), in `AuthoritativeState.trains`, keyed by train id:

- `path`: the directed edges the train covers, from rear to head, as `{ edgeId, towardsNodeId }`. Each step must continue from the node the previous one leads to, on a different edge; a path never revisits an edge.
  - The path is stored rather than re-derived, because the track behind a train cannot be recovered uniquely from its head.
- `headOffsetMm`: how far the head is along the head edge, from the node it entered by. It is always between 1 mm and the edge's length. At the edge's length, the head stands at the far node; signals stand at nodes, so this is "standing at the signal".
- `lengthMm` (at least 1). The tail is the point `lengthMm` behind the head along `path`.
  - The path is kept minimal: its rear edge always holds some part of the train. After each movement, rear edges the train has left are trimmed.
- `speedMmPerS`: a constant integer speed. P3 has no acceleration or braking.
  - Each tick advances the train by `speedMmPerS × tickDurationMs / 1000` mm, using integer division. The remainder is carried in `residue` (0 to 999), so movement is exact over any number of ticks, with no rounding drift.
  - Advancing past the safe-integer range blocks the train (`MOVEMENT_OVERFLOW`).
- `authority`: the ids of the routes the train has taken, oldest first. A taken route is marked on the set route as `takenBy` the train.
- `stopped`: why the train last stopped (`{ code, at, reason }`), or null while it is free to move.

**Creation:** trains exist only in the initial state (`initialState(world, { trains })`). There is no command to add or remove a train; timetable spawning is P5.

- A placement is validated, and any problem throws, as an invalid clock does. Codes: `MALFORMED`, `DUPLICATE_TRAIN`, `UNKNOWN_EDGE`, `DISCONNECTED_PATH`, `EDGE_LENGTH_UNKNOWN`, `HEAD_OUTSIDE_EDGE`, `TRAIN_LONGER_THAN_PATH`, `PATH_LONGER_THAN_TRAIN`, `PASSAGE_NOT_PERMITTED`, `POINTS_NOT_PROVEN`, `SIGNAL_INSIDE_TRAIN`, `TRACK_OCCUPIED`.
- **Point passages under a placed train:** every passage through a node inside its path must be permitted by `TrackGraph.switchPassage` with the world's valid game rules. Points there must be detected in the position that passage needs.
- **Signals under a placed train:** a new train starts with no authority, so it may not straddle a signal facing its direction of travel, or a signal whose facing is unknown. It would have passed that signal at danger.
- **Store checks:** the `CommandStore` constructor re-checks every train's geometry, its authority references and the derived occupancy.

**Occupancy is derived, never set:**

- `trackStatus` holds what is known of each edge apart from simulated trains. It comes from the initial `occupancy` values, and nothing changes it in P3.
- `occupancy[e]` is `occupied` if any train's path contains `e`; otherwise it is `trackStatus[e]`.
- A train occupies every edge it covers any part of, from head to tail. This whole-edge rule is the existing per-edge policy. It is conservative, and it claims no real track-circuit or axle-counter boundary; no dataset has any.
- When a train leaves an edge, the edge returns to its `trackStatus`. An edge that was `unknown` before the train arrived is `unknown` again, never clear.
- `decide` reads the derived `occupancy`, so routes and points are checked against trains too.
- `deriveOccupancy` is the only producer. The store throws if any accepted transition leaves `occupancy` different from it.

**Movement authority:** a train moves only along routes it has taken.

- **Taking a route:** a train may take a set route when all of these hold:
  - the head stands at the route's start node: the entry signal's node, or a fringe entry's outside node;
  - the route's first edge continues from the head edge;
  - no other train has taken the route;
  - its data status (and its overlap's) is still allowed by the policy;
  - its entry signal (if any) is a main or shunting signal (P3.1, D-033; otherwise `ROUTE_NOT_ESTABLISHED`), and is `off`;
  - every required points is detected in the required position and locked by this route.
- **When it is taken:** the route is marked `takenBy` the train, and the entry signal returns to `on` (replacement on passing, a policy rule). So a following train sees danger, and a route can be used by one train only.
- **Fringe entries:** a route from a fringe entry has no signal. Its being set is the game's acceptance of the train (D-029).
- **Where a train can move:** the head may move only within the edges of its taken routes, in order. A train with no authority over its head edge cannot move, even within that edge.
- **The limit of authority** is the end of its last taken route: an exit signal, or a fringe exit's outside node. There the train stops, unless it can take the next route. Leaving play at a fringe exit is not modelled: the train stops at the cut's outside node.
- **No stale authority:** at every step, each route in `authority` must still be set and `takenBy` this train. Otherwise the train stops (`AUTHORITY_WITHDRAWN`).
  - Today a taken route cannot be cancelled while the train covers any of it, because cancelling needs clear track. This check is the second line of defence.

**Route state, allocation, aspect and authority (P3.1, D-033)** are four separate facts:

| Fact               | Where                  | Meaning                                                                                              |
| ------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| Route state        | `routes[id]` present   | Set: its points are locked and its track is reserved against conflicting routes                      |
| Allocation         | `routes[id].takenBy`   | Absent: the route is _offered_. Present: allocated to that train until the route is released (P4)    |
| Signal aspect      | `signals[id]`          | `off` exactly while the signal is the entry of one offered route                                     |
| Movement authority | `trains[id].authority` | The taken routes the train still covers. Only this lets a train move; an aspect never does by itself |

The lifecycle of a route with an entry signal:

1. **Set** (`set_route`): the route is offered, and the entry signal goes `off`.
   - The entry signal must be a main or shunting signal (`ROUTE_NOT_ESTABLISHED` otherwise). A signal of unknown function never authorises a movement, whatever the route's data status. The R2 assessment does not read signal functions; this check is the pipeline's.
   - A signal is `off` for at most one offered route (`ROUTE_CONFLICT`).
2. **Taken:** the train's head crosses the entry signal. In the same step, the route becomes `takenBy` the train, it joins the train's authority, and the signal returns to `on`. The crossing is checked against the state before replacement, and only that train, at that crossing, passes under that `off` aspect.
3. **Held:** the train keeps the route in its authority while any part of it, head to tail, covers one of the route's edges. A long train whose tail is still behind the signal keeps moving: signals are checked only where the head crosses.
4. **Consumed:** once the tail has left every edge of the route, it is dropped from the train's authority. Since P4 the route is then released by the `route-release` stage at the end of the same tick (below); in P3 it stayed set until cancelled.
5. **Cancelled** (`cancel_route`, on clear track only): only an offered route's entry signal is put back `on`; a taken route's signal is already `on`, and is left alone in case it has been cleared since for another route. Since P4 an offered route with a train approaching is approach locked instead of removed (below).
6. A following train can only take a route that is set anew after release or cancellation. Until then it stops at the entry signal (`SIGNAL_AT_DANGER`).

The `CommandStore` checks these invariants on every state it accepts (`routeSignalIssues`): every `off` signal is a worked stop signal and the entry of exactly one offered route, every offered route's entry signal is `off`, and every `takenBy` names an existing train. It throws, keeping its state, on any breach.

**At every node the head crosses**, from edge _a_ (arriving from node _p_) at node _N_ onto edge _b_ (leading to node _m_), these are checked in order:

1. `b` is the next edge of the authority, or the first edge of the route being taken. It must be a different edge incident to _N_; there is no reversal (`DISCONNECTED_PATH`, `NO_AUTHORITY`).
2. `TrackGraph.switchPassage(p, N, m, world game rules)` must give `through`, or `set` with the points detected in that position (`POINTS_NOT_PROVEN`) and locked by one of the train's routes (`POINTS_NOT_LOCKED`). `leg_to_leg` and `unresolved` are never passed (`PASSAGE_NOT_PERMITTED`). This is the same resolver route validation uses, and slip diagonals and untyped junctions stay impassable.
3. Every signal at _N_ that faces _m_, or whose facing is unknown, is checked by its movement role (P3.1, D-033; `SIGNAL_MOVEMENT_ROLE` in `src/sim/train.ts`), which follows from the source-derived `function`:
   - `worked_stop` (`main`, `shunting`): passed only if it is the entry signal of the route the train takes by this very crossing, and is `off`. At `on` the train stops (`SIGNAL_AT_DANGER`). If it is `off` but not for the route taken here, the train also stops (`NO_AUTHORITY`). An aspect alone never grants authority.
   - `no_stop` (`distant`, `repeater`): passed whatever its state. These functions have no stop indication. They never authorise a movement.
   - `always_stop` (`stop_board`, `other`, `unknown`): never passed (`SIGNAL_AT_DANGER`), and never authorise a movement. A signal whose function the data does not establish stays a stop.
   - A signal off the track graph (`trackNodeId` null) cannot be crossed, so it is not checked.
4. `b` has a known length (`EDGE_LENGTH_UNKNOWN`).
5. `b` is not in another train's path and its `trackStatus` is `clear` (`TRACK_OCCUPIED`, `TRACK_NOT_PROVEN_CLEAR`).

**How a train stops:** a train advances up to the first point it may not pass, and stops there with `stopped` set; its carried residue is dropped. That point is the end of its head edge, at a node.

- Trains stop instantly: there are no braking curves (policy `trainStopping: "instant"`). Because of this, a signal returned to danger ahead of a train always stops it before the signal.
- P4 adds approach locking as a one-edge game abstraction (below). That abstraction is sufficient only because stopping is instant: any braking model must widen the approach zone to braking distance in the same change.
- A stopped train's state is consistent: path, offset, occupancy and authority all describe one position. No head advances alone, and no tail is lost.
- A stop is not a rejected tick. The tick is accepted, the train records the stop, and a change line reports it whenever the stop reason changes.

**Tick-stage integration:** movement is the stage `train-movement` in `TICK_STAGES`. The P2 contract is made explicit, not removed:

- A `TickStage` is `{ name, writes, run }`. `writes` lists the state fields the stage may replace; it can never list `version` or `clock`.
- After each stage, `decideTick` checks that `version`, `clock` and every field not listed are the same objects as before. It also checks that `occupancy` is derived. Any breach throws, and the store keeps its state.
- `train-movement` writes `trains`, `occupancy`, `routes` (`takenBy` only) and `signals` (replacement only). It never writes `points` or `trackStatus`.
- (P4) `TICK_STAGES` is `[train-movement, route-release]`. `route-release` runs second and writes only `routes` (removing released routes).
- **Ordering:** trains are processed one at a time, in ascending id order (code-unit order).
  - Each train sees the state left by the trains before it, with occupancy re-derived after each one. So a later train can never enter track an earlier train has just occupied, or take a route an earlier train has just taken.
  - All of this happens inside the tick, after the commands before it and before the commands after it.
- The pipeline still owns `version`, `clock` and the event log. Movement changes are published with the accepted tick's event.

**Not modelled in P3 (known gaps):**

- **Movement:** reversing, shunting, coupling and splitting, trains leaving play, permissive working, speed limits, braking and acceleration.
- **Signalling:** aspects beyond `on`/`off` (distants and repeaters are passed whatever they show; shunting signals that may be passed at danger for some movements are treated as stop signals), and overlaps used by a moving train (trains stop at the exit signal, so an overlap is protected but entered only under the onward route). Approach locking and route release were added in P4 (below).
- **Overlaps and onward routes (found in the P3.1 review, D-033; resolved in P4, D-034):** route conflicts included overlap track, so a train standing at the exit signal of a route _with an overlap_ could never be given the onward route. P4 exempts an onward route from its predecessor's overlap track (below).

### Route lifecycle: approach locking and release (P4, D-034)

P4 adds approach locking and automatic route release to the existing pipeline and tick stages. It adds no command, no timetable spawning and no data. **Everything here is a game rule.** No dataset has an approach-locking distance, a release time, track circuits, overlaps or control tables, and Carlisle has none. The tests (`tests/routeLifecycle.test.ts`, `tests/carlisleRelease.test.ts`) prove that the model is internally consistent, not that it is faithful to Carlisle or any other real interlocking.

**Seven separate facts.** Each has one owner, and nothing is stored twice:

| Fact               | Where                                    | Meaning                                                                                                        |
| ------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Route setting      | `routes[id]` present                     | Set: its points are locked and its track (with overlap) is reserved against conflicting routes                 |
| Signal aspect      | `signals[id]`                            | `off` exactly while the signal is the entry of one _offered_ route                                             |
| Train association  | `routes[id].takenBy`                     | The train that took the route; fixed until the route is released                                               |
| Movement authority | `trains[id].authority`                   | The taken routes the train still covers. Only this lets a train move                                           |
| Occupation         | `occupancy` (derived)                    | Edges covered by any train's footprint, head to tail, or not proven clear apart from trains                    |
| Approach locking   | `routes[id].approachLock`                | `{ commandId, lockedAtMs }`: cancelled with a train approaching; protection kept, signal `on`                  |
| Release            | absence from `routes` after a tick stage | The route no longer exists: points unlocked, track unreserved. Nothing else changes. No signal is ever cleared |

**Phase** (`routePhase` in `src/sim/state.ts`) is derived from the fields, never stored: `offered` (no `takenBy`, no `approachLock`), `taken` (`takenBy`), `approach_locked` (`approachLock`). A route is never both taken and approach locked.

**State machine** of one route with an entry signal (a fringe-entry route is the same, with no signal):

```
              set_route                    train head crosses entry
  (absent) ──────────────► offered ────────────────────────────────► taken
     ▲  ▲  signal off          │ cancel_route                          │
     │  │                      │                                       │ tick: no train holds it or
     │  │  nothing approaching │  a train approaching                  │ covers its track (route-release)
     │  └──────────────────────┤  (signal on, protection kept)         │
     │      (signal on)        ▼                                       │
     │                  approach_locked ── tick: release time elapsed  │
     │                         │           or nothing approaching ─────┤
     └─────────────────────────┴───────────────────────────────────────┘
                     released: removed from routes; signals untouched
```

**When a train counts as approaching** (policy `approachLocking: "approach_edge"`, `approachReasons` in `src/sim/routeLifecycle.ts`):

- The _approach edges_ of a route are the edges that meet its start node (the entry signal's node, or a fringe entry's outside node), other than the route's first edge. This uses only the existing track graph.
- A train approaches when its **head** is on an approach edge and it is travelling towards the start node. Speed and stopped state do not matter: a train standing at the signal is approaching.
- An approach edge whose occupancy apart from trains (`trackStatus`) is `unknown` or `occupied` counts as approached. Unknown is never clear.
- A route whose start node is not known is always treated as approached.
- A train two or more edges back is **not** approaching, and neither is a train on an approach edge travelling away. This is safe only because trains stop instantly (`trainStopping: "instant"`). One edge is an abstraction: edges vary in length, and it claims no real distance. A braking model must replace it.

**Commands:**

- `set_route` is unchanged, except that an approach-locked route is refused with `ROUTE_APPROACH_LOCKED`, and only `offered` routes count for "a signal is `off` for at most one offered route". Approach-locked and taken routes still take part in every conflict and points-locking check, because they remain in `routes`.
- `cancel_route`, in order:
  - Not set: `ROUTE_NOT_SET`.
  - Approach locked: `ROUTE_APPROACH_LOCKED` (no second lock, no change).
  - Track (with overlap) not proven clear: `TRACK_OCCUPIED` / `TRACK_NOT_PROVEN_CLEAR`. A taken route always has a train on it, because otherwise it would have been released, so **a taken route is never cancelled**. Its train keeps its authority and runs on to the exit signal.
  - Offered, with nothing approaching: removed, and the signal is put `on`.
  - Offered, with a train approaching: the signal is put `on`, and the route stays in `routes` with `approachLock = { commandId, lockedAtMs: clock.timeMs }`. Its points stay locked and its track and overlap stay reserved.
  - Taken, on clear track: this is reachable only from a crafted state. The route is removed and the signal is left alone (the P3.1 fix).
- A repeated `cancel_route` with the same `commandId` is a `duplicate`: it returns the original result and makes no transition. A new `commandId` is `ROUTE_APPROACH_LOCKED` (while locked) or `ROUTE_NOT_SET` (after release). Rejections never change the version. There is no operator command to release a route early.

**The `route-release` tick stage** runs after `train-movement`, so it sees the positions movement has just produced. It writes only `routes`. In ascending route-id order:

- A **taken** route is released when no train lists it in its `authority`, no train covers any of its own edges (head to tail; a stopped train included), and every overlap edge covered by a train is covered under an onward route that train holds (`takenRouteHold`). The route and its overlap are released whole: there is no sectional release.
- An **approach-locked** route is released when `clock.timeMs − lockedAtMs ≥ policy.approachLockReleaseMs`, or when nothing approaches it any more (`approachLockHold`). The time is integer simulation milliseconds from the cancel command, so it is independent of the tick length.
- An **offered** route is never released by time: it stays until taken or cancelled.
- Change lines: `route <id> released: train <t> has cleared it`, `route <id> approach lock released: <n> ms since cancellation`, `route <id> approach lock released: nothing approaching`.
- Release never changes a signal, a train, the points or occupancy. A released route must be set again before its signal can clear.

**Overlaps:** an overlap is reserved with its route (conflicts and track checks) and is released with it.

- A route whose entry signal is the exit signal of another route does not conflict with that route on track that is _only_ in the other route's overlap (`onwardOverOverlap` in `src/sim/pipeline.ts`). The onward route continues over the overlap in the same direction. Opposed points there still conflict: swinging overlaps are not modelled. A train standing at the exit signal can therefore be given the onward route.
- There is no timed overlap release: a train standing at the exit signal keeps its route and overlap until it moves on.
- No dataset has overlaps; the rule is tested only with the synthetic overlap `ov1`.

**Safety invariants** (`routeSignalIssues`, checked by the `CommandStore` on its initial state and after every accepted command and tick; any breach throws and keeps the old state):

- Every `off` signal is a worked stop signal and the entry of exactly one offered route. An approach-locked or taken route never keeps its signal `off`.
- `takenBy` names an existing train; `approachLock` is never present together with `takenBy`.
- `lockedAtMs` is a non-negative safe integer, not after the clock.
- No train covers any track of an approach-locked route.
- `stateTrainIssues` still requires every route in a train's `authority` to be set and `takenBy` that train. So an approach-locked or released route can never be authority, and movement takes only `offered` routes.

**Determinism:** both stages are pure and iterate in ascending id order. Release depends only on the state after all trains have moved, so it does not depend on train id order (tested in both orders). Times are integers. Commands, ticks, versions, duplicates, stale checks and replay are unchanged, and replay of P4 inputs gives byte-identical logs.

**Not modelled (P4):**

- real approach-locking distances or braking;
- "train comes to a stand" release;
- sectional release, and overlap timed release or swinging overlaps;
- track circuits;
- re-setting an approach-locked route (refused);
- emergency or operator-forced release.

**Audit (P5, D-035):**

- The approach-lock release condition was traced and confirmed against this policy, with no change.
- The onward-over-overlap exemption now establishes its own relationship: the overlap must belong to the previous route's exit signal, and only the leading run of edges that the overlap and the onward route share from that signal is exempt. Any other shared edge conflicts (fail closed).
- Evidence and tests: `tests/p4Audit.test.ts`.

### Timetable services (P5, D-035)

P5 runs dated timetable services through the same store, tick and invariants. No command is added: services are created only by the session's frozen plan, and only tick stages change them. **Every rule here is a game rule over sourced timetable data.** None reproduces a real train describer, acceptance or fringe-box procedure.

**Operating time** (`src/sim/railwayTime.ts`):

- `SimWorld.timetable.base` fixes simulation time 0 as the UTC instant of the snapshot's window start (local `operatingDate windowStart`, D-026) in Europe/London.
- Simulation time stays integer milliseconds of elapsed time, so on a clock-change day the wall clock jumps and simulation time does not.
- Local times resolve through `Intl` with an explicit zone and the pure `Date.UTC`. Nothing reads the host zone, the system clock or a timer, so replay is unaffected.
- A nonexistent or ambiguous local time makes the service unsupported. It is never guessed.

**Plan, built once** (`src/sim/servicePlan.ts`; `createWorld({ ..., timetable: { snapshot, patterns, config } })`):

- Each snapshot service is matched against the valid service patterns (`service-patterns.json`).
  - The call before play, every area or deferred call, and the call after play must match one pattern exactly, including its platform and line checks.
  - It is then `representable`, or `approximated` if it has a timetabled stop in play, which the game does not enact.
  - Otherwise it is `unsupported` or `invalid`, with reason codes.
- Runnable services carry:
  - a deterministic train id;
  - a due time: the time at the timing point before play;
  - the route chain;
  - the session's train length and speed (game settings);
  - the entry placement: rear at the entry cut's outside node, head `lengthMm` along the entry route.
- Plan order: due time, then service id.

**State** (`AuthoritativeState.services`):

- Exactly the runnable services, each with `status` (`scheduled`, `pending`, `active`, `departed`), `waiting`, `enteredAtMs` and `departedAtMs`.
- A service train carries `TrainState.service`.
- `serviceIssues` is checked on every accepted state:
  - an active service has exactly its train;
  - no other service has a train;
  - times are ordered and not after the clock;
  - no other train uses a service train id.

**Stages** (`TICK_STAGES`): `train-movement`, `service-exit`, `route-release`, `service-entry`.

| Stage           | Writes                                      | Rule                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service-exit`  | `trains`, `occupancy`, `routes`, `services` | A service train holding its exit route, standing wholly on the exit cut edge with its head at the outside node (its tail past the cut's inside node), leaves play: it is removed, the routes it took are released, and the service becomes `departed`. Nothing beyond the cut is simulated. Placed trains (no service) still stop at the cut.                                                     |
| `service-entry` | `trains`, `occupancy`, `routes`, `services` | In plan order, a due `scheduled`/`pending` service enters only if its entry fringe route is set and offered, the route and its overlap have an allowed status, its points are detected and locked by it, every placement edge is proven clear, and `placementIssues` finds nothing. The new train takes the route at once (`takenBy`). Otherwise the service is `pending`, with the first reason. |

**Safety expectations kept:**

- A train never enters occupied or unproven track.
- A train never enters without a route the signaller set.
- A service never enters twice; a departed service never returns.
- A duplicate tick changes nothing.
- No signal or points are changed by a service stage.

Because entry needs an offered route, the signaller's route setting is the acceptance. A cancelled entry route leaves the service pending. The Carlisle south entry has no approach track, so cancelling it never approach locks.

**Not modelled (P5):** station stops and dwell, real train length, speed, formation or braking, associations, trains starting or ending in play, reversing, timetable-driven operators (AI), and any track beyond a cut.

**P6 additions (D-036):**

- **Traversable chains only.** `buildServicePlan` refuses a pattern whose route chain contains a signal that movement would never let the train pass (`routeChainBlockers`, code `ROUTE_CHAIN_BLOCKED`). It applies the same D-033 roles as `crossingProblem`, statically: inside each route, a facing worked stop signal other than the route's entry, or any always-stop signal, blocks the chain. Before P6 the planner checked only route status, entry placement and exit length, so a chain through an unknown-function signal (for example CE438) would have been counted as runnable and then held for ever.
- **Planned routing** (policy literal `serviceRouting: "planned_chain_only"`). Since P6 two routes may start at one signal (CE323: Down Main and goods line). A service train takes an offered route only if it is in its own plan's `routeIds`. Offered any other route, it does not move and stops with `ROUTE_NOT_PLANNED` (a new `StopCode`), and the route stays offered. To correct it, the signaller cancels (approach locked, as for any route with a train approaching) and sets the planned route. Without this rule, a misrouted service would reach a cut that is not its exit fringe and could never leave play. Placed trains (no service) still take any offered route, as in P3. A game rule; it claims nothing about how drivers or signallers handle a wrong route.
- **Alternative routes from one signal** must be declared conflicting (the validator already requires it for shared track). While one is approach locked, the other cannot be set, so the P4 early "nothing approaching" release remains unreachable on committed Carlisle data (`tests/p4Audit.test.ts`).

**P7 additions (D-037):**

- **Journeys ending beyond play.** A pattern may have no call after play (`after: null`) only if its journey ends in a deferred area that its exit fringe's cut leads into. Entry, movement and exit are unchanged: the train leaves play at the fringe as any service does, and the rest of the journey is not simulated. A service terminating inside play still never matches, because there is no termination lifecycle.
- **Points on incomplete junctions are never worked.** `decide` refuses `move_points` for Points on a junction the track graph classes `incomplete` (a two-edge switch, an untyped junction; D-025), with the new rejection code `POINTS_TOPOLOGY_INCOMPLETE`. Nothing changes, as with every rejection, for human and AI operators alike. Before P7 such Points could be "detected" in a position the model cannot interpret. Movement through those nodes was already impossible.
- **Known limit (unreachable):** `routeConflict` does not treat a junction node shared without a shared edge as a conflict. Validator C4 caps both routes of such a pair at `insufficient_evidence`, which the policy never clears. This check must be added before any crossing passage is modelled.

### Simulation policy (explicit assumptions)

`src/sim/policy.ts` holds the game's rules. They are SIMULATION ASSUMPTIONS, not real interlocking behaviour.

- **Owner decisions:**
  - `allowedRouteStatuses`: `evidenced` and `game_rule`. `insufficient_evidence` and `invalid` cannot be allowed, and `evidenced` alone is a valid, tighter setting.
  - `routeSettingMovesPoints: false`: operators move points first.
  - (P4) `approachLockReleaseMs`: the time release of an approach lock, a positive integer. The default of 120 000 ms is a game setting, not a sourced value.
- **Fixed fail-safe rules,** typed as literals so that no configuration can switch them off:
  - unknown occupancy is treated as occupied;
  - occupancy is held per edge;
  - points move and are detected instantly;
  - a route may be cancelled only on proven-clear track (`cancelRequiresClearTrack`); since P4, an offered route with a train approaching stays approach locked when cancelled;
  - (P4) a train approaches a route when its head is on an edge meeting the route's start node, travelling towards it, or that edge is not proven clear (`approachLocking: "approach_edge"`), a game abstraction;
  - (P4) a taken route is released whole, with its overlap, once no train holds it or covers its track (`routeRelease: "on_train_clearance"`);
  - (P3.1) a signal facing a train acts by its function (`signalAtOn: "stop_by_function"`): main and shunting signals stop it unless they are the `off` entry signal of the route it takes there; distants and repeaters do not stop it; stop boards and unknown functions always stop it. Only a main or shunting signal may be a route's entry (D-033);
  - (P3) a train passing a route's entry signal returns it to `on` (`signalReplacement: "on_passing"`);
  - (P3) trains stop instantly at the limit of their authority (`trainStopping: "instant"`);
  - (P3) track of unknown length is impassable (`unknownEdgeLength: "impassable"`);
  - (P6) a service train takes only routes of its planned chain (`serviceRouting: "planned_chain_only"`).

### Future multiplayer clients

- A Socket.IO server will implement `StatePublisher`. Clients will send envelopes and receive `StateUpdate`s.
- Each client renders only the authoritative state it receives. Client-side checks are for UX and never change state.
- Per-area filtering, reconnection (resynchronising from `version`) and persistence will be designed with the server work.

## Consequences

- One code path serves humans, AI and tests. The safety invariants are tested at the decision level (`tests/sim.test.ts`).
- Every real points lie is unknown, so any route over points is `insufficient_evidence` unless a `game-rules.json` rule configures the points (D-029). Such a route is at best `game_rule`. The safety harness uses labelled synthetic fixtures; since P1 (D-030) the Carlisle MVP set of 7 `game_rule` routes also runs through the pipeline in `tests/carlisleRoutes.test.ts`.
- Passing the harness does not certify, reproduce or prove the operational safety of any real interlocking.

## Risks and open decisions

1. **Not modelled:** real approach-locking distances and braking (P4 uses a one-edge game abstraction), sectional release, overlap timed release and swinging overlaps, point swing time and failure, signal aspects beyond on/off, flank-protection semantics beyond holding points, and train describers. Since P5: station stops, real train characteristics and associations.
2. **Session assignment:** how operators are assigned control areas (lobby, roles, takeover between human and AI) is undecided.
3. **Persistence:** whether the event log is persisted and used for replay or recovery is undecided.
4. **Conflicting commands:** concurrent submissions and ticks are serialised by the single store. Distributing it would need a new design.
5. **Points that are both flank and path for different routes:** these are locked by any holder. Real flank protection may be more permissive; no source defines it here.
6. **Carlisle:** the playable area is one proposed game area and all handovers are undecided (D-027). The route set is 8 labelled game routes: the 7 MVP routes on the WCML Up and Down Main (D-030) and the Caldew Jn goods-line route (D-036). There are no overlaps and no Up exit to the south (CE263, CE268 and CE438 have unknown functions).
7. **Ticks and STALE (P2):** because every tick raises the version, a networked client at a fast tick rate may see many `STALE` rejections. Whether to relax the stale check (for example, comparing only interlocking-relevant state, or letting a command rebase across ticks that changed nothing it depends on) is undecided. Any relaxation must still refuse commands whose authority has changed.
8. **Timetable entry time (P5):** a service is due at the fringe from its time at the timing point before play, so at Carlisle it reaches the station earlier than timetabled by the running time from Penrith. A sourced fringe or berth timing would replace this (D-035, I-013).
