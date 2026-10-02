/**
 * Death and revival (owner decision 2026-09-30; rulings R151–R156): the
 * fallen stay dead until Idun's Apple, a Cleric's Revive or the town brings
 * them back, a full wipe ends the hunt, and the town heals the whole party
 * (owner amendment 2026-09-30).
 */
import { IDUN_APPLE_ID, content } from '@narok/data';
import type { ClassId, SkillId } from '@narok/data';
import { createProgress } from '@narok/progression';
import type { Progress } from '@narok/progression';
import { describe, expect, test } from 'vitest';
import { decide, resolveCast } from '../src/actions';
import { defaultPlacement } from '../src/battlefield/grid';
import { finishEncounter, reviveWithApples } from '../src/lifecycle';
import { schedule } from '../src/scheduler';
import { defaultStrategy } from '../src/state';
import type { BagState, DomainEvent, HuntPartyMember, LabInput, SimState } from '../src/types';
import { context, lab, labInput, runTo } from './fixtures';

function member(
  classId: ClassId, index: number, progress: Partial<Progress> = {}, characterId = `char-${index}`,
): HuntPartyMember {
  return {
    characterId,
    progress: {
      ...createProgress(content.progression),
      level: 10,
      awardedLevels: 10,
      attributes: { ...content.classes[classId].attributes },
      statPoints: 0,
      skillPoints: 0,
      ...progress,
    },
    equipped: [],
    hp: 1_000_000,
    mp: 1_000_000,
  };
}

interface HuntOptions {
  classes?: ClassId[];
  ranks?: Partial<Record<string, Partial<Record<SkillId, number>>>>;
  characterIds?: string[];
  apples?: number;
  input?: Partial<LabInput>;
  level?: number;
}

function input(classes: ClassId[], overrides: Partial<LabInput> = {}): LabInput {
  return labInput({
    classes,
    placement: defaultPlacement(classes),
    strategies: Object.fromEntries(classes.map((classId, index) => [`p${index}`, defaultStrategy(classId)])),
    ...overrides,
  });
}

function bag(apples: number): BagState {
  if (apples === 0) return { capacity: 100, usedSlots: 0, held: {} };
  return { capacity: 100, usedSlots: Math.ceil(apples / 999), held: { [IDUN_APPLE_ID]: apples } };
}

function hunt(options: HuntOptions = {}): SimState {
  const classes = options.classes ?? ['guardian', 'cleric', 'ranger'];
  const party = Object.fromEntries(classes.map((classId, index) => {
    const id = `p${index}`;
    const level = options.level ?? 10;
    // A level-1 character keeps its creation attributes; level 10 carries milestone A's.
    const attributes = level === 1 ? createProgress(content.progression).attributes : content.classes[classId].attributes;
    return [id, member(classId, index, {
      level, awardedLevels: level, attributes: { ...attributes }, skillRanks: options.ranks?.[id] ?? {},
    }, options.characterIds?.[index])];
  }));
  return lab().start(input(classes, options.input), { party, bag: bag(options.apples ?? 0) });
}

/** The hunt advanced to its first encounter, before anyone decides. */
function fighting(options: HuntOptions = {}): SimState {
  const sim = lab();
  return runTo(sim, hunt({ ...options, input: { recipe: 'melee', ...options.input } }), 2_000).state;
}

/** Marks a party member dead the way a killing blow leaves it. */
function kill(state: SimState, id: string): void {
  const actor = state.actors[id]!;
  actor.hp = 0;
  actor.pendingCast = null;
  actor.currentTarget = null;
  actor.forcedTarget = null;
  actor.actionToken += 1;
}

const half = (maxHp: number) => Math.max(1, Math.floor((maxHp * 50) / 100));

/**
 * Arms `attackerId` with a basic strike on `targetId` resolving at `at`, under a
 * fresh action token, and makes it land: a certain critical always hits, and a
 * reach of 99 cells keeps the target in range wherever it stands.
 */
function strikeAt(state: SimState, attackerId: string, targetId: string, at: number): void {
  const attacker = state.actors[attackerId]!;
  attacker.stats = { ...attacker.stats, critBp: 10_000 };
  attacker.basicRange = 99;
  attacker.actionToken += 1;
  attacker.pendingCast = { skillId: 'basic', targets: [targetId], startedAt: state.nowMs, completesAt: at, token: attacker.actionToken };
  schedule(state, { at, kind: 'resolve', actorId: attackerId, epoch: state.epoch, token: attacker.actionToken });
}

describe('a dead member stays dead (R151)', () => {
  test('with no apple and no Cleric it stays dead through later won encounters', () => {
    const sim = lab();
    const state = fighting({ classes: ['guardian', 'ranger', 'arcanist'] });
    const mpAtDeath = state.actors.p2!.mp;
    kill(state, 'p2');
    const later = runTo(sim, state, 600_000);
    expect(later.state.metrics.wins, 'the survivors keep winning').toBeGreaterThan(1);
    expect(later.state.actors.p2!.hp).toBe(0);
    expect(later.state.actors.p2!.mp).toBe(mpAtDeath);
    expect(later.events.filter((event) => event.kind === 'revive')).toEqual([]);
  });
});

describe("Idun's Apple (R152)", () => {
  test('one apple revives the fallen at once at half its maximum HP, with its MP as at death', () => {
    const state = fighting({ apples: 1 });
    const events: DomainEvent[] = [];
    const ctx = context(state, events);
    const ranger = state.actors.p2!;
    ranger.mp = 13;
    ranger.statuses = [{ id: 'slow:e0', sourceId: 'e0', kind: 'slow', valueBp: 3_000, expiresAt: 9_000 }];
    ranger.cooldowns = { 'double-shot': 4_000 };
    state.actors.e0!.threat = { p2: 40, p0: 10 };
    const cell = ranger.position;
    const rng = state.rng;
    kill(state, 'p2');

    reviveWithApples(state, ctx, ['p2']);

    expect(ranger.hp).toBe(half(ranger.stats.maxHp));
    expect(ranger.mp).toBe(13);
    expect(ranger.statuses).toEqual([]);
    expect(ranger.pendingCast).toBeNull();
    expect(ranger.cooldowns).toEqual({ 'double-shot': 4_000 });
    expect(state.actors.e0!.threat).toEqual({ p0: 10 });
    expect(ranger.position, 'its death cell was free').toBe(cell);
    expect(state.bagState.held).toEqual({});
    expect(state.bagState.usedSlots).toBe(0);
    expect(state.metrics.consumed).toEqual({ [IDUN_APPLE_ID]: 1 });
    expect(state.rng, 'reviving draws nothing').toBe(rng);
    expect(events.map((event) => [event.kind, event.actorId, event.amount, event.reason]))
      .toEqual([['revive', 'p2', half(ranger.stats.maxHp), IDUN_APPLE_ID]]);
    // It rejoins the fight: a decision is queued under its new action token.
    expect(state.queue.some((entry) => entry.kind === 'act' && entry.actorId === 'p2' && entry.token === ranger.actionToken))
      .toBe(true);
  });

  test('a revived member takes its input placement when its death cell is taken', () => {
    const state = fighting({ apples: 1 });
    const ctx = context(state, []);
    const ranger = state.actors.p2!;
    ranger.position = state.actors.p0!.position;
    kill(state, 'p2');
    reviveWithApples(state, ctx, ['p2']);
    expect(ranger.position).toBe(state.input.placement.p2);
  });

  test('in a running hunt the apple revives at the instant of death and the bag holds one fewer', () => {
    const sim = lab();
    const start = hunt({ classes: ['guardian', 'ranger', 'arcanist'], apples: 2, level: 1 });
    const run = runTo(sim, start, 600_000);
    const deaths = run.events.filter((event) => event.kind === 'death' && event.actorId!.startsWith('p'));
    const revives = run.events.filter((event) => event.kind === 'revive');
    expect(deaths.length, 'a level-1 party loses someone').toBeGreaterThan(0);
    expect(revives[0]).toMatchObject({ at: deaths[0]!.at, actorId: deaths[0]!.actorId, reason: IDUN_APPLE_ID });
    expect(revives.length).toBe(Math.min(2, deaths.length));
    expect(run.state.metrics.consumed[IDUN_APPLE_ID]).toBe(revives.length);
    expect(run.state.bagState.held[IDUN_APPLE_ID] ?? 0).toBe(2 - revives.length);
  });

  test('two deaths at one instant with one apple: the lower character id revives, the other stays dead', () => {
    // Roster order and character-id order disagree on purpose: p1 holds the lower id.
    const state = fighting({ apples: 1, characterIds: ['char-b', 'char-a', 'char-c'] });
    const ctx = context(state, []);
    kill(state, 'p0');
    kill(state, 'p1');
    reviveWithApples(state, ctx, ['p0', 'p1']);
    expect(state.actors.p1!.hp).toBe(half(state.actors.p1!.stats.maxHp));
    expect(state.actors.p0!.hp).toBe(0);
    expect(state.metrics.consumed).toEqual({ [IDUN_APPLE_ID]: 1 });
  });

  test('R157: deaths from two resolutions at one millisecond share the instant; the lower character id gets the apple', () => {
    // p0 holds the higher character id and dies first in queue order (e0 resolves before e1).
    const state = fighting({ apples: 1, characterIds: ['char-b', 'char-a', 'char-c'] });
    const at = state.nowMs + 1;
    state.actors.p0!.hp = 1;
    state.actors.p1!.hp = 1;
    strikeAt(state, 'e0', 'p0', at);
    strikeAt(state, 'e1', 'p1', at);
    const result = lab().advance(state, at);
    const deaths = result.events.filter((event) => event.kind === 'death').map((event) => event.actorId);
    expect(deaths, 'e0 kills p0 before e1 kills p1').toEqual(['p0', 'p1']);
    expect(result.state.actors.p1!.hp).toBe(half(result.state.actors.p1!.stats.maxHp));
    expect(result.state.actors.p0!.hp).toBe(0);
    expect(result.state.metrics.consumed).toEqual({ [IDUN_APPLE_ID]: 1 });
    expect(result.events.filter((event) => event.kind === 'revive').map((event) => [event.at, event.actorId]))
      .toEqual([[at, 'p1']]);
  });

  test('an apple that saves the last living member prevents the wipe', () => {
    const state = fighting({ apples: 1 });
    kill(state, 'p1');
    kill(state, 'p2');
    const at = state.nowMs + 1;
    state.actors.p0!.hp = 1;
    strikeAt(state, 'e0', 'p0', at);
    const result = lab().advance(state, at);
    expect(result.events.map((event) => event.kind)).toContain('death');
    expect(result.events.map((event) => event.kind)).not.toContain('wipe');
    expect(result.state.phase).toBe('fighting');
    expect(result.state.metrics.wipes).toBe(0);
    expect(result.state.actors.p0!.hp).toBe(half(result.state.actors.p0!.stats.maxHp));
  });

  test('R157: when the last two standing fall at one millisecond from two resolutions, one apple still averts the wipe', () => {
    const state = fighting({ apples: 1, characterIds: ['char-b', 'char-a', 'char-c'] });
    kill(state, 'p2');
    const at = state.nowMs + 1;
    state.actors.p0!.hp = 1;
    state.actors.p1!.hp = 1;
    strikeAt(state, 'e0', 'p0', at);
    strikeAt(state, 'e1', 'p1', at);
    const result = lab().advance(state, at);
    expect(result.events.map((event) => event.kind)).not.toContain('wipe');
    expect(result.state.phase).toBe('fighting');
    expect(result.state.actors.p1!.hp).toBe(half(result.state.actors.p1!.stats.maxHp));
    expect(result.state.actors.p0!.hp).toBe(0);
  });

  test('without an apple nothing is revived and nothing is consumed', () => {
    const state = fighting();
    kill(state, 'p2');
    reviveWithApples(state, context(state, []), ['p2']);
    expect(state.actors.p2!.hp).toBe(0);
    expect(state.metrics.consumed).toEqual({});
  });
});

describe("the Cleric's Revive (R153)", () => {
  test('a living Cleric with Revive rank 1 revives a dead ally through its strategy rule', () => {
    const state = fighting({ ranks: { p1: { revive: 1 } } });
    const events: DomainEvent[] = [];
    const ctx = context(state, events);
    const guardian = state.actors.p0!;
    guardian.mp = 9;
    kill(state, 'p0');

    decide(state, 'p1', ctx);
    const cast = state.actors.p1!.pendingCast!;
    expect(cast).toMatchObject({ skillId: 'revive', targets: ['p0'] });

    state.nowMs = cast.completesAt;
    resolveCast(state, 'p1', ctx);
    expect(guardian.hp).toBe(half(guardian.stats.maxHp));
    expect(guardian.mp).toBe(9);
    expect(events.at(-1)).toMatchObject({ kind: 'revive', actorId: 'p0', targetId: 'p1', reason: 'revive' });
    expect(state.metrics.consumed, 'the spell spends no apple').toEqual({});
  });

  test('a Cleric with Revive rank 0 never casts it', () => {
    const state = fighting();
    const ctx = context(state, []);
    kill(state, 'p0');
    decide(state, 'p1', ctx);
    expect(state.actors.p1!.pendingCast?.skillId ?? null).not.toBe('revive');
  });

  test('a dead Cleric cannot cast it', () => {
    const sim = lab();
    const state = fighting({ ranks: { p1: { revive: 1 } } });
    kill(state, 'p0');
    kill(state, 'p1');
    const later = runTo(sim, state, 10_000);
    expect(later.events.filter((event) => event.reason === 'revive')).toEqual([]);
    expect(later.state.actors.p0!.hp).toBe(0);
  });

  test('a Cleric that dies with a Revive cast in progress never lands it', () => {
    const state = fighting({ ranks: { p1: { revive: 1 } } });
    kill(state, 'p0');
    decide(state, 'p1', context(state, []));
    const cast = state.actors.p1!.pendingCast!;
    expect(cast).toMatchObject({ skillId: 'revive', targets: ['p0'] });
    state.actors.p1!.hp = 1;
    strikeAt(state, 'e0', 'p1', state.nowMs + 1);
    const later = lab().advance(state, cast.completesAt);
    expect(later.events.filter((event) => event.kind === 'death').map((event) => event.actorId)).toContain('p1');
    expect(later.events.filter((event) => event.kind === 'revive' || event.reason === 'revive:fizzle')).toEqual([]);
    expect(later.state.actors.p0!.hp).toBe(0);
  });

  test('a Revive whose target an apple already revived fizzles: nothing restored, its MP not refunded', () => {
    const state = fighting({ apples: 1, ranks: { p1: { revive: 1 } } });
    const events: DomainEvent[] = [];
    kill(state, 'p0');
    decide(state, 'p1', context(state, events));
    const cast = state.actors.p1!.pendingCast!;
    expect(cast).toMatchObject({ skillId: 'revive', targets: ['p0'] });
    const mpAfterCast = state.actors.p1!.mp;
    expect(mpAfterCast, 'the MP is spent when the cast starts').toBe(state.actors.p1!.stats.maxMp - content.skills.revive.mp);
    reviveWithApples(state, context(state, events), ['p0']);
    const hpAfterApple = state.actors.p0!.hp;
    const later = lab().advance(state, cast.completesAt);
    expect(later.events.filter((event) => event.actorId === 'p1' && event.reason === 'revive:fizzle')).toHaveLength(1);
    expect(later.events.filter((event) => event.kind === 'revive')).toEqual([]);
    expect(later.state.actors.p0!.hp).toBeLessThanOrEqual(hpAfterApple);
    expect(later.state.actors.p1!.mp, 'a fizzle refunds nothing').toBeLessThanOrEqual(mpAfterCast);
    expect(later.state.metrics.consumed).toEqual({ [IDUN_APPLE_ID]: 1 });
  });

  test('the revive rule takes the ally-dead condition only', () => {
    const strategy = defaultStrategy('cleric');
    expect(strategy.rules.find((rule) => rule.skillId === 'revive')).toEqual({
      skillId: 'revive', enabled: true, condition: { kind: 'ally-dead' },
    });
    const wrong = {
      ...strategy,
      rules: strategy.rules.map((rule) => rule.skillId === 'revive' ? { ...rule, condition: { kind: 'always' } } : rule),
    };
    const roster: ClassId[] = ['guardian', 'cleric', 'ranger'];
    expect(() => lab().start(input(roster, { strategies: { ...input(roster).strategies, p1: wrong as never } })))
      .toThrow(/revive requires ally-dead/);
  });
});

describe('a full wipe ends the hunt (R154)', () => {
  test('every member dead with no apple and no revive stops the hunt with wipe; nothing respawns', () => {
    const state = fighting();
    const events: DomainEvent[] = [];
    const ctx = context(state, events);
    for (const id of ['p0', 'p1', 'p2']) kill(state, id);
    finishEncounter(state, ctx);
    expect(state.phase).toBe('stopped');
    expect(state.stopReason).toBe('wipe');
    expect(state.metrics.wipes).toBe(1);
    expect(state.queue).toEqual([]);
    expect(events.map((event) => event.kind)).toEqual(['wipe', 'stop']);
    expect(events.at(-1)!.reason).toBe('wipe');
  });

  test('a running hunt that wipes stays stopped', () => {
    const sim = lab();
    const run = runTo(sim, hunt({ classes: ['guardian', 'ranger', 'arcanist'], level: 1 }), 3_600_000);
    expect(run.state.stopReason).toBe('wipe');
    expect(run.state.metrics.wipes).toBe(1);
    const later = sim.advance(run.state, run.state.nowMs + 120_000);
    expect(later.events).toEqual([]);
    expect(later.state.phase).toBe('stopped');
  });
});

describe('the return to town (R155)', () => {
  test('heals the whole party, the dead and the living, to full HP and MP', () => {
    const state = fighting();
    state.actors.p0!.hp = 31;
    state.actors.p0!.mp = 5;
    kill(state, 'p1');
    state.actors.p1!.mp = 2;
    const stopped = lab().stop(state);
    for (const id of ['p0', 'p1', 'p2']) {
      const actor = stopped.actors[id]!;
      expect([actor.hp, actor.mp]).toEqual([actor.stats.maxHp, actor.stats.maxMp]);
    }
    expect(stopped.rng).toBe(state.rng);
    expect(stopped.metrics).toEqual(state.metrics);
    expect(stopped.progression).toEqual(state.progression);
  });

  test('a wipe brings the whole party home at full HP and MP', () => {
    const state = fighting();
    for (const id of ['p0', 'p1', 'p2']) kill(state, id);
    finishEncounter(state, context(state, []));
    for (const id of ['p0', 'p1', 'p2']) {
      const actor = state.actors[id]!;
      expect([actor.hp, actor.mp]).toEqual([actor.stats.maxHp, actor.stats.maxMp]);
      expect(actor.position).toBe(state.input.placement[id]);
    }
  });
});

describe('a run with no deaths is byte-identical to before (R151–R155)', () => {
  test('a hunt whose Cleric holds Revive rolls, fights and counts exactly as at 2e2d182', () => {
    const sim = lab();
    const run = runTo(sim, hunt({ ranks: { p1: { revive: 1 } }, input: { seed: 2 } }), 3_600_000);
    expect(run.events.filter((event) => event.kind === 'death' && event.actorId!.startsWith('p'))).toEqual([]);
    // Recorded at 2e2d182 from the same party, seed and horizon.
    expect(run.state.rng).toBe(1_319_631_358);
    expect(run.events.length).toBe(13_453);
    expect(run.state.metrics).toMatchObject({
      kills: 511, wins: 141, wipes: 0, rawExp: 12_690, rawGold: 1_313, damageDealt: 62_160, effectiveHealing: 10_906,
      walkMs: 283_348, fightMs: 1_142_049, restMs: 2_174_603, consumed: {},
    });
  });
});
