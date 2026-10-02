# Part 1 — Platform, accounts and persistence

Part of the [milestone B technical specification](../../2026-09-21-milestone-b-spec.md). **Draft, 2026-09-21** —
not accepted; the open decisions at the end of this part are the owner's and nothing here is
implementable until they are recorded. [Layer 1 design](../../layer-1-design.md) and the
[Realm UI specification](../../2026-09-16-realm-ui-spec.md) outrank this document.

Section numbers below are local to this part; cross-part references name the part. Requirement ids in this part are `P-nn`.

This section specifies the server that milestone B introduces: processes, authentication, the transport contract, concurrency, the PostgreSQL schema, the version-update runbook, administration and operational bounds. The hunt lifecycle itself — settlement, precompute, release, away reports — is specified separately; this section owns the surfaces it runs on and the transactions it commits into. Requirements are identified `P-nn` and each is phrased so a test or a runbook step decides it. Values that the parent documents do not settle appear as **OPEN DECISION** markers and are collected at the end.

### 1. Service topology

Milestone B adds `packages/protocol` and `apps/server` to the existing workspace; `packages/data`, `packages/sim`, `tools/balance` and `apps/client` keep their milestone A responsibilities (layer-1 §4.1). `packages/protocol` holds the shared REST/WebSocket schemas and error codes validated with zod, and is the only module both `apps/server` and `apps/client` import for wire shapes (layer-1 §4.1). It depends on `@narok/data` types but never on `@narok/sim` internals, so no simulation structure leaks onto the wire.

| Process | Owns | Talks to |
|---|---|---|
| `api` (Fastify, Node) | HTTP routes, WebSocket upgrade and sessions, all validation, all database transactions, the authoritative clock, event release to clients | PostgreSQL; `catchup` workers in-process; clients over HTTPS/WSS behind Caddy (layer-1 §13) |
| `catchup` worker pool | Executing `advance()` from `@narok/sim` over a checkpoint, producing a candidate result; no database access, no wall-clock authority | `api` only, by message passing |
| `admin` CLI | Grants/revocations, password resets, maintenance freeze, settle/migrate/resume, restore drills (layer-1 §8.4, §4.7) | PostgreSQL and the `api` maintenance flag |
| PostgreSQL | All durable state | `api` and `admin` only |
| Caddy | TLS termination, HTTP→HTTPS redirect, `api` reverse proxy (layer-1 §13) | `api` |

> **Ruling R202 (final review I3, controller ruling 2026-10-02) — deviation from this table and from §8.**
> In milestone B the `catchup` pool does not exist as a separate execution context: catch-up runs
> **inline on the `api` event loop** (`apps/server/src/compose.ts`, `new SegmentPool(inlineExecutor(sim))`),
> and there is **no bounded catch-up queue** and so no `RATE_LIMITED` overflow (§8's "Queued catch-up jobs"
> row is unmet). The `SegmentExecutor` seam is where a `worker_threads` executor and the bounded queue
> go; `runSegment` is already pure (P-04 holds: it writes nothing). Measured on the workstation
> (`artifacts/catchup-12h.json`, `artifacts/catchup-12h.ts`): a 12 h digest-mode reconnect settlement
> takes 712 ms p50 of wall time and blocks the event loop for 605 ms p50 (624.4 ms max) alone; sixteen
> returning at once take 9.5 s in total, serialised on the one thread, with a longest single stall of
> 1.16 s. Every socket release tick, heartbeat, authorisation and REST request on the process waits
> behind that. It is an **open gate before any invitation**, beside B-27, closed by the owner or by the
> worker executor and bounded queue (results §8).

- **P-01** `apps/server` executes progression exclusively through `createSimulation()` exported by `@narok/sim` (contracts §3). No transition, formula, RNG draw or scheduler exists in `apps/server`. Verified by a dependency check that fails the build if `apps/server` declares a simulation-shaped dependency other than `@narok/sim`/`@narok/data`, and by a source scan asserting no `xorshift`/`advance`-loop implementation outside `packages/sim`.
- **P-02** The server never accepts a client-supplied simulation snapshot as account state. `decode()` is used only for operator/admin artifacts and migration inputs (contracts §3: "Snapshots are experiment artifacts and cannot be imported as trusted production accounts").
- **P-03** Equivalence test: a fixture checkpoint advanced by the `catchup` pool to sim time `T` produces the byte-identical canonical `encode()` output as `tools/balance` advancing the same input to `T` under the same pinned simulation/content versions (contracts §3, layer-1 §4.8 "use the same game transitions for live and offline progress").
- **P-04** A worker returns a candidate result only; it holds no transaction and cannot write. The `api` process decides whether to commit it (layer-1 §8.1 step 5).
- **P-05** Periodic work — live-hunt checkpointing, session pruning, `command_results`/`hunt_reports` retention sweeps — runs as named timers inside `api` with a durable "last completed at" record per job, so a restart does not skip or double-run a sweep. See **OPEN DECISION — scheduler process boundary**.

The deployment target is one VPS running Docker Compose with `api`, PostgreSQL and Caddy; local development runs PostgreSQL in Docker (layer-1 §13). Nothing in this section assumes a second host except off-host backup storage (layer-1 §8.4).

### 2. Accounts, authentication and transport

Registration and login use email and password; Discord OAuth is explicitly later (layer-1 §3). Beta has no email verification and no self-service password reset; recovery is the admin CLI (layer-1 §8.3).

- **P-06** Passwords are stored as argon2id hashes and never logged, echoed or included in any response or audit row (layer-1 §8.3, §8.4). Test: a registration/login/reset integration run greps the captured log stream and every `resource_audit` row for the submitted password and for the hash, and finds neither. Parameters: see **OPEN DECISION — argon2id parameters and password policy**.
- **P-07** The session credential is transported only in an `httpOnly; Secure; SameSite=Lax` cookie (layer-1 §8.3). The server never accepts a session in a query string, a request body or a WebSocket subprotocol. Test: a request carrying a valid session value in any non-cookie position is answered `UNAUTHENTICATED`.
- **P-08** Every mutating HTTP request and every WebSocket upgrade is rejected unless its `Origin` matches the configured allowlist (layer-1 §8.3). Test: allowed origin passes, foreign origin and absent origin on a mutation both return `FORBIDDEN_ORIGIN`, and the upgrade is refused before any session lookup.
- **P-09** Login rotates the session: a new session row is created and the credential presented at login is invalidated in the same transaction (layer-1 §8.3). Test: the pre-login cookie is unusable afterwards.
- **P-10** A password change or admin reset revokes every session row for the account and closes every open socket bound to those sessions within one heartbeat interval (layer-1 §8.3). Test: an open socket receives a close with `UNAUTHENTICATED` and no further frames after the reset commits.
- **P-11** Session expiry and revocation are re-checked on every request and on every heartbeat, not only at upgrade (layer-1 §8.3: "authentication at upgrade is not perpetual authorization"). Test: revoking a session mid-hunt stops frame delivery on the existing socket.
- **P-12** Ownership of every referenced character, item, preset, report and hunt is checked against the authenticated account before any business validation (layer-1 §8.1, §8.3). Test: cross-account identifiers return `NOT_OWNED`, and the response body distinguishes nothing about whether the object exists.
- **P-13** Login, registration and admin-reset attempts are rate-limited per source and per account identifier; gameplay commands are rate-limited per account (layer-1 §8.3). Limits: see **OPEN DECISION — rate limits and resource bounds**.

**What the client may never assert.** These are rejected or ignored, never trusted, and each has a negative test:

| Client claim | Rule |
|---|---|
| Elapsed or current time | The server derives elapsed time from stored anchors and its own clock (layer-1 §4.6). A client-supplied timestamp is a validation error, not an input. |
| Command time / backdating | Command time is server-assigned at read (layer-1 §4.5, §8.1 step 1). |
| Account state version as truth | `expectedStateVersion` is a guard, never a value the server writes (layer-1 §8.1). |
| Simulation outcomes, seeds, PRNG state, future events | Never sent to the client and never accepted from it (layer-1 §4.4, §8.3). |
| Entitlement, gold, EXP, item stats, drop results | Server-computed; client copies are display only (layer-1 §4.1). |
| Ownership or equip eligibility | Re-validated server-side even when the UI enforces it (UI spec §10). |

### 3. HTTP and WebSocket API surface

All REST payloads are zod-validated in `packages/protocol` (layer-1 §4.1). Every response carries `stateVersion` for the account it read or wrote. `Idempotency-Key` is required on the mutations marked below and is scoped to `(account, operation)`; replaying a key with different input is an error, not a new command (layer-1 §8.1). The "guard" column marks commands that must carry `expectedStateVersion` because the user formed the intent against a snapshot they read.

| Method / path | Request | Response | Auth | Guard | Idem | Error codes |
|---|---|---|---|---|---|---|
| `POST /api/auth/register` | email, password | account summary | none | — | no | `VALIDATION`, `EMAIL_TAKEN`, `RATE_LIMITED` |
| `POST /api/auth/login` | email, password | 204 + rotated cookie | none | — | no | `VALIDATION`, `INVALID_CREDENTIALS`, `RATE_LIMITED` |
| `POST /api/auth/logout` | — | 204 | session | — | no | `UNAUTHENTICATED` |
| `GET /api/me` | — | account, entitlement, `stateVersion`, pinned versions | session | — | — | `UNAUTHENTICATED` |
| `GET /api/characters` | — | characters with derived stats | session | — | — | `UNAUTHENTICATED` |
| `POST /api/characters` | slot, name, classId | character | session | yes | yes | `VALIDATION`, `RULE_VIOLATION` (slot taken, name taken), `CONFLICT_STATE_VERSION` |
| `POST /api/characters/:id/attributes` | staged allocation | character, `stateVersion` | session | yes | yes | `VALIDATION`, `NOT_OWNED`, `RULE_VIOLATION` (not in town, insufficient points), `CONFLICT_STATE_VERSION` |
| `POST /api/characters/:id/skills` | skill, target rank | character | session | yes | yes | as above plus `RULE_VIOLATION` (prerequisite) |
| `POST /api/characters/:id/respec` | scope | character | session | yes | yes | as above |
| `GET /api/inventory` | paging | items, stacks, capacity | session | — | — | `UNAUTHENTICATED` |
| `POST /api/inventory/equip` | itemId, characterId, slot | inventory delta | session | yes | yes | `NOT_OWNED`, `RULE_VIOLATION` (town-only, level, slot), `CONFLICT_STATE_VERSION` |
| `POST /api/inventory/sell` | itemIds | gold delta, removed ids | session | yes | yes | `NOT_OWNED`, `RULE_VIOLATION` (locked/equipped item), `CONFLICT_STATE_VERSION` |
| `POST /api/inventory/lock` | itemId, locked | item | session | yes | yes | `NOT_OWNED`, `VALIDATION` |
| `POST /api/shop/buy` | definitionId, quantity | stacks, gold | session | — | yes | `VALIDATION`, `RULE_VIOLATION` (gold, capacity) |
| `GET /api/presets` | kind | presets with payload schema versions | session | — | — | `UNAUTHENTICATED` |
| `PUT /api/presets/:id` | payload, payloadSchemaVersion | preset | session | yes | yes | `VALIDATION`, `NOT_OWNED`, `CONFLICT_STATE_VERSION` |
| `POST /api/presets/loot/preview` | filter payload | proposed disposition per recent drop | session | — | no | `VALIDATION` — read-only, mutates nothing (UI spec §6) |
| `POST /api/hunts` | party, mapId, presetIds | hunt summary, `generation` | session | yes | yes | `VALIDATION`, `RULE_VIOLATION` (hunt already active, party invalid), `CONFLICT_STATE_VERSION` |
| `POST /api/hunts/current/stop` | — | settled summary, `generation` | session | — | yes | `RULE_VIOLATION` (no hunt), `HUNT_FAULTED` |
| `POST /api/hunts/current/strategy` | presetId, presetVersion | pending version, `generation` | session | yes | yes | `CONFLICT_STATE_VERSION`, `RULE_VIOLATION`, `HUNT_FAULTED` |
| `GET /api/hunts/current` | — | public state, `generation`, `lastSeq` | session | — | — | `UNAUTHENTICATED` |
| `GET /api/reports` / `GET /api/reports/:id` | paging / id | settled away summaries | session | — | — | `NOT_OWNED`, `NOT_FOUND` |
| `GET /api/content/:version` | — | pinned content bundle | session | — | — | `NOT_FOUND` (unpinned version) |

Hunt-control semantics belong to the hunt-lifecycle section; this table fixes their transport, guard and idempotency obligations only.

**WebSocket.** One endpoint, `/ws`, authenticated by cookie at upgrade and re-checked per P-11. The message vocabulary reuses milestone A's worker contract where it fits (`apps/client/src/worker-contract.ts`): `frame`, `snapshot`, `error {code, field}` and a `generation` on every message. The decisive difference is direction of control: in the laboratory the client drives `advance`; in production the client may never move the authoritative clock, so `advance` has no server-side counterpart (layer-1 §4.4 items 4–5).

| Direction | Message | Fields | Rules |
|---|---|---|---|
| c→s | `hello` | `lastGeneration?`, `lastSeq?` | Sent once per connection; the server answers `snapshot` if generation differs or `lastSeq` is outside the retained window |
| c→s | `heartbeat` | — | Refreshes presence; presence refresh happens only after eligible accrual is settled (layer-1 §4.4 item 2) |
| c→s | `ack` | `generation`, `seq` | Releases output backpressure up to `seq`; unacked backlog above the bound closes the socket with `BACKPRESSURE` |
| s→c | `frame` | `generation`, `firstSeq`, `lastSeq`, `events[]`, `state: PublicState` | Contains only events whose authoritative timestamps have elapsed (layer-1 §4.4 item 4) |
| s→c | `snapshot` | `generation`, `seq`, `state: PublicState` | Resynchronization point; the client discards its local queue on receipt (layer-1 §4.4) |
| s→c | `report` | `generation`, `reportId` | Points at a settled report; reading it credits nothing (UI spec §8) |
| s→c | `error` | `generation`, `code`, `field` | Same shape as the worker contract's error message |

- **P-14** Every server message carries `generation` (monotonic per account, incremented at hunt start and at every accepted intervention) and a domain-event sequence (`seq`, allocated by the simulation's `nextDomainSeq` lineage, contracts §5). Both are monotonic within a generation.
- **P-15** A client must drop any message whose `generation` is lower than the highest it has observed, and must discard its local playback queue when `generation` increases (layer-1 §4.4). Test: after an accepted strategy apply, a deliberately delayed pre-intervention `frame` is delivered and the rendered log contains none of its events.
- **P-16** The server refuses to emit an event with `seq` lower than the last emitted `seq` for the same generation, and refuses `frame` events with an authoritative timestamp greater than the released clock. Both violations raise `PROTOCOL` rather than being trimmed (contracts §7 precedent: exceeding a bound is an invariant error, never permission to drop events).
- **P-17** A `snapshot` is a complete `PublicState` (contracts §3) and never contains PRNG state, seeds, pending private future events, or any field absent from `PublicActor`/`PublicState`. Test: schema-compare an emitted snapshot against the `PublicState` type; any additional key fails.

**Error envelope.** `{ code, field, retryable, stateVersion? }`. `field` is a bounded diagnostic path in the style of `SimError.field` (contracts §3), never a serialized state. The server never returns localized display text; the client localizes from the stable code (layer-1 §9).

### 4. Concurrency and ordering

Every gameplay mutation — town actions, preset applies, hunt start, hunt stop, live checkpoints and catch-up settlements — follows the five-step sequence in layer-1 §8.1, with these bindings:

- **P-18** One account-wide `state_version` covers all gameplay mutations, including town actions and hunt start when no hunt exists (layer-1 §8.1). No path relies on locking `hunts` alone.
- **P-19** Single-writer per account is enforced by `SELECT ... FOR UPDATE` on the `accounts` row inside the short commit transaction, at `READ COMMITTED`. The lock is the writer token; acquisition order is the total order of concurrent commands for that account (layer-1 §4.5 "simultaneous commands use server sequencing"). Test: two simultaneous sells of the same item produce exactly one success and one `CONFLICT_STATE_VERSION` or `RULE_VIOLATION`, never two gold credits.
- **P-20** Every commit asserts `UPDATE accounts SET state_version = state_version + 1 WHERE id = $account AND state_version = $read`. Zero affected rows aborts the transaction. This is the single mechanism that prevents a stale snapshot from overwriting newer town actions (layer-1 §4.3, §8.1 step 5).
- **P-21** Long simulation runs outside the transaction (layer-1 §8.1 step 2). A worker result is discarded, not merged, when the version moved; the server re-reads and re-simulates from the fresh checkpoint (layer-1 §11 "never merge stale inventory deltas blindly"). Test: mutate the account mid-settlement and assert the first worker result is dropped and no reward from it reaches `resource_audit`.
- **P-22** Server-internal version collisions are retried automatically with a bounded attempt count and jittered backoff; on exhaustion the command returns `CONFLICT_STATE_VERSION` with `retryable: true`. See **OPEN DECISION — conflict retry bound**.
- **P-23** A client-supplied `expectedStateVersion` mismatch is never auto-retried. It returns `CONFLICT_STATE_VERSION` with the current `stateVersion`; the client refetches and revalidates the draft rather than discarding it (UI spec §5 "reject stale writes with a recoverable conflict message"; UI spec §7 "refresh/revalidate rather than overspending or discarding a draft without explanation"). Test: a staged attribute apply against a superseded version is rejected, the staged values survive in the client, and no points are spent.
- **P-24** At most one catch-up job per account is in flight. A duplicate request for an account with a job in flight is coalesced onto the existing job, not queued behind it (layer-1 §8.1 "queue duplicate catch-up work rather than allowing unbounded worker contention"). Test: N simultaneous reconnects for one account produce one worker job.
- **P-25** Idempotency: `command_results` is written in the same transaction as the effect. A replay with the same `(account, operation, key)` and the same request hash returns the stored response without re-executing; the same key with a different request hash returns `IDEMPOTENCY_KEY_REUSED` (layer-1 §8.1). Test: a duplicated equip and a duplicated shop purchase each mutate once.
- **P-26** Cross-account ordering is undefined and unnecessary: there is no player interaction before Layer 4 (layer-1 §3, §14). No mechanism in this section may be justified by future trading.

### 5. Persistence model

PostgreSQL with Drizzle migrations (layer-1 §4.1). Identifiers are `uuid` primary keys generated server-side. All monetary and quantity columns are `integer` with nonnegative checks and stay inside the safe-integer bounds the simulation requires (contracts §3). Every constraint below is enforced in the database in addition to application validation (layer-1 §8.2).

| Table | Key columns and types | Constraints and indexes |
|---|---|---|
| `accounts` | `id uuid pk`, `email text`, `password_hash text`, `password_changed_at timestamptz`, `gold integer`, `bag_capacity integer`, `state_version bigint not null default 0`, `premium_granted_at timestamptz null`, `premium_expires_at timestamptz null`, `created_at` | unique index on `lower(email)`; `check gold >= 0`; `check bag_capacity >= 0` |
| `sessions` | `id uuid pk`, `account_id uuid fk`, `token_hash bytea`, `created_at`, `expires_at`, `revoked_at null`, `last_seen_at` | unique on `token_hash`; index `(account_id)`; index `(expires_at)` for pruning |
| `characters` | `id uuid pk`, `account_id uuid fk`, `slot smallint`, `name text`, `class_id text`, `level integer`, `exp bigint`, `awarded_level integer`, `unspent_stat_points integer`, `unspent_skill_points integer`, `attributes jsonb`, `skills jsonb`, `build_template jsonb`, `auto_spend jsonb`, `hp integer`, `mp integer`, `dead boolean` | unique `(account_id, slot)`; `check slot between 0 and 2` (layer-1 §5.1 three slots); unique index on normalized name (see open decision); `check level >= 1`; `check awarded_level <= level` (layer-1 §5.3) |
| `items` | `id uuid pk`, `account_id uuid fk`, `base_item_id text`, `base_content_version text`, `rarity text`, `item_level integer`, `bonuses jsonb`, `tradeable boolean not null default false`, `locked boolean not null default false`, `equipped_character_id uuid null`, `equipped_slot text null`, `created_at` | partial unique `(equipped_character_id, equipped_slot) where equipped_character_id is not null` (one item per slot, layer-1 §8.2); `check (equipped_character_id is null) = (equipped_slot is null)`; index `(account_id) where equipped_character_id is null`; `check tradeable = false` during beta (layer-1 §7.1) |
| `stack_items` | `(account_id, definition_id) pk`, `quantity integer` | `check quantity >= 0`; upper bound follows the stack rule in layer-1 §7.5 |
| `strategy_presets`, `loot_presets` | `id uuid pk`, `account_id uuid fk`, `name text`, `payload jsonb`, `payload_schema_version integer`, `grid_hash text null`, `preset_version integer`, `updated_at` | unique `(account_id, name)`; index `(account_id)`; `grid_hash` required for presets carrying placement (contracts §2) |
| `hunts` | `account_id uuid pk`, `status text`, `map_id text`, `checkpoint bytea`, `checkpoint_schema_version integer`, `simulation_version text`, `content_version text`, `grid_hash text`, `sim_anchor_ms bigint`, `wall_anchor_at timestamptz`, `last_seen_at timestamptz`, `paused boolean`, `generation bigint`, `faulted_reason text null`, `updated_at` | one hunt per account by primary key (layer-1 §5.1); index `(status) where status = 'running'`; `check generation >= 0` |
| `hunt_checkpoint_archive` | `id uuid pk`, `account_id uuid`, `generation bigint`, `captured_for text` (`migration` \| `fault`), `checkpoint bytea`, version columns as in `hunts`, `created_at` | index `(account_id, created_at desc)`; written only by migration (layer-1 §4.7 "retain the old artifacts") and by fault capture (layer-1 §11) |
| `account_drop_protection` | `(account_id, reward_tier) pk`, `counter integer`, `updated_at` | `check counter >= 0`; committed in the same transaction as the reward that changed it (layer-1 §4.3, §7.3) |
| `hunt_reports` | `id uuid pk`, `account_id uuid fk`, `generation bigint`, `payload jsonb`, `created_at`, `expires_at` | index `(account_id, created_at desc)`; retention per open decision (layer-1 §8.2 "bounded retained away summaries") |
| `command_results` | `(account_id, idempotency_key) pk`, `operation text`, `request_hash bytea`, `response jsonb`, `state_version_after bigint`, `created_at`, `expires_at` | index `(expires_at)`; retention per open decision |
| `resource_audit` | `id bigserial pk`, `account_id uuid`, `occurred_at timestamptz`, `reason text`, `source_ref text`, `delta jsonb`, `state_version_after bigint` | index `(account_id, occurred_at desc)`; index `(source_ref)`; append-only, no update or delete grant for the application role |
| `account_grants` | `id uuid pk`, `account_id uuid`, `grant_key text`, `kind text`, `payload jsonb`, `granted_at`, `granted_by text` | unique `(account_id, grant_key)` makes onboarding and admin grants idempotent (layer-1 §7.4, §8.2) |
| `maintenance` | single row: `frozen boolean`, `cutoff_at timestamptz null`, `note text`, `updated_at`, `updated_by text` | `check` enforcing exactly one row; required so the §4.7 cutoff is durable and visible to every process |

**Transaction boundaries.**

- **T1 — auth.** Registration, login, logout and reset commit alone. They do not touch `state_version`, because it covers gameplay mutations (layer-1 §8.1).
- **T2 — gameplay command.** One short transaction containing, atomically: progression rows, item/stack rows, gold, `resource_audit`, `account_drop_protection`, `hunts` (checkpoint plus its version and anchor columns), `command_results`, and the `state_version` increment of P-20 (layer-1 §8.1 step 4, §4.3).
- **T3 — periodic live checkpoint.** Uses the same T2 shape, including the version increment, because it persists earned rewards. This is precisely why a town draft formed before it conflicts (P-23) rather than silently overwriting it (layer-1 §4.4 item 6).
- **T4 — maintenance settlement.** T2 per account, driven by the CLI while the freeze flag is set.
- **P-27** No gameplay write occurs outside T2/T3/T4. Test: revoke `UPDATE` on gameplay tables from any role other than the application role, and assert an integration run where a simulated crash between worker completion and commit leaves zero partial rows — no reward without its audit row, no checkpoint without its progression (layer-1 §11 "replay from the durable checkpoint and commit once; no duplicated rewards").

**Checkpoint blob.** The complete checkpoint of layer-1 §4.3 lives in `hunts.checkpoint`, one row per account, as a single value; it is not split across tables, because §4.3 requires resumption without hidden process state. It is versioned by four columns read before any use: `checkpoint_schema_version` (this envelope), `simulation_version`, `content_version` and `grid_hash` — the same quadruple the simulation validates on decode (contracts §3). The envelope wraps the `SimState` produced by `@narok/sim` together with the account-scoped fields §4.3 names that are not simulation state (reward sequence namespace, pity inputs, pending preset snapshot, wipe counters, presence anchors).

- **P-28** Loading a checkpoint whose four version columns do not match the deployed pins fails closed with `WRONG_VERSION`; the server never substitutes a version to make a replay succeed (layer-1 §11 "content mismatch"; contracts §3).
- **P-29** Reward identifiers are derived from the persisted hunt namespace plus reward sequence and are unique per account; the server does not generate them with a UUID function (layer-1 §4.3). Test: replaying a segment from the durable checkpoint after an induced crash produces the same reward identifiers and inserts no duplicate `resource_audit` rows.
- **P-30** Encoding is canonical, not `jsonb`: PostgreSQL's `jsonb` normalizes key order and numeric representation, which would destroy the byte-equality the determinism tests depend on (contracts §3). See **OPEN DECISION — checkpoint column type, encoding and size cap**.

### 6. Version updates and migration runbook (layer-1 §4.7)

Preconditions, checked and recorded before step 1: a verified restore of the current backup into a clean database (layer-1 §8.4); the outgoing simulation/content artifacts retained and addressable by version; the incoming migration applied successfully to a copy of production data; and a rollback target recorded (backup label plus outgoing artifact versions).

| Step | Action | Verification before proceeding |
|---|---|---|
| 1 | `admin maintenance freeze --cutoff <t>` sets `maintenance.frozen` and `cutoff_at`. `api` then answers every mutating route and every `ack`-driven release with `MAINTENANCE`; reads stay available | No gameplay mutation commits after `cutoff_at`: assert `max(resource_audit.occurred_at) <= cutoff_at` |
| 2 | Settle each hunt to its eligible cutoff under the **outgoing** simulation and content versions, respecting the offline cap and stop conditions (layer-1 §4.7 step 2, §4.6) | Every `hunts` row has `sim_anchor_ms` consistent with its settlement and no account has unsettled eligible time |
| 3 | Persist the settlement (T4), then copy each `hunts.checkpoint` into `hunt_checkpoint_archive` with `captured_for = 'migration'` | Archive row count equals hunt row count |
| 4 | Run schema, content and placement migrations; recompute derived values; apply the defined HP/MP adjustment rule; write new-version checkpoints (layer-1 §4.7 steps 3–4) | The HP/MP adjustment rule is a gate: see **OPEN DECISION — HP/MP adjustment on maximum change**, which layer-1 §5.3 and §15 leave open |
| 5 | Resume: clear the freeze, set new wall/sim anchors, bump every hunt `generation`, and notify clients of changed content or reset placements (layer-1 §4.7 step 5) | Clients observe a `generation` increase and take a `snapshot`; no pre-migration event is played (P-15) |

- **P-31** Maintenance downtime is never simulated afterwards. Test: for a hunt spanning the window, settled sim time excludes the freeze interval and the post-resume anchor starts at resume (layer-1 §4.7).
- **P-32** Rollback: while the freeze holds and before step 5, rollback restores the recorded backup label and redeploys the outgoing artifacts; the archived checkpoints are the replay source. After step 5 rollback is a restore-and-replay operation with acknowledged data loss back to the backup label, so step 5 is the point of no return and must be recorded as such in the runbook execution log.
- **P-33** A hash is not a replay artifact: the outgoing content bundle itself is retained until the post-migration recovery verification passes (layer-1 §4.7).
- **P-34** The whole runbook is exercised on the target deployment setup before invitations, including a backup restore and a migration settlement (layer-1 §8.4, §12 "server, client, and operations").

### 7. Administration, recovery and the error taxonomy

The admin CLI can: grant and revoke beta premium; reset a password; freeze/unfreeze maintenance; run settle/migrate/resume; capture a fault bundle; and read an account's audit trail (layer-1 §8.4, §10). It cannot grant gold, items, EXP or levels outside the idempotent `account_grants` path, and it has no route that writes a checkpoint by hand.

- **P-35** Every administrative action writes an `account_grants` row (for grants) and a `resource_audit` row with `reason` and the operator identity in `source_ref`, and never records a secret (layer-1 §8.4). Test: an admin reset produces an audit row and no password material anywhere in it.
- **P-36** Grants are idempotent by `(account_id, grant_key)`: repeating the same onboarding or admin grant is a no-op (layer-1 §7.4, §8.2).
- **P-37** Premium is a bookkeeping entitlement only; no admin action can change a running hunt's rules or outcomes, and beta premium has no simulation modifier (layer-1 §4.6, §10). Test: granting and revoking premium mid-hunt leaves the checkpoint's canonical encoding unchanged apart from the unrelated fields the command time advances.
- **P-38** On an invalid simulation state the server rolls back the failing segment, keeps the last valid checkpoint, writes a `hunt_checkpoint_archive` row with `captured_for = 'fault'` plus the reproduction inputs, sets `hunts.status = 'faulted'` with `faulted_reason`, and stops automatic retries. No wipe penalty and no invented town settlement (layer-1 §11). Recovery to town is an explicit, validated player or operator action.

**Bounded error taxonomy.** The API returns exactly these codes; they are stable identifiers, never localized text (layer-1 §9, §11). The names below are derived one-to-one from the failure classes the parent documents enumerate; the WebSocket-only codes reuse milestone A's worker-contract vocabulary.

| Code | HTTP | Meaning | Retryable | Source |
|---|---|---|---|---|
| `VALIDATION` | 400 | Schema, range or shape failure; `field` names the path | no | layer-1 §8.1 |
| `UNAUTHENTICATED` | 401 | Absent, expired or revoked session | no | layer-1 §8.3 |
| `INVALID_CREDENTIALS` | 401 | Login failure; never distinguishes unknown email from wrong password | no | layer-1 §8.3 |
| `FORBIDDEN_ORIGIN` | 403 | Origin allowlist rejection on a mutation or upgrade | no | layer-1 §8.3 |
| `NOT_OWNED` | 403 | Referenced object is not the account's | no | layer-1 §8.1, §8.3 |
| `NOT_FOUND` | 404 | Unknown object the account could otherwise own | no | layer-1 §8.1 |
| `EMAIL_TAKEN` | 409 | Registration conflict | no | layer-1 §3 |
| `CONFLICT_STATE_VERSION` | 409 | Optimistic-concurrency guard failed; body carries current `stateVersion` | yes, after refetch | layer-1 §8.1, §11; UI spec §5 |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Same key, different input | no | layer-1 §8.1 |
| `CONTENT_VERSION_MISMATCH` | 409 | Client content pin differs from the server's; client refetches | yes, after refetch | layer-1 §11 |
| `HUNT_FAULTED` | 409 | Hunt is faulted; only the explicit recovery action is accepted | no | layer-1 §11 |
| `RULE_VIOLATION` | 422 | Business rule refused a well-formed command; `field` names the rule | no | layer-1 §8.1 |
| `RATE_LIMITED` | 429 | Per-account or per-source limit; `Retry-After` set | yes | layer-1 §8.3 |
| `INTERNAL` | 500 | Unclassified server failure; no detail leaks | yes | layer-1 §11 |
| `MAINTENANCE` | 503 | Freeze active | yes, later | layer-1 §4.7 |
| `STALE_GENERATION` | ws | Message addressed a superseded generation | no | worker contract; layer-1 §4.4 |
| `PROTOCOL` | ws | Invariant violation in the message stream | no | worker contract; contracts §7 |
| `BACKPRESSURE` | ws | Unacknowledged output exceeded its bound; socket closed | yes, reconnect | layer-1 §8.3 |

- **P-39** No other code reaches a client. Test: enumerate the codes emitted across the whole integration suite and assert the set is a subset of this table. Simulation error codes (`INVALID_STATE`, `LOOP_DETECTED`, `TIME_REWIND`, …, contracts §3) are internal diagnostics recorded with the fault bundle; see **OPEN DECISION — simulation error-code exposure**.

### 8. Operations limits

Layer-1 §8.3 requires caps on message sizes, connections, worker jobs and pending output with backpressure, and §13 requires worker concurrency and memory to be sized from measurement. Milestone A measured a workstation only; **the single-VPS concurrency target is an open gate and was not tested on the target VPS** (milestone A results §6.5), and the sub-second catch-up goal is recorded as evaluated, not met (results §6.6). Nothing in this section may be written as though either had passed.

| Bound | Unit | Value |
|---|---|---|
| HTTP request body | bytes | open decision |
| WebSocket inbound message | bytes | open decision |
| Concurrent sockets per account | count | open decision |
| Unacknowledged outbound events per socket | count | open decision, enforced by P-14's `ack` and `BACKPRESSURE` |
| Catch-up worker pool size | count | open decision, sized from VPS measurement (layer-1 §13) |
| Queued catch-up jobs | count | open decision; overflow returns `RATE_LIMITED`, never an unbounded queue (layer-1 §4.8) — **not built in B: catch-up runs inline with no queue (R202, open pre-invite gate)** |
| Per-job scheduled-event budget | count | reuse the simulation's `maxScheduledEvents` yield mechanism; continuation chunks preserve the split invariant (contracts §5, layer-1 §4.8) |
| Checkpoint blob size | bytes | open decision |

- **P-40** Every bound above is configuration, is logged at startup, and has a test that drives the system past it and asserts the documented refusal rather than degradation (layer-1 §8.3).
- **P-41** Operational metrics are exported for: failed/faulted hunts, worker queue depth and latency, transaction conflict rate, catch-up duration percentiles, and resource anomalies detected against `resource_audit` (layer-1 §8.4).
- **P-42** Backups are stored outside the single VPS failure boundary and a restore into a clean database and application environment is executed and recorded before invitations (layer-1 §8.4). Cadence, retention and objectives: see **OPEN DECISION — backup cadence, retention and objectives**.
- **P-43** Before invitations, the operations checklist of layer-1 §8.4 is executed and recorded: crash recovery, duplicate requests, concurrent inventory changes, socket expiry and bounded catch-up load, each as a named test with stored output.
- **P-44** The VPS load exercise of layer-1 §13 (100 concurrent players as a target, not a claim) is scheduled in Phase C (phases, Phase C) and its result must be published before the concurrency gate is described as closed.

### 9. Open decisions

1. **OPEN DECISION — session token format, lifetime and concurrent sessions.** Layer-1 §8.3 fixes the cookie attributes and login rotation but not the credential's shape, lifetime, sliding-renewal behaviour, or whether logging in on a second device revokes the first. Options: (a) opaque 256-bit random token, hashed at rest, fixed absolute lifetime plus idle timeout, multiple concurrent sessions allowed; (b) same, but single-session-per-account; (c) signed JWT with short expiry and a refresh token. Tradeoff: (a) keeps revocation instant and P-10/P-11 trivially testable at the cost of a session lookup per request; (c) reduces lookups but makes revocation eventual, which contradicts §8.3's "expiring/revoked sessions lose socket access". Recommendation: (a), with the absolute and idle lifetimes and multi-tab policy decided together with the socket-per-account bound.
2. **OPEN DECISION — argon2id parameters and password policy.** §8.3 names argon2id but no cost parameters, and no document states a minimum length, composition rule or breach-list check. Options: tune memory/time/parallelism to a target verification cost on the VPS, versus adopting a library default. Tradeoff: defaults may be either too weak or too expensive for the single VPS under login bursts. Recommendation: choose parameters by measuring verification latency on the target VPS under the login rate limit, record them in configuration with a `password_hash` algorithm tag so rehash-on-login is possible, and adopt a minimum-length-only policy with no composition rules.
3. **OPEN DECISION — registration gating.** §8.4 speaks of "before inviting players" and §8.3 defers the identity-check process, but no document says whether registration is open or invitation-gated. Options: open registration; invite-code required; admin-created accounts only. Tradeoff: open registration makes the rate limits and the abuse surface the primary defence for a single VPS; invite codes bound the population and match the beta framing. Recommendation: invite-code gating during closed beta, with codes as idempotent `account_grants`-style rows so redemption cannot be replayed.
4. **OPEN DECISION — admin recovery identity check and credential handoff.** Explicitly left open by layer-1 §8.3. Options: out-of-band contact through the invitation channel with a one-time password valid for a short window; operator-set password delivered in the same channel; a time-limited reset link. Tradeoff: a one-time password keeps the admin from ever knowing a durable credential; a link reintroduces the email dependency beta excludes. Recommendation: one-time password with a short validity, forced change at first use, session revocation on redemption, and an audit row per issuance. Must be decided before invitations.
5. **OPEN DECISION — character name normalization and uniqueness.** Layer-1 §5.1 marks names 3–16 characters and globally unique as proposed, with normalization, case handling and the allowed character set unspecified. Options: ASCII-only case-insensitive; Unicode NFKC with a confusable-folding index; Unicode allowed but uniqueness on a folded key. Tradeoff: PT-BR is a first-class language (layer-1 §3), so ASCII-only is user-hostile, while confusable folding is the only option that makes "globally unique" meaningful. Recommendation: store the display name as entered, enforce uniqueness on an NFKC-folded, case-folded key in a generated column with a unique index, and decide the allowed category set explicitly.
6. **OPEN DECISION — checkpoint column type, encoding and size cap.** Not settled by any document. Options: (a) `text`/`bytea` holding the canonical JSON that `encode()` produces; (b) `jsonb`; (c) compressed `bytea`. Tradeoff: `jsonb` reorders keys and renormalizes numbers, which breaks the byte-equality the determinism and split-invariance tests rely on (contracts §3); compression saves space but adds a codec to the replay artifact set. Recommendation: (a) `bytea` containing canonical JSON with a configured maximum size that is enforced before insert and surfaced as `INTERNAL` with a fault capture, not as a truncation; revisit compression only if measurement on the VPS justifies it.
7. **OPEN DECISION — rate limits and resource bounds.** §8.3 mandates the limits without values, and §13 requires sizing from measurement that the open VPS gate has not produced. Options: provisional conservative constants now, tightened after the VPS load exercise; or block on measurement. Tradeoff: blocking stalls milestone B; provisional constants risk being wrong but are configuration, not schema. Recommendation: ship provisional constants as configuration with P-40's refusal tests, and treat the final values as a Phase C deliverable attached to the concurrency gate.
8. **OPEN DECISION — retention windows for `command_results`, `hunt_reports` and `resource_audit`.** §8.2 says reports are "bounded" and `command_results` carries "retention metadata" without values. Options: time-based expiry; count-per-account caps; both. Tradeoff: idempotency keys must outlive any client retry window or P-25 becomes untestable in practice; audit rows are the only defence against resource anomalies (§8.4) and should outlive reports. Recommendation: expire `command_results` on a window comfortably longer than the client's maximum retry/backoff schedule, cap `hunt_reports` per account by count and age, and retain `resource_audit` for the whole beta without automatic deletion.
9. **OPEN DECISION — conflict retry bound and backoff.** §8.1 requires bounded retries without a number. Options: fixed small attempt count with jittered backoff; deadline-based retry. Tradeoff: too many retries turn a contended account into a latency sink on a single VPS; too few surface avoidable conflicts to the player. Recommendation: a small fixed attempt count with jittered backoff and a per-command deadline, both configuration, with a test asserting exhaustion returns `CONFLICT_STATE_VERSION` rather than looping.
10. **OPEN DECISION — catch-up execution substrate and queue durability.** §4.1 says "worker pool for catch-up" without saying `worker_threads` versus child processes, or whether the queue survives a restart. Options: (a) in-process `worker_threads` with an in-memory queue; (b) child processes with an in-memory queue; (c) a Postgres-backed job table. Tradeoff: catch-up is recomputable from the durable checkpoint, so queue durability buys little; child processes isolate memory and crashes at higher cost; a job table adds contention to the same database the commit path uses. Recommendation: (a), because a lost job is re-derived on the next reconnect (layer-1 §4.4 item 2) — confirm against the memory measurements from the VPS exercise before Phase C.
11. **OPEN DECISION — scheduler process boundary.** No document names a scheduler process; the periodic work in P-05 nonetheless exists. Options: timers inside `api`; a separate scheduler container; cron invoking the admin CLI. Tradeoff: a separate process adds a deployment unit to a single-VPS target for work measured in seconds per hour; in-process timers must be made restart-safe and must not double-run if `api` is ever scaled to two instances. Recommendation: in-process timers with a durable per-job "last completed at" record and an advisory lock, and an explicit note that scaling `api` beyond one instance requires revisiting this.
12. **OPEN DECISION — concurrent sockets per account and multi-tab behaviour.** Layer-1 §12 requires multiple tabs to be tested but does not say what they should do. Options: one socket per account with the newest winning; N sockets all receiving the same frames; one socket with the others degraded to polling. Tradeoff: fan-out multiplies the pending-output bound per account; a newest-wins rule is simple but makes a background tab silently die. Recommendation: allow a small fixed number of sockets per account, all receiving identical frames from one release path, with the bound counted per account rather than per socket.
13. **OPEN DECISION — same-origin hosting of the client.** §13 fixes Caddy on one VPS but does not say whether `apps/client` is served from the same origin as the API. This determines whether the `SameSite=Lax` cookie of §8.3 works without further measures and what the Origin allowlist contains. Options: same origin with Caddy path-routing; separate subdomains. Tradeoff: same origin makes cookie auth and the allowlist trivial; subdomains require the cookie to be host-scoped correctly and enlarge the allowlist. Recommendation: same origin, with the allowlist containing exactly that origin plus the local development origin.
14. **OPEN DECISION — simulation error-code exposure.** Contracts §3 defines `SimErrorCode`, and layer-1 §11 requires a stable code for invalid commands, but nothing says whether simulation codes reach the client. Options: map every simulation error to `INTERNAL` plus a fault bundle; expose a subset (`WRONG_VERSION` as `CONTENT_VERSION_MISMATCH`); expose all. Tradeoff: exposing all leaks engine detail and grows the taxonomy past "bounded"; mapping all to `INTERNAL` loses the one distinction the client can act on, which is a version mismatch. Recommendation: map `WRONG_VERSION` to `CONTENT_VERSION_MISMATCH` and every other simulation code to `INTERNAL` with a fault capture.
15. **OPEN DECISION — backup cadence, retention and objectives.** §8.4 requires off-host backups and a tested restore but states no cadence, retention or recovery objectives. Options: periodic logical dumps; continuous WAL archiving with point-in-time recovery; both. Tradeoff: PITR bounds data loss to minutes and makes the §4.7 rollback target precise, at the cost of an archiving pipeline on a single VPS; dumps alone make rollback coarse and put the migration runbook's point of no return at greater risk. Recommendation: WAL archiving to off-host storage plus periodic full dumps, with explicit recovery point and recovery time objectives recorded and a restore drill executed on a stated schedule before invitations.
16. **OPEN DECISION — HP/MP adjustment on maximum change.** Required by the migration runbook step 4 and left open by layer-1 §5.3 and §15 ("HP/MP adjustments on stat/max changes"). It is listed here because migration cannot be executed without it, not because this section should decide it. Options: preserve absolute values and clamp; preserve the ratio; preserve absolute for increases and ratio for decreases. Tradeoff: ratio preservation can heal or harm a party during maintenance, which conflicts with §4.5's rule that transitions never grant free recovery; absolute-with-clamp never heals but can leave a character at a low fraction after a large maximum increase. Recommendation: absolute value preserved and clamped to the new maximum, decided jointly with the progression section before any migration is run.
