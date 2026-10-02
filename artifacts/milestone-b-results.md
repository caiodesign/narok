# Milestone B — results, evidence and recommendation

This is the `artifacts/milestone-b-results.md` that part 4 §6 of the
[milestone B specification](../docs/milestone-b/04-client.md) requires. It is written during
plan task 11, in the shape [`milestone-a-results.md`](milestone-a-results.md) set.

**Every number below was printed by a command run on this workstation during this evidence run.**
Nothing is estimated or extrapolated, nothing is copied from a spec as though it were measured, and
no gate is called passed by this document alone. Where a gate could not be run, the sentence that
would hold its result says so instead, names what is missing, and the gate is listed as open in §8.

**Contents.** 1 Build under test · 2 Correctness commands and results · 3 Continuous integration ·
4 Defects this run exposed · 5 Coverage map B-01…B-30 · 6 Performance evidence (workstation; target
VPS not run) · 7 Screenshots and transcripts · 8 Gates that are open · 9 Milestone A's carried
prerequisites · 10 Raw artifacts · 11 Rulings made in this task · 12 Recommendation.

**The three milestone A prerequisites stay open:** A-14's five-tester placement experiment, R64's
visual sign-off, and the single-VPS concurrency target (A §6.5). B-22 and B-27 are their B-shaped
continuations and do not close them (§9).

---

## 1. Build under test

| Field | Value |
|---|---|
| base commit | `f624423` (branch `feat/hunt-lifecycle`) |
| commits of this run | the four task 11 commits on top of `f624423` (`git log f624423..HEAD`): the R198 fix, the R199 operator command, the doc sweep, and the evidence commit carrying this file |
| working tree at run time | `f624423` plus this task's changes, uncommitted while the evidence ran and committed unchanged afterwards; no other edits |
| `simulationVersion` | `b1` |
| `contentVersion` | `2afa20bacd8473db84d2ef8043832507ecdd7467b1996499a7cbec1575013bdd` |
| `gridHash` | `c2c839371c6faddb0756adef80f3fcb3d17c841fef809acc419dea7ddb43e4b9` |
| Node | `v24.15.0` (the repo's `engines.node`) |
| pnpm | `10.34.5` (the repo's `packageManager`) |
| PostgreSQL | `postgres:17-alpine`, container `narok-postgres` (`compose.dev.yml`); every drill used its own database |
| OS / hardware | Windows 11 Pro 10.0.26200, AMD Ryzen 7 7800X3D (8 cores / 16 threads), 31.2 GiB |

The three versions are the ones the drills read back from the `hunts` rows they wrote
(`artifacts/b25-recovery.txt`, "replay ran under the pinned versions").

---

## 2. Correctness commands and results

Repo-relative, in the order run. Exit status is the process exit code observed here.

| # | Command | Exit | Headline result | Raw output |
|---|---|---|---|---|
| 1 | `pnpm check` (narok-postgres up) | **0** | **1,298 tests passed in 95 files**, 0 failed; `tsc --noEmit` and `eslint` clean. Fix round 1: run with `DATABASE_URL` on the harness database `narok_e2e` (the `db` suites truncate whatever it names); `schema.db.test.ts`'s application-role case now connects to the database `DATABASE_URL` names instead of a hard-coded `narok`, so the harness run passes and the dev database is not reached | `artifacts/run-b11/check-fix1.txt` (local, not committed) |
| 2 | `pnpm --filter @narok/client build` | **0** | production build, eight JS chunks | `artifacts/run-b11/client-build-fix1.txt` (local, not committed) |
| 3 | `pnpm --filter @narok/lab build` | **0** | production build | `artifacts/run-b11/lab-build-fix1.txt` (local, not committed) |
| 4 | `pnpm test:e2e` | **0** | **14 of 14 passed** (45.1 s, fix round 1): `client.spec` 3, `hunt.spec` 2 (B-24 EN and PT-BR, now with a strategy edit saved through `PUT /api/presets/:id`), `town.spec` 2 (EN and PT-BR), `laboratory.spec` 7 | `artifacts/run-b11/e2e-fix1.txt` (local, not committed) |
| 5 | the five stylesheet `diff`s of `docs/realm-hunt-port.md`, `docs/realm-strategy-port.md`, `docs/realm-town-port.md` | **0** | all five print nothing | `artifacts/run-b11/css-diffs.txt` (local, not committed) |
| 6 | `node artifacts/bundle-grep.mjs artifacts/b02-b19-grep.txt` | **0** | B-02: 0 engine literals in the client bundle, 7 in the lab bundle (positive control); B-19: see §5 | `artifacts/b02-b19-grep.txt` |
| 7 | `node artifacts/recovery-drill.mjs artifacts/b25-recovery.json` | **0** | **18/18 checks** (B-25, B-29 server half, B-30 server half); fix round 1 re-run: server labels corrected, EXP check can no longer pass vacuously, drops in flight at the crash recorded (**0**). One of five fix-round runs failed one B-30 check (see §4.3, *start on a faulted hunt*) | `artifacts/b25-recovery.{json,txt}` |
| 8 | `node artifacts/concurrency-drill.mjs artifacts/b26-concurrency.json` | **0** | **18/18 checks** (B-26, B-18) | `artifacts/b26-concurrency.{json,txt}` |
| 9 | `node artifacts/restore-drill.mjs artifacts/b28-restore.json` | **0** | **13/13 checks** (B-28); re-run in fix round 1 because `ops/maintenance resume` changed (R201): it now prints `lifted` | `artifacts/b28-restore.{json,txt}` |
| 10 | `node artifacts/frame-budget.mjs artifacts/b23-frames.json 30` | **0** | 0.847 ms main-thread task time per frame; 0 missed vsyncs in 1,830 intervals (workstation) | `artifacts/b23-frames.json` |
| 11 | `node artifacts/load-accounts.mjs 50 0.1 artifacts/b27-load.json` | **0** | 50 returning accounts, six-minute hold; **workstation numbers** (§6.2) | `artifacts/b27-load.json`, `artifacts/b27-load.log` (local, not committed) |
| 12 | `node artifacts/town-shots.mjs http://127.0.0.1:4173/ artifacts/town` | **0** | 20 screenshots, the 1100 px probe and the B-21 automated checks | `artifacts/town/*.png`, `artifacts/town/probe.json` |

The drills were run twice: once while being written, and again on the final code (the figures in
this file are from the second run). Commands 7–12 start their own `apps/server` processes on
harness databases (`narok_drill_recovery`, `narok_drill_concurrency`, `narok_drill_backup`,
`narok_restore`, `narok_frames`, `narok_load`, `narok_shots`) and never touch `narok`.

### 2.1 What the two new end-to-end specs drive

`e2e/hunt.spec.ts` (B-24, in EN and in PT-BR): sign in and create a party through the server's real
routes, seed the first presets (ruling R197); open the Strategy screen and see the saved preset
(`Saved v1`); **configure strategy** — set Rest HP from 50 to 61, see the draft marked unsaved, press
Save preset, and wait for the `PUT /api/presets/:id` response: 200, the request carries
`rest.hpStart: 61`, and the marker clears to `Saved v2` on the acknowledgement (fix round 1; before it
the spec only opened and closed the screen); Start hunt; wait until the elapsed readout and the log move; five samples that the shown elapsed time
never passes the newest state the server released (read off the routed socket); drop the socket from
the network side; the server settles the absence and announces a report, and Away opens; the
herald's time away and the simulated-of-cap fact are separate figures, and the cap meter's maximum
is the server's `capCutoffWall − awayFromWall`, with no `17h42`-style literal anywhere; Return to hunt;
Stop, with the operator stop copy; Bag; Character; back to Hunt; then **Start a new hunt from town and
see it stream on the same socket** (the R198 regression, §4.1). No Pause or Resume control exists in
either language at three points. `e2e/town.spec.ts`: the compass and the Bag agree on occupancy;
no Materials tab, no Sell control and no purchase control (no Buy / Purchase / Shop / Comprar / Loja
button or link); the Strategy screen shows exactly the account's one preset tab, no fourth (locked
premium) slot (fix round 1 added these two — the spec's header claimed them before it asserted them); equip a starter weapon in town (a real command; the bag
re-reads one slot fewer); lock another (a real command; the cell says "locked" in text); the
Character screen's equipment pane shows the weapon. Every wait is a condition; neither file calls
`waitForTimeout`.

---

## 3. Continuous integration

`.github/workflows/ci.yml` now runs, in order: checkout; pnpm from `packageManager`; Node pinned to
`engines.node`; `pnpm install --frozen-lockfile`; `pnpm build:data`; `pnpm typecheck`; `pnpm lint`;
`pnpm db:migrate` against a **PostgreSQL 17 service container** (same image, user and port as
`compose.dev.yml`); `pnpm test` (the `unit` project, including `stylesheet-port.test.ts`, and the
`db` project); **the five B-01 `diff`s** as a bash step; `npx playwright install --with-deps
chromium`; `pnpm --filter @narok/client build`; **`pnpm --filter @narok/lab build`**; **`node
artifacts/bundle-grep.mjs`**; `pnpm test:e2e` (projects `chromium` and `lab`). `apps/server` has no
build step — it runs under `tsx` everywhere — so its "build" in CI is the typecheck plus the e2e
run, which boots it from source. No secret is referenced.

**A green run has not been observed.** Nothing was pushed from this session. Every step the
workflow contains was run locally against this tree and passed (§2), which is not the same as a
green Actions run. The service-container wiring in particular is unexercised.

---

## 4. Defects this run exposed

### 4.1 A new hunt was invisible to an open socket (fixed, ruling R198)

**What.** Part 2 §1 step 1 starts every hunt at `generation = 1`. A player stop (or an engine stop
followed by a stop command) leaves the old hunt at 2. The socket (`ws/socket.ts` `deliver`) drops a
view whose generation is not newer than its own (P-15), and the client's playback reducer does the
same (B-05). So after a stop, **Start a new hunt** was accepted by the server and then never reached
an open socket or the screen until the player reloaded.

**How found.** The load harness and `frame-budget.mjs` restarted ended hunts and saw almost no
frames; a probe script (session scratch, not committed) showed `snapshot@g1 report@g1` and then nothing for
15 s after a REST start. In the browser, the button stayed enabled and the shell stayed "stopped".

**Blast radius, measured.** Every second and later hunt of an account whose client stayed connected
across the stop — i.e. the normal "Stop, then Start a new hunt" path of part 4 §3.1. Without the fix
the extended `e2e/hunt.spec.ts` fails in both languages at the new-hunt step
(`.superpowers/sdd/2026-09-22-milestone-b-plan/task-11-evidence/02-new-hunt-e2e-red.txt`, 2 failed);
the lifecycle test fails `expected 1 to be 3` (`…/01-generation-red.txt`). First hunts were
unaffected, which is why every earlier test passed.

**Fix.** `startHunt` reads the previous row's generation under the account lock and opens the new
hunt at `previous + 1` (1 for an account's first hunt, as step 1 states). Part 2 §2 already makes
`generation` monotonic; reward ids stay `<huntId>:<seq>` and the precompute cache stays keyed by
hunt id, so nothing else moves. One existing assertion changed meaning and was updated: a hunt
started after a fault recovery is generation 2, not 1.

**Evidence the fix changed nothing else.** `pnpm check` 1,297/1,297; all 236 `db` tests; the e2e
suite 14/14 including the new step; both drills re-run on the fixed code at 18/18.

### 4.2 A new account cannot start a hunt from the product (open — ruling R197)

No route creates a strategy or loot preset (`PUT /api/presets/:id` answers `NOT_OWNED` for an absent
id by design), and B ships no sign-in or party-creation screen. A freshly registered account
therefore has no way, inside the product, to reach Start hunt. The end-to-end specs and every drill
sign in and create characters through the real REST routes and seed the first presets with
`apps/server/test/harness/provision-presets.ts` — the same direct insert the server's own route
suites use. Onboarding is Phase C (layer-1's phase table), so this is recorded, not fixed here; the
owner decides whether B needs a minimal sign-in and default-preset path before invitations.

### 4.3 Recorded for the owner, not fixed

- **The credential rate limit trusts `X-Forwarded-For`.** `plugins/rate-limit.ts` charges a
  credential attempt to the *first* `X-Forwarded-For` entry, which a client controls unless the
  proxy overwrites the header. The harnesses rely on that to charge each test account to its own
  TEST-NET address; an attacker could rely on it to bypass P-13. Whether Caddy is configured to
  overwrite it is a deployment fact this run could not check.
- **B-30's client half has no action to offer.** A faulted hunt is reported (`HUNT_FAULTED`, the
  Orders copy), but `recoverFaultedHunt` has no route (`POST /api/hunts/current/recover` → 404 in the
  drill) and the client no control. Part 4 §2 requires "the explicit recovery action".
- **B-29's client half is a message, not a refetch.** On `CONTENT_VERSION_MISMATCH` the client shows
  "The game content was updated. Reload to continue."; it does not compare `/api/me`'s versions with
  its bundle, refetch, or invalidate the placement UI. Part 4 §7's content decision (a) — content
  bundled, a mismatch forces a reload — makes the message defensible, but the gate text asks for more.
- **Start on a faulted hunt can answer `VALIDATION` before `HUNT_FAULTED`** (observed in fix round 1,
  one recovery-drill run in five, `400 VALIDATION plan.setup.party.p0.hp`). `POST /api/hunts`
  builds and simulates the plan (`sim.start`) before the lifecycle transaction checks the existing
  hunt, so when the faulted hunt's checkpoint left a character at 0 HP the request is refused for
  the party's HP, not for the fault. The refusal is still a refusal; the reason is wrong, and the
  same ordering applies to a start while any hunt is running. **Fixed in the final fix round
  (R205):** the route reads the hunt's status before the plan is simulated, and a faulted hunt
  answers `HUNT_FAULTED`; `recoverFaultedHunt` now heals the party's rows to their derived maxima,
  so a character a fault left at 0 HP can start again after recovery. (A start while a hunt is
  *running* still simulates the plan before the in-transaction `hunt.status` refusal.)
- **Start during the return journey.** After Stop the party travels to town for 10 s of content;
  the shell offers Start a new hunt immediately and the server refuses it (`hunt.travel`) until the
  party arrives. Nothing on screen says why.
- **B-22 observations from the 1100 px probe and the screenshots** (a human must judge): the Away
  timeline's early marks overlap into an unreadable cluster and overflow the panel's left edge when
  the events crowd the start of a long absence (`en-away-1440x900.png`); the Character roster cards
  overflow their row by up to 46 px at 1100 px and long names truncate (`pt-BR-character-1280x800.png`);
  the PT-BR loot-filter rows overflow by 15 px at 1100 px ("Vender automaticamente").
- **Focus indicator.** The automated walk found 2 of 39 Bag stops — both text inputs — whose focused
  rendering does not differ from their blurred rendering beyond the caret.
- **Balance, observed only.** In the bundled content a level-1 party under the default strategy wipes
  within 15 s to 7 min of simulated time; drops in the first hunts are rare (three drop rows across
  26 one-hour absences in the recovery drill's final run). Not a defect of this task; it limits what the drills can show
  (§5, B-25).
- **Startup flake, not reproduced.** Twice in the first three `playwright test` launches of the day a
  `webServer` process exited with `0xC0000409` before any test ran; it did not recur in the ~12
  launches after. Cause not identified (two concurrent native `vite build`s are the suspect).

---

## 5. Coverage map (B-01 … B-30)

Green = automated evidence named here passed in this run. Partly open = a half is green and a half is
named open. Open = not exercised, with the reason.

| Gate | Status | Evidence |
|---|---|---|
| B-01 ported stylesheets | **green** (CI run not observed) | five `diff`s print nothing (§2 #5); `stylesheet-port.test.ts`; both in `ci.yml` |
| B-02 no simulation in the client | **green** | source: `engine-free.test.ts` and Task 8's lint rule; bundle: 0 engine-only literals in `apps/client/dist`, 7 in `apps/lab/dist` as the control (`b02-b19-grep.txt`); `client.spec.ts` "starts no simulation worker" |
| B-03 no future event rendered | **green** | `playback.test.ts`; in the browser, five samples per language of shown elapsed ≤ newest released state (`hunt.spec.ts`) |
| B-04 playback buffer | **green** | `clock.test.ts` |
| B-05 stale / newer generation | **green** | `use-hunt.test.tsx`, `playback.test.ts`; R198 makes the server honour the same rule across hunts |
| B-06 sequence gap resyncs | **green** | `playback.test.ts`, `ws-protocol.test.ts` |
| B-07 reconnect from a snapshot | **green** | `use-hunt.test.tsx`; in the browser, a network-side drop mid-hunt reconnects and the stream resumes (`hunt.spec.ts`) |
| B-08 no future outcome or seed | **green** | `release.test.ts`, `ws-protocol.test.ts` schema assertions |
| B-09 skill states and inspection | **green** | `skill-states.test.tsx` |
| B-10 strategy draft/save/apply | **green** | `strategy-lifecycle.test.tsx`, `hunt-commands.test.tsx` |
| B-11 apply at an encounter boundary | **green** | `commands.db.test.ts` |
| B-12 bag interaction | **green** | `bag.test.tsx`; in the browser, select/equip/lock against the real bag (`town.spec.ts`) |
| B-13 equip eligibility both sides | **green** | `bag.test.tsx`, `town-routes.db.test.ts`; in the browser, a real town equip (`town.spec.ts`) |
| B-14 loot filter precedence | **green** | `packages/loot/test/evaluate.test.ts` with `vectors.json`, asserted by both runtimes |
| B-15 bulk sale | **open — behind prices** | `/api/inventory/sell` unimplemented; client selection behind `VITE_FEATURE_SHOP` (`shop-flag.test.ts`). Closes when prices exist |
| B-16 allocation and skills | **green** | `character.test.tsx`, `town-routes.db.test.ts` |
| B-17 away report never double-credits | **green** | `away-report.db.test.ts`; concurrency drill: an immediate second return writes no audit row |
| B-18 offline and wall-clock semantics | **green, one branch unexercised** | concurrency drill: the 13 h return's window starts at the previous `last_seen_at` and presence is refreshed by that settlement; time away 46,803,064 ms and simulated 27,329 ms reported separately; a second tab joining gets no report; 200 rounds of two-tab heartbeats leave EXP columns equal to the checkpoint. The **`capped`** branch (a hunt still running at the 12 h cap) was not reached: every hunt in this content ends long before 12 h |
| B-19 no corrected mockup content | **partly open** | grep: 0 matches for 17h42m, EXP loss, de-levelling, time-until-death, the two-level divisor, Materials, bag expansion, fourth preset, gallery, compare-original; 6 matches for "premium" — 5 are selectors of the frozen town sheets (`.ledger-premium`, `--premium`, `.prem-tag`), which no component renders, and 1 is `/api/me`'s `premium` boolean in the protocol schema (`b02-b19-grep.txt`). **Open:** the human read of the correction table against the running build |
| B-20 localisation | **green** | `i18n.test.ts` parity; `hunt.spec.ts` and `town.spec.ts` run end to end in PT-BR from the committed strings |
| B-21 accessibility | **partly open** | automated: focus indicator on 38/38 Hunt, 39/39 Strategy, 27/27 Away, 37/39 Bag, 38/38 Character Tab stops per language; with reduced motion the live log kept receiving rows (EN 11 → 15, PT-BR 9 → 19) with 0 running animations (`town/probe.json`). **Open:** the stated human observation of keyboard-only traversal of all five screens, and the colour-alone review |
| B-22 visual composition, three new screens | **partly open** | 20 screenshots committed (§7); 1100 px probe: no document-level horizontal overflow on any screen in either language; element-level overflows listed in §4.3. **Open:** the human look. **Does not close R64** |
| B-23 frame budget and R109 | **green on the workstation** | 0.847 ms main-thread task per presented frame under a live socket at the one supported release rate (1 s tick, 1x), 0 missed vsyncs (§6.1); the R109 identity rule's unit test. Not a target-device figure |
| B-24 end-to-end smoke | **green, with R197's onboarding caveat** | `hunt.spec.ts` EN and PT-BR against the built bundle, a real server and a real PostgreSQL; sign-in and party creation go through REST because no screen exists (§4.2); strategy is configured on the shipped screen — one edit, Save, `PUT /api/presets/:id` 200, unsaved marker cleared (fix round 1) |
| B-25 recovery | **EXP half green; drop half partly open (vacuous: no drop in flight)** | recovery drill (fix round 1 re-run): SIGKILL of server #1 with 10.0 s of released sim time ahead of the committed checkpoint (released 30,178 ms, committed 20,132 ms); server #2 restarts under the same pins and replays from it; 3 reward ids unique and contiguous per hunt (2 hunts); every pre-crash reward intact; kept-drop audits = reward items (2 = 2); at the crash the database held exactly what the committed checkpoint had rolled; EXP 4,100 → 4,172 credited once, and the check now fails if the checkpoint carries no progression to compare (columns 4,172 = checkpoint 4,172). **Drop half:** the drill now records the drops rolled past the committed checkpoint — **0** in this run (`dropsInFlightAtCrash`), and 0 in each of the four other fix-round runs. No drop was in flight at the crash, so "uncommitted precomputation is never a reward source" is shown for EXP and for an empty drop set only; for a dropped item it is unexercised. Closing it needs a drill that makes a drop land between the committed checkpoint and the SIGKILL (drops are rare at level 1, §4.3) |
| B-26 concurrency | **green** | two server processes, one account: 182 lock attempts against 92 heartbeat settlements (checkpoint seq 1 → 67); 150 intents, 32 lost races, each answered `CONFLICT_STATE_VERSION` with the current version and landed on retry (max 2 tries); no shared version; final lock correct; committed hunt never moved backwards in 133 samples; key replay returns the stored result on both processes; same key, other body → `IDEMPOTENCY_KEY_REUSED` |
| B-27 load on the target VPS | **open** | workstation run only (§6.2). The gate names the target VPS; none exists. **Does not close §6.5** |
| B-28 backup restore and migration settlement | **partly open** | restore drill: `pg_dump -Fc` → empty database → `pg_restore`; all 17 tables identical by row count and row md5; a fresh process signs both accounts in and reads identical characters, bag and hunt; `ops/maintenance` freeze → settle (to the cutoff, pinned artifacts) → resume (sim time unchanged across a 4.3 s outage, `lastSeenAt` advanced by exactly the outage) → the hunt plays on. **Open:** B has no content migration to transform (part 2 §7 step 4), and the routes do not refuse commands while frozen (step 1) — the freeze is a stopped process |
| B-29 content mismatch | **partly open** | server: a checkpoint pinned to other content answers `CONTENT_VERSION_MISMATCH` on read and socket and its bytes stay untouched (recovery drill; `ops/maintenance settle` refuses the same, `maintenance.db.test.ts`). **Open:** the client's refetch and placement invalidation (§4.3) |
| B-30 faulted hunt | **partly open** | server: an injected unknown class faults the hunt (`INVALID_STATE`), writes one `fault` archive row, charges no wipe, three reconnects with heartbeats write nothing, normal stop and start answer `HUNT_FAULTED`. Fix round 1: one of five drill runs saw the start answer `400 VALIDATION plan.setup.party.p0.hp` instead (§4.3, *start on a faulted hunt*); the committed run is a passing one. **Open:** the explicit recovery action has no route and no client control (§4.3) |

---

## 6. Performance evidence

### 6.1 Workstation results

Hardware as §1. Headless Chromium 153 at 1440×900.

**B-23, per-frame HUD cost under a live socket** (`artifacts/b23-frames.json`, 30 s window, the hunt
running throughout, 25 socket frames carrying events received in the window):

| Measure | Value |
|---|---|
| frames presented | 1,831 |
| main-thread task time per frame | **0.847 ms** (script 0.177, layout 0.043, style recalc 0.076) |
| frame interval p50 / p95 / p99 / max | 16.7 / 16.7 / 16.8 / 16.8 ms |
| intervals that missed a vsync (> 25 ms) | 0 of 1,830 |
| budget | 16.7 ms |

Method (ruling R200): Δ CDP `Performance.getMetrics` TaskDuration over the window ÷ frames presented
(a `requestAnimationFrame` counter). Milestone A's R109 figures (44.4 ms before, 3.85 ms after) are
recorded without their method, so this measurement is **not** a like-for-like repeat of them and is
not compared with them as one.

**B-27 harness, workstation only** (`artifacts/b27-load.json`): one server process, 50 accounts
onboarded (each charged to its own TEST-NET source), 50 hunts, every hunt backdated one hour, then
all 50 sockets reconnected at once; then a six-minute hold with acks, a heartbeat and a hunt read per
account every 30 s, and ended hunts started again.

| Measure | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| onboarding (register, sign in, 3 characters) | 50 | 186.0 ms | 252.3 ms | 257.0 ms | 257.0 ms |
| start hunt | 50 | 24.7 ms | 28.4 ms | 73.9 ms | 73.9 ms |
| **returning reconnect → snapshot (settles a 1 h absence)**, 50 at once | 50 | 442.7 ms | 454.7 ms | 456.6 ms | 456.6 ms |
| hunt read under load | 600 | 118.6 ms | 261.0 ms | 261.4 ms | 261.9 ms |
| frame inter-arrival per socket | 7,675 | 1,010.8 ms | 5,045.4 ms | 5,651.7 ms | 41,197.7 ms |

Peak server RSS **351.5 MiB** (347 one-second samples). 0 read failures; 67 hunts restarted during
the hold. The inter-arrival tail includes the gaps while a hunt ended and was restarted, so it is a
liveness figure, not a latency one. Socket bound: with one socket already open, five more were
opened; the fifth and sixth sockets of the account were closed `1013 RATE_LIMITED`, the documented
refusal at `socketsPerAccount = 4`. Every hunt in the one-hour absence ended early (wipes), so
"settles a 1 h absence" settled minutes of simulated time per account, not an hour.

**12 h catch-up on the API event loop (final review I3, ruling R202)** (`artifacts/catchup-12h.json`,
script `artifacts/catchup-12h.ts`, harness database `narok_drill_catchup`): the reconnect path a
socket's `hello` takes after a full twelve-hour absence (`LifecycleFeed.connect` — summary
settlement with the away-report digest, the report, the view), through the composed server
dependencies with the inline executor, for a laboratory party that survives the whole 12 h
(43,200,000 simulated ms credited in every run; a level-1 party with progression wipes in minutes).
Event-loop block = the longest gap a 1 ms interval saw (agrees with `monitorEventLoopDelay`'s max).

| Measure | n | p50 | max |
|---|---|---|---|
| one reconnect, wall time | 5 | 712.0 ms | 728.4 ms |
| one reconnect, event-loop block | 5 | 605.4 ms | 624.4 ms |
| sixteen reconnects at once, total wall time | 1 | 9,482.3 ms | — |
| sixteen reconnects at once, longest event-loop block | 1 | 1,155.4 ms | — |

While a settlement runs, nothing else on the process runs: no release tick, heartbeat, socket
authorisation or REST request. Sixteen returning players hold the loop for ~9.5 s, in stalls of
up to 1.16 s. This is the cost R202 accepts for B; it is an open pre-invite gate (§8).

### 6.2 Target VPS results — **not run**

No target VPS exists for this run. B-27's gate and milestone A §6.5 both name it; neither is claimed.
The figures in §6.1 must not be quoted as capacity.

---

## 7. Screenshots and transcripts

- **B-22:** `artifacts/town/{en,pt-BR}-{hunt,strategy,away,bag,character}-{1440x900,1280x800}.png`
  (20 files), with the 1100×800 probe in `artifacts/town/probe.json`. The Away report is a real one
  (a two-hour absence settled by the server).
- **B-21:** the automated half is `artifacts/town/probe.json` (`a11y` and `reducedMotion` per
  language). The human half — keyboard-only traversal of all five screens — has **not** been
  performed by anyone in this run.
- **B-25:** `artifacts/b25-recovery.txt` (transcript), `artifacts/b25-recovery.json`.
- **B-26 / B-18:** `artifacts/b26-concurrency.txt`, `artifacts/b26-concurrency.json`.
- **B-28:** `artifacts/b28-restore.txt`, `artifacts/b28-restore.json`.

---

## 8. Gates that are open, and who closes them

| Gate | What is missing | Who can close it |
|---|---|---|
| B-15 | prices, the sale route and its reconciliation test | owner (prices), then an implementer |
| B-19 (human half) | a person reads part 4 §4 against the running build | owner or a delegated reviewer |
| B-21 (human half) | keyboard-only traversal of all five screens, stated; the colour-alone review | a human tester |
| B-22 (human half) | a person looks at the 20 screenshots and the §4.3 overflows | owner |
| B-27 | the load run on the target VPS with its hardware recorded | operator with VPS access |
| B-28 (rest) | refusal of commands while frozen; a real content migration through step 4 | implementer, then operator |
| B-29 (client half) | refetch / invalidate on a version change | implementer (after the owner confirms part 4 §7 option (a) is enough) |
| B-30 (client half) | a recovery route and the one control the client offers | implementer |
| B-25 (drop half) | a drill run in which a drop lands between the committed checkpoint and the SIGKILL | implementer |
| B-24 (onboarding) | a sign-in and default-preset path inside the product (§4.2) | owner decides scope (B or Phase C) |
| CI | a green Actions run | anyone who pushes |
| Catch-up executor (R202) — **before invite** | catch-up runs inline on the API event loop with no bounded queue (§6.1: 605 ms block per 12 h reconnect, ~9.5 s for sixteen at once); a `worker_threads` executor behind `SegmentExecutor` plus a bounded queue refusing with `RATE_LIMITED`, or the owner's acceptance of the inline cost | owner, or an implementer before invitations |
| Credential limiter trusts `X-Forwarded-For` — **before invite** | `plugins/rate-limit.ts` charges the first XFF entry; safe only if the proxy overwrites it (§4.3) | owner (proxy topology) |

## 9. Milestone A's carried prerequisites

- **A-14, the five-tester placement experiment — open.** Nothing in B ran it.
- **R64, the visual sign-off of A's two screens — open.** B-22's screenshots are of B's screens and
  do not close it.
- **A §6.5, the single-VPS concurrency target — open.** B-27's workstation run does not close it.
- **Shop UI — deferred** behind `VITE_FEATURE_SHOP` (off), with B-15.

## 10. Raw artifacts

Committed: `artifacts/bundle-grep.mjs`, `recovery-drill.mjs`, `concurrency-drill.mjs`,
`restore-drill.mjs`, `load-accounts.mjs`, `frame-budget.mjs`, `town-shots.mjs`, `catchup-12h.ts`; `b02-b19-grep.txt`; `catchup-12h.json`;
`b23-frames.json`; `b25-recovery.{json,txt}`; `b26-concurrency.{json,txt}`; `b28-restore.{json,txt}`;
`b27-load.json`; `town/*.png`, `town/probe.json`; this file. The harness they share is
`e2e/support/server.mjs`.

Not committed (raw output, on this workstation only): `artifacts/run-b11/*.txt` (the stdout of §2's
commands), `artifacts/b27-load.log`, `artifacts/b28-backup.dump`, `artifacts/playwright/`.

## 11. Rulings made in this task

- **R197 — the end-to-end harness and its onboarding.** `vite preview` proxies `/api` and `/ws` to a
  real server when `NAROK_API_PROXY` is set (one origin, as Caddy gives production); sign-in and
  party creation go through the real REST routes because B has no screen for them; the first presets
  are seeded by `apps/server/test/harness/provision-presets.ts` because no route creates one; each
  test onboarding is charged to its own TEST-NET source address. *Why:* the alternative was a fake
  server or no B-24 at all. *Cost if wrong:* the specs gain a sign-in screen step when one exists.
- **R198 — a new hunt opens one generation past the account's last** (§4.1). *Why:* part 2 §2's
  monotonic generation, which the socket and the client both enforce. *Cost if wrong:* one line in
  `startHunt` and one test.
- **R199 — the maintenance settlement is an offline operator command**
  (`apps/server/src/ops/maintenance.ts`: `freeze`, `settle`, `resume`), reachable by no route; the
  freeze is a stopped process until the routes refuse commands while frozen. *Why:* P-31's
  arithmetic had no path that ran it, and the drill needed one; an HTTP admin surface would have
  been new attack surface. *Cost if wrong:* move it behind an admin route later.
- **R200 — B-23's method is stated, not inherited** (§6.1), because A's is unrecorded.
- **R201 — `ops/maintenance resume` keeps the freeze while any running hunt was skipped** (fix round
  1): a running hunt not anchored at the cutoff — typically `freeze` then `resume` with no `settle`
  — is reported `skipped`, left untouched, the freeze stays set and the command exits 2;
  `resume --force` is the explicit override. A hunt `refused` for a pin mismatch does not hold the
  freeze, because this build can never settle it and every route refuses it the same way. *Why:*
  lifting the freeze over an unsettled hunt bills the whole outage to that player's offline
  allowance, which P-31 forbids. *Cost if wrong:* drop the check; `maintenance.db.test.ts` names it.

### Final fix round (final review I1–I3, 2026-10-02)

- **R202 — catch-up runs inline, with no bounded queue, deviating from the plan.** The plan's
  Task 3 interface runs `runSegment` in a worker, and part 1 §1/§8 ask for a `catchup` pool reached by
  message passing and a bounded queue whose overflow returns `RATE_LIMITED`. B ships
  `new SegmentPool(inlineExecutor(sim))` in `compose.ts`: every settlement runs on the API event loop
  and concurrent settlements serialise there. Measured in §6.1 (605 ms block per 12 h reconnect).
  Recorded where it binds: `docs/milestone-b/01-platform.md` §1 and §8. *Why:* a worker executor is a
  sizeable change, there is no VPS and no invitation imminent, and the `SegmentExecutor` seam already
  isolates the change. *Cost if wrong:* event-loop stalls under real load — an open gate before
  invite (§8).
- **R203 — gameplay commands are charged per account, and heartbeat settlements coalesce (P-13).**
  Every mutating hunt, preset and town route resolves the session and then charges
  `limiters.command` (`config.rateLimits.command`, unchanged) before any read or rule; reads are not
  charged. A socket heartbeat no longer queues a settlement per message: it waits for one already in
  flight for the account, and settles nothing while the age of the account's settlement window is
  under the existing `persistCadenceMs` (the release tick's own gate), so heartbeats commit at most
  once per cadence window. No new interval or threshold was introduced. *Cost if wrong:* a heartbeat
  storm still costs a view (an engine run on a copy, no write) per heartbeat.
- **R204 — the db suites refuse the dev database.** `apps/server/test/db-helpers.ts` refuses any
  database whose name does not end in `_test` or `_e2e` unless `GITHUB_ACTIONS=true` (a bare `CI` is not
  accepted) or
  `NAROK_DB_TESTS_TRUNCATE=<name>` opts in, because the suites truncate every table and the default
  URL names `narok`. Local `pnpm check` needs `DATABASE_URL` pointed at a harness database (for
  example `narok_e2e`). *Cost if wrong:* a developer sets one variable.
- **R205 — recovering a faulted hunt heals the party (owner rule: every return to town fully
  heals).** `recoverFaultedHunt` sets each party character's HP and MP to the maxima the one
  derivation (`characterMaxima`) gives its row and worn items, in the recovery's transaction, and
  `POST /api/hunts` answers `HUNT_FAULTED` before it simulates the plan. Stop, wipe and stalemate
  already heal through the engine's `returnToTown`, committed by `commitProgression`; the maintenance
  `settle` reaches town only through those same engine paths.

## 12. Recommendation: **retain the authoritative server design; do not invite players yet**

Scoped to what was measured.

**Retain.** The server's central claims held under real processes, not just unit tests: a SIGKILL
mid-hunt lost nothing committed and credited nothing twice; two processes racing one account
produced exactly one winner per version and only documented refusals; a restored dump came back
byte-identical by every table; a fault stopped, archived and stayed stopped. The HUD costs under
1 ms of main-thread time per frame on this workstation with a live socket.

**Do not invite yet, because of what this run found or could not run:** a new account cannot reach
a hunt from the product (§4.2); a faulted hunt has no recovery the player can take (B-30); the
credential limiter's trust of `X-Forwarded-For` needs a deployment answer; catch-up runs inline on
the API event loop with no bounded queue (R202 — 605 ms per 12 h reconnect, §6.1); and every capacity
figure here is a workstation figure — B-27 and A §6.5 need the VPS. The defect that would have hit
every returning player (§4.1) is fixed and guarded by a browser test.
