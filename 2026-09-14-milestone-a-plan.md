# Milestone A Combat Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a disposable, deterministic combat laboratory that demonstrates whether party strategy and 5×5 placement create understandable decisions.

**Updated:** 2026-09-16; filename retains the date this planning packet began. Realm Refined is the primary presentation direction; simulation tasks remain unchanged.

**Architecture:** One pure simulation package runs in a Node balance CLI and a browser worker. Typed immutable content drives four classes, eight skills, three encounters, and a grid adapter. React/PixiJS displays public elapsed state; no persistent accounts or production authority are implemented in this milestone.

**Tech Stack:** TypeScript strict mode, pnpm workspaces, Vitest, fast-check, React, Vite, PixiJS, react-i18next, Playwright. Resolve compatible package versions at bootstrap, save exact dependency versions, and commit the lockfile; do not copy unverified version guesses into configuration.

**Spec:** [Milestone A scope/mechanics](2026-09-14-milestone-a-spec.md) and [simulation contracts](2026-09-14-simulation-contracts-spec.md). Read both completely before executing tasks.

## Global Constraints

- Read [Realm UI specification](2026-09-16-realm-ui-spec.md) and [Opus handoff](docs/opus-handoff.md). Use the refined visual system within A's scope; the five mockups do not authorize B/C systems or override gameplay defaults.

- Implement milestone A only.
- Four classes; party sizes one, two, or three; duplicate classes permitted.
- Eight active skills: Taunt, Cleave, Heal, Smite, Double Shot, Arrow Rain, Fire Bolt, Frost Nova.
- No EXP loss and no de-leveling during beta.
- `10,000 = 100%` for multiplicative factors.
- Default board width/height is 5.
- All movement takes 500 ms.
- Simulation imports no Node/browser I/O and never reads wall time or `Math.random()`.
- No accounts, server, database, inventory, potions, premium, or production offline simulation in this milestone.
- Original geometric placeholders and PT-BR/English UI keys from the beginning.
- The parent legal/IP constraints remain in force; do not fetch or derive franchise artwork.
- Experiment resets and seed controls must be labeled as laboratory controls, never production hunt behavior.
- Detailed mechanics and numeric content in the specs are prototype defaults; changes require updated content/versioned fixtures and an explanation.

## Repository and execution preparation

The target contains this specification packet, historical visual studies and the selected Realm Refined HTML/CSS/JS prototypes; no game application is implemented. All paths below are relative to `/Users/caio.oliveira2/dev/nu/narok/`. During implementation, inspect the repository again and preserve these documents, mockups and newer user files. Establish repository/worktree isolation at execution time using the appropriate Superpowers skill.

If no repository exists when implementation is authorized, initialize this project as its own repository before code commits; never commit into the unrelated `random` workspace. Commit the existing planning documents as the baseline. The task commits below are proposed execution steps, not actions already performed.

## File and responsibility map

```text
package.json, pnpm-workspace.yaml, pnpm-lock.yaml, tsconfig.json
vitest.config.ts, eslint.config.mjs, .gitignore
packages/data/
  package.json
  scripts/build-content.ts             canonical digests and generated content
  src/types.ts                         content contracts
  src/prototype.ts                     numeric tables/recipes from the scope spec
  src/validate.ts                      content validation
  src/generated/content.ts             generated immutable content/digests
  src/index.ts
  test/content.test.ts
packages/sim/
  package.json
  src/types.ts, src/errors.ts, src/index.ts
  src/rng.ts, src/math.ts               deterministic primitive calculations
  src/scheduler.ts                     stable queue and scheduling assertions
  src/state.ts, src/snapshot.ts         initial state, runtime validation, canonical JSON
  src/battlefield/types.ts, src/battlefield/grid.ts
  src/strategy.ts                      target/rule selection
  src/actions.ts                      decision execution and cast resolution
  src/effects.ts                      expiry, threat, slow/stun rules
  src/lifecycle.ts                    spawn, walk, rest, wipe, stop
  src/advance.ts                      bounded event dispatch, time accounting
  src/project.ts                      safe public actor/frame projection
  test/fixtures.ts, test/stress-fixture.ts
  test/rng.test.ts, test/math.test.ts, test/grid.test.ts
  test/state.test.ts, test/snapshot.test.ts, test/scheduler.test.ts
  test/actions.test.ts, test/effects.test.ts, test/lifecycle.test.ts
  test/advance.test.ts, test/invariants.test.ts, test/projection.test.ts
tools/balance/
  package.json
  src/cli.ts, src/run.ts, src/matrix.ts, src/report.ts, src/benchmark.ts
  test/run.test.ts, test/report.test.ts
apps/client/
  package.json, index.html, vite.config.ts
  src/main.tsx, src/App.tsx, src/styles.css
  src/experiment.worker.ts, src/worker-contract.ts, src/useExperiment.ts, src/clock.ts
  src/ExperimentControls.tsx, src/BattlefieldView.tsx
  src/EventLog.tsx, src/Comparison.tsx, src/i18n.ts
  src/locales/en.json, src/locales/pt-BR.json, src/art-manifest.ts
  test/clock.test.ts, test/controls.test.tsx
e2e/laboratory.spec.ts, playwright.config.ts
.github/workflows/ci.yml
```

Generated artifacts belong under `artifacts/` and are ignored by default; selectively commit a concise results report and small pinned test fixtures, not raw benchmark dumps.

## Test-first workflow

Each task is an independently reviewable capability. Within it, take the listed steps in order, separating test addition, red run, implementation, green run, and commit. A task can contain several short code edits; do not convert the entire plan into one monolithic patch. Infrastructure commands may fail until installation/configuration is complete; a test that subsequently fails on a missing behavior is the useful red check.

Never describe planned commands as executed. Preserve actual failure output and measurements during execution.

---

### Task 1: Typed prototype content and reproducible randomness

**Files:** Create root workspace/configuration files; `packages/data/**`; `packages/sim/package.json`, `src/rng.ts`, `src/errors.ts`, `test/rng.test.ts`.

**Interfaces:** Produces all content types, `validateContent(value:unknown):Content`, generated `content:Content`, `SimError`, `nextU32(state)` and `drawBelow(state,max)` with the exact signatures in the contract. Consumers are every subsequent task.

- [ ] Create the minimal workspace with packages/data, packages/sim, tools/balance, and apps/client as workspace paths. Install exact dependencies and write the lockfile. Configure root scripts as follows; create package manifests with `@narok/data` and `@narok/sim` exports pointing at `src/index.ts`.

```json
{
  "private": true,
  "type": "module",
  "scripts": {
    "build:data": "tsx packages/data/scripts/build-content.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint packages tools apps e2e",
    "dev": "pnpm --filter @narok/client dev",
    "balance": "tsx tools/balance/src/cli.ts",
    "check": "pnpm build:data && pnpm typecheck && pnpm lint && pnpm test",
    "test:e2e": "playwright test"
  }
}
```

Use strict TypeScript, ES2022 target, ESNext modules, Bundler resolution, `react-jsx`, and path mappings for the two packages. Exclude artifacts and node_modules. Configure Vitest to discover `**/test/**/*.test.{ts,tsx}`; Playwright owns e2e files. Install TypeScript/tsx/Vitest/fast-check/ESLint/typescript-eslint/Node types at root; place React/React DOM/Vite/PixiJS/i18next/react-i18next in the client workspace, plus React types, React Testing Library, jest-dom and jsdom for component tests. Root Playwright supplies e2e execution. Configure jsdom and jest-dom setup only for client component tests. Record the runtime and package-manager versions used in the root package metadata.

- [ ] Add the RNG vectors and malformed-content tests before implementation:

```ts
import { expect, test } from 'vitest';
import { nextU32, drawBelow } from '../src/rng';
test('xorshift32 has stable vectors and rejects zero', () => {
  let state = 1;
  const values: number[] = [];
  for (let i = 0; i < 3; i++) {
    const next = nextU32(state);
    state = next.state;
    values.push(next.value);
  }
  expect(values).toEqual([270369, 67634689, 2647435461]);
  expect(() => nextU32(0)).toThrow();
  expect(drawBelow(1, 1).value).toBe(0);
});
```

For content tests, mutate copies of the specified table to duplicate a spawn, reference a missing skill, set a zero interval, omit an element pair, and use a noninteger HP. Each must produce `INVALID_CONTENT` with its field path.

- [ ] Run `pnpm test packages/sim/test/rng.test.ts packages/data/test/content.test.ts`; expect failures for missing RNG/validation exports.
- [ ] Copy the exact content interfaces from the contract and encode the scope-spec tables in `prototype.ts`. Implement the RNG:

```ts
export function nextU32(state: number) {
  if (!Number.isInteger(state) || state < 1 || state > 0xffffffff)
    throw new RangeError('nonzero uint32 seed required');
  let x = state;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  const value = x >>> 0;
  return { state: value, value };
}
export function drawBelow(state: number, max: number) {
  if (!Number.isInteger(max) || max < 1 || max > 1_000_000)
    throw new RangeError('invalid draw bound');
  const limit = Math.floor(0x100000000 / max) * max;
  let next = nextU32(state);
  while (next.value >= limit) next = nextU32(next.state);
  return { state: next.state, value: next.value % max };
}
```

Translate validation RangeErrors at public simulation boundaries into the documented SimError codes. Type the source definitions as `Omit<Content,'version'|'gridHash'>`. In the Node build script, canonicalize definitions including shape offsets, compute SHA-256, add the digest fields, validate the completed Content, and emit the generated content module. Generated output must be identical across two invocations without input changes. Simulation code must not import the build script.

- [ ] Run the two tests, `pnpm build:data` twice, and compare generated output. Run typecheck against the files present at this task.
- [ ] Commit explicit workspace/config/data/RNG paths with message `feat: define prototype content and deterministic rng`.

### Task 2: Grid geometry and legal movement

**Files:** Create `packages/sim/src/types.ts` from the runtime contract, `src/battlefield/types.ts`, `src/battlefield/grid.ts`, `test/grid.test.ts`, and the `actor()` fixture in `test/fixtures.ts`.

**Interfaces:** Consumes `GridConfig`, `Actor`, `ShapeId`; produces `Battlefield`, `createGrid`, `gridPosition`, `gridCoordinates`. No combat resolver may import coordinate conversion functions.

- [ ] Add a blocked-path test and an edge-clipping test:

```ts
import { expect, test } from 'vitest';
import { createGrid, gridPosition as pos } from '../src/battlefield/grid';
import { actor } from './fixtures';
test('takes the deterministic detour around a friendly blocker', () => {
  const grid = createGrid({ width: 5, height: 5, playerRows: [3,4],
    enemyRows: [0,1], moveMs: 500, maxEnemies: 5 });
  const mover = actor({ id: 'p0', position: pos(2,3) });
  const blocker = actor({ id: 'p1', position: pos(2,2) });
  const target = actor({ id: 'e0', side: 'enemy', position: pos(2,1) });
  expect(grid.nextStep(mover, target, 1, [mover,blocker,target])).toBe(pos(1,3));
});
test('square clips at the right edge without wrapping', () => {
  const grid = createGrid({ width: 5, height: 5, playerRows: [3,4],
    enemyRows: [0,1], moveMs: 500, maxEnemies: 5 });
  const a = actor({ id: 'e0', side: 'enemy', position: pos(4,0) });
  const b = actor({ id: 'e1', side: 'enemy', position: pos(0,1) });
  const c = actor({ id: 'e2', side: 'enemy', position: pos(4,1) });
  expect(grid.affected(a, 'square', [a,b,c])).toEqual(['e0','e2']);
});
```

- [ ] Run `pnpm test packages/sim/test/grid.test.ts`; expect missing grid behavior failures.
- [ ] Implement BFS using a queue of `{position,firstStep}` records. Enumerate up/left/right/down, reject outside/occupied/visited cells, and return firstStep on the first cell within range. If already in range return null; if exhausted return null. `canReach` checks current range or the existence of a step. Store/export the following offsets in `packages/data/src/prototype.ts`; the grid adapter consumes content offsets and returns sorted actor IDs:

```ts
export const shapeOffsets: Record<ShapeId, [number, number][]> = {
  single: [[0,0]],
  cleave: [[-1,0],[0,0],[1,0]],
  square: [[0,0],[1,0],[0,1],[1,1]],
  plus: [[0,0],[-1,0],[1,0],[0,-1],[0,1]],
};
```

Validate encoded positions when constructing/decoding state; combat treats them as opaque. Reject overlapping spawn cells rather than silently relocating them.

- [ ] Add surrounded-target/in-range, unreachable-target, duplicate-placement, wrong-zone, and 6×6 tests. Run the grid suite and typecheck.
- [ ] Commit these explicit paths with message `feat: add deterministic grid battlefield`.

### Task 3: Derived stats and damage arithmetic

**Files:** Create `packages/sim/src/math.ts`, `test/math.test.ts`; update `test/fixtures.ts` to derive actor defaults from content.

**Interfaces:** Consumes class/content definitions; produces `derive`, `damage`, `effectiveHeal` exactly as specified.

- [ ] Add golden arithmetic cases:

```ts
import { expect, test } from 'vitest';
import { content } from '@narok/data';
import { derive, damage, effectiveHeal } from '../src/math';
test('Guardian formulas use explicit rounding', () => {
  expect(derive(content.classes.guardian)).toMatchObject({
    maxHp: 277, maxMp: 60, atk: 37, def: 17, intervalMs: 1569,
  });
});
test('power then defense and actual restoration', () => {
  expect(damage({ offense: 100, powerBp: 12000, elementBp: 10000,
    familyBp: 10000, varianceBp: 10000, critical: false,
    defense: 20, hit: true })).toBe(100);
  expect(effectiveHeal(95,100,82)).toBe(5);
  expect(effectiveHeal(100,100,82)).toBe(0);
});
```

- [ ] Run `pnpm test packages/sim/test/math.test.ts`; expect missing math export failures.
- [ ] Implement the exact formula sequence; use a checked multiplication helper before products, and floor after each required operation:

```ts
export function effectiveHeal(hp: number, maxHp: number, requested: number) {
  return Math.max(0, Math.min(maxHp - hp, requested));
}
function multiplySafe(a: number, b: number): number {
  const product = a * b;
  if (!Number.isSafeInteger(product)) throw new RangeError('unsafe product');
  return product;
}
function scale(value: number, bp: number): number {
  return Math.floor(multiplySafe(value, bp) / 10000);
}
```

`damage` returns zero immediately for a miss, otherwise applies skill/element/family/variance/crit factors and defense as specified. `derive` calculates all declared fields, including separate magical defense, physical hit/flee, and crit basis points. Keep random rolls outside these helpers.

- [ ] Add monotonic-defense, missed-hit, minimum damage, overflow, magical-defense, and all element-pair cases. Run math/content tests.
- [ ] Commit with message `feat: implement explicit combat arithmetic`.

### Task 4: State validation, canonical snapshots, and event queue

**Files:** Create `src/state.ts`, `src/snapshot.ts`, `src/scheduler.ts`; add `test/state.test.ts`, `test/snapshot.test.ts`, `test/scheduler.test.ts`; complete `labInput()`, `fightFixture()`, and `context()` test helpers.

**Interfaces:** Produces `startState(content:Content,battlefield:Battlefield,input:LabInput):SimState`, `encodeSnapshot(state:SimState):string`, `decodeSnapshot(text:string,content:Content,battlefield:Battlefield):SimState`, `compareScheduled`, `schedule`, `takeNext`. `fightFixture():SimState` creates a valid manually assembled encounter at 2,000 ms; `context(state,events):Context` records sequential domain events for handler tests. These are in-package helpers; public Simulation wrappers arrive in task 7.

- [ ] Add queue precedence and round-trip tests:

```ts
import { expect, test } from 'vitest';
import { compareScheduled } from '../src/scheduler';
import { encodeSnapshot, decodeSnapshot } from '../src/snapshot';
import { content } from '@narok/data';
import { createGrid } from '../src/battlefield/grid';
import { fightFixture } from './fixtures';
test('expiry precedes resolve regardless of actor ID', () => {
  const base = { at: 1000, epoch: 1, token: null, seq: 1 };
  expect(compareScheduled(
    { ...base, kind: 'expire', actorId: 'z' },
    { ...base, kind: 'resolve', actorId: 'a' },
  )).toBeLessThan(0);
});
test('snapshot preserves complete state', () => {
  const state = fightFixture();
  expect(decodeSnapshot(encodeSnapshot(state), content, createGrid(content.grid)))
    .toEqual(state);
});
```

- [ ] Run the three new suites and observe the missing behavior failures.
- [ ] Implement queue ordering with the fixed priority map and ASCII string comparison; never `localeCompare`:

```ts
const priority = { expire: 0, regen: 10, resolve: 20, act: 30,
  deadline: 40, transition: 50 } as const;
export function compareScheduled(a: ScheduledEvent, b: ScheduledEvent): number {
  return a.at - b.at || priority[a.kind] - priority[b.kind]
    || (a.actorId < b.actorId ? -1 : a.actorId > b.actorId ? 1 : 0)
    || a.seq - b.seq;
}
```

`startState` validates roster, skills/conditions, strategies, placement, limits, and seed; creates fresh full-resource party actors; initializes metrics and sequences; schedules first walk completion at 2,000 ms and regen at 5,000 ms. Snapshot validation checks the complete runtime schema and version IDs, including at most one current actionable event per token and valid pending-cast targets/identity. Allow stale queued entries to exist when their epoch/token marks them stale.

- [ ] Add rejection tests for wrong versions, zero RNG, negative HP, unsafe timestamp, duplicate live positions, invalid rule/class pairing, malformed queue, and >1 MiB text. Confirm repeated serialization gives identical text. Run state/snapshot/scheduler/math/grid tests.
- [ ] Commit with message `feat: define resumable state and stable event queue`.

### Task 5: Strategy, casts, threat, and timed effects

**Files:** Create `src/strategy.ts`, `src/actions.ts`, `src/effects.ts`, `test/actions.test.ts`, `test/effects.test.ts`.

**Interfaces:** Consumes state/content/Battlefield/Context. Produces `decide(state,actorId,ctx)`, `resolveCast(state,actorId,ctx)`, `expire(state,actorId)`. Resolver applies the whole cast and marks deaths; the advance dispatcher invokes `finishEncounter` afterwards, keeping lifecycle dependency in task 6. Strategy can use internal `Decision` union `{kind:'cast',skillId,targets}` / `{kind:'move',position}` / `{kind:'idle'}`.

- [ ] Add a healing test that proves threat uses actual restoration, not requested healing:

```ts
import { expect, test } from 'vitest';
import { decide, resolveCast } from '../src/actions';
import { fightFixture, context } from './fixtures';
import type { DomainEvent } from '../src/types';
test('near-full target creates only effective-heal threat', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  const cleric = state.actors.p1;
  state.actors.p0.hp = state.actors.p0.stats.maxHp - 5;
  state.input.strategies.p1.rules = [{ skillId: 'heal', enabled: true,
    condition: { kind: 'ally-hp-below', value: 99 } }];
  decide(state, cleric.id, ctx);
  state.nowMs = cleric.pendingCast!.completesAt;
  resolveCast(state, cleric.id, ctx);
  expect(events.find(e => e.kind === 'heal')?.amount).toBe(5);
  for (const enemy of Object.values(state.actors).filter(a => a.side === 'enemy'))
    expect(enemy.threat.p1).toBe(2);
});
```

- [ ] Run action/effect suites; expect missing handler failures.
- [ ] Implement rule scanning and target sorting exactly from scope §6. Apply costs/cooldown at cast start and schedule a `resolve` at calculated completion. Use explicit RNG draws for each valid hit and actor-ID-sorted AoE targets. Implement each skill through its declared effect/hit count, with only Heal, Smite, Taunt, and Frost Nova requiring their specified special rules.

```ts
// Inside a heal resolution, after validating a living in-range target:
const restored = effectiveHeal(target.hp, target.stats.maxHp, 50 + 2 * caster.attributes.int);
target.hp += restored;
const threatAdded = Math.floor(restored / 2);
for (const enemy of Object.values(state.actors)
  .filter(a => a.side === 'enemy' && a.hp > 0)
  .sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
  enemy.threat[caster.id] = (enemy.threat[caster.id] ?? 0) + threatAdded;
}
```

Expire each elapsed status/force record before actions. Stun postpones rather than refunds/cancels the pending action. Repeated slow uses strongest-active value; duplicate Taunt replaces force and updates threat. Dead/invalid targets fizzle without new RNG or refund.

- [ ] Add separate behavior cases for eight skills, hit/miss/crit consumption, Double Shot target death, out-of-range completion, AoE clipping/friendly-fire exclusion, Taunt replacement/expiry/unreachable source, slow replacement/expiry, and stun at completion. Check disabled/unaffordable/on-cooldown rules and attacking-member fallback. Run all sim tests.
- [ ] Commit with message `feat: implement strategy driven skills and threat`.

### Task 6: Encounters, regeneration, rest, wipes, and stop reasons

**Files:** Create `src/lifecycle.ts`, `test/lifecycle.test.ts`; update fixtures for deterministic fixed/mixed recipes.

**Interfaces:** Produces `transition(state,ctx)`, `regenerate(state,ctx)`, `finishEncounter(state,ctx)`; consumes resolver deaths and queue APIs. No level-up or spendable resource balances are added.

- [ ] Add total-wipe-limit and victory-revival tests:

```ts
import { expect, test } from 'vitest';
import { finishEncounter } from '../src/lifecycle';
import { fightFixture, context } from './fixtures';
test('one allowed wipe stops on the first wipe', () => {
  const state = fightFixture();
  for (const a of Object.values(state.actors).filter(a => a.side === 'party')) a.hp = 0;
  finishEncounter(state, context(state, []));
  expect(state.phase).toBe('stopped');
  expect(state.stopReason).toBe('wipe-limit');
  expect(state.metrics.wipes).toBe(1);
});
test('won encounter revives a member without a free MP refill', () => {
  const state = fightFixture();
  state.actors.p1.hp = 0;
  state.actors.p1.mp = 3;
  for (const a of Object.values(state.actors).filter(a => a.side === 'enemy')) a.hp = 0;
  finishEncounter(state, context(state, []));
  expect(state.actors.p1.hp).toBe(Math.floor(state.actors.p1.stats.maxHp / 10));
  expect(state.actors.p1.mp).toBe(3);
});
```

- [ ] Run `pnpm test packages/sim/test/lifecycle.test.ts`; observe missing lifecycle failures.
- [ ] Implement the specified phase state machine. Each transition invalidates the old encounter epoch, preserves party cooldowns, and schedules only the next necessary timed work. Fixed recipe selection draws no RNG; mixed uses one bounded draw over ordered melee/ranged/clustered weights. Emit one spawn/phase event per corresponding transition and one win/wipe per resolved encounter.

```ts
// Wipe branch of finishEncounter; shared cleanup occurs before this branch.
state.metrics.wipes += 1;
if (state.metrics.wipes >= state.input.wipeLimit) {
  state.phase = 'stopped';
  state.stopReason = 'wipe-limit';
  state.queue = [];
} else {
  state.phase = 'respawning';
  schedule(state, { at: state.nowMs + ctx.content.respawnMs,
    kind: 'transition', actorId: '', epoch: null, token: null });
}
```

Regen runs on the global cadence; living actors only. Rest reevaluates after ticks and applies the strict start/higher exit comparisons. Victory revival clears encounter statuses without resetting MP/cooldowns. Respawn completion performs the only full HP/MP reset after initial experiment setup.

- [ ] Test five-total-wipe behavior, a 30-second respawn, cooldown preservation, zero-MP rest exclusion, 89/90 HP and 79/80 MP boundaries, walking/regen overlap, stable formation reset, mixed-seed repeatability, and no duplicate win from stale events. Run lifecycle/action/effect tests.
- [ ] Commit with message `feat: implement bounded encounter and recovery loop`.

### Task 7: Bounded advance, collection modes, and public projection

**Files:** Create `src/advance.ts`, `src/project.ts`, `src/index.ts`, `test/advance.test.ts`, `test/invariants.test.ts`, `test/projection.test.ts`; finish `lab`, `atFight`, `runTo` helpers.

**Interfaces:** Produces the complete `Simulation` interface and `createSimulation`. Public entry points wrap the tested state/snapshot/handler modules. `runTo` resumes work-budget yields to an absolute target.

- [ ] Add the core equivalence tests before composing the dispatcher:

```ts
import { expect, test } from 'vitest';
import { lab, labInput, runTo } from './fixtures';
test('split and summary runs preserve state and ordered events', () => {
  const sim = lab();
  const initial = sim.start(labInput());
  const direct = runTo(sim, initial, 60000);
  const left = runTo(sim, initial, 2751);
  const right = runTo(sim, sim.decode(sim.encode(left.state)), 60000);
  expect(right.state).toEqual(direct.state);
  expect([...left.events, ...right.events]).toEqual(direct.events);
  expect(runTo(sim, initial, 60000, { collect: 'summary' }).state).toEqual(direct.state);
});
test('work limit yields without changing the outcome', () => {
  const sim = lab();
  const state = sim.start(labInput());
  expect(runTo(sim, state, 60000, { maxScheduledEvents: 1 }))
    .toEqual(runTo(sim, state, 60000));
});
```

- [ ] Run the new suites and observe missing Simulation dispatch failures.
- [ ] Implement `advance` using this control flow and the exact return/stop rules from contract §5:

```text
validate compatible state and target >= state.nowMs
clone input once; initialize optional event collector
while a queued entry is due and the work budget remains:
    pop smallest entry; count it even if stale
    accrue elapsed duration to current phase; move nowMs to entry.at
    if epoch/token is stale: continue
    dispatch expire / regen / resolve / act / deadline / transition
    after resolve: finishEncounter
    assert resource, time, occupancy, and scheduling invariants
    if stopped: return exact stopped state with reachedTarget=true
if due entries remain: return checkpoint with reachedTarget=false
accrue remaining duration to target; set nowMs=target
return canonical queue/state with reachedTarget=true
```

Domain emission increments the same counter in both modes. Implement `project` as an explicit allowlist of fields, not object spread of runtime actors. Export only public state and observed current targeting reasons; never queue/RNG or future hit results.

- [ ] Add fast-check seed/split tests (100 cases initially), exact deadline/final-kill ordering, expiry-at-cast boundary, input immutability, stopped-state stability, queue-yield equivalence, snapshot mid-cast, and forbidden projection fields. Record one pinned one-hour fixture from an actual run and its content/simulation IDs. Run all sim suites plus typecheck.
- [ ] Commit with message `feat: expose deterministic resumable simulation`.

### Task 8: Balance CLI, matrices, and honest performance measurement

**Files:** Create `tools/balance/package.json`, all `src/*.ts` and tests in its file map, plus `packages/sim/test/stress-fixture.ts`.

**Interfaces:** `runBatch(input:LabInput,seeds:number[],untilMs:number):RunResult[]`; `RunResult` contains the exact CSV fields and `metrics:Metrics`. `runMatrix(seeds:number[],untilMs:number):RunResult[]` enumerates the 34 compositions/recipes/placements. `writeCsv(rows:RunResult[]):string` returns escaped CSV; CLI owns writing. `benchmark(hours:number[],runs:number):BenchmarkReport` returns metadata and per-run timing/memory/actual-simulated-time records.

- [ ] Add duplicate-seed reproducibility and output-denominator tests:

```ts
import { expect, test } from 'vitest';
import { runBatch } from '../src/run';
import { labInput } from '../../../packages/sim/test/fixtures';
test('same seeds yield identical gameplay metrics', () => {
  const rows = runBatch(labInput(), [1,1], 60000);
  expect(rows[0]).toEqual(rows[1]);
  expect(rows[0].elapsed_ms).toBeLessThanOrEqual(rows[0].requested_ms);
  const expected = rows[0].elapsed_ms === 0 ? null
    : rows[0].kills * 3600000 / rows[0].elapsed_ms;
  expect(rows[0].kills_per_hour).toBe(expected);
});
```

- [ ] Run `pnpm test tools/balance/test`; expect missing run/report export failures.
- [ ] Implement summary-mode runs without retaining domain logs; drain work-budget yields to the same target. Build class multisets using nondecreasing class indexes so ordering does not multiply equivalent compositions. Generate placements explicitly from the spec; default positions remain class-aware. Encode CSV strings with doubled quotes and wrap fields containing commas/newlines/quotes.

```ts
function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",\n\r]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}
function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}
```

Separate gameplay measurements from wall-clock timing, so repeated gameplay rows remain identical. Benchmark in isolated worker processes to measure peak sampled RSS and wall duration per run. Implement the explicitly labeled engine-stress fixture; its omission of regen is test setup, not a hidden gameplay option. Report early-stopped normal runs separately from full-duration stress runs.

- [ ] Test seed range parsing, unknown class/recipe rejection, quote escaping, zero-duration output, exactly 34 multisets, short-run labeling, and required benchmark metadata. Run a small actual batch: `pnpm balance run --hours 0.01 --seeds 1:3 --recipe mixed --party guardian,cleric,ranger --out artifacts/cli-smoke.csv`.
- [ ] Commit explicit CLI/fixture paths with message `feat: add reproducible balance and benchmark tools`.

### Task 9: Laboratory controls, worker protocol, and playback clock

**Files:** Create client manifest/Vite/index/main/App/styles, `src/worker-contract.ts`, `src/experiment.worker.ts`, `src/useExperiment.ts`, `src/clock.ts`, `src/ExperimentControls.tsx`, `test/clock.test.ts`, `test/controls.test.tsx`.

**Interfaces:** Worker messages use contract §7 verbatim. Pure clock helpers live in `src/clock.ts`: `horizon(clock:PlaybackClock,realNowMs:number):number`; `reanchor(clock,realNowMs,{paused?,speed?}):PlaybackClock`. `PlaybackClock` has `realAnchorMs`, `simAnchorMs`, `speed`, `paused`, `bufferMs`; horizons are nonnegative and capped by stop time in the hook. Hook exports `{state,events,status,start,pause,resume,stop,setSpeed}`.

- [ ] Add a pause/reanchor test with no real sleeps:

```ts
import { expect, test } from 'vitest';
import { horizon, reanchor } from '../src/clock';
test('paused real time does not advance the laboratory', () => {
  const clock = { realAnchorMs: 0, simAnchorMs: 0, speed: 1,
    paused: false, bufferMs: 2000 };
  expect(horizon(clock,5000)).toBe(3000);
  const paused = reanchor(clock,5000,{ paused: true });
  expect(horizon(paused,15000)).toBe(3000);
  const resumed = reanchor(paused,15000,{ paused: false });
  expect(horizon(resumed,16000)).toBe(4000);
});
```

- [ ] Run client unit tests; observe absent clock/control behavior.
- [ ] Implement the clock with anchors in **unbuffered simulation time**; subtract buffer exactly once in `horizon`. Pausing/speed changes preserve that unbuffered value, avoiding double buffer subtraction. Implement worker generations, one outstanding advance, a 25-scheduled-event work budget, the 1,000-domain-event bound, and acknowledgements; do not send a new request while the previous one is unconsumed.

```ts
export function horizon(clock: PlaybackClock, realNowMs: number): number {
  const delta = clock.paused ? 0 : Math.max(0, realNowMs - clock.realAnchorMs) * clock.speed;
  return Math.max(0, Math.floor(clock.simAnchorMs + delta - clock.bufferMs));
}
export function reanchor(clock: PlaybackClock, now: number,
  changes: Partial<Pick<PlaybackClock,'paused'|'speed'>>): PlaybackClock {
  const delta = clock.paused ? 0 : Math.max(0, now - clock.realAnchorMs) * clock.speed;
  return { ...clock, simAnchorMs: clock.simAnchorMs + delta,
    realAnchorMs: now, ...changes };
}
```

Controls validate class/strategy/placement combinations before start. Retain experimental setup separately from the active input; a changed setup starts a new generation. Persist neither results nor seeds to a production service. Worker exceptions become bounded error messages; clean up listeners and terminate workers on unmount.

- [ ] Test invalid/duplicate placements, one-to-three roster sizes, stale-generation rejection, pause/speed changes, bounded pending frames, worker error recovery, and no future-event publication beyond the supplied horizon. Build the client once.
- [ ] Commit with message `feat: add isolated combat laboratory controls`.

### Task 10: Isometric board, localization, and comparative reports

- [ ] Use Realm Refined Hunt/Strategy as the primary visual reference. Share window, resource-bar, unit, skill-state and typography tokens/components; keep A's actual content and experiment controls. Do not recreate the review gallery/footer or fake excluded systems.
- [ ] Verify composition at 1440×900 and 1280×800, and no clipping at 1100px width; test PT-BR/long labels, keyboard placement/focus and reduced motion. Inspectable skill states must never become manual-cast controls. Compare observed experiments, not mockup survival projections.

**Files:** Create `BattlefieldView.tsx`, `EventLog.tsx`, `Comparison.tsx`, `art-manifest.ts`, `i18n.ts`, both locale JSON files; update App/styles and client component tests.

**Interfaces:** `BattlefieldView` consumes `PublicState` and `GridConfig`; never reads `SimState`. `EventLog` consumes the last 500 DomainEvents. `Comparison` receives prop `runs: readonly {input:LabInput,state:PublicState}[]`, with zero to two entries. All labels come from translation keys; numeric amounts use locale formatting.

- [ ] Add accessible control and comparison tests before UI implementation. Example behavior:

```tsx
import { expect, test } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { Comparison } from '../src/Comparison';
import '../src/i18n';
import { lab, labInput } from '../../../packages/sim/test/fixtures';
test('comparison renders actual-time rates and zero-time absence', () => {
  const sim = lab();
  const input = labInput();
  const initial = sim.project(sim.start(input));
  const completed = { ...initial, nowMs: 30000,
    metrics: { ...initial.metrics, kills: 5 } };
  render(<Comparison runs={[{ input, state: completed }, { input, state: initial }]} />);
  const a = within(screen.getByTestId('comparison-slot-a'));
  const b = within(screen.getByTestId('comparison-slot-b'));
  expect(a.getByTestId('kills-per-hour')).toHaveTextContent('600');
  expect(a.getByTestId('elapsed-time')).toHaveTextContent('30 s');
  expect(b.getByTestId('kills-per-hour')).toHaveTextContent('—');
});
```

- [ ] Run client tests and observe missing render/translation behavior.
- [ ] Draw the board with this projection and manifest-driven original shapes:

```ts
function projectCell(column: number, row: number, tileWidth: number, tileHeight: number) {
  return { x: (column - row) * tileWidth / 2,
    y: (column + row) * tileHeight / 2 };
}
```

Depth-sort by row+column with stable actor-ID ties. Show spawn zones during setup, selection outline, valid placement targets, and current actor HP/MP. Keyboard cell selection mirrors click behavior through buttons or an accessible grid overlay. Avoid parsing PositionId outside the grid adapter; call `gridCoordinates` in this renderer only.

Create translation keys for every label, error code, class/monster/skill name, target reason, and event sentence. Retain only the two comparison slots and 500 event rows. A phase/stop report states observed facts, not unsupported diagnoses. Destroy Pixi resources on unmount and handle resize without recreating simulation state.

- [ ] Test EN/PT-BR key parity, keyboard placement, invalid-cell explanation, two comparison slots, event-log cap, and explicit laboratory labeling. Build client and manually inspect both languages at narrow and wide widths.
- [ ] Commit with message `feat: visualize and compare combat experiments`.

### Task 11: End-to-end verification, benchmarks, and placement decision

**Files:** Create `e2e/laboratory.spec.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`; extend `test/invariants.test.ts`; produce `artifacts/milestone-a-results.md` during execution.

**Interfaces:** Consumes the working CLI and browser laboratory. Produces evidence and a retain/simplify recommendation; it does not automatically authorize milestone B or more content.

- [ ] Add Playwright smoke coverage using accessible names translated by the selected locale:

```ts
import { expect, test } from '@playwright/test';
test('a player can run, pause, resume and inspect an experiment', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start experiment', exact: true }).click();
  await expect(page.getByTestId('elapsed-time')).not.toHaveText('0 s');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByTestId('playback-status')).toHaveText('Paused');
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.getByRole('button', { name: 'Stop experiment', exact: true }).click();
  await expect(page.getByTestId('comparison-slot-a')).toBeVisible();
});
```

Add a second run from changed placement and verify comparison B, plus PT-BR smoke with its actual translated accessible names. Use condition-based waits, not fixed sleeps.

- [ ] Run the smoke test and fix wiring, accessibility, event-buffer, or localization failures it exposes. Do not fabricate a red test if prior implementation already satisfies it; record the observed result.
- [ ] Wire CI to install from frozen lockfile, generate content, typecheck, lint, run unit/integration tests, install the test browser, build client, and run Playwright. Use package/runtime versions recorded in task 1.
- [ ] Run the required evidence commands:

```sh
pnpm check
pnpm --filter @narok/client build
pnpm test:e2e
pnpm balance run --hours 1 --seeds 1:100 --recipe mixed --party guardian,cleric,ranger --out artifacts/baseline.csv
pnpm balance matrix --hours 1 --seeds 1:100 --out artifacts/matrix.csv
pnpm balance benchmark --hours 12,24 --runs 20 --out artifacts/performance.json
```

Benchmark the sustained engine fixture as specified, and run a batch of 100 jobs with bounded concurrency. Record workstation results separately if the intended VPS is unavailable; do not claim the VPS target has passed. If performance is inadequate, use profiles to choose the next optimization rather than replacing combat with a different offline formula.

- [ ] Conduct the five-person placement experiment. Record actual observations and the evidence for each explanation; this step requires real testers and cannot be marked complete by an automated agent acting as five people. If testers are unavailable, finish all automated work and leave only this evidence gate explicitly pending.
- [ ] Write the results report with commands and outcomes, actual build hashes, artifact paths, benchmark hardware, short/full-run distinctions, human observations, and the retain/simplify recommendation. Report any failed or unavailable gate plainly.
- [ ] Commit CI/e2e changes and the concise results report with message `test: verify combat prototype and record experiment results`. Do not commit large raw benchmark outputs or secrets.

## Coverage and acceptance map

| Requirement | Implementation tasks | Evidence |
|---|---|---|
| A-01 classes/party sizes/duplicates | 1, 4, 9 | content/input validation and controls |
| A-02 eight skills | 1, 3, 5 | per-skill resolver tests |
| A-03 grid/geometry | 2, 5, 10 | two-board tests, placement controls |
| A-04 recipes | 1, 6 | fixed/mixed spawn and seed tests |
| A-05 strategies | 4, 5, 9 | selection/fallback/condition tests |
| A-06 determinism/checkpoints | 1, 4, 7 | vectors, split, restore, boundary tests |
| A-07 loop/wipes/stalemate | 6, 7 | lifecycle/deadline tests |
| A-08 fixed builds/raw opportunities | 1, 3, 6, 8 | stat vectors and labeled CSV |
| A-09 collection/work limits | 7, 9 | equal-state modes, bounded yields/frames |
| A-10 CLI/performance | 8, 11 | actual CSV/JSON plus machine metadata |
| A-11 browser/comparison | 9, 10, 11 | component/e2e and visual inspection |
| A-12 languages/art | 10, 11 | locale parity, manifest, bilingual smoke |
| A-13 verification | 4, 7, 11 | all automated commands and results |
| A-14 human grid decision | 11 | real tester observations and recommendation |

## Execution handoff

The packet is documentation-only. An implementation request can use either task-by-task subagent execution with review between tasks, or inline execution with checkpoints. Read both linked specs first; preserve prototype-default labels and avoid adding milestone B/C work. Completion requires reporting real evidence and any remaining human-test or target-hardware gate.
