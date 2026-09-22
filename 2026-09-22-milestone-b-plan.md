# Milestone B Persistent Playable Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the combat laboratory into a persistent playable loop: accounts, an authoritative server, a town with equipment, a shared bag with a loot filter, offline catch-up under the shared cap, and an away report. Exit criterion (layer-1 §2): players complete repeated hunt → understand → adjust → hunt cycles, and recovery and concurrency checks pass.

**Written:** 2026-09-22.

**Spec:** [Milestone B technical specification](2026-09-21-milestone-b-spec.md) and its four parts under [`docs/milestone-b/`](docs/milestone-b/). Read the index and the part a task belongs to before executing it. [Layer 1 design](layer-1-design.md) and the [Realm UI specification](2026-09-16-realm-ui-spec.md) outrank both.

**Architecture:** The same `@narok/sim` package that the laboratory and the balance CLI run now also runs on the server, which owns the clock. `apps/client` becomes a playback client with no engine in it; the milestone A laboratory moves to `apps/lab` and keeps its harness. Fastify and PostgreSQL hold accounts, progression, inventory and one checkpoint per account.

**Tech stack:** the milestone A stack plus Fastify, PostgreSQL, Drizzle, zod and argon2. Resolve compatible versions at bootstrap, save exact versions, commit the lockfile; do not copy unverified version guesses into configuration.

## Standing before execution

This plan is **not authorized to start**. Two things gate it:

1. **Milestone A's three open gates** ([spec §5](2026-09-21-milestone-b-spec.md)) — the five-tester placement experiment, the R64 visual sign-off, and the single-VPS concurrency target. A's results report says plainly: *before anything is added*, run the tester session and have a human do the visual checks. If the placement gate fails, layer-1 §13 requires simplifying or revising the grid before content is added, which changes task 10 and the formation half of every screen.
2. **Forty-two open decisions** ([spec §4](2026-09-21-milestone-b-spec.md)). Nine were settled or deferred by the owner on 2026-09-21 and are written into the tasks below as fixed. Five more are technical, take their part's recommendation, and are marked in place as `(assumes …; revisit if the owner decides otherwise)`. The rest block beta invitations or want a measurement, not the first line of code.

## Global constraints

- Implement milestone B only. The exclusions in [spec §2.2](2026-09-21-milestone-b-spec.md) hold: no extra maps or skills, no premium with any simulation effect, no trading, no materials, no payments.
- Written rules beat mockups. The correction table in the UI spec §9 is acceptance criteria, not advice.
- One simulation implementation. The server, the CLI and the lab all call `createSimulation()` from `@narok/sim`; no transition, formula, RNG draw or scheduler is reimplemented anywhere else.
- The client never asserts time, command time, ownership, entitlement or outcome. The server derives all of them.
- Never send a client an event whose authoritative timestamp has not elapsed, and never send a seed or PRNG state at all.
- The four ported stylesheets stay byte-identical and uneditable (R107, R113, and the new rulings in task 10). Anything the product needs goes in a labelled additions block.
- No number is invented. Every rate, threshold and price comes from layer-1 or is an explicitly open input; a task that needs an unsettled number stops and says so.
- Rulings continue the repository's single `Rnn` sequence: tasks 1–7 take **R114–R129**, tasks 8–11 take **R130–R139**, recorded next to the code they bind.

## Owner decisions written into these tasks

| Decision | Consequence in the plan |
|---|---|
| Stop returns to town; the encounter is abandoned; no resume | Task 3 keeps A's queue-clearing `stop`; task 9 deletes the Resume copy and makes the second control start a new hunt |
| Bag overflow loses the drop, audited; the hunt continues | Task 6 disposes at `finishEncounter` and writes `overflow-lost` |
| The first won encounter grants a fixed Uncommon item — one definition per class, one fixed bonus, no PRNG draw, identical for every account | Task 7 grants it idempotently; task 6 proves the draw sequence is byte-identical with and without the grant |
| Prices deferred | The NPC shop and potion purchase sequence last, behind a disabled flag; nothing else may depend on a price |
| The laboratory is kept | Task 8 moves it to `apps/lab` with its tests instead of deleting it |
| Bag, Character and Away port verbatim | Task 10 adds three more byte-identical sheets and their diff invariants |
| Two-handed weapons lock the off-hand | Task 7 enforces it in the equip command and in the schema |

## Test-first workflow

Unchanged from milestone A, and it is what made A's evidence trustworthy: within each task, separate test addition, red run, implementation, green run and commit. A task may contain several short edits; do not collapse the plan into one patch. Infrastructure commands may fail until installation completes — a test that then fails on missing behaviour is the useful red check.

Never describe a planned command as executed. Preserve actual failure output and measurements.

---

### Task 1: Wire protocol, server skeleton, accounts and the error taxonomy

**Files:** Create `packages/protocol/package.json`, `src/index.ts`, `src/codes.ts`, `src/rest.ts`, `src/ws.ts`, `src/public-state.ts`, `test/codes.test.ts`, `test/rest.test.ts`, `test/public-state.test.ts`; `apps/server/package.json`, `src/main.ts`, `src/app.ts`, `src/config.ts`, `src/errors.ts`, `src/plugins/{origin,session,rate-limit}.ts`, `src/auth/{password,sessions}.ts`, `src/routes/{auth,me}.ts`, `src/store/{ports,memory}.ts`, `test/{auth,origin,session,ownership,taxonomy,boundary}.test.ts`; update root `package.json` scripts.

**Interfaces:** `@narok/protocol` exports zod schemas for every REST pair in part 1 §3, the `ErrorCode` union and the `ErrorEnvelope` `{code, field, retryable, stateVersion?}` of part 1 §7, and the `ClientMessage`/`ServerMessage` unions of part 1 §3 (`hello`, `heartbeat`, `ack` / `frame`, `snapshot`, `report`, `error`), continuing the vocabulary of `apps/client/src/worker-contract.ts`. It declares its own wire schema for `PublicState`/`PublicActor` and imports `@narok/sim` at type level only, so no simulation structure reaches the wire (P-01, part 1 §1). `apps/server` exposes `createApp(deps)` over `AccountStore`/`SessionStore` ports; Task 2 substitutes the Drizzle adapter without touching this task's tests.

**Gates:** the server half of B-02 (no simulation dependency reaches the wire or the client), the stable-code precondition of B-20, the login leg of B-24.

- [ ] Add `packages/protocol` and `apps/server` as workspace members (the `pnpm-workspace.yaml` globs already match). Resolve compatible versions for Fastify and its cookie/websocket plugins, zod, argon2 and the PostgreSQL driver at bootstrap, install exact versions and commit the lockfile; do not copy unverified version guesses into configuration. Add a root `dev:server` script and extend `check` with the boundary scan below.
- [ ] Add the protocol tests before any schema: every request/response pair in part 1 §3 round-trips and rejects unknown keys; the exported `ErrorCode` set equals exactly the part 1 §7 table, with no member added and none missing.
- [ ] Add a type-level conformance test asserting the protocol `PublicState` schema is mutually assignable with `@narok/sim`'s `PublicState`, so P-17 is decided by the type checker and no runtime sim import exists.
- [ ] Add `test/auth.test.ts` before the routes: login rotates the session and invalidates the presented credential in the same transaction (P-09); a registration/login/reset run greps the captured log stream and every audit row for the submitted password and for the hash and finds neither (P-06); `INVALID_CREDENTIALS` never distinguishes unknown email from wrong password; register, login and admin-reset attempts refuse past their configured limit with `RATE_LIMITED` and `Retry-After` (P-13).
- [ ] Add `test/session.test.ts`: a valid session value presented in a query string, a request body or a WebSocket subprotocol is answered `UNAUTHENTICATED` (P-07); the cookie carries `httpOnly; Secure; SameSite=Lax`; expiry and revocation are re-checked per request and per heartbeat, not only at upgrade (P-11); a password change revokes every session row and closes every bound socket within one heartbeat interval (P-10).
- [ ] Add `test/origin.test.ts`: an allowed origin passes; a foreign origin and an absent `Origin` on a mutation and on the upgrade both return `FORBIDDEN_ORIGIN`, refused before any session lookup (P-08).
- [ ] Add `test/ownership.test.ts`: cross-account identifiers return `NOT_OWNED` and the body distinguishes nothing about whether the object exists (P-12). Cover one row per line of part 1 §2's "what the client may never assert" table: a client-supplied elapsed time or command timestamp is a validation error, and `expectedStateVersion` is read as a guard and never written as a value.
- [ ] Add `test/taxonomy.test.ts`: the set of codes emitted across the whole suite is a subset of the part 1 §7 table (P-39), and simulation codes map `WRONG_VERSION → CONTENT_VERSION_MISMATCH` with every other `SimErrorCode → INTERNAL` plus a fault capture (proposed default, part 1 §9 #14).
- [ ] Add `test/boundary.test.ts`: `apps/server` declares no simulation-shaped dependency other than `@narok/sim`/`@narok/data`, `packages/protocol` declares neither, and a source scan finds no `xorshift` or `advance` loop outside `packages/sim` (P-01).
- [ ] Run `pnpm test packages/protocol/test apps/server/test`; expect failures for the missing schemas, app factory and auth routes.
- [ ] Implement the protocol package first: one strict zod object per route exported with its inferred type, and the codes as a frozen tuple so the enumeration test has something to compare against. Implement the Fastify app as a factory taking its ports and configuration, reading no process state at import time.
- [ ] Validate at the boundary with the protocol schemas and translate every rejection into the envelope. `field` is a bounded diagnostic path in the style of `SimError.field`, never a serialized state, and the server returns no localized display text — the client localizes from the stable code (part 1 §3).
- [ ] Register the route table of part 1 §3 with its auth, guard and idempotency columns. `Idempotency-Key` and `expectedStateVersion` are parsed and carried here; they are enforced in Task 2. `POST /api/shop/buy` is registered behind a disabled flag answering `MAINTENANCE`, because prices are deferred and the shop sequences last (spec §4.0).
- [ ] Store passwords as argon2id with an algorithm tag beside the hash so rehash-on-login stays possible. Take the cost parameters from configuration and choose their values by measuring verification latency on the target VPS under the login rate limit, not in this plan (part 1 §9 #2).
- [ ] Make the session credential shape, lifetimes, socket-per-account bound and origin allowlist configuration that is logged at startup, each with a test driving the system past the bound and asserting the documented refusal rather than degradation (P-40, part 1 §9 #1, #7).
- [ ] Register invite-code redemption as an idempotent grant row so a code cannot be replayed (part 1 §9 #3); issuance belongs to the admin CLI and is not built here.
- [ ] Run `pnpm test packages/protocol/test apps/server/test` and `pnpm typecheck`; record the observed output.
- [ ] Commit the explicit protocol and server paths with message `feat: add wire protocol and authenticated server skeleton`.

### Task 2: PostgreSQL schema, migrations, transaction boundaries and idempotency

**Files:** Create `apps/server/drizzle.config.ts`, `src/db/schema.ts`, `src/db/client.ts`, `src/db/tx.ts`, `src/db/jobs.ts`, `src/db/repositories/{accounts,sessions,characters,items,presets,hunts,grants,audit,maintenance}.ts`, `apps/server/drizzle/*.sql`, `compose.dev.yml`, `test/{schema,concurrency,idempotency,checkpoint-column,migration}.test.ts`; demote `src/store/memory.ts` to a test double; add root `db:up`, `db:generate`, `db:migrate` scripts.

**Interfaces:** `withAccountTx(accountId, expectedStateVersion, fn)` is the only path that writes gameplay rows: it locks the `accounts` row, runs the body, asserts the version increment, writes `command_results` and `resource_audit`, and commits (P-19, P-20, P-25, P-27). `saveCheckpoint`/`loadCheckpoint` read the four version columns before any use and enforce the configured size cap. `runPeriodicJob(name, fn)` records a durable "last completed at" under an advisory lock (P-05).

**Gates:** B-26 (concurrency on one account); the idempotency half of B-15; the durable substrate B-25 and B-28 are later proved against.

- [ ] Add the constraint tests before the schema, one assertion per row of the part 1 §5 table: unique on `lower(email)`; `gold >= 0` and `bag_capacity >= 0`; `characters` unique `(account_id, slot)` with `slot` inside its documented range and `awarded_level <= level`; `stack_items.quantity >= 0`; one `hunts` row per account by primary key; `account_drop_protection.counter >= 0`; and exactly one `maintenance` row.
- [ ] Add the `items` constraint tests: the partial unique `(equipped_character_id, equipped_slot)` and the null-pairing check, which are also what make a two-handed weapon's forced-empty off-hand enforceable in the database (spec §4.0), plus `tradeable = false` during beta.
- [ ] Add the append-only test for `resource_audit`: revoke `UPDATE` and `DELETE` on it from the application role and assert the failure (part 1 §5).
- [ ] Add `test/concurrency.test.ts` before `tx.ts`: two simultaneous sells of the same item produce exactly one success and one `CONFLICT_STATE_VERSION` or `RULE_VIOLATION`, never two gold credits (P-19); a commit whose read version moved affects zero rows and aborts (P-20).
- [ ] Extend it for the settlement race: an account mutated mid-settlement causes the first worker result to be discarded rather than merged, with no reward from it reaching `resource_audit` (P-21); exhausted internal retries return `CONFLICT_STATE_VERSION` with `retryable: true` instead of looping, the attempt count and backoff being configuration (P-22, part 1 §9 #9); a client `expectedStateVersion` mismatch is never auto-retried, the staged draft survives and no points are spent (P-23).
- [ ] Add `test/idempotency.test.ts`: a duplicated equip and a duplicated purchase each mutate once and return the stored response; the same key with a different request hash returns `IDEMPOTENCY_KEY_REUSED` (P-25); repeating an onboarding or admin grant under the same `(account_id, grant_key)` is a no-op (P-36).
- [ ] Add `test/checkpoint-column.test.ts`: bytes read back from `hunts.checkpoint` are byte-identical to what `encodeSnapshot` produced, so the determinism tests keep their byte-equality (P-30) — (assumes `bytea` holding canonical JSON per part 1 §9 #6; revisit if the owner decides otherwise).
- [ ] Extend it for version and size discipline: a checkpoint whose four version columns do not match the deployed pins fails closed with `WRONG_VERSION` and the server substitutes nothing (P-28); a blob past the configured cap surfaces `INTERNAL` with a fault capture, never a truncation.
- [ ] Add the reward-identity test: identifiers derived from the hunt namespace plus reward sequence survive a replay after an induced crash and insert no duplicate audit rows under the unique `(accountId, rewardId)` constraint, with no UUID function involved (P-29).
- [ ] Add `test/migration.test.ts` for the runbook shape of part 1 §6: migrations apply cleanly to a copy of seeded data, and step 3 copies every `hunts.checkpoint` into `hunt_checkpoint_archive` with `captured_for = 'migration'` so the archive row count equals the hunt row count.
- [ ] Extend it for step 4: the HP/MP adjustment rule is applied inside migration and not at the next level-up — (assumes the current absolute value is preserved and clamped to the new maximum, the same rule for level-up, equip, respec and migration, per part 1 §9 #16 and part 3 §8 #12; revisit if the owner decides otherwise) — and an `input.placement` that no longer validates resets to the class-default formation through the exported `defaultPlacement`, with the account notified (part 2 §7 step 4).
- [ ] Run `pnpm db:up && pnpm db:migrate && pnpm test apps/server/test`; expect failures for the missing schema, transaction helper and repositories.
- [ ] Define the schema in Drizzle exactly as part 1 §5 tables it, generate the migration and commit the generated SQL. Every constraint is enforced in the database in addition to application validation.
- [ ] Implement `withAccountTx` once and make it the only writer: `SELECT ... FOR UPDATE` on `accounts` at `READ COMMITTED`, the lock being the writer token and its acquisition order the total order of concurrent commands for that account.

```sql
UPDATE accounts SET state_version = state_version + 1
WHERE id = $account AND state_version = $read;
```

- [ ] Bind T1–T4 to code paths and assert the binding. T1 commits auth alone and never touches `state_version`. T2 commits progression, items, stacks, gold, audit, drop protection, the `hunts` row with its version and anchor columns, `command_results` and the increment atomically. T3 reuses the T2 shape for the periodic live checkpoint, which is exactly why a town draft formed before it conflicts rather than being silently overwritten. T4 is T2 driven by the CLI under the freeze flag.
- [ ] Assert P-27 with an injected crash between worker completion and commit: no gameplay write occurs outside T2/T3/T4, no reward exists without its audit row, and no checkpoint exists without its progression.
- [ ] Re-run Task 1's auth suites unchanged against the Drizzle adapter and retire the in-memory store to a test double.
- [ ] Grant the one-time starter contents through the idempotent `account_grants` path, never through a direct gold or item write — (assumes idempotent per account and slot: potions on the first slot plus a character-bound, non-sellable starter weapon, per part 3 §8 #10; revisit if the owner decides otherwise).
- [ ] Implement the periodic sweeps of P-05 as named in-process timers with a durable per-job record and an advisory lock, and record in the runbook that scaling `api` past one instance requires revisiting this (part 1 §9 #11). Retention windows for `command_results`, `hunt_reports` and `resource_audit` are configuration with refusal tests, not constants chosen here (part 1 §9 #8).
- [ ] Run `pnpm db:migrate && pnpm test apps/server/test` and `pnpm check`; record the observed output. The executed restore drill and migration settlement (P-34, gate B-28) are evidence work and belong to the milestone's evidence task, not to this one.
- [ ] Commit the explicit schema, migration and repository paths with message `feat: persist accounts and hunts in versioned transactions`.

### Task 3: Authoritative hunt lifecycle, checkpoints, recovery and the socket protocol

**Files:** Create `apps/server/src/hunt/{envelope,clock,lifecycle,release}.ts`, `src/workers/{pool,segment}.ts`, `src/ws/socket.ts`, `src/routes/hunts.ts`, `test/{envelope,hunt-clock,lifecycle,release,ws-protocol,equivalence,recovery,faulted}.test.ts`; extend `packages/sim/src/types.ts`, `src/snapshot.ts` and `packages/sim/test/snapshot.test.ts` for the B stop vocabulary; extend `packages/protocol/src/ws.ts`.

**Interfaces:** `simTimeAt(envelope, wallMs): number` and the anchor arithmetic are pure and live in `src/hunt/clock.ts`, testable without a database. `encodeCheckpoint`/`decodeCheckpoint` wrap `encodeSnapshot`/`decodeSnapshot` unchanged and add the envelope of part 2 §2 (`envelopeVersion`, `accountId`, `huntId`, `generation`, `checkpointSeq`, `accountStateVersion`, `wallAnchorMs`, `simAnchorMs`, `pausedWallMs`, `lastSeenAt`, `offlineCapMs`, `rewardSeq`, `pendingRewards`, `pity`, the active and pending strategy and loot versions, `inventoryProjection`, `stopContext`); no second serialisation is invented. `runSegment(checkpoint, simTarget, options)` executes in a worker and returns a candidate only — it holds no transaction and cannot write (P-04).

**Gates:** B-08 (no future outcome, seed or PRNG state reaches a client), B-25 (recovery), the server half of B-29 (versions are never substituted for replay), B-30 (faulted hunt); the server halves of B-05, B-06 and B-07.

- [ ] Add `test/hunt-clock.test.ts` covering the anchor table of part 2 §3 as pure arithmetic, one case per step: start, connect, heartbeat, cadence persist, intervene, pause.
- [ ] Add `test/envelope.test.ts`: the envelope round-trips under full validation, extending the existing `snapshot.test.ts` coverage (B-L08); a checkpoint from another simulation version, content version, schema version or grid hash is refused by `assertCompatible` (B-L20, P-28).
- [ ] Add `test/equivalence.test.ts`: a fixture checkpoint advanced by the worker pool to sim time `T` produces byte-identical canonical `encode()` output to `tools/balance` advancing the same input to `T` under the same pins (P-03); a client-supplied snapshot is never accepted as account state on any gameplay route (P-02).
- [ ] Add `test/release.test.ts`: every released event satisfies `event.at <= releaseSimMs` and events are emitted in `(at, seq)` order, filtered by `event.at` and never by batch arrival (B-L06, part 2 §1 step 4); a client request for a later window is answered with what has elapsed and does not move the authoritative clock.
- [ ] Add `test/ws-protocol.test.ts` for the invariant failures: emitting a `seq` lower than the last for a generation, or an event past the released clock, raises `PROTOCOL` rather than being trimmed (P-16); a snapshot schema-compared against `PublicState` fails on any additional key and carries no seed, `rng`, `queue` or `pendingRewards` (P-17, B-08).
- [ ] Extend it for generation discipline: every server message carries `generation` and the domain sequence, both monotonic within a generation (P-14); a deliberately delayed pre-intervention frame delivered after an accepted apply contributes nothing (P-15); a `hello` whose generation differs or whose `lastSeq` is outside the retained window is answered with `snapshot`; unacknowledged output past its bound closes the socket with `BACKPRESSURE` (P-40); revoking a session mid-hunt stops frame delivery on the open socket (P-11).
- [ ] Add `test/lifecycle.test.ts` for start: an injected commit failure leaves no `hunts` row and no idempotency result (B-L01); start records `T0` as the server command time with `simAnchorMs = 0`, `generation = 1`, `rewardSeq = 0`, and draws the hunt seed as a CSPRNG nonzero u32 persisted in the checkpoint and never sent to a client (part 2 §9 #1).
- [ ] Extend it for precompute and cadence: the precomputed segment of part 2 §1 step 3 is held in memory only, discarded on any intervention, version change, recovery or superseding commit, and is never a reward source; the persist cadence and precompute horizon are configuration carrying the proposed defaults of part 2 §1, each with a refusal test.
- [ ] Extend it for worker discipline: N simultaneous reconnects for one account produce one coalesced worker job rather than a queue (P-24); a per-job budget reuses the engine's `maxScheduledEvents` yield and continuation chunks resume against the same absolute target, so the split invariant holds for free (part 2 §6).
- [ ] Assert the stop contract as the owner decided it (spec §4.0): stopping a hunt *is* the return to town, the in-progress encounter is abandoned, and the return consumes a simulated travel segment whose duration is a content constant added to `packages/data`, not a number chosen here.
- [ ] Test that contract exactly: the canonical encoding across stop differs only in `phase`, `stopReason`, `queue` and the travel segment's own time accrual, while `rng`, cooldowns, `metrics` including `wipes`, `encounterCount` and pity are byte-identical (B-L18); stopping neither activates a pending version nor resets account-scoped encounter accounting (B-L17); pity survives stop, town return, map change and recovery (B-L19).
- [ ] Record that there is no resume-capable pause, so A's queue-clearing `Simulation.stop` is reused exactly as it stands and only the presence pause of part 2 §3 accumulates `pausedWallMs`. Starting again allocates a new `huntId`, hence a new reward namespace, and takes its rules from the presets named on the start command — nothing activates implicitly.
- [ ] Add `test/recovery.test.ts`: killing the server mid-hunt and replaying from the durable checkpoint under the pinned versions commits each reward exactly once and never sources a reward from uncommitted precomputation (B-25, B-L07, P-27).
- [ ] Add `test/faulted.test.ts`: an injected invalid sim state rolls back the failing segment, keeps the last valid checkpoint, writes a `hunt_checkpoint_archive` row with `captured_for = 'fault'` plus the reproduction inputs, sets `status = 'faulted'` with `faulted_reason`, stops automatic retries, charges no wipe penalty, invents no town settlement, and answers every command but the explicit validated recovery with `HUNT_FAULTED` (P-38, B-30).
- [ ] Run `pnpm test apps/server/test packages/sim/test/snapshot.test.ts`; expect failures for the missing envelope, clock, release filter and socket.
- [ ] Implement the eight lifecycle steps of part 2 §1 as the contract states them, each mutating step inside `withAccountTx`, with `project(state)` plus `generation` and the event cursor as the only thing sent — never the seed, never the queue.
- [ ] Extend `packages/sim` once: `StopReason` becomes the closed union B needs — A's `'wipe-limit' | 'stalemate' | 'operator'` plus retreat and the party stop conditions of layer-1 §6.6 — validated by `decodeSnapshot`, which is what keeps a foreign snapshot out of a production account (part 2 §9 #5). `simulationVersion` moves to `'b1'` with that change; reaching the offline cap is not a stop. Task 4's activation hook lands inside the same unreleased `b1`, so no in-milestone checkpoint migration is needed.
- [ ] Run the server and sim suites and `pnpm typecheck`; record the observed output.
- [ ] Commit the explicit lifecycle, worker and socket paths with message `feat: run authoritative hunts over durable checkpoints`.

### Task 4: Offline settlement, command ordering, pending activation and away reports

**Files:** Create `apps/server/src/hunt/{settle,commands,pending,rewards}.ts`, `src/reports/away.ts`, `src/routes/reports.ts`, `test/{settle,commands,pending,rewards,away-report}.test.ts`; extend `packages/sim/src/lifecycle.ts` and `packages/sim/test/lifecycle.test.ts` with the activation hook; extend `src/routes/hunts.ts` with stop and strategy.

**Interfaces:** `settle(envelope, nowWall)` returns the credited segment, the re-anchored envelope and the drained rewards, and is pure over its inputs so the part 2 §3 worked example is a unit test. `applyCommand(account, command)` implements settle-then-apply with `(commandAtWall, receiveSeq)` ordering, `receiveSeq` allocated under the same lock that reads the account state version. `activatePending(state)` is the engine-side hook.

**Gates:** B-11 (an apply lands at an encounter boundary, never mid-fight), B-17 (the away report never double-credits), B-18 (offline and wall-clock semantics); the server halves of B-10 and B-14.

- [ ] Add `test/settle.test.ts` before `settle.ts`, over the arithmetic part 2 §3 states, all integer milliseconds:

```text
capCutoffWall      = previousLastSeenAt + offlineCapMs
eligibleCutoffWall = min(nowWall, capCutoffWall)
simTarget          = simAnchorMs + (eligibleCutoffWall - wallAnchorMs) - pausedWallMs
result             = advance(state, simTarget, { collect: 'summary' })
creditedSimMs      = result.state.nowMs - state.nowMs
```

- [ ] Assert the part 2 §3 worked example end to end: the credited duration, the stop wall instant computed from the **pre-settlement** anchors, and both uncovered intervals (B-L03). Credit is always the `state.nowMs` delta, never the requested horizon, because an engine stop condition ends accrual on its own.
- [ ] Assert the ordering settle → commit → refresh presence → re-anchor: a failure injected between settle and refresh leaves `lastSeenAt` at its previous value with the allowance intact (B-L02); re-anchoring to `nowWall` rather than to `eligibleCutoffWall` makes a second settlement after a wait credit zero (B-L04); settling twice at one instant is a no-op (B-L05).
- [ ] Assert presence semantics: a heartbeat is a settlement and not a bare presence write, and does not bump `generation`; presence is per account, so two tabs contend on one state version and cannot double-settle (B-18). Maintenance downtime is excluded from settled sim time and `lastSeenAt` advances by the downtime at resume, so an operator outage does not bill the player's allowance (P-31, part 2 §9 #10).
- [ ] Add `test/commands.test.ts`: two commands assigned the same `commandAtWall` apply in `receiveSeq` order, the second against the first's committed result, and client-supplied ordering hints and timestamps are ignored (B-L11); a mismatched `generation` or `accountStateVersion` is rejected recoverably with the current values and the checkpoint is unchanged (B-L12).
- [ ] Extend it for settle-then-apply: an invalid intent leaves its settlement committed, because settling is not conditional on the command being legal (B-L13); the command classes of part 2 §4 settle, bump generation and touch preset rows exactly as its table states — saving a preset changes no running hunt.
- [ ] Add `test/pending.test.ts` before the engine hook: `pendingStrategy.payload` is a deep validated copy taken at apply time, so a later edit to the same preset row does not mutate the queued snapshot (B-L14); a newer acknowledged apply replaces the pending one, at most one pending per hunt (B-L16); the projection exposes active and pending versions separately.
- [ ] Assert activation timing: it happens before the next encounter spawns, including after walking and resting, never mid-fight, and a control run proves the `rng` value is identical across activation and the recipe draw unchanged (B-L15, B-11) — (assumes one atomic activation of the whole payload at the next spawn, part 2 §9 #4; revisit if the owner decides otherwise).
- [ ] Test that decision's stated consequence with it: an activated payload whose `wipeLimit` is at or below `metrics.wipes` stops the hunt immediately with the ordinary `wipe-limit` reason, granting no free continuation and no recovery.
- [ ] Add `test/rewards.test.ts`: rewards are read from state and the `metrics` delta and never out of the returned events, so summary settlement and detailed live play credit the same thing, with the reward list asserted alongside state and RNG (B-L09); reward ids are `"<huntId>:<rewardSeq>"` allocated inside the transition and reproducible across a replay (B-L07, part 2 §9 #2).
- [ ] Extend it for carriers and counters: the bounded `pendingRewards` array drains at each commit and its cap forces a commit the way the work budget forces a yield, never dropping or altering state (part 2 §9 #8); pity counters live in the checkpoint with `account_drop_protection` as the derived index written in the same transaction and rewritten by a replay (part 2 §9 #3).
- [ ] Assert the two fixed owner decisions on the reward path (spec §4.0): a drop that does not fit the bag is lost and audited as lost, the hunt continues and no bag row is written; the first won encounter grants the fixed Uncommon item for the character's class through the idempotent grant path, identical for every account, with a test asserting the draw sequence is byte-identical with and without the grant because it consumes no PRNG.
- [ ] Add `test/away-report.test.ts`: the report is built from the committed deltas after the settlement commits, and opening, reopening or refreshing it credits nothing (B-17); time away and simulated duration are reported separately with the stop reason, and a cap-stopped accrual is reported as a cap rather than as a combat failure (part 2 §3, UI spec §8); the running, stopped, capped and bag-full states each render their own copy and actions; counts reconcile with inventory.
- [ ] Run `pnpm db:migrate && pnpm test apps/server/test packages/sim/test/lifecycle.test.ts`; expect failures for the missing settlement, command ordering and activation hook.
- [ ] Implement `settle.ts` as the quoted arithmetic, reading `offlineCapMs` from the checkpoint rather than from configuration at replay time, so a later cap change cannot rewrite settled history.
- [ ] Implement the activation hook at the top of `spawnEncounter` in `packages/sim/src/lifecycle.ts`, before `chooseRecipe` draws, so activation consumes no RNG and cannot reroll an encounter; it is a state-only change at an event boundary that already exists, so the split invariant is untouched.
- [ ] Implement the loot-filter apply so it affects only drops after the acknowledged cutoff and never retroactively, evaluated by the same evaluator the preview calls — (assumes a pure `packages/loot` imported by both server and client with one shared test vector, per spec §4.1 and part 4 §7; revisit if the owner decides otherwise).
- [ ] Run the settlement, command, pending, reward, away-report, lifecycle and invariant suites plus `pnpm check`; record the observed output, and record any measured settlement cost separately from the milestone A figures, which were measured on a workstation and not on the deployment host.
- [ ] Commit the explicit settlement, command and report paths with message `feat: settle offline progress and order authoritative commands`.

### Task 5: Equipment content, bonus pools, and loadout composition

**Files:** Extend `packages/data/src/types.ts`, `src/prototype.ts`, `src/validate.ts`; create `packages/data/test/items.test.ts`. Create `packages/sim/src/loadout.ts`, `packages/sim/test/loadout.test.ts`; extend `packages/sim/src/math.ts`, `test/math.test.ts`; re-pin `packages/sim/test/fixtures/one-hour-run.json`.

**Interfaces:** Produces `ItemDefinition`, `BonusDefinition`, `RolledBonus`, `Slot`, `Rarity`, `Handedness` exactly as Part 3 §1.2 declares them; `bonusCount(rarity)`; `resolveLoadout(items: ItemInstance[], content: Content): ResolvedLoadout`; `deriveCharacter({classId, level, allocated, loadout}): DerivedStats`. `derive`, `damage` and `effectiveHeal` keep their milestone A signatures; `DamageInput` gains optional `offenseBonusBp` and `resistBp`, both defaulted to 10,000. Consumers are tasks 6 and 7 and the server's town commands.

**Gates:** Closes the content half of **B-29** (item content is pinned by `content.version`, never substituted). Supplies the stat arithmetic **B-12** (comparison deltas) and **B-13** (eligibility fields) are proven against. Closes no client gate on its own.

- [ ] Add the composition tests before any implementation, in `packages/sim/test/loadout.test.ts`:

```ts
import { expect, test } from 'vitest';
import { content } from '@narok/data';
import { damage, derive } from '../src/math';
import { deriveCharacter, resolveLoadout } from '../src/loadout';
test('an empty loadout reproduces the class definition exactly', () => {
  const guardian = content.classes.guardian;
  expect(deriveCharacter({ classId: 'guardian', level: guardian.level,
    allocated: guardian.attributes, loadout: resolveLoadout([], content) }))
    .toEqual(derive(guardian));
});
test('defaulted bonus factors leave A-era damage bit-identical', () => {
  const a = { offense: 100, powerBp: 12000, elementBp: 10000, familyBp: 10000,
    varianceBp: 10000, critical: false, defense: 20, hit: true };
  expect(damage({ ...a, offenseBonusBp: 10000, resistBp: 10000 })).toBe(damage(a));
});
```

- [ ] Add `packages/data/test/items.test.ts` in the style of `content.test.ts`: mutate copies of the item table so a `fittingBonuses` entry is missing, a slot pool holds three distinct identities, a `spans` array is shorter than `ceil(maxMonsterLevel / 10)`, a non-weapon definition sets `basicIntervalMs`, and a `BonusKind` lacks a `stacking` rule. Each must throw `ContentError` with `code: 'INVALID_CONTENT'` and its exact field path. Add a fast-check property over generated legal item sets: `stacking: 'sum'` results are independent of item order and `stacking: 'max'` never exceeds the largest single value.
- [ ] Run `pnpm test packages/sim/test/loadout.test.ts packages/data/test/items.test.ts`; expect failures for the missing `resolveLoadout`/`deriveCharacter`/item-validation exports.
- [ ] Extend `Content` additively with `items`, `bonuses`, `rarities` (rolled-bonus counts 0/1/2/3/4 and Legendary `protected: true`, Part 3 §1.1) and `onboardingGrant`; extend `MonsterDefinition` with `equipment: string[]`, `consumables`, `dropMultiplier`, `goldMin`, `goldMax`. Author `goldMin = goldMax = rawGold` per monster so B's gold draw reproduces A's banked gold exactly; every other value (definitions, bonus spans, multipliers) is an **open content input** and no number is invented here. Keep `basePrice: number | null` and require `null` while the deferred-prices flag is off, so no placeholder price can reach a sale (spec §4.0: prices deferred).
- [ ] Write `validateItemContent` in `validate.ts`'s existing `fail(field, message)` style and call it from `validateContent`: `fittingBonuses` exist and list the definition's slot; every slot's eligible pool has at least four distinct identities (otherwise a Legendary of that slot is unrollable); `levelRequirement` matches the 1/10/20/30/40 tier ladder; `spans` covers `ceil(maxMonsterLevel / 10)` entries with `min <= max`; `basicIntervalMs`/`basicRange`/`basicKind` non-null exactly for `slot === 'weapon'`; every `BonusKind` in use has a `stacking` rule and a composition path below (Part 3 §1.5). Treat each family/element variant as its own bonus identity (assumes Part 3 §8 #2; revisit if the owner decides otherwise), and keep `valueTier = ceil(itemLevel / 10)` indexing `spans` (assumes §8 #3; revisit if the owner decides otherwise).
- [ ] Implement `resolveLoadout` (sum or max per declared `stacking`, class empty-slot defaults when no weapon is equipped, refuse an `offhand` occupied under a two-handed `weapon`) and compose through the existing `derive` rather than restating a formula:

```ts
const base = derive({ ...content.classes[classId], level,
  attributes: addAttributes(allocated, loadout.attributeBonus),
  weaponAtk: loadout.weaponAtk, weaponMatk: loadout.weaponMatk,
  armorDef: loadout.armorDef, armorMdef: loadout.armorMdef,
  basicIntervalMs: loadout.basicIntervalMs, basicRange: loadout.basicRange,
  basicKind: loadout.basicKind });
return { ...base,
  atk: scale(base.atk, loadout.atkBp), matk: scale(base.matk, loadout.matkBp),
  maxHp: scale(base.maxHp, loadout.maxHpBp),
  critBp: Math.min(10_000, base.critBp + loadout.critBpBonus),
  intervalMs: Math.max(300, Math.ceil((base.intervalMs * 10_000) / loadout.attackSpeedBp)) };
```

- [ ] In `math.ts`, insert `offenseBonusBp` between step 1 (skill power) and step 2 (element chart) and `resistBp` after family and before variance, each one floored `scale` step. Both default to 10,000, and `scale(x, 10000) === x` for integer `x`, so an unequipped call is unchanged.
- [ ] Add the remaining cases: two-handed occupancy refusal, duplicate bonus identity on one instance, value-tier indexing at item level 1 and at the band maximum, `max`-stacked versus `sum`-stacked composition, and monotonicity of `deriveCharacter` in `weaponAtk`. Run `pnpm test packages/data packages/sim`, then `pnpm build:data` twice and diff the generated module for byte equality, then `pnpm typecheck`.
- [ ] Re-pin `one-hour-run.json` with an explained update (layer-1 §12): **only `contentVersion` may change.** `simulationVersion`, `rng`, the 13,648-event count and every metrics field must be identical — a changed event stream means the extension was not additive; investigate rather than re-pin.
- [ ] Commit the data and math paths with message `feat: add equipment content model and loadout composition`.

### Task 6: Per-kill drops, pity plumbing, and the shared loot evaluator

**Files:** Create `packages/loot/{package.json,src/index.ts,src/types.ts,src/evaluate.ts}`, `packages/loot/test/evaluate.test.ts`, `packages/loot/test/vectors.json`. Create `packages/sim/src/rewards.ts`, `packages/sim/test/rewards.test.ts`; extend `packages/sim/src/{actions,lifecycle,types,state,validate-state}.ts`; extend `tools/balance/src/{types,csv,run}.ts` and `tools/balance/test/report.test.ts`.

**Interfaces:** `packages/loot` exports `evaluate(drop: DropDescriptor, preset: LootPreset): Disposition` where `Disposition = {action: 'keep'|'auto-sell'|'ignore', matched: 'protected'|{exception:number}|'default'}` — pure, no I/O, importing only `@narok/data` types, so the server, the simulation and the UI preview run one function (assumes spec §4.1's `packages/loot` recommendation; revisit if the owner decides otherwise). `packages/sim/src/rewards.ts` exports `bandFor(value: number, multiplier: number): Rarity | null`, `rollReward(state, monster, ctx): PendingReward | null` and `dispositionRewards(state, ctx): void`. `SimState.simulationVersion` becomes `'b1'`.

**Gates:** Closes the evaluator half of **B-14** (precedence rules, and the preview calling the same function the server applies). Supplies **B-25**'s reward identity (`"<huntId>:<rewardSeq>"`, idempotent on retry) and **B-17**'s drop counts. Keeps **B-08** green: no reward payload carries the seed or RNG state.

- [ ] Add `packages/sim/test/rewards.test.ts` first, pinning layer-1 §7.2's ppm ladder at every boundary:

```ts
import { expect, test } from 'vitest';
import { bandFor } from '../src/rewards';
test('the layer-1 ppm ladder is a total function at every boundary', () => {
  expect([0, 4_999].map((v) => bandFor(v, 1))).toEqual(['common', 'common']);
  expect(bandFor(5_000, 1)).toBe('uncommon');
  expect(bandFor(7_000, 1)).toBe('rare');
  expect(bandFor(7_500, 1)).toBe('epic');
  expect([7_600, 7_609].map((v) => bandFor(v, 1))).toEqual(['legendary', 'legendary']);
  expect([7_610, 999_999].map((v) => bandFor(v, 1))).toEqual([null, null]);
});
```

- [ ] Add the stream-independence property with fast-check: two states differing only in `bagState`, `lootPresetSnapshot` and `dropProtection` must reach the same `state.rng` and the same rolled rarity after the same kill (Part 3 §2.3 — disposition may vary, the roll may not). Add a draw-count test: a kill consumes the same number of draws whether or not a guarantee is pending.
- [ ] Add `packages/loot/test/evaluate.test.ts` driven by the committed `vectors.json`: a Legendary drop receives Keep and cannot be overridden into Auto-sell or Ignore by any exception or default; ordered exceptions match top to bottom, first match wins; the mandatory fallback gives every unmatched drop a disposition; each supported condition (category, slot, minimum rarity, minimum bonus count, bonus identity, minimum item level) matches and fails to match; material conditions are absent. The same vector file is the server preview's fixture in the client task, so drift becomes a failing test.
- [ ] Run `pnpm test packages/sim/test/rewards.test.ts packages/loot/test/evaluate.test.ts`; expect failures for the missing package and missing reward exports.
- [ ] Implement the fixed §2.2 draw sequence inside `processDeath` in `actions.ts`, at the point it already banks `kills`/`rawExp`/`rawGold`, consuming every step in order over canonically sorted lists: band draw at `drawBelow(state.rng, 1_000_000)` (always consumed), definition draw, `bonusCount(rarity)` identity-plus-value draw pairs with the chosen identity removed and the weight recomputed (fitting bonuses weight 2, others weight 1), consumable draw, gold draw over `[goldMin, goldMax]`:

```ts
const band = drawBelow(state.rng, 1_000_000); state.rng = band.state;
const natural = bandFor(band.value, monster.dropMultiplier);
const rarity = ctx.content.pity.guaranteeEnabled
  ? raiseToGuarantee(natural, state.dropProtection, ctx.content.pity) : natural;
```

- [ ] Ship pity **plumbing enabled and the guarantee disabled** (Part 3 §2.4): `content.pity.guaranteeEnabled` is false, counters `epicPlus` and `legendary` still accrue in the checkpoint and appear in metrics, an eligible opportunity is one enemy death whose monster has a non-empty equipment list and which produced a band draw, an award resets its own and every lower tier, and the higher tier wins when two are simultaneously due. No threshold is chosen here — thresholds and eligibility weighting are an open input resolved before expanded beta, not before B ships.
- [ ] Disposition at `finishEncounter`, never at death: walk `pendingRewards` in ascending `rewardSeq`, call `evaluate` with the checkpointed `lootPresetSnapshot`, place Keep into `bagState`, credit Auto-sell without consuming a slot, and on a Keep that does not fit **lose the drop**, emit a `drop-lost` domain event and record an `overflow-lost` audit reason; the hunt continues and never returns to town (spec §4.0). Consumable overflow opens a new stack when a slot is free and otherwise follows the same rule.
- [ ] Extend `SimState` with `nextRewardSeq`, `pendingRewards[]`, `dropProtection`, `lootPresetSnapshot` and `bagState` — the fields Part 2 §2 requires the checkpoint to carry — initialize them in `state.ts`, validate them in `validate-state.ts`, and move `simulationVersion` to `'b1'` so `decodeSnapshot` refuses an A-era snapshot. Auto-sell gold conversion stays behind the deferred-prices flag: until prices exist, an auto-sold item is counted, not priced.
- [ ] Extend `tools/balance` with `items_rolled_<rarity>`, `items_kept`, `items_autosold`, `drops_lost`, `first_drop_ms`, `first_drop_rarity`, `epic_wait_kills` and `legendary_wait_kills` appended to `CSV_COLUMNS` in that order; gold columns are added with prices, not here. Report waits per seed as distributions, never as a mean (layer-1 §12).
- [ ] Add the pity reset matrix, the scaled-band-sum-over-1,000,000 content rejection, the `'a1'` snapshot rejection, and a split-invariance test proving drops are identical whether a hunt is advanced in one segment or many. Run `pnpm test packages/loot packages/sim tools/balance` and `pnpm typecheck`, then re-pin `one-hour-run.json`: this time `simulationVersion`, `rng` and the event count all move; record the new values and the reason (drops consume draws in the kill handler).
- [ ] Commit the loot package, sim rewards and CLI columns with message `feat: roll deterministic drops and evaluate the loot filter`.

### Task 7: Town commands, progression, and the onboarding grant

**Files:** Create `packages/progression/{package.json,src/index.ts,src/levels.ts,src/allocation.ts,src/equip.ts,src/bag.ts}` and `packages/progression/test/{levels,allocation,equip,bag}.test.ts`. Extend `packages/data/src/prototype.ts` and `scripts/build-content.ts` (compiled EXP and point tables, `onboardingGrant`, potion definitions); extend `packages/sim/src/{lifecycle,rewards,types}.ts` and add `packages/sim/test/progression.test.ts`.

**Interfaces:** All pure, no I/O, imported by both the server's town commands and the simulation's mid-hunt level-ups: `expToNext(level)` reading the compiled table; `pointBudget(level): {statPoints, skillPoints}`; `statCost(from, to)`; `applyAllocation(character, delta, quotedCost)`; `equip(character, instance, bag)` / `unequip(...)`; `bagPlace(bag, instance)`; `consumePotion(bag, characterId, kind)`; `clampResources(current, max)`. Each returns `{ok: true, next}` or `{ok: false, code, field}`. Part 3 §5.3's six names are **rule identifiers, not wire codes**: map STALE_STATE to `CONFLICT_STATE_VERSION`, INVALID_INPUT to `VALIDATION`, and TOWN_ONLY / CAP_EXCEEDED / COST_MISMATCH / INSUFFICIENT_POINTS to `RULE_VIOLATION` with the rule name in `field`, so Part 1 P-39's bounded-code assertion still holds.

**Gates:** Closes the server/rule half of **B-13** (equip eligibility, two-handed, town-only) and **B-16** (allocation preview, reset, atomic commit, insufficient points, stale version). Supplies **B-19**'s corrected progression rules (one skill point per four levels; no EXP-loss path exists to grep for) and **B-12**'s comparison arithmetic. **B-15** stays open behind prices.

- [ ] Add `packages/progression/test/levels.test.ts` and `allocation.test.ts` before implementation, pinning the parent curves at the beta cap:

```ts
import { expect, test } from 'vitest';
import { pointBudget, statCost } from '../src/index';
test('the parent curves are exact at the beta cap', () => {
  expect(statCost(1, 99)).toBe(628);
  expect(pointBudget(50)).toEqual({ statPoints: 412, skillPoints: 13 });
  expect(pointBudget(1)).toEqual({ statPoints: 30, skillPoints: 1 });
});
```

- [ ] Add the staged-allocation property with fast-check: for any non-negative integer delta vector, `applyAllocation` either commits every point and the replayed cost equals the quoted cost, or commits **nothing** and returns one code — no partial spend, in the §5.3 order (version, town, non-negative, cap 99, replayed cost, affordability).
- [ ] Add `packages/progression/test/equip.test.ts`: under-level, wrong class, wrong slot and unowned refusals; a two-handed weapon auto-unequips the off-hand in town and **fails when the bag cannot hold what comes off** (spec §4.0); an equip while hunting is refused with the town-only rule; HP and MP are preserved absolute and clamped on every maximum change (assumes spec §4.1's option (a); revisit if the owner decides otherwise) — assert identically for level-up, equip, unequip and respec, and assert an equip that raises Max HP heals nothing.
- [ ] Run `pnpm test packages/progression`; expect failures for the missing package exports.
- [ ] Compile `floor(50 * level^2.2)` to level 50 and the per-level point grants into versioned content tables in `build-content.ts`; runtime reads the table and never evaluates the exponent (layer-1 §4.2, §5.3). Grant one skill point at creation and one at every fourth level reached (4, 8, …, 48); grant 30 stat points at creation and `3 + floor(L / 5)` on reaching each `L > 1`; track `awardedLevels` so a retry or migration grants exactly once.
- [ ] Split party EXP in integer basis points with a per-character `expCarry` in the checkpoint, so one long segment and many short ones award identically:

```ts
const shareBp = 10_000 + 1_000 * (members - 1);          // layer-1 §5.3
const per = Math.floor((monster.rawExp * shareBp) / (10_000 * members));
```

Members dead at the moment of the kill are ineligible and still counted in the divisor — their share is destroyed, with no EXP loss and no de-levelling (assumes Part 3 §8 #13; revisit if the owner decides otherwise).
- [ ] Run stat auto-spend inside the simulation from the checkpointed `autoSpendTemplate`, never a live account read: ordered build targets, affordability and the 99 cap validated, unaffordable points carried forward, `deriveCharacter` recomputed immediately, and resources clamped by the same rule. Auto-spend is available to every account with no entitlement check (layer-1 §5.5); skill points are always manual; template editing is town-only.
- [ ] Implement respec as free in town, refunding earned points only, granting no heal and duplicating no resource, and revalidating saved strategy presets: a rule referencing a now-rank-0 skill is **disabled, not deleted**, and the player is notified. Equipment eligibility depends on level and class only and is unchanged by a respec.
- [ ] Implement the onboarding grant as content plus an idempotent key, with no PRNG anywhere on the path: `onboardingGrant[classId]` names one fixed definition at rarity `uncommon`, item level 1, with one fixed bonus at a fixed authored value, identical for every account of that class (spec §4.0). It is attempted at the first settlement after the account's first won encounter under key `(accountId, 'onboarding:first-equipment:v1')`, consumes no `rewardSeq` and no pity opportunity, carries `source = {grantId}`, is excluded from every drop metric, and returns the existing instance id when repeated. A full bag defers the grant to the next settlement rather than losing it — a grant is not a drop, so §3.4's loss rule does not reach it (assumes this reading; revisit if the owner decides otherwise).
- [ ] Implement the starter kit idempotently on `(accountId, 'starter-kit', characterSlot)`: layer-1 §7.6's proposed 20 Small HP Potions on the first slot only, and a character-bound, non-sellable starter weapon per slot, so neither component can be cycled for value (assumes spec §4.1's recommendation; revisit if the owner decides otherwise).
- [ ] Implement bag operations against the 100-slot shared bag with 999-stack consumables and no slot cost for equipped items: place, stack, lock and unlock, and potion consumption resolved in ascending character id so two characters can never consume the same unit. Small HP Potion heals 25% of Max HP and Small MP Potion restores 20% of Max MP under the shared 10-second per-character potion cooldown (layer-1 §6.6, §7.6).
- [ ] Add death regression tests in `packages/sim/test/progression.test.ts`: a wipe moves no EXP, level, point or item field; the wipe limit defaults to 1 and is configurable 1–5 as a total, not extra retries; a single dead member after a won encounter revives at `max(1, floor(maxHp / 10))` with MP preserved. Run `pnpm test packages/progression packages/sim` and `pnpm check`.
- [ ] Do **not** add the NPC shop, potion purchase, sale price or bulk sale here. Prices are deferred (spec §4.0); they are planned last behind the prices flag, and nothing in tasks 5–7 may import a price.
- [ ] Commit the progression package, content tables and simulation hooks with message `feat: implement town equip, bag and progression rules`.

### Task 8: Split the laboratory into `apps/lab` and make `apps/client` engine-free

Owner decision (index §4.0): the laboratory is **kept**, in its own workspace, so `apps/client` stops shipping `@narok/sim`. Gate **B-02** is the test that this actually happened.

**Files:** Create `apps/lab/{package.json,index.html,vite.config.ts}`, `apps/lab/src/{main.tsx,LabApp.tsx}`, `apps/client/test/engine-free.test.ts`. Move with `git mv`: `apps/client/src/{experiment.worker.ts,worker-contract.ts,useExperiment.ts,exportSession.ts,BattlefieldView.tsx,Comparison.tsx,art-manifest.ts}` and `apps/client/src/hud/{LabStrip.tsx,RunsPanel.tsx}` to `apps/lab/src/`; `apps/client/test/{battlefield,comparison,experiment-worker,exportSession}.test.*` to `apps/lab/test/`. Update `apps/client/src/{App.tsx,main.tsx}`, `apps/client/package.json`, root `package.json`, `playwright.config.ts`, `e2e/laboratory.spec.ts`. Move `gridPosition`, `gridCoordinates`, `defaultPlacement` (`packages/sim/src/battlefield/grid.ts`) and `defaultStrategy` (`packages/sim/src/state.ts`) into `packages/data/src/`.

**Interfaces:** `apps/lab` depends on `@narok/client` (workspace) and `@narok/sim`; `apps/client` depends on neither `@narok/sim` at runtime nor `pixi.js`. `@narok/data` gains the pure position codec and the two content-derived default builders; `packages/sim/src/index.ts` re-exports all four unchanged, so every existing sim consumer and R106's letter are untouched.

- [ ] **Do not move `apps/client/src/{styles.css,strategy.css,setup.css}` or `apps/client/src/hud/**`.** R107's and R113's acceptance `diff` commands name those paths; moving a frozen sheet silently breaks the gate that guards it. `apps/lab` imports the HUD and the sheets from `@narok/client`; the dependency runs one way only and a cycle is a lint failure.
- [ ] Write `apps/client/test/engine-free.test.ts` first. Over every file under `apps/client/src/**` it asserts: no `import`/`export` from `@narok/sim` that is not `import type`/`export type`; no import of `pixi.js`; no import of any path under `apps/lab/`; and that `apps/client/package.json` lists `@narok/sim` only under `devDependencies`. The same assertions run in reverse over `apps/lab/src/**`, where the engine is allowed.

```ts
import { expect, test } from 'vitest';
test('apps/client imports @narok/sim type-only (B-02)', async () => {
  const offenders: string[] = [];
  for (const file of await clientSources()) {
    const text = await readFile(file, 'utf8');
    for (const line of text.split('\n'))
      if (/from '@narok\/sim'/.test(line) && !/^\s*(import|export) type\b/.test(line))
        offenders.push(`${file}: ${line.trim()}`);
  }
  expect(offenders).toEqual([]);
});
```

- [ ] Run `pnpm test apps/client/test/engine-free.test.ts`; expect failure naming today's five value importers — `src/experiment.worker.ts` (`createSimulation`, `createGrid`, `SimError`), `src/BattlefieldView.tsx` and `src/hud/{Battlefield,Compass}.tsx` (`gridCoordinates`), `src/ExperimentControls.tsx` (`defaultPlacement`, `defaultStrategy`, `gridPosition`).
- [ ] Move the four pure helpers into `packages/data` beside `shapeOffsets` and `GridConfig`; `packages/sim` imports them rather than redeclaring them, so there is one implementation and no copy. Record **R130**: the position codec and the content-derived defaults are content, not engine. R106's intent is unchanged — decoding stays out of the resolver, the strategy layer and the log — and its letter now reads "any component that draws a spatial view".
- [ ] Create the `apps/lab` workspace (already matched by `pnpm-workspace.yaml`'s `apps/*`) with `index.html` and `vite.config.ts` from the client's, its own entry, and the moved modules. `LabApp.tsx` is A's `App.tsx` composition: the ported HUD imported from `@narok/client`, plus `LabStrip`, `RunsPanel` and the session export. Add root scripts `"dev:lab"` and `"build:lab"` filtered to `@narok/lab`.
- [ ] Repoint `e2e/laboratory.spec.ts` at the lab preview: add a `playwright.config.ts` project `lab` with its own `webServer` on a distinct port, keeping the `chromium` project for the client. A's smoke passing unchanged is the proof the split lost no behaviour.
- [ ] Record **R131**: `apps/lab` may import `@narok/client`; `apps/client` may never import `apps/lab`; the frozen stylesheets never move.
- [ ] Run the full gate; all five must pass and both diffs must be empty:

```sh
pnpm check
pnpm --filter @narok/client build && pnpm --filter @narok/lab build
pnpm test:e2e
diff <(sed -n '11,764p' codex-examples/realm-refined/hunt.html) <(sed -n '1,754p' apps/client/src/styles.css)
diff <(sed -n '98,750p' codex-examples/realm-refined/strategy.html) <(sed -n '1,653p' apps/client/src/strategy.css)
```

- [ ] Commit with message `refactor: split the laboratory into apps/lab and free the client of the engine`.

### Task 9: Protocol client, server-owned clock, and the Hunt and Strategy command semantics

Gates **B-03**, **B-04**, **B-05**, **B-06**, **B-07**, **B-09**, **B-10**, and the client half of **B-08** and **B-23**. Consumes `packages/protocol` and `apps/server` from the earlier tasks.

**Files:** Create `apps/client/src/{protocol.ts,playback.ts,transport.ts,useHunt.ts,commands.ts}`; `apps/client/test/{playback.test.ts,use-hunt.test.tsx,hunt-commands.test.tsx,strategy-lifecycle.test.tsx}`; extend `apps/client/test/clock.test.ts`. Update `apps/client/src/{App.tsx,ExperimentControls.tsx,validation.ts,i18n.ts,locales/en.json,locales/pt-BR.json}`, `apps/client/src/hud/{OrdersPanel.tsx,CommandBar.tsx,ChatPanel.tsx,SetupOverlay.tsx}`, `apps/client/src/hud/strategy/*`.

**Interfaces:** `protocol.ts` is the client half of Part 1 §3's union — c→s `hello{lastGeneration?,lastSeq?}`, `heartbeat`, `ack{generation,seq}`; s→c `frame{generation,firstSeq,lastSeq,events[],state}`, `snapshot{generation,seq,state}`, `report{generation,reportId}`, `error{generation,code,field}` — validated against `@narok/protocol`'s schemas, with `STALE_GENERATION` and `PROTOCOL` keeping the meanings `worker-contract.ts` gave them and `BACKPRESSURE` added. `playback.ts` is pure: `reduce(view, message, nowMs): {view, effects}` with `Effect` one of `request-snapshot` or `ack`. `useHunt.ts` keeps `UseExperimentResult`'s field names — `{state, events, status, start, stop}` — so every `hud/*` prop type is unchanged. `clock.ts` is unmodified as a module.

- [ ] Write `apps/client/test/playback.test.ts` first, one case per rule of Part 4 §2, driving `reduce` by hand with no socket and no timer: an event with `at > horizon(clock, now)` is retained but never exposed to the view model (B-03); a frame below the highest observed `generation` changes nothing at all (B-05); a higher `generation` clears `events`, drops the pending queue, sets `resyncing`, emits `request-snapshot` and splices nothing onto the old history (B-05); a non-contiguous `seq` emits `request-snapshot` and invents no event (B-06); a `snapshot` replaces state wholesale, sets `simAnchorMs = releasedUntilMs` and `realAnchorMs = now`, and clears `events` (B-07); a payload carrying a `seed` or an `rng` field, or an event with `at > releasedUntilMs`, raises `PROTOCOL` instead of being dropped (B-08, client half); a frame with an empty `events` array returns the **same array reference** (R109, B-23); a horizon overrun yields `buffering`, holds the last frame and extrapolates nothing.

```ts
test('a newer generation resynchronises and never splices onto the old history', () => {
  const live = reduce(view, frame({ generation: 7, firstSeq: 1, lastSeq: 3 }), 1000).view;
  const next = reduce(live, frame({ generation: 8, firstSeq: 9, lastSeq: 9 }), 1100);
  expect(next.view.status).toBe('resyncing');
  expect(next.view.events).toEqual([]);
  expect(next.effects).toEqual([{ kind: 'request-snapshot', generation: 8 }]);
});
```

- [ ] Extend `apps/client/test/clock.test.ts` for B-04: at every speed in `ALLOWED_SPEEDS` the horizon trails released time by exactly `bufferMs`, and re-anchoring from a snapshot followed by a pause and a speed change never subtracts the buffer twice.
- [ ] Write `apps/client/test/use-hunt.test.tsx` against a hand-written fake socket implementing `protocol.ts`'s union — the substitution pattern `apps/lab/test/experiment-worker.test.ts` uses for the worker (R56): connect, `hello`, frames, a mid-hunt drop, reconnect delivering `report` then `snapshot`, and an assertion that the rendered log holds no duplicated or reordered event (B-07).
- [ ] Run `pnpm test apps/client/test/playback.test.ts apps/client/test/clock.test.ts apps/client/test/use-hunt.test.tsx`; expect failures for the absent `playback`, `protocol` and `useHunt` modules.
- [ ] Implement `playback.ts`, then `transport.ts` (one cookie-authenticated `/ws` socket, reconnect with backoff, `ack` up to the last applied `seq`, `heartbeat` on the configured interval), then `useHunt.ts` over both. The client never sends `advance`, and never derives elapsed time from `performance.now()` for anything but rendering: `clock.ts` paces frames only, anchored to the server's released clock.
- [ ] Apply the owner's Stop decision to the Hunt shell. Stop is a command (`POST /api/hunts/current/stop`) that returns to town and abandons the encounter; there is **no resume**. `hud/OrdersPanel.tsx` therefore carries Start hunt and Stop, each showing *pending* until acknowledged, and when the hunt is stopped the second control **starts a new hunt** — its label and helper copy say the previous encounter was abandoned and that the return consumed travel time. Delete the Pause and Resume affordances and their locale keys. `hunt-commands.test.tsx` asserts no client path pauses authoritative time and that neither locale carries a Resume string on the hunt path. Record **R132** for both halves.
- [ ] Record **R133**: R109's "any future publisher of a per-frame collection" now binds the socket handler, at the same 16.7 ms per-frame budget.
- [ ] Bind the panels R108 left out, now that the server publishes them: `ChatPanel`'s Loot tab returns bound to real loot events, and wallet, zone and bag occupancy bind to account state. Binding is allowed; inventing a row is still forbidden. `body[data-paused]` tracks the **authoritative** hunt status, not the playback state (R110): a buffering client is still hunting.
- [ ] Build the Strategy lifecycle the strategy port deferred to B, one test per row of Part 4 §3.2 in `strategy-lifecycle.test.tsx` (B-10): Edit mutates the draft only and marks it unsaved; Save preset clears the marker on acknowledgement, not on click; Apply next encounter saves and queues that exact version, pending until the server reports it active; Revert is local; Close with unsaved changes offers Keep editing / Discard / Save. Active and pending render separately; editing the saved preset after an apply does not mutate the queued snapshot; a newer acknowledged apply replaces pending; pending survives a reconnect; `CONFLICT_STATE_VERSION` renders as a recoverable conflict localised from the code. Three preset tabs, never four. R111, R112 and R113 bind every line: no transcribed coordinate, the SVG stays `aria-hidden` scenery over a `role="grid"` of buttons, and no rule inside `strategy.css` is edited.
- [ ] Keep `validation.ts` as pre-flight feedback only: every rejection the client renders comes from the server's stable code through `i18n.ts`, never from client English. Add a test that every code in `@narok/protocol`'s error union has an EN and a PT-BR message.
- [ ] Add the B-09 component cases: inspection issues no cast command; ready, active, cooldown, casting, unavailable and passive render distinctly with animation disabled; a passive is never a button; the waiting reason is the server's factual one with the cost or remaining time it names.
- [ ] Run `pnpm test apps/client`, `pnpm check`, and `pnpm --filter @narok/client build`.
- [ ] Commit with message `feat: play back the authoritative hunt and command it over the protocol`.

### Task 10: Port Bag, Character and Away verbatim, and build their screens

Owner decision (index §4.0): the three remaining sheets are **ported verbatim**, byte-identical and frozen under a new ruling, with additions confined to a labelled block. Gates **B-01** (extended to five sheets), **B-12**, **B-16**, **B-17**, **B-20**, and the client half of **B-13**, **B-14** and **B-15**. Every number in the three mockups is a fixture (UI spec §9) and none of them is copied into a component or a content table.

**Files:** Create `apps/client/src/{bag.css,character.css,away.css}`, `apps/client/src/town/{model.ts,BagScreen.tsx,FilterPane.tsx,ItemCompare.tsx,CharacterScreen.tsx,GearPane.tsx,AttributePane.tsx,SkillPane.tsx,AwayReport.tsx}`, `docs/realm-town-port.md`, `apps/client/test/{stylesheet-port.test.ts,town-model.test.ts,bag.test.tsx,character.test.tsx,away.test.tsx}`. Update `apps/client/src/{App.tsx,i18n.ts,locales/en.json,locales/pt-BR.json}` and `apps/client/test/i18n.test.ts`.

- [ ] Write `apps/client/test/stylesheet-port.test.ts` first: it shells all five `diff` invariants — the two in the port records plus the three below — and fails on any output, so CI covers B-01 without a hand-run command. The ranges below were measured on the working tree of 2026-09-22; re-measure each `<style>` block's bounds when the files are created and write the confirmed ranges into `docs/realm-town-port.md`:

```sh
diff <(sed -n '11,761p' codex-examples/realm-refined/bag.html)       <(sed -n '1,751p' apps/client/src/bag.css)
diff <(sed -n '11,822p' codex-examples/realm-refined/character.html) <(sed -n '1,812p' apps/client/src/character.css)
diff <(sed -n '11,713p' codex-examples/realm-refined/away.html)      <(sed -n '1,703p' apps/client/src/away.css)
```

- [ ] Add the collision case to the same file. Measured on the working tree, the three blocks share 94, 80 and 91 selectors with `styles.css:1-754`, of which 6, 10 and 8 rule bodies differ — including `:root` (character, away) and `.realm` (character). Loading all five sheets globally therefore **restyles Hunt**. The test asserts the Hunt route's computed `:root` tokens and `.realm` box are identical with and without each new sheet mounted. That is a loading rule, not a licence to edit: each sheet is imported by its own screen module, never by `main.tsx`, and every product-side addition goes in that file's labelled additions block after the frozen range.
- [ ] Run `pnpm test apps/client/test/stylesheet-port.test.ts`; expect failure — the three sheets do not exist.
- [ ] Extract each mockup's first `<style>` block byte-for-byte into its sheet, then write `docs/realm-town-port.md` with the confirmed ranges, the collision measurement, a per-region component map, and rulings **R134** (the three sheets are not editable — R107's words, applied to `bag.css`, `character.css` and `away.css`), **R135** (route-scoped loading, with the measured `:root`/`.realm` collision as its stated reason) and **R136** (R108 extends to the three screens: every panel is bound to real account state or left out — no placeholder rarity, price, stat or timeline row, including "for now").
- [ ] Write the screen tests before the screens. `bag.test.tsx` (B-12): search, category tab, sort, select, pin and unpin all functional; comparison against a real eligible character and a real equipped slot with signed deltas, restrictions and an empty-slot case; equip disabled while hunting with the "Return to town to equip" explanation and under-level stating both levels (B-13); a locked item excluded from bulk sale and its sale refused without an explicit unlock; a bulk-sale preview reconciled against the server response with every counter read from the one returned state (B-15). `town-model.test.ts` drives filter precedence through the shared `packages/loot` evaluator — locked excluded, Legendary protected, ordered exceptions first-match-wins, then the rarity or default rule with a mandatory fallback — and asserts the preview mutates no drop record (B-14). `character.test.tsx` (B-16): staged allocation showing unspent versus pending cost distinctly, per-control before/after preview, insufficient points, atomic commit, stale-state refresh-and-revalidate that never overspends and never silently discards the draft, a locked skill naming its missing prerequisites, and the skill-point curve read from content with no divisor literal in any component. `away.test.tsx` (B-17): time away and simulated duration separate; the three wipe counts distinct; the four states (running, stopped, capped, bag full) rendering the correct copy and action; a cap rendered as a cap and never as a combat failure; reopening or refreshing crediting nothing; the action state recomputed from current inventory after Manage bag.
- [ ] Run `pnpm test apps/client/test/bag.test.tsx apps/client/test/character.test.tsx apps/client/test/away.test.tsx apps/client/test/town-model.test.ts`; expect failures for the absent screens.
- [ ] Implement `town/model.ts` as the view-model adapter — the role `hud/model.ts` plays for Hunt — and the screens region by region in the mockups' own class vocabulary. Route them from `App.tsx`; Strategy stays the `SetupOverlay` panel R113 exists for. One coherent account state feeds Hunt, Bag, Character and Away, and the counters reconcile across them.
- [ ] Extend `apps/client/test/i18n.test.ts` to the three screens: EN and PT-BR expose exactly the same key set in both directions across all five screens (B-20), and neither locale carries EXP-loss, de-levelling, forecast, premium-cap, Materials, bag-expansion or fourth-preset copy.
- [ ] **Shop UI last, behind a flag.** Prices are deferred (index §4.0), so the NPC shop and potion purchase ship no route, no component and no price key. Add `VITE_FEATURE_SHOP`, default off, with a test asserting the built bundle contains no shop entry point while it is off. Nothing else in this task depends on it.
- [ ] Run `pnpm check` and `pnpm --filter @narok/client build`; all five `diff` invariants empty.
- [ ] Commit with message `feat: port the bag, character and away screens`.

### Task 11: CI, end-to-end evidence, the recovery and concurrency drills, and the results report

Gates **B-01**, **B-02** (bundle half), **B-18**, **B-19**, **B-21**, **B-22**, **B-23**, **B-24**, **B-25**, **B-26**, **B-27**, **B-28**, **B-29**, **B-30**. Milestone A's three gates are prerequisites and **stay open**: A-14's five-tester placement experiment, R64's visual sign-off and the single-VPS concurrency target. B-22 and B-27 are the B-shaped continuations of the second and third and **do not close them**; no step below may claim otherwise.

**Files:** Create `e2e/{hunt.spec.ts,town.spec.ts}`, `artifacts/{recovery-drill.mjs,concurrency-drill.mjs,load-accounts.mjs,town-shots.mjs,frame-budget.mjs}`, `artifacts/milestone-b-results.md`. Update `.github/workflows/ci.yml` and `playwright.config.ts`.

- [ ] Write the two e2e specs before wiring CI, against the built bundle and a real server with a real PostgreSQL, using accessible names read from the committed locale files at run time (the pattern `e2e/laboratory.spec.ts` established) and condition-based waits only — no `waitForTimeout` anywhere. The B-24 flow in both languages: register or log in, configure party and strategy, start hunt, observe elapsed released events, drop and reconnect, away report, return to hunt, stop, town, bag, character. Carry the negative assertions inline: no future event rendered, no Resume control, no literal cap string.
- [ ] Run `pnpm test:e2e` and fix the wiring, accessibility, protocol or localisation defects it exposes. Record the observed result; do not fabricate a red run for behaviour the earlier tasks already satisfy.
- [ ] Extend `.github/workflows/ci.yml` in its existing order (`install --frozen-lockfile`, `build:data`, `typecheck`, `lint`, `test`, Playwright browser, client build, e2e): add a PostgreSQL service and the server build, add `pnpm --filter @narok/lab build` with the `lab` Playwright project, and keep the stylesheet-port test in the unit run so B-01's five diffs gate every push. Node and pnpm stay pinned from `engines` and `packageManager`.
- [ ] B-02, bundle half: after the client build, grep `apps/client/dist/**` for the engine's entry symbols and record the command with its output. Task 8's lint rule covers the source; this covers what ships.
- [ ] B-19: grep the built bundle and both locale files for every forbidden concept in Part 4 §4 — premium cap, EXP loss, de-levelling, time-until-death, the two-level skill divisor, Materials, paid bag expansion, fourth preset, gallery, compare-original — and record the output. A human then reads the correction table against the running build; an agent cannot sign that half.
- [ ] Write the drills as scripts, so they are repeatable evidence rather than a transcript: `recovery-drill.mjs` kills the server mid-hunt, replays from the durable checkpoint under pinned versions, and asserts rewards committed exactly once with no uncommitted precomputation used as a reward source (B-25); `concurrency-drill.mjs` races a town mutation against a hunt settlement on one account and asserts one `state_version` wins, the loser retries against fresh state, and retried commands are idempotent (B-26). Both also cover B-29 (a content version change refetches content and invalidates the placement UI; the server never substitutes versions for replay) and B-30 (an injected invalid sim state faults the hunt, stops automatic retries, charges no wipe penalty, and the client offers only the explicit validated recovery action). B-18 rides the same server integration: settle before presence refresh, no retroactive accrual, time away and simulated duration reported separately, multiple tabs and repeated heartbeats.
- [ ] Run the evidence commands and record each one's exit status, headline result and raw output path:

```sh
pnpm check
pnpm --filter @narok/client build && pnpm --filter @narok/lab build
pnpm test:e2e
node artifacts/recovery-drill.mjs      artifacts/b25-recovery.json
node artifacts/concurrency-drill.mjs   artifacts/b26-concurrency.json
node artifacts/frame-budget.mjs        artifacts/b23-frames.json
node artifacts/load-accounts.mjs <concurrent-accounts> <hours> artifacts/b27-load.json
node artifacts/town-shots.mjs http://127.0.0.1:4173/ artifacts/town
```

- [ ] B-27: `load-accounts.mjs` extends `artifacts/batch-100.mjs`'s shape from bounded worker jobs to concurrent authenticated accounts with bounded worker queues, socket limits and output backpressure, and runs **on the target VPS**, recording p50/p95/p99 and peak RSS against stated hardware. If no VPS is available, run it on the workstation, label the numbers as workstation results, and leave the gate open — A's results file refuses to claim this one and B must not claim it either. `frame-budget.mjs` measures per-frame HUD cost under a live socket at the highest supported release rate against the 16.7 ms budget, by the method A used for R109's 44.4 ms and 3.85 ms figures.
- [ ] B-28: restore a backup into a clean database and application environment, settle a maintenance migration under pinned artifacts, and commit both transcripts.
- [ ] B-22: run `town-shots.mjs` (the `hud-shots.mjs` pattern extended to the three new routes) at 1440×900 and 1280×800 with the `clip-probe.mjs` overflow probe at 1100px, in EN and PT-BR, and commit the screenshots. The automated overflow assertion is necessary and not sufficient — a human looks at the pages. B-21 is a stated human observation of keyboard-only traversal of all five screens plus the automated focus-visibility and reduced-motion checks. Neither step, nor any combination of them, closes R64: that sign-off is the owner's, on A's two screens, and remains open.
- [ ] Write `artifacts/milestone-b-results.md` in the shape `artifacts/milestone-a-results.md` established: the build under test (commit, `simulationVersion`, `contentVersion`, `gridHash`, Node and pnpm versions, working-tree state); every correctness command in the repo-relative form a reader would type, with exit status, headline result and raw output path; what CI runs and whether a green run was observed; every defect this run exposed, with measured blast radius, fix commit and the evidence the fix changed no behaviour; the coverage map B-01…B-30, each row green, partly open or open with its evidence named; performance split into workstation and **target VPS** sections with hardware metadata; the B-22 screenshots and the B-21, B-25 and B-26 transcripts; the open gates, each naming who can close it; the status of the three carried milestone A prerequisites (A-14, R64, §6.5) stated as open, with the shop UI listed as deferred behind its flag; raw artifact paths; and a retain/simplify recommendation scoped to what was actually measured. No fabricated measurement, no figure copied from a spec as though observed, and no gate asserted as passed by the report itself.
- [ ] Commit CI, the e2e specs, the drill harnesses, the screenshots and the results report with message `test: verify the milestone B client and record the evidence run`. Do not commit raw load dumps or secrets.

**Ruling numbers.** Tasks 8–11 record their rulings in `.superpowers/sdd/2026-09-21-milestone-b-plan/task-N-rulings.md` and in the port record each one binds, reserving **R130–R139** so tasks 1–7 can take R114–R129 without collision. R130–R136 are allocated above; renumber only if tasks 1–7 overrun their band.

---

## Coverage and acceptance map

Gate ids are [part 4 §6](docs/milestone-b/04-client.md)'s `B-01`–`B-30`. A gate is closed by evidence,
not by a task being finished.

| Gate | Tasks | Evidence |
|---|---|---|
| B-01 ported stylesheets unchanged | 10 | five `diff` commands print nothing, in CI |
| B-02 the client runs no simulation | 8, 9, 11 | source lint plus a grep over the built bundle |
| B-03–B-07 playback, generation and reconnect | 3, 9 | fake-socket integration and clock unit tests |
| B-08 no future outcome or seed released | 3, 9 | server release filter test; schema assertion over every payload |
| B-09 hunt skill states and inspection | 9 | component tests with animation disabled |
| B-10, B-11 strategy draft, apply, activation boundary | 4, 9 | server settle-then-apply test; component tests per row |
| B-12, B-13 bag interaction, equip eligibility | 7, 10 | evaluator and command tests both sides |
| B-14 loot filter precedence and preview | 6, 10 | shared `packages/loot` vectors asserted by both runtimes |
| B-15 bulk sale | 2, 10 | idempotency test; blocked behind prices until they exist |
| B-16 allocation and skills | 7, 10 | staged apply, reset, stale version, repeat submission |
| B-17 away report never double-credits | 4, 10 | reopen and refresh credit nothing; counts reconcile |
| B-18 offline and wall-clock semantics | 4, 11 | settle before presence; separate time-away and simulated duration |
| B-19 no corrected mockup content ships | 7, 10, 11 | grep of bundle and locales, plus a human read of the correction table |
| B-20 localisation | 10, 11 | key parity both directions; PT-BR end-to-end run |
| B-21 accessibility | 10, 11 | keyboard traversal recorded as a human observation |
| B-22 visual composition of the three new screens | 10, 11 | committed screenshots — **does not close R64** |
| B-23 frame budget and R109 | 9, 11 | measured per-frame cost under a live socket |
| B-24 end-to-end smoke | 1, 11 | Playwright against the built bundle and a real server |
| B-25 recovery | 2, 3, 11 | kill mid-hunt, replay from the durable checkpoint, rewards once |
| B-26 concurrency | 2, 11 | town mutation racing a settlement on one account |
| B-27 load on the target VPS | 11 | run on the VPS — **does not close the §6.5 concurrency gate** |
| B-28 backup restore and migration settlement | 2, 11 | restore into a clean database; settle under pinned artifacts |
| B-29 content mismatch | 5, 3, 11 | client refetches; server never substitutes a version |
| B-30 faulted hunt | 3, 11 | injected invalid state faults the hunt and charges no wipe |

## Execution handoff

This packet is documentation. When execution is authorized, run it task by task with review between
tasks, reading the spec part a task belongs to first. Two standing rules from milestone A carry over
unchanged: report real evidence, and name every gate that stays open — including the three carried
from A, which no task here can close.

`artifacts/milestone-b-results.md` is written during task 11 in the shape
[`artifacts/milestone-a-results.md`](artifacts/milestone-a-results.md) established, and it is the
only place a gate may be called closed.
