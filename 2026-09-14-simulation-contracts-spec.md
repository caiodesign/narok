# Milestone A — Simulation and Experiment Contracts

**Date:** 2026-09-14\
**Updated:** 2026-09-16 — presentation cross-reference added; simulation interfaces unchanged.\
**Status:** Selected technical defaults for the [milestone A scope and mechanics](2026-09-14-milestone-a-spec.md).\
**Parent direction:** [Layer 1 design](layer-1-design.md)

## 1. Module boundaries and dependencies

The client follows the [Realm UI specification](2026-09-16-realm-ui-spec.md) within milestone A scope. Its visual mockups are not content tables or simulation contracts. Their localStorage queues, offline reports, sample stat previews and DOM mutations must not be imported into this engine; production command/persistence contracts belong to milestone B.

```text
packages/data  ←  packages/sim  ←  tools/balance
                       ↑
                apps/client worker → public frames → React/PixiJS
```

`data` supplies typed immutable definitions; it imports neither simulation nor browser modules. `sim` imports content types/data, contains all deterministic transitions, and imports no Node/browser I/O. The CLI owns files and performance clocks. The worker owns experiment pacing. React/PixiJS owns controls, rendering, localization, and bounded playback history.

There is no server or protocol package until milestone B needs it. A's public frame type belongs to `sim` so the worker and CLI can share it without creating a speculative production API.

## 2. Content definitions

Define these in `packages/data/src/types.ts`; export them through its index. IDs are ASCII stable identifiers, not display names.

```ts
export type ClassId = 'guardian' | 'cleric' | 'ranger' | 'arcanist';
export type SkillId = 'taunt' | 'cleave' | 'heal' | 'smite'
  | 'double-shot' | 'arrow-rain' | 'fire-bolt' | 'frost-nova';
export type RecipeId = 'melee' | 'ranged' | 'clustered';
export type Element = 'neutral' | 'fire' | 'water' | 'earth' | 'wind';
export type Family = 'beast' | 'undead' | 'demon' | 'plant' | 'insect' | 'humanoid';
export type ShapeId = 'single' | 'cleave' | 'square' | 'plus';
export type DamageKind = 'physical' | 'magic';
export interface Attributes {
  str: number; agi: number; vit: number; int: number; dex: number; luk: number;
}
export interface GridConfig {
  width: number; height: number; playerRows: number[]; enemyRows: number[];
  moveMs: number; maxEnemies: number;
}
export interface ClassDefinition {
  id: ClassId; attributes: Attributes; level: number;
  baseHp: number; hpPerLevel: number; baseMp: number; mpPerLevel: number;
  weaponAtk: number; weaponMatk: number; armorDef: number; armorMdef: number;
  basicIntervalMs: number; basicRange: number; basicKind: DamageKind;
  skills: SkillId[];
}
export interface SkillDefinition {
  id: SkillId; mp: number; cooldownMs: number; baseCastMs: number;
  range: number; shape: ShapeId; powerBp: number; hits: number;
  effect: 'damage' | 'heal' | 'taunt'; damageKind: DamageKind;
  element: Element; slowBp: number; durationMs: number;
}
export interface MonsterDefinition {
  id: string; level: number; family: Family; element: Element;
  hp: number; mp: number; atk: number; matk: number; def: number; mdef: number;
  hit: number; flee: number; intervalMs: number; range: number;
  rawExp: number; rawGold: number;
}
export interface RecipeDefinition {
  id: RecipeId; weight: number;
  monsters: { monsterId: string; column: number; row: number }[];
}
export interface Content {
  version: string; gridHash: string; grid: GridConfig;
  classes: Record<ClassId, ClassDefinition>;
  skills: Record<SkillId, SkillDefinition>;
  monsters: Record<string, MonsterDefinition>;
  recipes: Record<RecipeId, RecipeDefinition>;
  shapes: Record<ShapeId, [number, number][]>;
  elements: Record<Element, Record<Element, number>>;
  walkMs: number; regenMs: number; encounterLimitMs: number; respawnMs: number;
}
```

For non-damaging skills use `powerBp=0`, `hits=1`, `damageKind='magic'`, `element='neutral'`. Heal computes restoration from INT. Taunt uses `shape='single'` but selects up to three primary target IDs in strategy. For damage skills without a timed effect use `slowBp=0,durationMs=0`; Frost Nova uses 3000/5000. Taunt duration is 4000. Smite's family multiplier is a versioned skill-specific rule in the combat resolver.

`validateContent(value: unknown): Content` checks all required keys, finite integer ranges, eight skills/four classes, nonempty recipes, at most five monsters, references, unique legal spawn cells, and complete element pairs. A prototype board supports 4–8 cells per dimension and at least three player/five enemy spawn cells; reject unsupported movement rather than pretending to support eight-direction movement.

The build generates `version` and `gridHash` using SHA-256 over canonical JSON content/config, excluding the digest fields. Canonical JSON recursively sorts object keys with code-unit order, preserves array order, and rejects non-JSON/nonfinite values. Hashing happens in the Node content-build tool; simulation only compares strings. Do not use timestamps in content hashes.

## 3. Public runtime types

Define in `packages/sim/src/types.ts`, importing the preceding content types. Code examples in the plan consume these exact names.

```ts
export type ActorId = string;
export type PositionId = string & { readonly __position: unique symbol };
export type Phase = 'walking' | 'fighting' | 'resting' | 'respawning' | 'stopped';
export type StopReason = 'wipe-limit' | 'stalemate' | 'operator';
export type TargetMode =
  | { kind: 'lowest-hp' | 'highest-hp' | 'highest-level' | 'nearest' }
  | { kind: 'attacking'; partyId: ActorId };
export type Condition =
  | { kind: 'always' | 'ally-targeted' }
  | { kind: 'ally-hp-below' | 'targets-at-least'; value: number };
export interface Rule { skillId: SkillId; enabled: boolean; condition: Condition }
export interface Strategy { rules: Rule[]; target: TargetMode }
export interface LabInput {
  seed: number; classes: ClassId[]; recipe: RecipeId | 'mixed';
  placement: Record<ActorId, PositionId>;
  strategies: Record<ActorId, Strategy>;
  rest: { hpStart: number; mpStart: number }; wipeLimit: number;
}
export interface DerivedStats {
  maxHp: number; maxMp: number; atk: number; matk: number; def: number; mdef: number;
  hit: number; flee: number; critBp: number; intervalMs: number;
}
export interface TimedStatus {
  id: string; sourceId: ActorId; kind: 'slow' | 'stun'; valueBp: number; expiresAt: number;
}
export interface PendingCast {
  skillId: SkillId | 'basic'; targets: ActorId[]; startedAt: number; completesAt: number;
  token: number;
}
export interface Actor {
  id: ActorId; side: 'party' | 'enemy'; definitionId: string; level: number;
  family: Family; element: Element; attributes: Attributes;
  stats: DerivedStats; hp: number; mp: number; position: PositionId;
  basicKind: DamageKind; basicRange: number; skills: SkillId[];
  cooldowns: Partial<Record<SkillId, number>>; statuses: TimedStatus[];
  threat: Record<ActorId, number>;
  forcedTarget: { actorId: ActorId; expiresAt: number } | null;
  currentTarget: ActorId | null; pendingCast: PendingCast | null; actionToken: number;
}
export type QueueKind = 'expire' | 'regen' | 'resolve' | 'act' | 'deadline' | 'transition';
export interface ScheduledEvent {
  at: number; kind: QueueKind; actorId: ActorId; seq: number;
  epoch: number | null; token: number | null;
}
export interface Metrics {
  kills: number; wins: number; wipes: number; rawExp: number; rawGold: number;
  damageDealt: number; effectiveHealing: number;
  walkMs: number; fightMs: number; restMs: number; respawnMs: number;
  actors: Record<ActorId, { damageDealt: number; damageReceived: number; healingDone: number }>;
}
export interface SimState {
  schemaVersion: 1; simulationVersion: 'a1'; contentVersion: string; gridHash: string;
  nowMs: number; rng: number; nextQueueSeq: number; nextDomainSeq: number;
  epoch: number; encounterCount: number; encounterStartedAt: number | null;
  phase: Phase; stopReason: StopReason | null; input: LabInput;
  actors: Record<ActorId, Actor>; queue: ScheduledEvent[]; metrics: Metrics;
}
export interface DomainEvent {
  seq: number; at: number; encounter: number;
  kind: 'phase' | 'spawn' | 'move' | 'cast' | 'damage' | 'miss' | 'heal'
    | 'death' | 'status' | 'taunt' | 'regen' | 'win' | 'wipe' | 'stop';
  actorId: ActorId | null; targetId: ActorId | null; amount: number | null;
  reason: string | null; position: PositionId | null;
}
export interface AdvanceOptions { collect?: 'events' | 'summary'; maxScheduledEvents?: number }
export interface AdvanceResult { state: SimState; events: DomainEvent[]; reachedTarget: boolean }
export interface PublicActor {
  id: ActorId; definitionId: string; side: 'party' | 'enemy'; position: PositionId;
  hp: number; mp: number; maxHp: number; maxMp: number; currentTarget: ActorId | null;
  casting: SkillId | 'basic' | null; targetReason: 'forced' | 'threat' | 'priority' | null;
}
export interface PublicState {
  nowMs: number; phase: Phase; stopReason: StopReason | null;
  actors: PublicActor[]; metrics: Metrics;
}
export interface Simulation {
  start(input: LabInput): SimState;
  advance(state: SimState, untilMs: number, options?: AdvanceOptions): AdvanceResult;
  stop(state: SimState): SimState;
  encode(state: SimState): string;
  decode(text: string): SimState;
  project(state: SimState): PublicState;
}
```

Export `createSimulation(content: Content, battlefield: Battlefield): Simulation` from the package root. `start`, `advance`, and `stop` do not mutate their input/content. Internal mutation of a private cloned state is allowed; use one clone per segment, not per event. `stop` preserves conditions, metrics, and RNG, clears scheduled work, sets `operator`, and does not emit gameplay rewards. The browser uses the returned projection and a local stop notification.

`encode/decode` use canonical JSON and full runtime validation. Reject incorrect schema/simulation/content/grid versions, unknown IDs, invalid numbers, invalid RNG, malformed queues, and contradictory actor/cast state. Verify field shapes and invariants before use; JSON parsing alone is not validation. Snapshots are experiment artifacts and cannot be imported as trusted production accounts.

Error codes: `INVALID_CONTENT`, `INVALID_INPUT`, `INVALID_STATE`, `WRONG_VERSION`, `TIME_REWIND`, `UNSAFE_INTEGER`, `LOOP_DETECTED`. Expose a `SimError extends Error` with `code` and a bounded diagnostic field path, never an enormous serialized state in the message. Maximum decoded snapshot input: 1 MiB. Content/runtime numbers are finite safe integers; durations, counts, resources and damage products are range checked before arithmetic could exceed the safe-integer range.

## 4. Battlefield and math APIs

In `packages/sim/src/battlefield/types.ts`:

```ts
export interface Battlefield {
  distance(a: PositionId, b: PositionId): number;
  inRange(a: PositionId, b: PositionId, range: number): boolean;
  placementSlots(side: Actor['side']): PositionId[];
  nextStep(actor: Actor, target: Actor, range: number, actors: Actor[]): PositionId | null;
  canReach(actor: Actor, target: Actor, range: number, actors: Actor[]): boolean;
  affected(primary: Actor, shape: ShapeId, eligible: Actor[]): ActorId[];
  validatePlacement(positions: PositionId[], side: Actor['side']): void;
}
```

`createGrid(config: GridConfig, shapes?: Content['shapes']): Battlefield`, `gridPosition(column:number,row:number): PositionId`, and `gridCoordinates(position:PositionId): {column:number,row:number}` live in the grid adapter. Omitted shapes use the prototype's exported data offsets; application/CLI composition passes the bound content's shapes explicitly. Only that adapter, fixture construction, and the renderer use coordinate conversions. `nextStep` returns null when already in range or no route; `canReach` distinguishes them.

Math exports:

```ts
derive(definition: ClassDefinition): DerivedStats
damage(input: {
  offense: number; powerBp: number; elementBp: number; familyBp: number;
  varianceBp: number; critical: boolean; defense: number; hit: boolean;
}): number
effectiveHeal(hp: number, maxHp: number, requested: number): number
nextU32(state: number): { state: number; value: number }
drawBelow(state: number, exclusiveMax: number): { state: number; value: number }
```

No math helper reads mutable PRNG implicitly. The resolver updates `state.rng` from explicit draw results. `effectiveHeal` returns actual restoration, not resulting HP.

## 5. Scheduler and checkpoints

Queue phases, in order:

| Kind | Priority | Meaning |
|---|---:|---|
| expire | 0 | Remove expired slow/stun/forced-target records |
| regen | 10 | Global party regeneration tick |
| resolve | 20 | Finish one actor's pending basic/skill cast atomically |
| act | 30 | Select skill/basic/movement or idle |
| deadline | 40 | Stop a still-unresolved encounter |
| transition | 50 | Complete walking or respawn |

Order by `(at, priority, actorId, seq)`; global events use `actorId=''`. Each scheduled event gets a monotonically increasing sequence. Party/enemy actions and deadlines use `epoch`; global regen and phase transitions use null. Increment epoch at encounter exit so stale casts cannot damage a subsequent group. Actor `token` invalidates replaced actions/casts. The global regen event schedules its successor regardless of phase unless stopped.

All newly scheduled decisions, cast completions, movement retries, and timed transitions are strictly later than the event that schedules them. Immediate damage, death marking, metrics, phase decisions, and domain emission happen inside the current handler; they do not schedule an earlier-priority same-time event. Expiry is always scheduled at a future duration. Assert the scheduling rule; reject zero/negative-duration content.

`advance` drains every queued event at or before `untilMs`, including stale entries, until target reached, stopped, or `maxScheduledEvents` is reached (default 10,000). Count popped entries, including stale ones, against the work limit. A yield leaves `nowMs` at the last processed entry; return `reachedTarget=false` unless stopped or no due entries remain. The caller resumes with the same target. When target is reached and active, accrue phase time up to that target and set `nowMs=untilMs`. When stopped, retain the exact stop time and return `reachedTarget=true`.

Metrics accumulate elapsed phase time **whenever nowMs advances**, including between arbitrary advance targets. Addition of integer durations must produce identical totals across splits. Domain sequence allocation and metrics happen whether or not the collector retains events. Summary mode returns an empty event array and the same final state. Do not store a detailed event history inside `SimState`.

Public scheduling exports in `scheduler.ts` for narrow tests: `compareScheduled(a,b):number`, `schedule(state,event:Omit<ScheduledEvent,'seq'>):void`, `takeNext(state):ScheduledEvent|undefined`. The internal array is canonically sorted at segment boundaries/serialization. Implement a heap only if measurement justifies it; a different internal queue layout must serialize to the same canonical order.

Pure transition entry points, exported for the package's own integration tests:

```ts
export interface Context { content: Content; battlefield: Battlefield; emit(event: Omit<DomainEvent,'seq'>): void }
export function decide(state: SimState, actorId: ActorId, ctx: Context): void;
export function resolveCast(state: SimState, actorId: ActorId, ctx: Context): void;
export function expire(state: SimState, actorId: ActorId): void;
export function transition(state: SimState, ctx: Context): void;
export function regenerate(state: SimState, ctx: Context): void;
export function finishEncounter(state: SimState, ctx: Context): void;
```

The advance dispatcher calls `finishEncounter` after a whole cast resolution; the cast resolver itself does not depend on lifecycle. It evaluates living sides, records a win/wipe exactly once, invalidates the encounter epoch, and chooses rest/walk/respawn/stop. The deadline handler runs after all same-time resolutions and stops only if still fighting. `Context.emit` injects the next domain sequence and records no separate wall time.

### Required RNG vector

Xorshift operations: `x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0`. Seed 1 must yield `270369`, then `67634689`, then `2647435461`. `drawBelow` accepts integer maxima 1–1,000,000, sets `limit=floor(2^32/max)*max`, draws until value < limit, then returns value modulo max. Reject seed zero. No cryptographic guarantee is claimed.

## 6. Test fixtures and public test helpers

Put only reusable fixture constructors in `packages/sim/test/fixtures.ts`:

```ts
export function labInput(overrides?: Partial<LabInput>): LabInput;
export function actor(overrides?: Partial<Actor>): Actor;
export function fightFixture(): SimState;
export function context(state: SimState, events: DomainEvent[]): Context;
export function lab(): Simulation;
export function atFight(): SimState;
export function runTo(sim: Simulation, state: SimState, untilMs: number,
  options?: AdvanceOptions): AdvanceResult;
```

- `labInput()` uses seed 1, Guardian/Cleric/Ranger, default positions/rules, mixed recipe, rest 50/30, wipe limit one. Overrides are shallow; callers replacing roster also provide corresponding placement/strategies.
- `actor()` creates a living party Guardian `p0` at `(2,3)` with derived preset stats, no effects/threat/cooldowns, no pending cast, and token zero. Overrides are explicit and never shared across calls.
- `fightFixture()` manually constructs the first melee encounter at 2,000 ms with default party/placement, three Boars, correct epoch, and first decisions at 2,500 ms. It does not call lifecycle/advance, allowing handler tests before dispatcher composition.
- `context(state,events)` binds validated prototype content and its grid/shapes; its emitter increments `state.nextDomainSeq` and appends complete domain events to the supplied array.
- `lab()` binds validated generated content and the default grid.
- `atFight()` starts default input and advances to 2,000 ms, returning the first spawned encounter before the 2,500 ms decisions.
- `runTo()` repeatedly calls `advance` with the same absolute target until `reachedTarget`, concatenates returned domain events, and requires progress on each yielded iteration. It is used only when a test needs full output; CLI summary execution discards each batch.

Stress fixtures use separately versioned test content, never normal player inputs: party/enemies with 10,000,000 HP, zero MP, 300 ms intervals, damage one, range ten, no healing/status/skills; encounter timeout 24 hours +1 ms; level and defenses chosen to keep arithmetic bounded. Spawn three party/five enemies at legal separate cells already within attack range, disable regen in the dedicated engine fixture through an omitted regen event, and schedule actors at +1 ms. The HP budget keeps all eight actors alive over the requested horizon. This creates a sustained high-event-rate schedule for 12/24 hours without claiming normal combat sustainability. Mark output `fixture=engine-stress` and keep normal gameplay benchmarks separate.

## 7. Worker, renderer, and CLI contracts

Worker input is a discriminated union: `start {generation,input}`, `advance {generation,untilMs}`, `stop {generation}`, `export {generation}`, and `import {generation,text}`. The worker holds at most one experiment state. Unknown/stale generations are rejected. `import` calls decode; it never bypasses validation.

Worker output: `frame {generation,state:PublicState,events:DomainEvent[],reachedTarget}`, `snapshot {generation,text}`, or `error {generation,code,field}`. Limit each advance to 25 scheduled events and each returned batch to 1,000 domain events. A work-budget yield is acknowledged and followed by another advance to the same target; there is one frame per request. Exceeding the domain-event bound is a protocol invariant error, never permission to drop events. The client sends the next advance only after consuming the preceding frame. A result's `state.nowMs` must be ≤ the requested target; pending casts expose their current skill, never future outcomes.

The laboratory clock maps real elapsed playback time to a nondecreasing experiment horizon, subtracting its playback buffer. Pause updates its anchor without advancing the worker. Speed changes settle the current anchor first. Node/browser clocks and timers remain outside `sim`.

`ExperimentControls.tsx` edits `LabInput`. `useExperiment.ts` owns generation, worker, clock, pause/resume/stop, and two summary slots. `BattlefieldView.tsx` receives `PublicState` and grid config, manages PixiJS lifecycle, and uses grid projection only. `EventLog.tsx` renders the last 500 translated events. `Comparison.tsx` compares metrics with the actual elapsed denominator.

CLI entry `tools/balance/src/cli.ts` parses `run`, `matrix`, `benchmark` commands. `runBatch` and `runMatrix` construct explicit inputs and call the same `Simulation`; `writeCsv` and `writeBenchmark` own filesystem output. Fail on invalid seeds/hours/classes/paths with a nonzero exit; create only the requested artifact parent directory. CSV quotes strings properly and emits no NaN/Infinity; use empty rate fields for zero elapsed time. Add artifact JSON metadata with parameters and build IDs.

## 8. Requirement traceability and deferred production obligations

This contract implements A-03 through A-13 from the milestone spec; the plan maps every A requirement to tasks. Production obligations remain in the parent: no live seed disclosure, no future authoritative outcome publication, server command sequencing, version-pinned maintenance settlement, account-wide transactions, and idempotent resources. The disposable laboratory neither proves nor bypasses those obligations.
