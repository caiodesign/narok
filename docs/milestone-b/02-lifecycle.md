# Part 2 — Authoritative hunt lifecycle, offline settlement and commands

Part of the [milestone B technical specification](../../2026-09-21-milestone-b-spec.md). **Draft, 2026-09-21** —
not accepted; the open decisions at the end of this part are the owner's and nothing here is
implementable until they are recorded. [Layer 1 design](../../layer-1-design.md) and the
[Realm UI specification](../../2026-09-16-realm-ui-spec.md) outrank this document.

Section numbers below are local to this part; cross-part references name the part. Requirement ids in this part are `B-Lnn`.

> **Superseded passages (milestone B Task 11 sweep, 2026-10-02).** The owner decision of 2026-09-30
> (Task 7c, rulings R151–R156; [part 3 §5.6's superseded block](03-town.md)) removed the wipe limit
> and the respawn, and made every return to town a full heal. The text below is kept as written and
> marked where it no longer holds:
>
> - §2's checkpoint table — `input.wipeLimit` and "wipe limit" in *Inputs*, "respawn state" in
>   *Encounter*: no such input or state exists. A full wipe ends the hunt with stop reason `wipe`
>   (R154).
> - §2's `stopContext` row and §4's / §9 #5's **stop reason vocabulary** — A's `'wipe-limit'` is gone;
>   the shipped union is `'wipe' | 'stalemate' | 'operator' | 'retreat' | 'potion-floor'`
>   (`packages/sim`, Task 7c).
> - §3's worked example — the engine stop at `46,000,000` would carry reason `wipe`, not `wipe-limit`;
>   the arithmetic is unchanged.
> - §4's and §9 #4's **pending activation boundary** — "wipe limit" is no longer a party-scope
>   setting, and the consequence "activating a `wipeLimit` at or below `metrics.wipes` stops the hunt"
>   has nothing left to govern.
> - §5's transition table — the *Stop* row's "never grants: heal" and the *Retreat* row's "recovery
>   of any kind on arrival" no longer hold: every return to town heals the whole party, living or
>   dead, to full HP and MP (R155). The *Wipe → respawn* row is struck: there is no respawn. The
>   *Resume* row and §9 #6 were already superseded by the owner's 2026-09-21 decision recorded in §5
>   (Stop returns to town; there is no Resume).
> - Shipped, for the record: a new hunt's first generation is one past the account's last
>   (ruling R198, Task 11), not a literal `generation=1` as §1 step 1 states — `1` holds only for an
>   account's first hunt. §2 already makes `generation` monotonic; this keeps it so across hunts.
> - Shipped, for the record: §7's maintenance sequence runs as an offline operator command,
>   `apps/server/src/ops/maintenance.ts` (`freeze`, `settle`, `resume`; ruling R199, Task 11). Steps
>   2, 3 (settle under the pinned artifacts, persist) and 5 (resume with new anchors, downtime not
>   billed) are wired; step 1's command refusal while frozen is not — the freeze is a stopped `api`
>   process — and step 4's content transform has no migration to run in B.

Milestone A built a pure, deterministic engine with no clock and no I/O (contracts §1). This section adds the authoritative envelope around it: who calls `advance`, with which target, what is written, what is sent, and in which order. It extends the A contracts and must not break them — every rule here is expressible as an envelope field, a call order, or a transaction boundary, never as a change to a transition A already proved.

Vocabulary used throughout. **Sim time** is `state.nowMs`, integer milliseconds from the hunt's own origin (`startState` sets `nowMs: 0` and `rng: input.seed`, `packages/sim/src/state.ts`). **Wall time** is integer milliseconds UTC, read only by `apps/server`. **Segment** is one committed `advance` interval. **Generation** is the hunt's intervention counter; it increments on every authoritative mutation of hunt rules or lifecycle state, never on a plain settlement. `packages/sim` still reads no wall clock, no `Math.random()`, and no database (layer-1 §4.1); all wall arithmetic in this section belongs to the server.

### 1. The eight lifecycle steps

Each step is a contract: preconditions, ordered operations, writes, sends, failure behaviour (layer-1 §4.4). Every mutating step runs inside the account mutation sequence of layer-1 §8.1 — read a coherent versioned snapshot and record the server command time, simulate outside the transaction, then a short transaction that locks/checks the account state version and commits progression, resources, reward/audit rows, checkpoint, version increment and idempotency result atomically.

| Step | Preconditions | Ordered operations | Writes | Sends | Failure |
|---|---|---|---|---|---|
| **1. Start** | Valid session; ownership of every referenced character, preset and item; no active hunt (layer-1 §5.1); party, map, strategy, placement and inventory validate; content and simulation versions pinned | Record `T0` = server command time → build the validated hunt input → `start(input)` (sim time 0) → build the envelope of §2 with `wallAnchorMs=T0`, `simAnchorMs=0`, `lastSeenAt=T0`, `generation=1`, `rewardSeq=0` → short transaction: check account state version, insert `hunts`, reserve consumables, bump version, store idempotency result | `hunts` row with the complete checkpoint; `command_results`; `resource_audit` for anything reserved | `project(state)` plus `generation` and the event cursor; never the seed, never the queue | `SimError INVALID_INPUT`/`INVALID_CONTENT` → stable error code, no row written; version conflict → retry from fresh state, bounded retries (layer-1 §8.1) |
| **2. Connect / reconnect** | Valid session; a hunt row exists | Read the hunt and `previousLastSeenAt` **before** touching presence → settle per §3 with `collect: 'summary'` → commit settlement → **then** refresh `lastSeenAt`/presence and re-anchor → build the away report from the committed deltas → send | Checkpoint, rewards, resources, audit, `hunt_reports`, presence | Away report, current `PublicState`, `generation`, event cursor | Settlement failure aborts before the presence refresh, so the allowance is not burned; the client retries and settles the same window; socket authorisation is re-checked, not assumed from the upgrade (layer-1 §8.3) |
| **3. Precompute** | A live connection; hunt running | Clone the committed checkpoint → `advance` on the clone to roughly +30 s (proposed default, layer-1 §4.4) → hold in memory only | Nothing durable | Nothing | Discard on any intervention, version change, recovery, or checkpoint commit that supersedes it; a precomputed segment is never a source of rewards (layer-1 §4.4 step 8) |
| **4. Release** | Precomputed or live events exist | Compute `releaseSimMs = simTimeAt(now)` (§3) → emit only events with `event.at <= releaseSimMs`, in `(at, seq)` order, tagged with `generation` | Nothing | Domain events; no future damage, death, loot roll or reward | Filtering is by `event.at`, never by batch arrival; a client request for a later window is answered with what has elapsed and does not move the authoritative clock (layer-1 §4.4 step 5) |
| **5. Playback** | Client holds a snapshot and cursor | Client renders roughly 2 s behind the released frontier (proposed default, layer-1 §4.4), exactly as the laboratory clock already does with its constant 2,000 ms buffer (A spec §11) | Nothing | Nothing | A stale `generation` invalidates the local queue; the client discards it and resynchronises from a current snapshot (layer-1 §4.4) |
| **6. Persist** | Hunt running; committed checkpoint is older than the cadence or an authoritative mutation is imminent | Settle to `simTimeAt(commitTime)` → one transaction: checkpoint, rewards for exactly that segment, inventory/gold deltas, audit rows, `checkpointSeq += 1`, account state version | All of the above, atomically | Nothing required | Cadence is approximately 20 s (proposed default, layer-1 §4.4 step 6); a failed commit leaves the previous checkpoint durable and the segment is re-simulated from it, producing identical rewards and identical reward ids (§2) |
| **7. Intervene** | A validated command with an idempotency key and an expected generation/account version | Record `commandAtWall` → settle to that instant and commit → validate the intent against the **settled** state → apply → new checkpoint, `generation += 1` → discard the private precomputation | Checkpoint with the applied intent; `command_results` | Acknowledgement carrying the new `generation`, the resulting active/pending versions, and a fresh snapshot | Stale expectations → recoverable conflict code (UI spec §5); invalid intent → stable error code and the settlement still stands, because settling is not conditional on the command being legal |
| **8. Recover** | Process restart, crash, or a faulted segment | Load the last durable checkpoint → rebind the **pinned** simulation and content versions from the envelope → replay forward from it | Only the re-committed segment | Snapshot after recovery | `advance` refuses a mismatched state with `WRONG_VERSION` (`assertCompatible`, `packages/sim/src/advance.ts`), so a replay under whatever content is deployed now is impossible by construction; an invalid state faults the hunt, preserves the last valid checkpoint and reproduction inputs, and stops automatic retries (layer-1 §11) |

Transport invariant: every protocol message carries the hunt `generation` and an event sequence, so events produced before an intervention are never played after it (layer-1 §4.4).

### 2. The checkpoint schema

A B checkpoint is `SimState` plus an envelope. The `SimState` half is already complete and already serialised: `encodeSnapshot` writes canonical JSON with recursively sorted keys and the queue in `compareScheduled` order, so equal states produce byte-identical text, and `decodeSnapshot` performs full runtime validation behind a 1 MiB input cap (`packages/sim/src/snapshot.ts`). Reuse both unchanged; do not invent a second serialisation.

What `packages/sim` already encodes (`packages/sim/src/types.ts`, `SimState`):

| Group | Fields | Covers layer-1 §4.3 requirement |
|---|---|---|
| Identity and pinning | `schemaVersion`, `simulationVersion`, `contentVersion`, `gridHash` | Simulation version, content version, checkpoint schema version |
| Clock and sequences | `nowMs`, `rng`, `nextQueueSeq`, `nextDomainSeq`, `epoch` | Simulation time, PRNG state, event sequence counters |
| Encounter | `encounterCount`, `encounterStartedAt`, `phase`, `stopReason` | Encounter state, rest/walk/respawn state, pause state |
| Inputs | `input` (seed, classes, recipe, `placement`, `strategies`, `rest`, `wipeLimit`) | Strategy snapshot, saved placement, wipe limit |
| Actors | `actors[*]`: level, attributes, `stats`, `hp`, `mp`, `position`, `cooldowns`, `statuses`, `threat`, `forcedTarget`, `currentTarget`, `pendingCast`, `actionToken` | Derived combat state, HP/MP, placements, targets, threat, pending casts, cooldowns, statuses, buff sources/expiry |
| Schedule | `queue[*]`: `at`, `kind`, `actorId`, `seq`, `epoch`, `token` | Regeneration schedule, pending actions, boundary-replay prevention |
| Accounting | `metrics` including `wipes` and per-actor totals | Wipe count, resource totals |

What B **adds**, as an envelope committed in the same row and the same transaction:

| Field | Type | Provenance / rule |
|---|---|---|
| `envelopeVersion` | int | B's own checkpoint schema version, distinct from `state.schemaVersion`, which versions the engine's shape (layer-1 §4.3) |
| `accountId`, `huntId` | stable ids | `huntId` is server-assigned and unique per account; it is the reward namespace (below) |
| `generation` | int, monotonic | Bumped by every intervention; carried on every protocol message (layer-1 §4.4) |
| `checkpointSeq` | int, monotonic | Orders durable checkpoints; a lower `checkpointSeq` never overwrites a higher one |
| `accountStateVersion` | int | The single account-wide version of layer-1 §8.1; the checkpoint records the version it was committed against so a stale worker result can be rejected rather than merged |
| `wallAnchorMs`, `simAnchorMs` | int ms | The wall/sim correspondence; re-anchored at every settlement (§3) |
| `pausedWallMs` | int ms | Accumulated wall time during authoritative pauses, so wall and sim may diverge without losing the mapping (layer-1 §4.6) |
| `lastSeenAt` | int ms UTC | Presence anchor; the cap is measured from the **previous** value (layer-1 §4.6) |
| `offlineCapMs` | int ms | The cap in force for this segment, recorded rather than read from config at replay time, so a later cap change cannot rewrite settled history |
| `rewardSeq` | int, monotonic | Next reward ordinal; lives in the checkpoint beside `nextDomainSeq`, allocated by the deterministic transition, never by the database |
| `pendingRewards` | bounded array | Rewards accrued since the last commit, drained on commit (see **OPEN DECISION — reward accrual carrier**) |
| `pity` | per reward tier counters | Persistent bad-luck counters; stop/start never resets them (layer-1 §7.3). See **OPEN DECISION — pity state ownership** |
| `activeStrategyVersion` | `{presetId, version}` per character | The rules `state.input.strategies` was built from; needed so the UI can name the active version (UI spec §5) |
| `pendingStrategy` | `{presetId, version, payload, commandId, acknowledgedAtSimMs}` or null | A deep validated **copy** of the preset, not a reference (§4) |
| `activeLootFilterVersion`, `pendingLootFilter` | same shape | Filter changes apply to future drops after the acknowledged cutoff, never retroactively (UI spec §6) |
| `inventoryProjection` | bounded record | The consumable/bag inputs the simulation reads (potion stacks, free slots). Canonical tables remain authoritative and are committed atomically with the checkpoint; the projection is rebuilt, never merged, when the account version moved (layer-1 §4.3) |
| `stopContext` | `{reason, atSimMs, atWallMs}` or null | B extends A's `StopReason` union (`'wipe-limit' \| 'stalemate' \| 'operator'`); see **OPEN DECISION — stop reason vocabulary** |

**Reproducible, collision-safe reward ids.** A reward id is `"<huntId>:<rewardSeq>"`, allocated inside the transition that creates the reward, from `rewardSeq` in the checkpoint. It needs no external UUID generator (layer-1 §4.3) because both halves are already durable: `huntId` is unique per account and never reused, and `rewardSeq` increases monotonically and is part of the state the checkpoint restores. Determinism does the rest — re-simulating a segment from the same checkpoint under the same pinned versions reproduces the same rewards in the same order with the same ids, so a retried commit is idempotent against a unique constraint on `(accountId, rewardId)` instead of double-crediting. This is the same mechanism A already proves for `nextDomainSeq`: the pinned one-hour fixture recomputes an exact 13,648-event stream field by field (`packages/sim/test/pinned-run.test.ts`).

### 3. Offline settlement

The beta cap is shared by every account: **12 hours = 43,200,000 ms** (proposed default, layer-1 §4.6). Accrual stops at the earlier of a hunt stop condition and `previousLastSeenAt + cap`.

Arithmetic, all integer milliseconds:

```text
capCutoffWall      = previousLastSeenAt + offlineCapMs
eligibleCutoffWall = min(nowWall, capCutoffWall)
simTarget          = simAnchorMs + (eligibleCutoffWall - wallAnchorMs) - pausedWallMs
result             = advance(state, simTarget, { collect: 'summary' })
creditedSimMs      = result.state.nowMs - state.nowMs
```

A stop condition inside the engine ends accrual earlier than `simTarget` on its own: `advance` retains the exact stop time and returns `reachedTarget: true` when the phase becomes `stopped` (`packages/sim/src/advance.ts`), so the credited duration is always `state.nowMs` delta, never the requested horizon. A stopped hunt is inert on further advance, proven by `packages/sim/test/advance.test.ts` "a stopped experiment accrues no further time, regen or events on repeated advance (R38)". The wall instant of a stop is `wallAnchorMs + (stopSimMs - simAnchorMs) + pausedWallMs`, computed with the **pre-settlement** anchors.

**Ordering is settle → commit → refresh presence → re-anchor** (layer-1 §4.4 step 2). The refresh is:

```text
lastSeenAt   := nowWall
wallAnchorMs := nowWall
simAnchorMs  := result.state.nowMs
pausedWallMs := 0
```

Re-anchoring to `nowWall` — not to `eligibleCutoffWall` — is precisely what makes uncovered wall time unrecoverable. No residual is stored, so there is nothing a later settlement could redeem, and deferring a reconnection can never convert unattended hours into production (layer-1 §4.6). It also makes a duplicate settlement harmless: the second one computes `simTarget == state.nowMs` and credits zero, which `packages/sim/test/invariants.test.ts` "advancing to the current time is a legal no-op" already covers at the engine level.

**Worked example.** Previous presence `W0`; the player returns 19 h later at `W1 = W0 + 68,400,000`. The checkpoint holds `wallAnchorMs = W0`, `simAnchorMs = 5,400,000` (90 min already simulated), `pausedWallMs = 0`, `offlineCapMs = 43,200,000`.

- `capCutoffWall = W0 + 43,200,000`; `eligibleCutoffWall = min(W1, that) = W0 + 43,200,000`.
- `simTarget = 5,400,000 + 43,200,000 = 48,600,000`.
- The engine wipes out at `nowMs = 46,000,000`, phase `stopped`, reason ~~`wipe-limit`~~ `wipe` (R154).
- `creditedSimMs = 46,000,000 - 5,400,000 = 40,600,000` (11 h 16 m 40 s). Stop wall instant `= W0 + 40,600,000`.
- Uncovered: `2,600,000 ms` between the stop and the cap cutoff, plus `25,200,000 ms` (7 h) between the cap cutoff and `W1`. Neither is ever simulated.
- After commit: `lastSeenAt = wallAnchorMs = W1`, `simAnchorMs = 46,000,000`.
- The away report shows time away 19 h and simulated duration 11 h 16 m 40 s separately, with the stop reason, exactly as UI spec §8 requires — and a cap-stopped accrual is reported as a cap, not as a combat failure.

Had the hunt still been running at the cutoff, `creditedSimMs` would be the full `43,200,000`, `simAnchorMs` would become `48,600,000`, and the 7 uncovered hours would be discarded identically.

**Heartbeats.** A connected client refreshes presence roughly every 30 s (proposed default, layer-1 §4.6). A heartbeat is a settlement, not a bare presence write: refreshing `lastSeenAt` without first settling would re-anchor across the covered interval and silently discard it, because uncovered time is never simulated later. A maintained connection therefore accrues continuously and never engages the cap; the cap bounds unattended disconnection, not daily production. Heartbeats do not bump `generation`.

**Anchor fields by step:**

| Step | Reads | Writes |
|---|---|---|
| Start | — | `wallAnchorMs`, `simAnchorMs=0`, `lastSeenAt`, `offlineCapMs` |
| Connect / reconnect | `lastSeenAt` (previous), `wallAnchorMs`, `simAnchorMs`, `pausedWallMs`, `offlineCapMs` | all of them, after the settlement commits |
| Heartbeat | same | same |
| Persist (cadence) | `wallAnchorMs`, `simAnchorMs`, `pausedWallMs` | `simAnchorMs`, `wallAnchorMs` (re-anchored at the commit instant); `lastSeenAt` only if the connection is live |
| Intervene | same | same, at `commandAtWall` |
| Pause / resume | `pausedWallMs` | `pausedWallMs` accumulated across the paused interval |

Concurrency: presence is per account, not per socket. Two tabs cannot double-settle because both settlements contend on the same account state version; the loser retries from fresh state and finds nothing left to credit (layer-1 §8.1, §12 "multiple tabs, repeated heartbeats, no retroactive accrual after presence refresh").

### 4. Commands: server time, settle-then-apply, and the pending-strategy contract

layer-1 §4.5 defers "pending-version persistence and exact command ordering" to milestone B, and UI spec §5 defers "exact production payload/schema and same-timestamp ordering". This subsection settles both.

Every command carries `accountId`, `huntId`, an idempotency key scoped to account and operation, the expected `generation`, and the expected `accountStateVersion`. It carries **no** client timestamp; the server assigns `commandAtWall` when it records the command time in step 1 of the mutation sequence, and clients cannot backdate changes (layer-1 §4.5).

**Settle-then-apply** is unconditional. Elapsed progress is settled to `simTimeAt(commandAtWall)` and committed *before* the command is validated, so an illegal command still leaves the settlement standing and never rewinds the clock. Only then is the intent validated against settled state, applied, and checkpointed with `generation += 1`; the private precomputation is discarded.

**Same-timestamp ordering.** Two commands may be assigned the same `commandAtWall`. Order is `(commandAtWall, receiveSeq)`, where `receiveSeq` is a per-account counter allocated under the same lock that reads the account state version. Because each command commits a version increment, the second command sees the first one's result and either applies on top of it or is rejected as stale. Client-supplied ordering hints are ignored.

**Stale-write rejection.** A mismatched `generation` or `accountStateVersion` is rejected with a recoverable conflict code carrying the current values, so the client refetches and may resubmit (UI spec §5). Replaying an idempotency key with identical input returns the stored result; replaying it with different input is invalid (layer-1 §8.1).

**Command classes:**

| Command | Settles first | Bumps generation | Notes |
|---|---|---|---|
| Start hunt | n/a (no hunt) | sets 1 | Requires no active hunt |
| Stop / resume | yes | yes | §5 |
| Retreat / travel | yes | yes | §5 |
| Apply strategy next encounter | yes | yes | Queues the pending version below |
| Save preset | no | no | Touches `strategy_presets` only; a running hunt is unchanged (UI spec §5) |
| Apply loot filter | yes | yes | Future drops only, after the acknowledged cutoff |
| Town actions (equip, respec, buy) | yes | no hunt-rule change | Still take the account state version |
| Heartbeat / resync | settles | no | §3 |

**Pending strategy version — the persisted contract.** Four distinct states, three of them durable:

| State | Where it lives | Effect on the running hunt |
|---|---|---|
| Draft | Client only; never sent | None. Closing with unsaved changes offers Keep editing / Discard / Save (UI spec §5) |
| Saved preset | `strategy_presets` row, versioned | None |
| Pending | `pendingStrategy` in the checkpoint | Applies at the next encounter spawn |
| Active | `state.input.strategies` (+ `activeStrategyVersion`) | In force now |

Rules, each directly testable:

1. `pendingStrategy.payload` is a **deep validated copy** taken at apply time, not a foreign key to the preset row. A later edit to the same preset changes the row and not the queued snapshot (UI spec §5). The copy is validated by the same input validator the engine uses, so an unactivatable payload can never reach the checkpoint.
2. Activation happens **before the next encounter spawns**, including after walking or resting, and never mid-fight. In engine terms the hook is at the top of `spawnEncounter` (`packages/sim/src/lifecycle.ts`), *before* `chooseRecipe` draws — so activation consumes no RNG and cannot reroll the encounter, and the split invariant is untouched because it is a state-only change at an event boundary that already exists.
3. A newer acknowledged apply **replaces** the pending one; the replaced version is discarded, not queued. There is at most one pending strategy per hunt.
4. Stopping does not activate the pending version and does not reset encounter state (layer-1 §4.5, UI spec §5). After a resume the pending version is still pending and activates at the next spawn.
5. `pendingStrategy` is part of the checkpoint, so it survives reconnect, crash recovery and replay by construction.
6. The projection exposes `activeVersion` and `pendingVersion` separately, so the UI can show both without inferring one from the other (UI spec §5).

**OPEN DECISION — pending activation boundary for party-scope rules.** Per-character rule lists clearly activate at the next encounter spawn. Party-scope settings (rest thresholds, wipe limit, bag-full policy, potion floor) are read at other moments — `finishEncounter` reads `input.rest` immediately after a win, before any spawn. Options: **(a)** one activation point for the whole payload, at the next spawn: simplest, matches the UI wording exactly, but a new rest threshold only takes effect one rest later. **(b)** Split activation: per-character rules at spawn, party-scope rules at the first phase boundary: more responsive, but two activation instants means two versions can be partially live at once, which the UI's single "pending version" cannot express. **Recommendation: (a)**, one atomic activation. Its consequence must be specified with it: if the activated payload lowers `wipeLimit` to at or below `metrics.wipes`, the hunt stops immediately at activation with the ordinary `wipe-limit` reason, granting no free continuation and no recovery.

**OPEN DECISION — stop reason vocabulary.** A's union is `'wipe-limit' | 'stalemate' | 'operator'`. B adds at least retreat and the party stop conditions of layer-1 §6.6 (return when HP potions fall below N; bag-full return-to-town) and needs a distinct faulted state (layer-1 §11). Options: **(a)** a closed union enumerated in the B contract, validated by `decodeSnapshot`; **(b)** an open string with a registry. **Recommendation: (a)** — `decodeSnapshot` already rejects unknown enum members and that rejection is what keeps a foreign snapshot out of a production account. Whichever is chosen, reaching the offline cap is **not** a stop: accrual ceased, the hunt is still running, and the report must say so (UI spec §8).

### 5. Stop, pause, retreat and travel

What each transition preserves, and what must never be free (layer-1 §4.5):

| Transition | Preserves | Never grants | New generation |
|---|---|---|---|
| Stop | HP/MP, damage taken, spent resources, `rng`, cooldown timestamps, `metrics` (including `wipes`), `encounterCount`, pity, `pendingStrategy` | Heal, seed reset, cooldown reset, encounter reroll | yes |
| Resume | Everything stop preserved, plus the scheduled queue | A fresh decision for an actor whose action was already scheduled | yes |
| Retreat (abandon encounter for town) | Party HP/MP, `rng`, cooldowns, pity, wipe count | Recovery of any kind on arrival; a re-entry that resamples a group | yes |
| Travel (map change) | Account-scoped state: pity, inventory, gold, characters | Same as retreat | ends the hunt |
| ~~Wipe → respawn~~ | ~~Only this transition grants the full HP/MP restore (A spec §10, `completeRespawn`)~~ — superseded: no respawn; a full wipe ends the hunt and the town return heals (R154, R155) | — | no (engine transition) |

A's `Simulation.stop` sets phase `stopped` and reason `operator`, clears the queue, and preserves everything else — proven by `packages/sim/test/advance.test.ts` "stop() sets operator phase/reason, clears the queue, and preserves everything else". **That is terminal, and B needs Resume**, so B cannot reuse it literally: a cleared queue loses the pending cast, the scheduled regen tick and every scheduled decision.

**DECIDED 2026-09-21 (owner): no resume-capable pause is needed — Stop returns to town and the encounter is abandoned, so there is nothing to resume. The queue-clearing `Simulation.stop` is therefore correct as it stands, and only the presence/offline pause of §3 retains state. Original text: OPEN DECISION — resume-capable pause.** Options: **(a)** add a `paused` phase to the B simulation version that retains `queue` and `nowMs` untouched and simply is not advanced while paused; wall and sim anchors diverge across the paused interval via `pausedWallMs`, which layer-1 §4.6 already contemplates ("simulation time and wall time … diverge during pauses"). **(b)** Keep A's clearing stop and rebuild a queue on resume from actor state. **(c)** Snapshot the queue into the envelope at stop and restore it on resume. **Recommendation: (a)**. Option (b) is the one §4.5 forbids in substance — a rebuilt queue either drops the pending cast or re-grants a decision, which is a free action or a free cast cancel; (c) duplicates the engine's own field outside the validator that checks it. Under (a) the resume assertion set is exact: after stop → resume with no elapsed time, the canonical encoding of the state is byte-identical except for `phase`.

**DECIDED 2026-09-21 (owner): stopping a hunt *is* the return to town. The in-progress encounter is abandoned, the return consumes a simulated travel segment, stopping preserves damage, spent resources, PRNG progression and pity, and starting again begins a new encounter — so repeated sampling costs travel time and grants no healing. The travel duration is a content constant. Original text: OPEN DECISION — retreat, town return and travel costs.** layer-1 §4.5 and §15 mark this as an open decision that must be settled before B, requiring that these transitions "consume game time/resources as appropriate and cannot provide repeated zero-cost encounter sampling or healing". Options: **(a) Preserved-encounter re-entry:** retreat freezes the encounter in the checkpoint and re-entry resumes it exactly — no reroll, no heal, no cooldown reset. Blocks resampling outright with no new content constants, but leaves a map change free. **(b) Simulated travel time:** returning to town and entering a map each cost a defined travel duration simulated as sim time with walking-rate regen, no encounter and no rewards. Charges a real cost using a transition that already exists, but needs content constants. **(c) Resource cost:** gold or potions per travel. Introduces an economy coupling the economy section has not specified. **(d) Re-entry cooldown:** a minimum dwell before re-entering. Cheapest to implement, easiest to perceive as arbitrary. **Recommendation: (a) + (b)** — (a) as the invariant for the same map, so a retreat can never sample a better group, and (b) for town return and map change, so abandoning a fight costs time rather than nothing. Both durations are content constants chosen in the content table, not numbers invented here. Under either, arrival in town grants no healing (layer-1 §7.6) and a map change ends the hunt and starts a new one with a new `huntId`, hence a new reward namespace, while account-scoped pity counters carry over unchanged (layer-1 §7.3).

### 6. Collection modes, work budgets and performance

Detailed and summary collection must not change state, RNG use, or rewards (layer-1 §4.8). The engine already satisfies this: `advance` allocates `nextDomainSeq` through `ctx.emit` in both modes and only retention differs (`packages/sim/src/advance.ts`), and the property is covered by `packages/sim/test/invariants.test.ts` "any seed agrees across summary collection and a one-event work budget" and `packages/sim/test/advance.test.ts` "split and summary runs preserve state and ordered events". B adds one consequence that is easy to violate: **summary mode returns an empty event array, so rewards must never be read out of the returned events.** They are read from state — the reward records the transition appended and the `metrics` delta — which is what lets an offline settlement in summary mode and a live session in detailed mode credit the same thing.

**OPEN DECISION — reward accrual carrier.** Options: **(a)** a bounded `pendingRewards` array in the checkpoint, appended by the transition and drained at each commit, with a hard cap that forces a commit when reached; **(b)** re-run the segment in detailed mode at commit time to harvest reward events; **(c)** counters only, with rewards reconstructed deterministically on demand. **Recommendation: (a)**. (b) doubles the settlement cost and makes rewards depend on a second execution; (c) makes the audit trail derived rather than recorded, which layer-1 §8.2 argues against. Under (a) the cap must behave like the work budget — force a yield and a commit, never silently drop or alter state — so the split invariant is preserved.

**Work budgets and continuation chunks.** `advance` counts every popped entry, stale entries included, against `maxScheduledEvents` (default 10,000), and a yield returns `reachedTarget: false` with `nowMs` at the last processed entry; the caller resumes with the **same absolute target** (contracts §5). Continuation chunks therefore preserve the split invariant for free, which is exactly what layer-1 §4.8 demands and what `invariants.test.ts` "stale entries are skipped but still spend the work budget" and "any seed splits anywhere without changing state or events" already prove. B rules: one settlement in flight per account; a bounded worker queue with duplicate catch-up work queued rather than run concurrently (layer-1 §8.1); a per-job work bound so one long hunt cannot monopolise a worker; and a yield never converts a long computation into a game outcome (A spec §10).

**Targets, quoting only measured numbers** (`artifacts/milestone-a-results.md` §6, workstation: AMD Ryzen 7 7800X3D, 16 CPUs, 31.2 GiB, Node v24.15.0, win32/x64 — **not** the deployment host, §6.5):

| Condition | p50 | p95 | p99 / max | Over 1,000 ms |
|---|---|---|---|---|
| 12 h gameplay, one at a time (20 samples) | 608.261 ms | 620.177 ms | 630.064 ms | 0 of 20 |
| 24 h gameplay, one at a time (20 samples) | 1,134.950 ms | 1,151.269 ms | 1,160.574 ms | 20 of 20 |
| 12 h gameplay, 16 concurrent (100 samples) | 1,390.494 ms | 1,490.269 ms | 1,530.337 ms | 96 of 100 |
| 24 h gameplay, 16 concurrent (100 samples) | 2,578.660 ms | 2,704.863 ms | 2,731.763 ms | 100 of 100 |
| 12 h engine-stress fixture (1 sample) | 4,216.354 ms | — | — | 1 of 1 |

Peak RSS: 104.9 MiB p50 sequential at 12 h, 105.4 MiB at 24 h, 67.7 MiB p50 and 102.9 MiB max per job at concurrency 16, 127.3 MiB for the engine-stress fixture. Batch throughput: 9.466 jobs/s (12 h, concurrency 16), 5.496 jobs/s (24 h, concurrency 16), against a 1.411 jobs/s sequential reference.

B's sizing rule follows from those figures rather than from the headline: the number to budget a settlement queue from is the **concurrent** median, 1,390.494 ms for a 12 h catch-up with sixteen in flight — 2.29× the 606.551 ms the same job costs alone — not the sub-second sequential p50. The 12 h cap settlement is the design's normal worst case; the sub-second goal is evaluated, not asserted (§6.6), and the single-VPS concurrency gate is open (§6.5). B must re-measure on the deployment host and must not quote §6.4 as evidence about it.

### 7. Version updates applied to in-flight hunts

From the simulation's point of view a version update is not a deploy, it is a rewrite of every checkpoint. `advance` compares `schemaVersion`, `simulationVersion`, `contentVersion` and `gridHash` against the bound content and throws `WRONG_VERSION` on any mismatch (`assertCompatible`, `packages/sim/src/advance.ts`; `packages/sim/test/snapshot.test.ts` covers each of the four rejection paths at decode time). An old checkpoint therefore cannot be replayed with whatever balance data is deployed now — the engine refuses (layer-1 §4.7).

The maintenance sequence, in engine terms:

1. Freeze gameplay mutations at a recorded wall cutoff `T_c`; reject new commands with a maintenance code.
2. For each hunt, settle to `min(stopCondition, previousLastSeenAt + offlineCapMs, T_c)` using the **old** pinned simulation and content artifacts, which are retained until settlement, migration and recovery verification all complete (layer-1 §4.7; a hash alone is not a replay artifact).
3. Persist the settlement. Only then run schema, content and placement migrations.
4. Decode with the old validator, transform, recompute derived values, apply the defined HP/MP adjustment rule, and write new-version checkpoints with new `envelopeVersion`, `simulationVersion`, `contentVersion` and `gridHash`. Re-validate `input.placement` through `validatePlacement`; an invalid placement resets to the class-default formation (`defaultPlacement` is already exported) and the player is notified (layer-1 §6.4). The HP/MP adjustment rule itself is still unspecified in layer-1 §5.3 and is owned by the progression section; this section only requires that it be applied inside migration, not at the next level-up.
5. Resume with new anchors (`wallAnchorMs := resumeWall`, `simAnchorMs := state.nowMs`, `pausedWallMs := 0`) and notify clients of changed content or reset placements; clients refetch content and invalidate placement UI (layer-1 §11).

Downtime is an explicit pause, never retroactively simulated with changed rules (layer-1 §4.7). A pending strategy version survives a migration only if its payload still validates under the new content; if it does not, it is dropped, the player is notified, and the active rules are unchanged — dropping a queued change is recoverable, silently activating a mutated one is not.

**OPEN DECISION — in-flight encounter handling across a version change.** Options: **(a)** settle to the cutoff, abandon the undecided encounter, re-seat the party to `input.placement` and resume at `walking`; no rewards for the partial fight and no wipe charged. **(b)** Preserve the encounter and re-derive enemies under the new content — undefined whenever a monster definition changed or was removed, and the enemy roster is rebuilt from content at spawn in any case. **(c)** Block migration until every hunt reaches an encounter boundary — unbounded, and a stalemate never reaches one. **Recommendation: (a)**: it is the only total option, it costs the player one undecided encounter, and the re-seat it needs is the same `input.placement` reset the engine already performs at `finishEncounter` and `spawnEncounter`.

**OPEN DECISION — maintenance downtime and the offline cap.** Does downtime consume a player's unattended allowance? Options: **(a)** treat it as ordinary uncovered wall time — simple, but charges the player's 12 h for an operator-caused outage. **(b)** Advance `lastSeenAt` by the downtime duration when resuming, so the cap is measured from the end of the outage. **Recommendation: (b)**. It retroactively simulates nothing — it only declines to bill the player for time the service was not available — and it is a single recorded adjustment on one field, auditable per hunt.

### 8. Testable requirements

| ID | Requirement | Verification |
|---|---|---|
| B-L01 | Start writes a checkpoint and an idempotency result in one transaction, or nothing | Integration test: injected commit failure leaves no `hunts` row |
| B-L02 | Reconnect settles and commits before `lastSeenAt` is refreshed | Integration test: failure injected between settle and refresh leaves `lastSeenAt` at its previous value and the allowance intact |
| B-L03 | Accrual never exceeds `previousLastSeenAt + offlineCapMs` | Clock test over the §3 worked example, asserting `creditedSimMs` |
| B-L04 | Uncovered wall time is never credited later | Clock test: settle, wait, settle again; second settlement credits zero |
| B-L05 | Repeated settlement at the same instant is a no-op | Existing engine coverage: `invariants.test.ts` "advancing to the current time is a legal no-op" |
| B-L06 | No future event, loot roll or PRNG state reaches a client | Protocol test asserting every released `event.at <= releaseSimMs`; payload schema forbids `rng`, `queue`, `pendingRewards` |
| B-L07 | Reward ids are reproducible and unique | Replay the same segment twice from one checkpoint; ids match; a unique constraint on `(accountId, rewardId)` rejects the duplicate commit |
| B-L08 | A checkpoint round-trips with full validation | Existing coverage: `snapshot.test.ts` round trips and rejection cases; extended to the envelope |
| B-L09 | Detailed and summary settlement produce identical state, RNG and rewards | Existing coverage: `invariants.test.ts` summary/one-event-budget agreement; extended to assert the reward list |
| B-L10 | Continuation chunks preserve the split invariant | Existing coverage: `invariants.test.ts` "any seed splits anywhere without changing state or events" and "stale entries are skipped but still spend the work budget" |
| B-L11 | Commands are ordered by `(commandAtWall, receiveSeq)`; client timestamps are ignored | Concurrency test: two commands at one instant apply in receive order, the second against the first's result |
| B-L12 | A stale `generation`/`accountStateVersion` is rejected recoverably, not merged | Integration test asserting the conflict code and an unchanged checkpoint |
| B-L13 | An invalid command still leaves its settlement committed | Integration test comparing checkpoints before and after a rejected intent |
| B-L14 | A later preset edit does not mutate a queued snapshot | Unit test: apply, edit preset, spawn; the activated payload is the queued one |
| B-L15 | Activation occurs before the next spawn, consumes no RNG, and cannot reroll the encounter | Unit test: identical `rng` before and after activation; identical recipe draw against a control run |
| B-L16 | A newer acknowledged apply replaces the pending one | Unit test: two applies, one pending, the newer payload activates |
| B-L17 | Stopping neither activates the pending version nor resets encounter state | Unit test on the stop → resume path |
| B-L18 | Stop/resume grants no heal, seed reset, cooldown reset or encounter reroll | Unit test: canonical encoding byte-identical across stop → resume except `phase` |
| B-L19 | Pity counters survive stop, resume, retreat and travel | Unit test across all four transitions |
| B-L20 | A checkpoint from another simulation or content version is refused | Existing coverage: `advance.ts` `assertCompatible`; `snapshot.test.ts` wrong-schema/content/grid rejections |

### 9. Open decisions

1. **OPEN DECISION — hunt seed provenance.** The engine requires `seed` in `1 … 4294967295` (`state.ts`) but nothing specifies where a production seed comes from, and §8.3 forbids exposing live hunt seeds. Options: **(a)** a CSPRNG-drawn nonzero u32 stored in the checkpoint at start; **(b)** derive it from a hash of `huntId` plus a server secret. **Recommendation: (a)** — determinism only requires that the seed be persisted, and a derived seed becomes guessable the moment `huntId` is client-visible.
2. **OPEN DECISION — reward identifier namespace.** `"<huntId>:<rewardSeq>"` versus including `generation` versus a hash. **Recommendation:** `"<huntId>:<rewardSeq>"` with a unique constraint on `(accountId, rewardId)`; including `generation` would give a replayed segment new ids and defeat the duplicate detection that makes retried commits safe.
3. **OPEN DECISION — pity state ownership.** Checkpoint-owned versus `account_drop_protection`-owned with a checkpoint mirror (layer-1 §4.3 and §8.2 each imply one). **Recommendation:** the counters the transition reads live in the checkpoint, and the account table is a derived index written in the same transaction; on recovery the replayed checkpoint rewrites the table.
4. **OPEN DECISION — pending activation boundary for party-scope rules.** One atomic activation at the next spawn versus split activation. **Recommendation:** one atomic activation, with an explicit rule that activating a `wipeLimit` at or below `metrics.wipes` stops the hunt immediately with the ordinary `wipe-limit` reason.
5. **OPEN DECISION — stop reason vocabulary.** A closed validated union versus an open registry. **Recommendation:** a closed union; reaching the offline cap is not a stop.
6. **OPEN DECISION — resume-capable pause.** A `paused` phase retaining the queue, versus A's queue-clearing stop plus a rebuilt queue, versus snapshotting the queue into the envelope. **Recommendation:** a `paused` phase; the rebuild option grants a free action or a free cast cancel, which layer-1 §4.5 forbids.
7. **OPEN DECISION — retreat, town return and travel costs.** Preserved-encounter re-entry, simulated travel time, resource cost, or re-entry cooldown (layer-1 §4.5, §15 — must be settled before B). **Recommendation:** preserved-encounter re-entry for the same map plus a simulated travel duration for town return and map change, with the durations chosen as content constants.
8. **OPEN DECISION — reward accrual carrier.** A bounded in-checkpoint `pendingRewards` array, a detailed-mode re-run at commit, or counters plus reconstruction. **Recommendation:** the bounded array, with its cap forcing a commit exactly the way the work budget forces a yield.
9. **OPEN DECISION — in-flight encounter handling across a version change.** Abandon and resume walking, re-derive enemies under new content, or block migration until every hunt is at a boundary. **Recommendation:** abandon the undecided encounter, charge no wipe, grant no recovery.
10. **OPEN DECISION — maintenance downtime and the offline cap.** Treat downtime as ordinary uncovered time, or advance `lastSeenAt` by the downtime. **Recommendation:** advance `lastSeenAt`; it simulates nothing retroactively and is one auditable field.

Carried dependencies owned by other sections but required here: the HP/MP adjustment rule for maximum changes (layer-1 §5.3, needed by §7 step 4), the bag-overflow and potion-floor stop conditions (layer-1 §6.6, §7.5, needed by §4's stop vocabulary), and the drop-protection thresholds (layer-1 §7.3, needed only when pity is enabled in expanded beta — B carries the state regardless).
