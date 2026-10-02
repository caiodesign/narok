# Part 4 — Client contracts, screens and acceptance

Part of the [milestone B technical specification](../../2026-09-21-milestone-b-spec.md). **Draft, 2026-09-21** —
not accepted; the open decisions at the end of this part are the owner's and nothing here is
implementable until they are recorded. [Layer 1 design](../../layer-1-design.md) and the
[Realm UI specification](../../2026-09-16-realm-ui-spec.md) outrank this document.

Section numbers below are local to this part; cross-part references name the part. Gate ids in this part are `B-nn` and cover the whole milestone, not only the client.

Milestone A did not build a throwaway client. `apps/client` is a ported, measured, tested Realm
Refined implementation of two of the five approved screens, and both ports carry binding rulings
(`docs/realm-hunt-port.md` R106–R110, `docs/realm-strategy-port.md` R111–R113). This section states
what survives the move to an authoritative server, what must be taken away from the client, how the
three unbuilt screens are contracted, and how each claim is proven. It adds no gameplay rule: where it
appears to, the UI spec and layer-1 win (§1).

### 1. The client stops owning time

Today `apps/client/src/useExperiment.ts` is the whole authority: it creates a generation, spawns
`experiment.worker.ts`, runs `@narok/sim` inside it, drives `clock.ts` from `performance.now()`, and
decides when the run starts, pauses, resumes and stops. In B none of that is the client's to decide
(layer-1 §4.4, §4.6: *"Clients never provide authoritative elapsed time"*).

| Concern | A (built) | B |
|---|---|---|
| Simulation | `@narok/sim` in `experiment.worker.ts` | Server only. One simulation package, no second implementation (§2.1). |
| Clock | `clock.ts` drives a worker `advance` | `clock.ts` paces **rendering only**, anchored to server-released time |
| Generation | `generationRef` incremented locally by `start` | Hunt generation assigned by the server (layer-1 §4.4) |
| Start / stop | Local, immediate | A command; the client shows *pending* until acknowledged (UI spec §4) |
| Seed | Operator-chosen in `LabInput` | Owned by the hunt, never disclosed (layer-1 §8.3, §2.3) |
| State shape | `PublicState` + `DomainEvent[]` | The same projection over the wire (contracts §3) plus account state |

**Kept verbatim.** `styles.css:1-754` and `strategy.css:1-653` (R107, R113 — not editable, and the two
`diff` commands in the port records stay the acceptance test); `apps/client/src/hud/` — `Battlefield`,
`Compass`, `PartyPanel`, `TargetFrame`, `CommandBar`, `ChatPanel`, `SessionPanel`, `WorldBackdrop`,
`SpriteSheet`, `OrdersPanel`, `SetupOverlay`; `hud/model.ts` as the view-model adapter;
`hud/strategy/{FormationPane,CharacterPane,PartyRulesPane,board.ts}` with R111's derived geometry and
R112's picture/controls split; `EventLog.tsx`; `i18n.ts` and `locales/*`; `clock.ts`; `setup.css`'s
four residual concerns. None of these needs to know where the state came from — `hud/model.ts` takes
`PublicState`, not a worker.

**Lost.** `experiment.worker.ts` and the simulation half of `worker-contract.ts` leave the production
bundle. `LabInput` stops being a start payload: seed, placement and strategies are account records,
not form output. `validation.ts` survives only as pre-flight feedback — the server's validation is the
one that counts (layer-1 §8.1) and the client must render the server's stable error code, never its
own English (layer-1 §9, §11). `apps/client`'s R51 "no network request at runtime" is a laboratory
rule and does not survive (§2.3).

**Migration path, by file.**

| File | Change |
|---|---|
| `apps/client/src/useExperiment.ts` | Split. Keep `UseExperimentResult`'s shape — `{state, events, status, start, pause, resume, stop}` — as the hook contract so `App.tsx` and every `hud/*` prop type is unchanged, and re-implement the body over the transport. Recommended target file `apps/client/src/useHunt.ts`, with `useExperiment.ts` retained only if the laboratory survives (open decision below). |
| `apps/client/src/worker-contract.ts` | Becomes the client half of the wire protocol (recommended `apps/client/src/protocol.ts`), keeping the discriminated-union style and the `generation` field on every message. Its `WorkerErrorCode` already carries `STALE_GENERATION` and `PROTOCOL`; both keep their meaning against a socket. |
| `apps/client/src/clock.ts` | Unchanged as a module. `PlaybackClock.simAnchorMs` is re-anchored from the server's released clock on every snapshot and on reconnect instead of from a local `start`. `reanchor`/`horizon` are already pure and already subtract the buffer exactly once. |
| `apps/client/src/ExperimentControls.tsx` | Keeps the draft, seating, keyboard model and validation; gains the preset lifecycle its own port record defers to B (§3.2). |
| `apps/client/src/App.tsx` | Composition only; swaps `useExperiment` for the hunt hook and adds routing to the three new screens. |
| `apps/client/src/hud/LabStrip.tsx`, `hud/RunsPanel.tsx`, `exportSession.ts` | Laboratory surfaces with no production referent (session export, retained comparison slots). Removed from the game shell; see the laboratory-retention decision. |
| `apps/client/src/BattlefieldView.tsx`, `Comparison.tsx`, `art-manifest.ts`, `pixi.js` | The Hunt port's "Known debt" — unreachable from `main.tsx` but still under test. B is the deliberate decision that record asks for, not a drive-by deletion. |

The client must import `@narok/sim` **type-only** in B. Types are the wire schema; the engine is not
shipped to the browser. This is testable (B-02) and it is what makes "no client-side authority"
mechanical rather than aspirational.

### 2. Playback contract

Layer-1 §4.4 fixes five rules the client obeys without exception: the server releases outcome events
only after their authoritative timestamps have elapsed (4); the client plays roughly two seconds
behind 🟡 (5); a future-window request cannot move the authoritative clock or expose the private
precompute buffer (5); protocol messages carry a hunt generation and an event sequence (closing
paragraph); a transport reconnect may discard the local animation queue and resynchronise from a
current snapshot.

1. **Render horizon.** The client renders at `horizon(clock, now())` — `clock.ts`'s existing
   `simAnchorMs + elapsed·speed − bufferMs`, floored and clamped at zero. `bufferMs` is the 2,000
   simulation-ms buffer A shipped (A spec §11), 🟡 in layer-1 §4.4. Events with `at > horizon` are
   held, never drawn: the rule filters the render path, not the transport.
2. **Never future.** No screen may read a field implying an unreleased outcome. `PublicActor` exposes
   `casting` without its result (contracts §7) and `PublicState` carries no queue and no `rng`. A
   payload containing a seed, an RNG word or an event whose `at` exceeds the server's released clock
   is a protocol invariant error, surfaced as one (A spec §11's batch-bound rule, carried forward),
   never silently dropped.
3. **Generation and sequence.** Every frame carries `{generation, seq}`. A frame for a generation the
   client no longer owns is discarded, exactly as `useExperiment.handleMessage` already discards a
   stale worker generation. A *newer* generation means the server re-anchored the hunt (intervention,
   recovery, maintenance settlement — layer-1 §4.4.7, §4.7): the client drops its pending animation
   queue and its `events` history, requests a snapshot, and re-anchors from it. It must not splice new
   events onto the old history.
4. **Sequence gaps.** `seq` is contiguous per generation. A gap triggers resynchronisation, not
   interpolation: request a snapshot, guess no missing event, renumber nothing.
5. **Resynchronisation.** A snapshot is `{generation, seq, releasedUntilMs, PublicState, account
   state}`. On receipt the client replaces state wholesale, sets `simAnchorMs = releasedUntilMs` and
   `realAnchorMs = now()`, clears `events`, and resumes. History before the snapshot is gone by design
   — the log is a bounded display buffer (500 rows in A), not a record.
6. **Reconnect.** Connect → the server settles accrued progress from the stored anchors *before*
   refreshing presence (layer-1 §4.4.2, §4.6) → the client receives an away report plus a current
   snapshot, shows the report (§3.5) and resumes from the snapshot. The report is a consequence of
   reconnecting; the client never asks for credit.
7. **Starvation.** If `horizon` overruns the newest released event, hold the last frame and show a
   buffering state. Never extrapolate combat.

| Playback state | Entered when | Client shows | Client must not |
|---|---|---|---|
| `live` | released events ahead of the horizon | the world, animated (R110) | — |
| `buffering` | horizon caught up to the release edge | last frame, an explicit indicator | extrapolate, or animate as if fighting |
| `resyncing` | generation bump or sequence gap | explicit resynchronising state, queue dropped | play the discarded queue |
| `disconnected` | socket loss | last frame, reconnect with backoff (layer-1 §11) | accrue locally, or report progress |
| `stale-generation` | frame for a generation the client no longer owns | nothing; discard the frame | apply any field from it |
| `faulted` | server marks the hunt faulted (layer-1 §11) | the fault, the last valid state, the explicit recovery action | retry automatically, or offer a normal restart |

Playback speed is a laboratory affordance (1×/4×/16×, `ALLOWED_SPEEDS` in `useExperiment.ts`) and its
production meaning is unsettled — see **OPEN DECISION — production playback speed**.

### 3. Per-screen contracts

Wire names and payload schemas for every command below belong to the protocol section (§4); this
section fixes the *intent*, the states and the prohibitions. "Never" lines are acceptance criteria,
not advice.

#### 3.1 Hunt

Reuses the whole ported shell: `App.tsx`'s `.realm` composition, `hud/Battlefield`, `hud/TargetFrame`,
`hud/PartyPanel`, `hud/SessionPanel`, `hud/Compass`, `hud/CommandBar`, `hud/ChatPanel` + `EventLog`,
`hud/OrdersPanel`, `hud/WorldBackdrop`, `hud/SpriteSheet`, `hud/model.ts`.

- **Reads:** projected hunt state and released events (§2); account state for wallet, bag occupancy
  and zone; the active strategy version's identity (§3.2); the hunt's stop reason and cap status.
- **Writes:** nothing directly. Every mutation is a command.
- **Commands:** start hunt (map, party, strategy preset, loot preset); stop hunt; resume hunt; open the
  strategy editor (client-local). Transport verbs are constrained by **OPEN DECISION — Stop and Resume
  semantics**.
- **States:** no hunt; start pending; running (`live`/`buffering` per §2); stop pending; stopped with
  its actual reason; capped (accrual stopped, distinct from a combat failure — UI spec §8); faulted;
  bag full while hunting.
- **Must show:** ready, active, cooldown, casting, unavailable and passive skill states distinctly and
  with animation disabled; the factual waiting reason on inspection (cooldown remaining, insufficient
  MP shown with the cost, condition not met, invalid or out-of-range target) with a link to the rule
  that governs it; Combat/Loot/System log tabs over one bounded history with scroll preservation and
  return-to-latest; observed rates with their measurement window and an em dash at zero duration (UI
  spec §4, layer-1 §9). `ChatPanel` omits the Loot tab today because A publishes no loot event (R108);
  B publishes loot, so the tab returns by **binding**, not by inventing a row. ~~`hud/Compass`'s death
  pips already count real wipes against a real limit and keep doing so.~~ *Superseded (owner decision
  2026-09-30, R154): there is no wipe limit; the compass shows the wipe count alone, with no limit to
  measure it against (`hud/Compass.tsx`).*
- **Never:** cast a skill on click — inspection only; show number-key casting hints; render a passive
  as a cast button; infer a guaranteed future cast; show "time until death" or any survival forecast;
  present Stop/Resume as done before the server acknowledges it; fill a panel with a placeholder (R108
  survives unchanged — loot, wallet and zone are bound in B because they are now real).
- **Removed from the shell:** `hud/LabStrip` and `hud/RunsPanel` have no production referent.

#### 3.2 Strategy

Reuses `ExperimentControls.tsx` and `hud/strategy/{FormationPane,CharacterPane,PartyRulesPane}` with
`board.ts`. `docs/realm-strategy-port.md` explicitly deferred the preset tabs, Revert, Save preset,
Apply next encounter and the unsaved-draft markers to B ("Save-versus-apply is milestone B (UI spec
§5)"). Building them completes that port; it does not contradict it. R111 (board derived from
`content.grid`, never transcribed), R112 (SVG scenery plus a `role="grid"` of buttons) and R113 (only
position and wrapping may be restated) bind every line of the work.

The lifecycle is UI spec §5's table, restated as client behaviour:

| Action | Client contract |
|---|---|
| Edit | Mutates the draft only. No command. Running hunt untouched. Draft marked unsaved (the `.unsaved` chrome exists in the reference). |
| Save preset | Command: save a versioned preset. Does not change a running hunt. Clears the unsaved marker on acknowledgement, not on click. |
| Apply next encounter | Command: save **and** queue that exact validated version. Shown as *pending* until acknowledged and until the server reports it active. |
| Revert | Restores the last saved preset, including toggles, thresholds and placement. Local; no command. |
| Close with unsaved changes | Offer Keep editing / Discard / Save. Never silently lose the draft. |

- **Reads:** saved presets and their versions; the **active** version the running hunt is using; the
  **pending** version, if any; content for legal cells, modes and conditions.
- **States:** draft clean / dirty; saved vN; active vN; pending vM, shown separately from active; apply
  pending acknowledgement; conflict (stale write) with a recoverable message; pending restored after
  reconnect.
- **Never:** apply on save; mutate a queued snapshot when the saved preset is later edited (the queue
  holds a snapshot, not a reference); show a projected-effect number, a survival estimate or a
  decorative predictor slider (UI spec §5, §9); show a fourth premium preset tab (§2.2); offer target
  modes or conditions the gameplay contract does not support, or at the wrong scope; put the basic
  attack inside the reorderable list, or a passive in it at all; let a Stop secretly activate the
  pending version or reset encounter state.
- **Sequencing the client renders but does not implement:** an apply settles elapsed progress to the
  server cutoff, activates before the next encounter is spawned (including after walking and resting),
  and waits out a fight in progress (UI spec §5, layer-1 §4.5). The client's job is to show which of
  those the hunt is in, and that the pending version has not taken effect yet.
- Carried debt: the character tabs ellipsize their class name in the narrow middle column; the class is
  repeated on the select below and the ported rule is not editable (strategy port, Known debt).

#### 3.3 Bag and loot filter

New. No component exists; `codex-examples/realm-refined/bag.html` is the shape reference and every
number in it is a fixture (UI spec §9). Stylesheet discipline is an open decision below.

- **Reads:** inventory items and stacks with stable ids, rarity, level and bonuses; bag capacity and
  occupancy; wallet; equipped-by character and slot; the active and draft loot presets; recent drop
  records for the preview.
- **Writes:** the loot-filter draft, locally, labelled unsaved and preserved across recoverable failures.
- **Commands:** save loot preset; apply loot filter (versioned with the hunt state — UI spec §6); lock
  and unlock an item; sell an item (deliberate confirmation for protected valuables, unlock first for
  locked ones); bulk sell unlocked; equip and unequip (town only). Retriable mutations carry an
  idempotency key (layer-1 §8.1).
- **States:** search, category tab, sort, selection, pin and unpin — all functional when the screen
  ships (UI spec §6); hunting versus town (inspection allowed, equip explained as "Return to town to
  equip"); under-level, stating required and current levels; empty target slot; locked; protected;
  preview result carrying proposed disposition, matching rule and the difference from the active
  filter; bulk-sale preview then reconciliation with the server response.
- **Filter precedence, exactly:** locked items are excluded from bulk sale; Legendary drops are
  protected from automatic sale or ignore and receive Keep; then ordered exceptions top-to-bottom,
  first match wins; then the rarity or default rule with a mandatory fallback for supported categories.
  "Always kept" is a disposition, not capacity — if Keep cannot fit, the configured bag-full policy
  applies.
- **Comparison:** a real eligible character and a real equipped slot or item, actual before/after stats,
  signed deltas, tradeoffs, level/class/slot restrictions, percentage-point differences labelled
  accurately, derived stats from the shared formula module. A bonus count is not an upgrade
  recommendation.
- **Never:** sell a locked item without an explicit unlock; apply a filter retroactively; mutate drop
  records during preview; submit a bulk sale twice; derive slot, category or wallet counters from
  anything but the one returned state; show a Materials tab or a paid bag expansion; silently add a
  lost item to the bag; let a pinned panel hide its equip requirements or actions.

#### 3.4 Character

New. `character.html` is the shape reference: equipment around the silhouette, attributes in the
middle, skills on the right, and selecting a character updates all three consistently (UI spec §7).

- **Reads:** roster and the selected character; equipment per slot; attributes and derived combat
  stats; unspent points; skill ranks, next-rank effects, costs and prerequisites; auto-spend
  configuration; level and EXP.
- **Writes:** a staged allocation draft, local, with unspent versus pending cost shown distinctly.
- **Commands:** apply allocation (validated, committed atomically); upgrade a skill rank; set the
  auto-spend template and its ordered targets. Reset is local.
- **States:** staged / unstaged; per-control cost with a before/after preview; insufficient points;
  stale account state before submission — refresh and revalidate, never overspend and never discard a
  draft without explanation (UI spec §7); town-only lock while hunting; a locked skill naming its
  missing prerequisites; post-commit refresh of rank, point balance, derived effects and dependent
  unlocks together.
- **Never:** badge auto-spend as premium or gate allocation on entitlement; use the mockup's "one skill
  point every 2 levels" — the curve is one at creation and one every four levels (UI spec §9), read
  from content and not hardcoded in a component; treat mockup rolls or suggested attribute deltas as
  balance data; apply a partial allocation; show EXP loss or de-levelling.

#### 3.5 Away report

New. `away.html` is the shape reference. The whole screen is a read of already-settled progress.

- **Reads:** a settled report record; the current hunt state; current inventory, for the action state.
- **Writes:** nothing that credits anything.
- **Commands:** none that grant. Navigation only: **Manage bag** (primary when the bag is full) opens
  the real account bag — the same inventory §3.3 shows, not a separate snapshot; **Return to hunt**
  views the still-running hunt; a restart action appears only when the hunt actually stopped. Any
  dismissal write is idempotent and is not a reward path — see **OPEN DECISION — away report
  acknowledgement and retention**.
- **Must show:** time away and actual simulated duration separately, with cap or stoppage reasons where
  they differ; party outcomes, earned totals, notable loot and the chronological timeline; party wipes
  used this hunt, wipes during this absence, and individual member deaths as three separate counts
  (under the 2026-09-30 owner rules a wipe ends the hunt, so "wipes this hunt" is 0 or 1 — still its
  own count, ruling of Task 10 fix 1); the
  actual stop reason and the correct restart action; a cap distinguished from a combat failure; lost
  Keep drops plus ongoing auto-sales, EXP and gold when the bag filled while hunting.
- **Refresh:** after managing the bag, the report's action state is recomputed from current inventory.
  It must not keep warning that the bag is full once space is freed.
- **Never:** grant on read or reopen; say Collect, Resume or Start when no such operation is needed;
  use EXP-loss language; imply missed drops can be reclaimed; obscure the recovery action with a
  valuable-find highlight; interrupt with a premium comparison; hide the timeline at 1440×900 (internal
  scroll at shorter heights is fine if the primary action stays visible).

### 4. The correction table as client acceptance criteria

UI spec §9 overrides the mockups. Restated so that each line is checkable.

| Correction (UI spec §9) | Client acceptance criterion |
|---|---|
| Premium 17h42m offline cap | No cap string is literal. Remaining time is derived from the server's cap; the shared beta cap is 12h 🟡 (layer-1 §4.6). No premium cap variant exists in any code path. |
| Premium-only stat auto-spend | Auto-spend has no entitlement check and no premium badge anywhere in `apps/client`. |
| Wipe caused 10% level loss | No EXP-loss or de-levelling copy in either locale; no client field represents one. |
| One skill point every 2 levels | The curve comes from content: one at creation, one every four levels. No literal divisor in a component. |
| Time until death / +45m forecast | No forecast component, string or translation key exists. Only observed metrics with an explicit window. |
| Five wipes selected | ~~The wipe limit defaults to one and is configurable 1–5; the bound is read, not typed.~~ *Superseded (owner decision 2026-09-30, R154; Task 11 sweep):* there is no wipe limit — a full wipe ends the hunt and returns the party to town, fully healed (R155). No wipe-limit control, bound or copy exists in either locale. |
| Party focus Highest threat / Element-weak | Only the gameplay contract's per-character target modes appear; monster threat is not offered as a player priority. |
| Extra mana-reserve / buff-refresh controls | Absent until the dependent rules are specified. |
| Group Heal, Shield Wall, buffs, passive ranks | Absent; the skill list is content-driven. |
| Equipment rows, prices, stats, example deltas | Every equipment figure comes from server data. No fixture value is bundled as content. |
| Materials, paid bag expansion, fixed fourth preset | No Materials tab, no purchase affordance, no fourth preset slot. |
| Mock screens showing different account state | One coherent authoritative account state feeds Hunt, Bag, Character and Away. Counters reconcile across screens. |
| LocalStorage and DOM-only mutations | `localStorage` holds exactly one key, `narok.language` (`i18n.ts`). No gameplay state is persisted client-side. |
| Gallery, Compare original, illustrative labels | No gallery route, no compare-original footer, no placeholder labels in the shipped bundle. |

### 5. Accessibility, localisation and performance

- **Key parity.** EN and PT-BR expose exactly the same key set in both directions.
  `apps/client/test/i18n.test.ts` already asserts this and extends to the three new screens. Server
  failures arrive as stable error codes and are localised by the client; a server never sends display
  text (layer-1 §9, §11).
- **Keyboard.** Every action reachable by pointer is reachable by keyboard: placement (R77, R112's
  `role="grid"` of buttons rather than a drag), the log's roving tabindex and return-to-latest (R61,
  R82), the bag grid and its pin and compare actions, the allocation steppers, the report's primary and
  secondary actions, and every internally scrolling region. Focus is visible; no action hides behind
  hover.
- **Colour is never the only signal.** Rarity appears in text as well as accent; cell legality and
  selection carry shape or text; skill states are distinguishable with animation disabled; loot
  dispositions are labelled. Reduced motion keeps information complete and does not suppress newly
  received events (UI spec §3, §4).
- **Per-frame identity (R109).** A published frame carrying no events must not change the `events`
  array's identity. In A the publisher was `useExperiment`; in B it is the socket handler, and the rule
  binds it identically — R109 is written as binding "any future publisher of a per-frame collection".
  The budget is the same: 16.7 ms per frame, against 3.85 ms measured after the rule and 44.4 ms before
  it (Hunt port, R109).
- **Run-state animation (R110).** `body[data-paused]` must track the **authoritative** hunt status in B,
  not the local playback state. A buffering client is still hunting; a stopped hunt is not.
- **Ported stylesheets (R107, R113).** No rule inside `styles.css:1-754` or `strategy.css:1-653` may be
  changed, reordered or deleted, including "only" a value. Additions go in the labelled block or a
  separately imported sheet. R113 permits restating the editor's position and column wrapping and
  nothing else. The two `diff` commands in the port records are the test, not a promise.
- **Layout.** 1440×900 primary, 1280×800 and 1100px validated; no horizontal clipping; internal scroll
  visible, discoverable and keyboard-accessible; long PT-BR names do not hide controls (UI spec §3, §10).
- **Bounded history.** The event log stays bounded and the bound is disclosed rather than presented as
  a complete record; A's value is 500 (`EVENT_HISTORY_LIMIT`). See **OPEN DECISION — event history
  bound in B**.

### 6. Acceptance gates and the evidence plan

**Prerequisites.** Milestone A's three open gates (index §5) are prerequisites, not entries in this list, and
none of them is claimed here to have passed: A-14 the five-tester placement experiment, R64's visual
composition sign-off, and the single-VPS concurrency target. B-22 and B-27 below are the B-shaped
continuations of the second and third; they do not close the A instances.

**Test layers.** *Unit* — vitest in `packages/*` and `apps/client/test/` over pure modules: clock,
protocol reducer, view model, loot evaluator, formulas. *Integration* — server against PostgreSQL in
Docker, plus a client-side fake socket implementing the protocol union, the way
`apps/client/test/experiment-worker.test.ts` fakes the worker today (R56's substitution pattern).
*E2E* — Playwright against the built bundle and a real server. *Load* — a harness of the shape of
`artifacts/batch-100.mjs`, extended from bounded worker jobs to concurrent authenticated accounts, run
on the target VPS.

| ID | Gate | Proof |
|---|---|---|
| B-01 | Ported stylesheets unchanged | The two `diff` commands in `docs/realm-hunt-port.md` and `docs/realm-strategy-port.md` print nothing; run in CI. |
| B-02 | The client runs no simulation | `@narok/sim` is imported type-only across `apps/client/src/**`; the production bundle contains no engine entry point. A lint rule plus a grep over `dist/` with recorded output. |
| B-03 | No future event is ever rendered | Unit: a frame carrying events beyond `horizon` renders none of them. Integration: across a scripted session no event reaches the view model with `at > horizon`. |
| B-04 | The playback buffer holds | `apps/client/test/clock.test.ts` extended: the horizon trails released time by the buffer at every supported speed, and re-anchoring from a snapshot never subtracts it twice. |
| B-05 | Stale generation discarded, newer generation resyncs | Fake-socket integration: a stale frame changes nothing; a newer generation drops the queue and history and requests a snapshot. |
| B-06 | A sequence gap resynchronises instead of interpolating | Fake-socket: a skipped `seq` produces a snapshot request and no invented event. |
| B-07 | Reconnect discards the local queue and resumes from a snapshot | Integration: socket drop mid-hunt, reconnect, away report plus snapshot, no duplicated or reordered event in the log. |
| B-08 | No future outcome, seed or PRNG state reaches a client | Server test over every released payload: `at <= releasedUntilMs`; schema assertion that no payload carries a seed or RNG field (layer-1 §12). |
| B-09 | Hunt skill states and inspection | Component tests: inspection issues no cast command; the states render distinctly with animation disabled; a passive is never a button; the waiting reason is the server's factual one. |
| B-10 | Strategy draft, save, apply, revert, close | Component tests for each row of §3.2's table; active and pending shown separately; editing the saved preset after an apply does not mutate the queued snapshot; a newer acknowledged apply replaces pending; pending survives reconnect; a stale write yields a recoverable conflict message. |
| B-11 | An apply lands at an encounter boundary, never mid-fight | Server integration: an apply issued during a fight settles to the command cutoff and activates before the next spawn, including after walk and rest. |
| B-12 | Bag interaction and comparison | Component tests: search, category, sort, select, pin and unpin; comparison against a real eligible character and slot with signed deltas, restrictions, and an empty-slot case. |
| B-13 | Equip eligibility enforced on both sides | Client: equip disabled while hunting with the "Return to town" explanation, and under-level stated with both levels. Server: the same command rejected with a stable error code. |
| B-14 | Loot filter precedence, preview and apply | Unit tests over the evaluator for each precedence rule; the preview calls the same evaluator the server applies and mutates no drop record; an apply affects only drops after the acknowledged cutoff. |
| B-15 | Bulk sale | Integration: preview count and gold reconcile with the server response; a duplicate submission under the same idempotency key produces one sale; all counters come from one returned state. |
| B-16 | Character allocation and skills | Component and server tests: preview, reset, atomic commit, insufficient points, stale account version refresh-and-revalidate, repeated submission. |
| B-17 | Away report never double-credits | Integration: reopening and refreshing a report credits nothing; the four states (running, stopped, capped, bag full) render the correct copy and actions; counts reconcile with inventory; the action state refreshes after managing the bag. |
| B-18 | Offline and wall-clock semantics | Integration: settle before presence refresh; no retroactive accrual; time away and simulated duration reported separately; multiple tabs and repeated heartbeats (layer-1 §12). |
| B-19 | No corrected mockup content ships | Grep the built bundle and both locale files for each forbidden concept in §4, output recorded, plus a human read of the correction table against the running build. |
| B-20 | Localisation | `i18n.test.ts` parity in both directions across all five screens; every server error code has a message in both languages; the e2e flow runs end to end in PT-BR. |
| B-21 | Accessibility | Keyboard-only traversal of all five screens recorded as a stated human observation; automated checks for focus visibility and reduced-motion completeness; a review that no state is signalled by colour alone. |
| B-22 | Visual composition of the three new screens | Human observation at 1440×900 and 1280×800, no horizontal clipping at 1100px, in EN and PT-BR, with screenshots committed. Automated overflow assertions are necessary and not sufficient — A's results say so explicitly. |
| B-23 | Frame budget and R109 | Measured per-frame HUD cost under a live socket at the highest supported release rate, against the 16.7 ms budget, recorded with the method A used; plus a unit test that an empty batch preserves `events` identity. |
| B-24 | End-to-end smoke | Playwright: login → configure → hunt → elapsed events → return/reconnect → away report (layer-1 §12), in both languages, against the built bundle and a real server. *Ruling R197 (Task 11): B ships no sign-in screen, no party-creation screen and no route that creates a preset, so `e2e/hunt.spec.ts` signs in and creates the party through the real REST routes and seeds the first presets with `apps/server/test/harness/provision-presets.ts`; everything after that is the shipped UI. `vite preview` proxies `/api` and `/ws` to the real server when `NAROK_API_PROXY` is set.* |
| B-25 | Recovery | Kill the server mid-hunt; replay from the durable checkpoint under pinned versions; rewards committed exactly once; uncommitted precomputation never used as a reward source. Transcript and resulting diff recorded. |
| B-26 | Concurrency | A town mutation and a hunt settlement racing on one account: one account state version wins, the loser retries against fresh state, no stale worker result is applied, retried commands are idempotent (layer-1 §8.1). |
| B-27 | Load on the target VPS | Concurrent returning accounts against the single VPS with bounded worker queues, socket limits and output backpressure; p50/p95/p99 and peak RSS recorded on stated hardware. Never claimed from workstation numbers. |
| B-28 | Backup restore and migration settlement | Restore into a clean database and application environment, and settle a maintenance migration under pinned artifacts (layer-1 §8.4, §4.7). |
| B-29 | Content mismatch | The client refetches content and invalidates placement UI on a version change; the server never substitutes versions for replay (layer-1 §11). |
| B-30 | Faulted hunt | An injected invalid sim state marks the hunt faulted, stops automatic retries, charges no wipe penalty, and the client offers only the explicit validated recovery action. |

**`artifacts/milestone-b-results.md` must contain,** in the shape milestone A's results file
established: the build under test (commit, `simulationVersion`, `contentVersion`, `gridHash`, Node and
pnpm versions, working-tree state); every correctness command in the repo-relative form a reader would
type, with exit status, headline result and the path to its raw output; what CI runs and whether a
green run was observed; any defect the evidence run exposed, with its measured blast radius, fix commit
and the evidence that the fix changed no behaviour; the coverage map B-01…B-30 with each row marked
green, partly open or open and its evidence named; performance evidence separated into workstation and
**target VPS** results with hardware metadata; the screenshots behind B-22 and the transcripts behind
B-21, B-25 and B-26; a list of gates that are open, each naming who can close it; the status of the
three carried-forward milestone A prerequisites; raw artifact paths; and a retain/simplify
recommendation scoped to what was actually measured. No fabricated measurement, no figure copied from a
spec as though it had been observed, and no gate asserted as passed by this document.

### 7. Open decisions

Eleven decisions this section could not take. None is implementable until the owner records it; each
is carried into the index's §4 alongside the rest of the milestone's open list.

| **OPEN DECISION** | Options | Tradeoff | Recommendation |
|---|---|---|---|
| **production playback speed** | (a) 1× only; (b) client-side fast-forward over already-released events; (c) a server catch-up rate | (c) contradicts layer-1 §4.4.4 by pulling outcomes forward; (b) only helps while the client is behind the release edge, which the 2 s buffer makes rare; (a) removes a control users know from A | (b), with the control hidden at the release edge and `ALLOWED_SPEEDS` unchanged |
| **client-side prediction** | (a) render only released frames; (b) ship `@narok/sim` to the browser to interpolate | (b) smooths motion but re-creates a second authority, needs the seed the server must never disclose, and breaks B-02 and B-08 | (a), unconditionally |
| **playback starvation threshold and indicator** — how long the last frame is held before the hunt stops reading as live | a fixed wall-clock threshold; a multiple of `bufferMs`; a server-supplied expectation | a fixed number is arbitrary and wrong on a slow link; a server-supplied expectation is one more protocol field | a multiple of `bufferMs`, stated once in `clock.ts` and 🟡 until B-23's session recording supports a value |
| **DECIDED 2026-09-21 (owner): the laboratory is kept**, as its own `apps/lab` holding `experiment.worker.ts`, `useExperiment.ts`, `LabStrip`, `RunsPanel`, `exportSession.ts`, `BattlefieldView.tsx`, `Comparison.tsx`, `art-manifest.ts` and their tests. `apps/client` becomes engine-free, which is what gate B-02 asserts; keeping the harness inside it would ship the simulation to production | — | — | — |
| **DECIDED 2026-09-21 (owner): port the three remaining sheets verbatim**, byte-identical and frozen under a new ruling continuing the R1xx sequence, exactly as R107 and R113 freeze Hunt and Strategy. Shared tokens are introduced only inside the labelled additions blocks; the frozen sheets are never refactored | — | — | — |
| **DECIDED 2026-09-21 (owner): Stop returns to town.** The in-progress encounter is abandoned; HP/MP, cooldowns, PRNG progression and pity are preserved, encounter progress is not. There is no Resume of an interrupted encounter, so the Hunt screen's second control starts a *new* hunt and its copy must say so. The analysis that follows is superseded: UI spec §4 wanted a Stop/Resume preserving encounter progress, layer-1 §4.5 described a paused encounter plus an explicit retreat |
| **Strategy as a panel or a route** | (a) keep `SetupOverlay` and R113's restatement; (b) a full route where `.editor` takes its native width; (c) both | (b) discards the reason R113 exists — the run controls must stay reachable; (c) doubles the surface under test | (a) |
| **away report acknowledgement and retention** — `hunt_reports` is "bounded retained away summaries" (layer-1 §8.2) with no specified surface | (a) latest report only, no read state; (b) an idempotent seen flag, no list; (c) a history list | any write on the report path must be provably not a reward path (B-17) | (a) for B; defer the list to Phase C |
| **where the loot evaluator runs** — UI spec §6 requires the preview to run *the actual evaluator* | (a) a shared package imported by server and client; (b) a server-side preview endpoint | (a) needs no round trip but two runtimes can drift; (b) cannot drift, costs a request per edit, and needs the drop records server-side anyway | (a), a pure `packages/loot` with one shared test vector both sides must satisfy, turning drift into a failing test |
| **content delivery and version pinning** — A bundles `@narok/data`; layer-1 §11 requires clients to *refetch* content on a mismatch | (a) keep content bundled, mismatch forces a reload; (b) fetch at boot, pinned by version, cached | (a) makes the client version the content version; (b) allows content updates without a client deploy but adds cache invalidation | (a) for B, revisited in C when content changes more often than the client does |
| **event history bound in B** — A bounds the log at 500 (`EVENT_HISTORY_LIMIT`); B adds loot and hour-long hunts | keep 500; raise it; a per-tab bound | one shared bound starves the quieter tabs; a per-tab bound multiplies memory and complicates return-to-latest | a per-tab bound, sized from a measured session under B-23 rather than chosen now |
