import { expect, test } from 'vitest';
import { content } from '@narok/data';
import type { ClassId } from '@narok/data';
import { decide, resolveCast } from '../src/actions';
import { expire } from '../src/effects';
import { derive } from '../src/math';
import { createGrid, gridPosition } from '../src/battlefield/grid';
import { isStale } from '../src/scheduler';
import { defaultStrategy } from '../src/state';
import { encodeSnapshot, decodeSnapshot } from '../src/snapshot';
import { fightFixture, context } from './fixtures';
import type {
  Actor, ActorId, DomainEvent, QueueKind, Rule, ScheduledEvent, SimState, TargetMode,
} from '../src/types';

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

/** Replaces one roster member's class so a single fixture can exercise every class. */
function useClass(state: SimState, id: ActorId, classId: ClassId): Actor {
  const definition = content.classes[classId];
  const target = state.actors[id];
  const stats = derive(definition);
  target.definitionId = classId;
  target.attributes = { ...definition.attributes };
  target.stats = stats;
  target.hp = stats.maxHp;
  target.mp = stats.maxMp;
  target.basicKind = definition.basicKind;
  target.basicRange = definition.basicRange;
  target.skills = [...definition.skills];
  state.input.classes[Number(id.slice(1))] = classId;
  state.input.strategies[id] = defaultStrategy(classId);
  return target;
}

function setRules(state: SimState, id: ActorId, rules: Rule[], target?: TargetMode): void {
  state.input.strategies[id].rules = rules;
  if (target) state.input.strategies[id].target = target;
}

function place(state: SimState, id: ActorId, column: number, row: number): void {
  state.actors[id].position = gridPosition(column, row);
}

/** Queued entries of one kind for one actor that the dispatcher would still act on. */
function live(state: SimState, kind: QueueKind, actorId: ActorId): ScheduledEvent[] {
  return state.queue.filter(
    (event) => event.kind === kind && event.actorId === actorId && !isStale(state, event),
  );
}

/**
 * Removes an actor's queued entry of one kind, standing in for the dispatcher, which
 * always pops an entry before running its handler. Only matters where the handler
 * re-schedules the same kind under the same token (stun postponement).
 */
function popQueued(state: SimState, kind: QueueKind, actorId: ActorId): void {
  const index = state.queue.findIndex((e) => e.kind === kind && e.actorId === actorId);
  if (index !== -1) state.queue.splice(index, 1);
}

function queuedAt(state: SimState, kind: QueueKind, actorId: ActorId): number[] {
  return state.queue.filter((e) => e.kind === kind && e.actorId === actorId).map((e) => e.at);
}

function summary(events: DomainEvent[]): unknown[][] {
  return events.map((e) => [e.kind, e.actorId, e.targetId, e.amount, e.reason]);
}

/** Runs one decision and its completion, moving simulated time to the cast's end. */
function castAndResolve(state: SimState, id: ActorId, ctx: ReturnType<typeof context>): void {
  decide(state, id, ctx);
  state.nowMs = state.actors[id].pendingCast!.completesAt;
  resolveCast(state, id, ctx);
}

test('a physical hit draws crit, accuracy and variance, then banks damage threat', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  place(state, 'p0', 2, 2);
  setRules(state, 'p0', []);
  state.rng = 1;

  decide(state, 'p0', ctx);
  expect(state.actors.p0.pendingCast).toEqual({
    skillId: 'basic', targets: ['e1'], startedAt: 2_000, completesAt: 2_001, token: 1,
  });
  expect(state.actors.p0.currentTarget).toBe('e1');
  expect(state.actors.p0.mp).toBe(60);
  expect(state.actors.p0.cooldowns).toEqual({});
  expect(state.rng).toBe(1);

  state.nowMs = 2_001;
  resolveCast(state, 'p0', ctx);

  // Exactly three draws: crit 369, accuracy 4689, variance 9405 from seed 1.
  expect(state.rng).toBe(2_647_435_461);
  expect(summary(events)).toEqual([
    ['cast', 'p0', 'e1', null, 'basic'],
    ['damage', 'p0', 'e1', 30, 'basic'],
  ]);
  expect(state.actors.e1.hp).toBe(150);
  expect(state.actors.e1.threat).toEqual({ p0: 30 });
  expect(state.metrics.damageDealt).toBe(30);
  expect(state.metrics.actors.p0.damageDealt).toBe(30);
  expect(state.actors.p0.pendingCast).toBeNull();
  expect(live(state, 'act', 'p0')).toEqual([
    { at: 3_570, kind: 'act', actorId: 'p0', seq: expect.any(Number), epoch: 0, token: 2 },
  ]);
});

test('a miss still consumes all three physical draws and adds no threat', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  place(state, 'p0', 2, 2);
  setRules(state, 'p0', []);
  state.actors.e1.stats.flee = 100; // hit chance clamps to 5%, accuracy roll 4689 fails
  state.rng = 1;

  castAndResolve(state, 'p0', ctx);

  expect(state.rng).toBe(2_647_435_461);
  expect(summary(events)).toEqual([
    ['cast', 'p0', 'e1', null, 'basic'],
    ['miss', 'p0', 'e1', null, 'basic'],
  ]);
  expect(state.actors.e1.hp).toBe(180);
  expect(state.actors.e1.threat).toEqual({});
  expect(state.metrics.damageDealt).toBe(0);
});

test('a critical bypasses accuracy and multiplies the roll by 1.5', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  place(state, 'p0', 2, 2);
  setRules(state, 'p0', []);
  state.actors.p0.stats.critBp = 10_000;
  state.actors.e1.stats.flee = 100; // accuracy would fail; the crit lands anyway
  state.rng = 1;

  castAndResolve(state, 'p0', ctx);

  expect(state.rng).toBe(2_647_435_461);
  expect(summary(events)).toEqual([
    ['cast', 'p0', 'e1', null, 'basic'],
    ['damage', 'p0', 'e1', 46, 'basic:critical'],
  ]);
  expect(state.actors.e1.hp).toBe(134);
});

test('smite consumes only variance, always lands, and never crits', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  setRules(state, 'p1', [{ skillId: 'smite', enabled: true, condition: { kind: 'always' } }]);
  state.actors.p1.stats.critBp = 10_000; // magic ignores the crit roll entirely
  state.actors.e0.stats.flee = 100; // magic ignores the accuracy roll entirely
  state.rng = 1;

  decide(state, 'p1', ctx);
  expect(state.actors.p1.pendingCast).toEqual({
    skillId: 'smite', targets: ['e0'], startedAt: 2_000, completesAt: 2_596, token: 1,
  });
  expect(state.actors.p1.mp).toBe(167);
  expect(state.actors.p1.cooldowns).toEqual({ smite: 5_000 });

  state.nowMs = 2_596;
  resolveCast(state, 'p1', ctx);

  // One draw only: variance 9234 from seed 1.
  expect(state.rng).toBe(270_369);
  expect(summary(events)).toEqual([
    ['cast', 'p1', 'e0', null, 'smite'],
    ['damage', 'p1', 'e0', 40, 'smite'],
  ]);
  expect(state.actors.e0.hp).toBe(140);
  expect(state.actors.e0.threat).toEqual({ p1: 40 });
  expect(live(state, 'act', 'p1')[0].at).toBe(4_379);
});

test('a magic basic attack uses full power, no element and only a variance draw', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  setRules(state, 'p1', [
    { skillId: 'heal', enabled: true, condition: { kind: 'ally-hp-below', value: 60 } },
    { skillId: 'smite', enabled: true, condition: { kind: 'always' } },
  ]);
  state.actors.p1.mp = 6; // neither skill is affordable
  state.rng = 1;

  decide(state, 'p1', ctx);
  expect(state.actors.p1.pendingCast).toEqual({
    skillId: 'basic', targets: ['e0'], startedAt: 2_000, completesAt: 2_001, token: 1,
  });

  state.nowMs = 2_001;
  resolveCast(state, 'p1', ctx);

  expect(state.rng).toBe(270_369); // magic: variance only
  expect(summary(events)).toEqual([
    ['cast', 'p1', 'e0', null, 'basic'],
    ['damage', 'p1', 'e0', 40, 'basic'],
  ]);
  expect(state.actors.p1.mp).toBe(6); // basics cost nothing
  expect(state.actors.p1.cooldowns).toEqual({});
});

test('fire bolt applies its fire multiplier against an earth defender', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  useClass(state, 'p2', 'arcanist');
  setRules(
    state, 'p2',
    [{ skillId: 'fire-bolt', enabled: true, condition: { kind: 'always' } }],
    { kind: 'nearest' },
  );
  state.rng = 1;

  decide(state, 'p2', ctx);
  expect(state.actors.p2.pendingCast).toEqual({
    skillId: 'fire-bolt', targets: ['e2'], startedAt: 2_000, completesAt: 2_864, token: 1,
  });
  expect(state.actors.p2.mp).toBe(189);

  state.nowMs = 2_864;
  resolveCast(state, 'p2', ctx);

  // 49 matk * 13000 power * 15000 fire-vs-earth * 9234 variance, mitigated by 4 mdef.
  expect(summary(events)).toEqual([
    ['cast', 'p2', 'e2', null, 'fire-bolt'],
    ['damage', 'p2', 'e2', 82, 'fire-bolt'],
  ]);
  expect(state.actors.e2.hp).toBe(98);
});

test('frost nova clips its plus shape, spares party members, and slows survivors', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  useClass(state, 'p2', 'arcanist');
  place(state, 'p2', 2, 4);
  place(state, 'p0', 2, 1); // inside the shape, and never a legal target
  place(state, 'e0', 1, 0);
  place(state, 'e1', 2, 0);
  place(state, 'e2', 3, 0);
  setRules(
    state, 'p2',
    [{ skillId: 'frost-nova', enabled: true, condition: { kind: 'targets-at-least', value: 3 } }],
    { kind: 'nearest' },
  );
  state.rng = 1;

  decide(state, 'p2', ctx);
  // Only the centre enemy covers three; the row above the shape is clipped off-board.
  expect(state.actors.p2.pendingCast?.targets).toEqual(['e1']);
  expect(state.actors.p2.mp).toBe(185);
  expect(state.actors.p2.cooldowns).toEqual({ 'frost-nova': 8_000 });
  // The left arm of the plus sits outside the caster's own range.
  expect(ctx.battlefield.inRange(state.actors.p2.position, state.actors.e0.position, 4)).toBe(false);

  state.nowMs = 2_864;
  resolveCast(state, 'p2', ctx);

  expect(state.rng).toBe(2_647_435_461); // three variance draws, one per target
  expect(summary(events)).toEqual([
    ['cast', 'p2', 'e1', null, 'frost-nova'],
    ['damage', 'p2', 'e0', 34, 'frost-nova'],
    ['status', 'e0', 'p2', 3_000, 'slow'],
    ['damage', 'p2', 'e1', 36, 'frost-nova'],
    ['status', 'e1', 'p2', 3_000, 'slow'],
    ['damage', 'p2', 'e2', 34, 'frost-nova'],
    ['status', 'e2', 'p2', 3_000, 'slow'],
  ]);
  expect([state.actors.e0.hp, state.actors.e1.hp, state.actors.e2.hp]).toEqual([146, 144, 146]);
  expect(state.actors.p0.hp).toBe(277);
  expect(state.actors.p0.statuses).toEqual([]);
  expect(state.actors.e1.statuses).toEqual([
    { id: 'slow:p2', sourceId: 'p2', kind: 'slow', valueBp: 3_000, expiresAt: 7_864 },
  ]);
  expect(state.queue.filter((e) => e.kind === 'expire').map((e) => [e.actorId, e.at])).toEqual([
    ['e0', 7_864], ['e1', 7_864], ['e2', 7_864],
  ]);
  expect(state.metrics.damageDealt).toBe(104);
});

test('cleave clips at the board edge and strikes the shape in actor-id order', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  place(state, 'p0', 0, 2);
  place(state, 'e0', 0, 1);
  place(state, 'e1', 1, 1);
  place(state, 'e2', 3, 1);
  setRules(
    state, 'p0',
    [{ skillId: 'cleave', enabled: true, condition: { kind: 'targets-at-least', value: 2 } }],
  );
  state.rng = 2;

  decide(state, 'p0', ctx);
  expect(state.actors.p0.pendingCast).toEqual({
    skillId: 'cleave', targets: ['e0'], startedAt: 2_000, completesAt: 2_001, token: 1,
  });
  expect(state.actors.p0.mp).toBe(54);
  expect(state.actors.p0.cooldowns).toEqual({ cleave: 6_000 });

  state.nowMs = 2_001;
  resolveCast(state, 'p0', ctx);

  expect(state.rng).toBe(818_967_331); // two physical attempts, three draws each
  expect(summary(events)).toEqual([
    ['cast', 'p0', 'e0', null, 'cleave'],
    ['damage', 'p0', 'e0', 43, 'cleave'],
    ['damage', 'p0', 'e1', 35, 'cleave'],
  ]);
  expect([state.actors.e0.hp, state.actors.e1.hp, state.actors.e2.hp]).toEqual([137, 145, 180]);
  expect(state.actors.e2.threat).toEqual({});
  expect(state.metrics.damageDealt).toBe(78);
});

test('cleave spares a party member standing inside the shape', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  place(state, 'p0', 2, 2);
  place(state, 'p1', 1, 1); // inside the cleave row, never eligible
  place(state, 'e0', 2, 1);
  place(state, 'e1', 3, 1);
  place(state, 'e2', 0, 0);
  setRules(
    state, 'p0',
    [{ skillId: 'cleave', enabled: true, condition: { kind: 'targets-at-least', value: 2 } }],
  );
  state.rng = 2;

  castAndResolve(state, 'p0', ctx);

  expect(summary(events)).toEqual([
    ['cast', 'p0', 'e0', null, 'cleave'],
    ['damage', 'p0', 'e0', 43, 'cleave'],
    ['damage', 'p0', 'e1', 35, 'cleave'],
  ]);
  expect(state.actors.p1.hp).toBe(180);
  expect(state.metrics.actors.p1.damageReceived).toBe(0);
});

test('arrow rain covers the square shape and spends draws on every attempt', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  place(state, 'p2', 2, 2);
  place(state, 'e0', 1, 0);
  place(state, 'e1', 2, 0);
  place(state, 'e2', 1, 1);
  setRules(
    state, 'p2',
    [{ skillId: 'arrow-rain', enabled: true, condition: { kind: 'targets-at-least', value: 3 } }],
  );
  state.rng = 1;

  decide(state, 'p2', ctx);
  expect(state.actors.p2.pendingCast).toEqual({
    skillId: 'arrow-rain', targets: ['e0'], startedAt: 2_000, completesAt: 2_626, token: 1,
  });
  expect(state.actors.p2.mp).toBe(78);

  state.nowMs = 2_626;
  resolveCast(state, 'p2', ctx);

  expect(state.rng).toBe(2_005_365_029); // nine draws: three attempts, hit/miss/hit
  expect(summary(events)).toEqual([
    ['cast', 'p2', 'e0', null, 'arrow-rain'],
    ['damage', 'p2', 'e0', 29, 'arrow-rain'],
    ['miss', 'p2', 'e1', null, 'arrow-rain'],
    ['damage', 'p2', 'e2', 30, 'arrow-rain'],
  ]);
  expect([state.actors.e0.hp, state.actors.e1.hp, state.actors.e2.hp]).toEqual([151, 180, 150]);
  expect(state.actors.e1.threat).toEqual({});
  expect(state.metrics.damageDealt).toBe(59);
  expect(live(state, 'act', 'p2')[0].at).toBe(3_899);
});

test('double shot lands two hits on the same target in one completion', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  setRules(
    state, 'p2',
    [{ skillId: 'double-shot', enabled: true, condition: { kind: 'always' } }],
    { kind: 'nearest' },
  );
  state.rng = 2;

  castAndResolve(state, 'p2', ctx);

  expect(state.rng).toBe(818_967_331); // six draws
  expect(summary(events)).toEqual([
    ['cast', 'p2', 'e2', null, 'double-shot'],
    ['damage', 'p2', 'e2', 29, 'double-shot'],
    ['damage', 'p2', 'e2', 24, 'double-shot'],
  ]);
  expect(state.actors.e2.hp).toBe(127);
  expect(state.actors.e2.threat).toEqual({ p2: 53 });
  expect(live(state, 'act', 'p2')[0].at).toBe(3_274);
});

test('double shot skips its second arrow when the first kills the target', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  setRules(state, 'p2', [{ skillId: 'double-shot', enabled: true, condition: { kind: 'always' } }]);
  const boar = state.actors.e2;
  boar.hp = 1;
  boar.currentTarget = 'p0';
  boar.forcedTarget = { actorId: 'p0', expiresAt: 9_000 };
  boar.pendingCast = {
    skillId: 'basic', targets: ['p0'], startedAt: 1_900, completesAt: 2_500, token: 0,
  };
  state.rng = 1;

  castAndResolve(state, 'p2', ctx);

  expect(state.rng).toBe(2_647_435_461); // three draws only, no second attempt
  expect(summary(events)).toEqual([
    ['cast', 'p2', 'e2', null, 'double-shot'],
    ['damage', 'p2', 'e2', 1, 'double-shot'], // effective damage capped at remaining HP
    ['death', 'e2', 'p2', null, null],
  ]);
  expect(boar.hp).toBe(0);
  expect(boar.threat).toEqual({ p2: 1 });
  expect(boar.actionToken).toBe(1);
  expect(boar.pendingCast).toBeNull();
  expect(boar.currentTarget).toBeNull();
  expect(boar.forcedTarget).toBeNull();
  expect(state.metrics).toMatchObject({ kills: 1, rawExp: 30, rawGold: 3, damageDealt: 1 });
});

test('a single target that left range fizzles without refund or RNG', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  setRules(state, 'p1', [{ skillId: 'smite', enabled: true, condition: { kind: 'always' } }]);
  state.rng = 1;

  decide(state, 'p1', ctx);
  place(state, 'e0', 4, 0); // seven cells away from the cleric, well past range four
  state.nowMs = 2_596;
  resolveCast(state, 'p1', ctx);

  expect(state.rng).toBe(1);
  expect(summary(events)).toEqual([
    ['cast', 'p1', 'e0', null, 'smite'],
    ['miss', 'p1', 'e0', null, 'smite:fizzle'],
  ]);
  expect(state.actors.e0.hp).toBe(180);
  expect(state.actors.p1.mp).toBe(167); // no refund
  expect(state.actors.p1.cooldowns).toEqual({ smite: 5_000 });
  expect(live(state, 'act', 'p1')[0].at).toBe(4_379);
});

test('a dead area primary fizzles the whole cast', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  useClass(state, 'p2', 'arcanist');
  place(state, 'p2', 2, 4);
  place(state, 'e0', 1, 0);
  place(state, 'e1', 2, 0);
  place(state, 'e2', 3, 0);
  setRules(
    state, 'p2',
    [{ skillId: 'frost-nova', enabled: true, condition: { kind: 'targets-at-least', value: 3 } }],
    { kind: 'nearest' },
  );
  state.rng = 1;

  decide(state, 'p2', ctx);
  state.actors.e1.hp = 0;
  state.nowMs = 2_864;
  resolveCast(state, 'p2', ctx);

  expect(state.rng).toBe(1);
  expect(summary(events)).toEqual([
    ['cast', 'p2', 'e1', null, 'frost-nova'],
    ['miss', 'p2', 'e1', null, 'frost-nova:fizzle'],
  ]);
  expect([state.actors.e0.hp, state.actors.e2.hp]).toEqual([180, 180]);
  expect(state.actors.e0.statuses).toEqual([]);
  expect(state.queue.filter((e) => e.kind === 'expire')).toEqual([]);
});

test('taunt forces up to three enemies and scales threat from the previous maximum', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  setRules(state, 'p0', [{ skillId: 'taunt', enabled: true, condition: { kind: 'ally-targeted' } }]);
  state.actors.e0.currentTarget = 'p1';
  state.actors.e0.threat = { p1: 40 };

  decide(state, 'p0', ctx);
  // Nearest first, then ascending id among the equidistant pair.
  expect(state.actors.p0.pendingCast).toEqual({
    skillId: 'taunt', targets: ['e1', 'e0', 'e2'], startedAt: 2_000, completesAt: 2_001, token: 1,
  });
  expect(state.actors.p0.mp).toBe(52);
  expect(state.actors.p0.cooldowns).toEqual({ taunt: 10_000 });

  state.nowMs = 2_001;
  resolveCast(state, 'p0', ctx);

  expect(summary(events)).toEqual([
    ['cast', 'p0', 'e1', null, 'taunt'],
    ['taunt', 'p0', 'e1', 1, null],
    ['taunt', 'p0', 'e0', 44, null],
    ['taunt', 'p0', 'e2', 1, null],
  ]);
  expect(state.actors.e0.threat).toEqual({ p1: 40, p0: 44 });
  expect(state.actors.e1.threat).toEqual({ p0: 1 });
  expect(state.actors.e0.forcedTarget).toEqual({ actorId: 'p0', expiresAt: 6_001 });
  expect(state.actors.e2.forcedTarget).toEqual({ actorId: 'p0', expiresAt: 6_001 });
  expect(state.queue.filter((e) => e.kind === 'expire').map((e) => [e.actorId, e.at])).toEqual([
    ['e0', 6_001], ['e1', 6_001], ['e2', 6_001],
  ]);
});

test('taunt spends no RNG at all', () => {
  const state = fightFixture();
  const ctx = context(state, []);
  setRules(state, 'p0', [{ skillId: 'taunt', enabled: true, condition: { kind: 'ally-targeted' } }]);
  state.actors.e0.currentTarget = 'p1';
  state.rng = 12_345;

  castAndResolve(state, 'p0', ctx);

  expect(state.rng).toBe(12_345);
});

test('a second taunt replaces the forced source and rescales threat', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  useClass(state, 'p1', 'guardian');
  state.actors.e0.hp = 0;
  state.actors.e2.hp = 0;
  state.actors.e1.currentTarget = 'p2';
  const taunt: Rule[] = [{ skillId: 'taunt', enabled: true, condition: { kind: 'ally-targeted' } }];
  setRules(state, 'p0', taunt);
  setRules(state, 'p1', [...taunt]);

  castAndResolve(state, 'p0', ctx);
  expect(state.actors.e1.threat).toEqual({ p0: 1 });
  expect(state.actors.e1.forcedTarget).toEqual({ actorId: 'p0', expiresAt: 6_001 });

  castAndResolve(state, 'p1', ctx);
  expect(state.nowMs).toBe(2_002);
  expect(state.actors.e1.threat).toEqual({ p0: 1, p1: 2 });
  expect(state.actors.e1.forcedTarget).toEqual({ actorId: 'p1', expiresAt: 6_002 });
  // The superseded record keeps its own expiry entry; it simply finds nothing to clear.
  expect(queuedAt(state, 'expire', 'e1')).toEqual([6_001, 6_002]);
});

test('a stunned actor postpones its decision under the same token', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  popQueued(state, 'act', 'p0');
  state.actors.p0.statuses = [
    { id: 'stun:a', sourceId: 'e0', kind: 'stun', valueBp: 0, expiresAt: 2_600 },
    { id: 'stun:b', sourceId: 'e1', kind: 'stun', valueBp: 0, expiresAt: 2_800 },
  ];

  decide(state, 'p0', ctx);

  expect(live(state, 'act', 'p0')).toEqual([
    { at: 2_800, kind: 'act', actorId: 'p0', seq: expect.any(Number), epoch: 0, token: 0 },
  ]);
  expect(state.actors.p0.actionToken).toBe(0);
  expect(state.actors.p0.pendingCast).toBeNull();
  expect(state.actors.p0.mp).toBe(60);
  expect(events).toEqual([]);
});

test('a stun at completion postpones the cast, keeping its token, MP and cooldown', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  setRules(state, 'p1', [{ skillId: 'smite', enabled: true, condition: { kind: 'always' } }]);
  state.rng = 1;

  decide(state, 'p1', ctx);
  state.actors.p1.statuses = [
    { id: 'stun:a', sourceId: 'e0', kind: 'stun', valueBp: 0, expiresAt: 3_000 },
  ];
  state.nowMs = 2_596;
  popQueued(state, 'resolve', 'p1');
  resolveCast(state, 'p1', ctx);

  expect(state.actors.p1.pendingCast).toEqual({
    skillId: 'smite', targets: ['e0'], startedAt: 2_000, completesAt: 3_000, token: 1,
  });
  expect(live(state, 'resolve', 'p1')).toEqual([
    { at: 3_000, kind: 'resolve', actorId: 'p1', seq: expect.any(Number), epoch: 0, token: 1 },
  ]);
  expect(state.actors.p1.mp).toBe(167);
  expect(state.actors.p1.cooldowns).toEqual({ smite: 5_000 });
  expect(state.rng).toBe(1);
  expect(summary(events)).toEqual([['cast', 'p1', 'e0', null, 'smite']]);

  // Expiry runs first at that timestamp, then the postponed completion lands intact.
  state.nowMs = 3_000;
  popQueued(state, 'resolve', 'p1');
  expire(state, 'p1');
  resolveCast(state, 'p1', ctx);

  expect(state.actors.p1.statuses).toEqual([]);
  expect(state.actors.e0.hp).toBe(140);
  expect(state.actors.p1.pendingCast).toBeNull();
  expect(live(state, 'act', 'p1')[0].at).toBe(4_783);
});

test('the next recovery uses the strongest active slow, never their sum', () => {
  const state = fightFixture();
  const ctx = context(state, []);
  place(state, 'p0', 2, 2);
  setRules(state, 'p0', []);
  state.actors.p0.statuses = [
    { id: 'slow:e0', sourceId: 'e0', kind: 'slow', valueBp: 3_000, expiresAt: 9_000 },
    { id: 'slow:e1', sourceId: 'e1', kind: 'slow', valueBp: 5_000, expiresAt: 9_000 },
  ];
  state.rng = 1;

  castAndResolve(state, 'p0', ctx);

  // ceil(1569 * 10000 / 5000) = 3138, not ceil(1569 * 10000 / 2000) = 7845.
  expect(live(state, 'act', 'p0')[0].at).toBe(5_139);
});

test('a slow that has already lapsed does not delay the next recovery', () => {
  const state = fightFixture();
  const ctx = context(state, []);
  place(state, 'p0', 2, 2);
  setRules(state, 'p0', []);
  state.actors.p0.statuses = [
    { id: 'slow:e0', sourceId: 'e0', kind: 'slow', valueBp: 5_000, expiresAt: 2_001 },
  ];
  state.rng = 1;

  castAndResolve(state, 'p0', ctx);

  expect(state.nowMs).toBe(2_001);
  expect(live(state, 'act', 'p0')[0].at).toBe(3_570);
});

test('rule scanning skips disabled, unaffordable, cooling-down and unsatisfied choices', () => {
  const cases: { name: string; prepare(state: SimState): void; expected: string }[] = [
    {
      name: 'eligible heal wins',
      prepare: () => undefined,
      expected: 'heal',
    },
    {
      name: 'disabled heal is skipped',
      prepare: (state) => { state.input.strategies.p1.rules[0].enabled = false; },
      expected: 'smite',
    },
    {
      name: 'unaffordable heal is skipped',
      prepare: (state) => { state.actors.p1.mp = 7; },
      expected: 'smite',
    },
    {
      name: 'cooling-down heal is skipped',
      prepare: (state) => { state.actors.p1.cooldowns.heal = 2_001; },
      expected: 'smite',
    },
    {
      name: 'unsatisfied condition is skipped',
      prepare: (state) => { state.actors.p0.hp = state.actors.p0.stats.maxHp; },
      expected: 'smite',
    },
    {
      name: 'every rule skipped falls back to a basic attack',
      prepare: (state) => { state.actors.p1.mp = 6; },
      expected: 'basic',
    },
  ];

  for (const testCase of cases) {
    const state = fightFixture();
    const ctx = context(state, []);
    setRules(state, 'p1', [
      { skillId: 'heal', enabled: true, condition: { kind: 'ally-hp-below', value: 60 } },
      { skillId: 'smite', enabled: true, condition: { kind: 'always' } },
    ]);
    state.actors.p0.hp = 100;
    testCase.prepare(state);

    decide(state, 'p1', ctx);

    expect(state.actors.p1.pendingCast?.skillId, testCase.name).toBe(testCase.expected);
  }
});

test('attacking mode keeps only enemies hitting the chosen member', () => {
  const state = fightFixture();
  const ctx = context(state, []);
  setRules(
    state, 'p2',
    [{ skillId: 'double-shot', enabled: true, condition: { kind: 'always' } }],
    { kind: 'attacking', partyId: 'p0' },
  );
  state.actors.e1.currentTarget = 'p0';

  decide(state, 'p2', ctx);

  expect(state.actors.p2.pendingCast?.targets).toEqual(['e1']);
});

test('attacking mode falls back to nearest when nobody is hitting that member', () => {
  const state = fightFixture();
  const ctx = context(state, []);
  setRules(
    state, 'p2',
    [{ skillId: 'double-shot', enabled: true, condition: { kind: 'always' } }],
    { kind: 'attacking', partyId: 'p0' },
  );
  state.actors.e1.currentTarget = 'p1';

  decide(state, 'p2', ctx);

  expect(state.actors.p2.pendingCast?.targets).toEqual(['e2']);
});

test('an out-of-range actor takes one step toward its target', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  setRules(state, 'p0', []);

  decide(state, 'p0', ctx);

  expect(state.actors.p0.position).toBe(gridPosition(2, 2));
  expect(summary(events)).toEqual([['move', 'p0', 'e1', null, null]]);
  expect(events[0].position).toBe(gridPosition(2, 2));
  expect(state.actors.p0.currentTarget).toBe('e1');
  expect(state.actors.p0.pendingCast).toBeNull();
  expect(state.actors.p0.mp).toBe(60);
  expect(live(state, 'act', 'p0')).toEqual([
    { at: 2_500, kind: 'act', actorId: 'p0', seq: expect.any(Number), epoch: 0, token: 1 },
  ]);
});

test('an actor with nothing reachable idles for 500 ms without emitting', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  setRules(state, 'p0', []);
  state.actors.p0.currentTarget = 'e1';
  for (const id of ['e0', 'e1', 'e2']) state.actors[id].hp = 0;

  decide(state, 'p0', ctx);

  expect(events).toEqual([]);
  expect(state.actors.p0.currentTarget).toBeNull();
  expect(state.actors.p0.position).toBe(gridPosition(2, 3));
  expect(live(state, 'act', 'p0')).toEqual([
    { at: 2_500, kind: 'act', actorId: 'p0', seq: expect.any(Number), epoch: 0, token: 1 },
  ]);
});

test('monsters attack the highest-threat member, breaking ties by distance', () => {
  const state = fightFixture();
  const events: DomainEvent[] = [];
  const ctx = context(state, events);
  place(state, 'e1', 2, 2);
  state.actors.e1.threat = { p0: 5, p1: 5, p2: 1 };
  state.rng = 1;

  decide(state, 'e1', ctx);
  expect(state.actors.e1.pendingCast).toEqual({
    skillId: 'basic', targets: ['p0'], startedAt: 2_000, completesAt: 2_001, token: 1,
  });

  state.nowMs = 2_001;
  resolveCast(state, 'e1', ctx);

  expect(summary(events)).toEqual([
    ['cast', 'e1', 'p0', null, 'basic'],
    ['damage', 'e1', 'p0', 20, 'basic'],
  ]);
  expect(state.actors.p0.hp).toBe(257);
  expect(state.metrics.actors.p0.damageReceived).toBe(20);
  expect(state.metrics.damageDealt).toBe(0); // only party damage counts toward the total
  expect(state.actors.p0.threat).toEqual({});
  expect(live(state, 'act', 'e1')[0].at).toBe(3_801);
});

test('an active forced target outranks the highest threat', () => {
  const state = fightFixture();
  const ctx = context(state, []);
  place(state, 'e1', 2, 2);
  state.actors.e1.threat = { p2: 100 };

  decide(state, 'e1', ctx);
  expect(state.actors.e1.currentTarget).toBe('p2'); // threat alone would chase the ranger

  const forced = fightFixture();
  const forcedCtx = context(forced, []);
  place(forced, 'e1', 2, 2);
  forced.actors.e1.threat = { p2: 100 };
  forced.actors.e1.forcedTarget = { actorId: 'p0', expiresAt: 10_000 };

  decide(forced, 'e1', forcedCtx);
  expect(forced.actors.e1.currentTarget).toBe('p0');
  expect(forced.actors.e1.pendingCast?.targets).toEqual(['p0']);
});

test('an unreachable forced source falls back to threat and keeps its record', () => {
  const state = fightFixture();
  const ctx = context(state, []);
  place(state, 'p0', 0, 0);
  place(state, 'p1', 1, 0); // boxes the guardian into the corner
  place(state, 'p2', 0, 1);
  place(state, 'e0', 1, 1);
  place(state, 'e1', 3, 0);
  place(state, 'e2', 4, 0);
  state.actors.e0.threat = { p1: 5, p2: 10 };
  state.actors.e0.forcedTarget = { actorId: 'p0', expiresAt: 10_000 };

  expect(state.actors.p0.hp).toBeGreaterThan(0);
  expect(ctx.battlefield.canReach(
    state.actors.e0, state.actors.p0, state.actors.e0.basicRange,
    Object.values(state.actors),
  )).toBe(false);

  decide(state, 'e0', ctx);

  expect(state.actors.e0.currentTarget).toBe('p2');
  expect(state.actors.e0.pendingCast?.targets).toEqual(['p2']);
  // The record stays until it expires on its own; decisions simply ignore it.
  expect(state.actors.e0.forcedTarget).toEqual({ actorId: 'p0', expiresAt: 10_000 });
});

test('every handler leaves a state that still passes snapshot validation', () => {
  const grid = createGrid(content.grid, content.shapes);
  for (const id of ['p0', 'p1', 'p2', 'e0', 'e1', 'e2']) {
    const state = fightFixture();
    const ctx = context(state, []);
    state.actors.p0.hp = 100; // gives the cleric a heal target
    state.actors.e0.currentTarget = 'p1'; // satisfies the guardian's taunt condition
    popQueued(state, 'act', id);

    decide(state, id, ctx);
    if (state.actors[id].pendingCast) {
      state.nowMs = state.actors[id].pendingCast!.completesAt;
      popQueued(state, 'resolve', id);
      resolveCast(state, id, ctx);
    }

    expect(() => decodeSnapshot(encodeSnapshot(state), content, grid), id).not.toThrow();
  }
});
