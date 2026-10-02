import { content } from '@narok/data';
import type { ClassId, ItemInstance } from '@narok/data';
import { createProgress, expToNext, gainExp, splitExp } from '@narok/progression';
import type { Progress } from '@narok/progression';
import { describe, expect, test } from 'vitest';
import { characterMaxima, deriveCharacter, resolveLoadout } from '../src/index';
import { finishEncounter } from '../src/lifecycle';
import { awardKillExp } from '../src/rewards';
import { encodeSnapshot } from '../src/snapshot';
import type { DomainEvent, HuntPartyMember, SimError, SimState } from '../src/index';
import { context, lab, labInput, runTo } from './fixtures';

const ROSTER: ClassId[] = ['guardian', 'cleric', 'ranger'];

/**
 * A level-10 character carrying exactly milestone A's class attributes and no
 * items: it derives the same stats as A's fixed lab character, so a hunt with
 * progression plays like the lab run until something levels up.
 */
function member(classId: ClassId, index: number, overrides: Partial<Progress> = {}, equipped: ItemInstance[] = []): HuntPartyMember {
  const progress: Progress = {
    ...createProgress(content.progression),
    level: 10,
    awardedLevels: 10,
    attributes: { ...content.classes[classId].attributes },
    statPoints: 0,
    skillPoints: 0,
    ...overrides,
  };
  return { characterId: `char-${index}`, progress, equipped, hp: 1_000_000, mp: 1_000_000 };
}

function party(overrides: Partial<Record<string, Partial<Progress>>> = {}): Record<string, HuntPartyMember> {
  return Object.fromEntries(ROSTER.map((classId, index) => [`p${index}`, member(classId, index, overrides[`p${index}`])]));
}

function started(overrides: Partial<Record<string, Partial<Progress>>> = {}): SimState {
  return lab().start(labInput(), { party: party(overrides) });
}

/** The fight at 2,000 ms with every party actor's progression recorded. */
function fighting(overrides: Partial<Record<string, Partial<Progress>>> = {}): SimState {
  const sim = lab();
  return runTo(sim, sim.start(labInput({ recipe: 'melee' }), { party: party(overrides) }), 2_000).state;
}

describe('a hunt with progression', () => {
  test('starts from the checkpointed characters: their level, derived stats and clamped resources', () => {
    const state = started({ p1: { level: 12, awardedLevels: 12 } });
    expect(state.progression).not.toBeNull();
    const cleric = state.actors.p1;
    expect(cleric.level).toBe(12);
    const derived = deriveCharacter({
      classId: 'cleric', level: 12, allocated: content.classes.cleric.attributes, loadout: resolveLoadout([], content), content,
    });
    expect(cleric.stats).toEqual(derived);
    expect(cleric.hp).toBe(derived.maxHp);
    expect(state.progression!.p1!.characterId).toBe('char-1');
  });

  test('a lab hunt carries no progression and is unchanged', () => {
    expect(lab().start(labInput()).progression).toBeNull();
  });

  test('EXP draws nothing: until a level-up the hunt rolls exactly what the lab run rolls', () => {
    const sim = lab();
    const plain = runTo(sim, sim.start(labInput({ seed: 77 })), 600_000).state;
    const leveled = runTo(sim, sim.start(labInput({ seed: 77 }), { party: party() }), 600_000).state;
    expect(leveled.progression!.p0!.level).toBe(10);
    expect(leveled.rng).toBe(plain.rng);
    expect(leveled.nextRewardSeq).toBe(plain.nextRewardSeq);
    expect(leveled.metrics).toEqual(plain.metrics);
    expect(leveled.actors).toEqual(plain.actors);
  });

  test('the party split pays living members, destroys a dead member’s share and leaves its carry', () => {
    const state = fighting();
    const ctx = context(state, []);
    state.actors.p2!.hp = 0;
    const before = structuredClone(state.progression!);
    awardKillExp(state, ctx, 30);
    const share = splitExp(30, 3, 0);
    expect(state.progression!.p0!.exp).toBe(before.p0!.exp + share.exp);
    expect(state.progression!.p0!.expCarry).toBe(share.carry);
    expect(state.progression!.p1!.exp).toBe(before.p1!.exp + share.exp);
    expect(state.progression!.p2).toEqual(before.p2);
  });

  test('a mid-hunt level-up grants its points once, auto-spends from the checkpointed template and re-derives at once', () => {
    const needed = expToNext(10, content.progression)!;
    const state = fighting({
      p0: {
        exp: needed - 1,
        autoSpendTemplate: { targets: [{ attribute: 'vit', value: 20 }], remainder: null },
      },
    });
    const ctx = context(state, []);
    const guardian = state.actors.p0!;
    guardian.hp = 50;
    awardKillExp(state, ctx, 30);
    const progress = state.progression!.p0!;
    expect(progress.level).toBe(11);
    expect(progress.awardedLevels).toBe(11);
    // Level 11 grants 3 + floor(11 / 5) = 5 points; VIT 11 -> 12 costs 3, the 2 left are carried.
    expect(progress.attributes.vit).toBe(12);
    expect(progress.statPoints).toBe(2);
    const derived = deriveCharacter({
      classId: 'guardian', level: 11, allocated: progress.attributes, loadout: resolveLoadout([], content), content,
    });
    expect(guardian.level).toBe(11);
    expect(guardian.stats).toEqual(derived);
    expect(guardian.attributes.vit).toBe(12);
    // A level-up heals nothing: HP keeps its absolute value under the higher maximum.
    expect(guardian.hp).toBe(50);
    // No template: the points accumulate.
    expect(state.progression!.p1!.statPoints).toBe(0);
  });

  test('a level-up clamps HP and MP when a maximum falls short of them', () => {
    const state = fighting({ p1: { exp: expToNext(10, content.progression)! - 1 } });
    const ctx = context(state, []);
    const cleric = state.actors.p1!;
    awardKillExp(state, ctx, 30);
    expect(cleric.hp).toBeLessThanOrEqual(cleric.stats.maxHp);
    expect(cleric.mp).toBeLessThanOrEqual(cleric.stats.maxMp);
  });

  test('one segment and many award identical EXP, carries and levels (split invariance)', () => {
    const sim = lab();
    const start = sim.start(labInput({ seed: 9 }), { party: party({ p0: { exp: 7_000 }, p2: { exp: 7_500 } }) });
    const whole = runTo(sim, start, 1_800_000).state;
    let cut = start;
    for (let at = 37_000; at < 1_800_000; at += 37_000) cut = runTo(sim, cut, at).state;
    cut = runTo(sim, cut, 1_800_000).state;
    expect(whole.progression!.p0!.level).toBeGreaterThan(10);
    expect(encodeSnapshot(cut)).toBe(encodeSnapshot(whole));
  });

  test('the checkpoint round-trips the progression and refuses a corrupt one', () => {
    const sim = lab();
    const state = runTo(sim, started(), 120_000).state;
    expect(sim.encode(sim.decode(sim.encode(state)))).toBe(sim.encode(state));
    const raw = JSON.parse(sim.encode(state)) as { progression: Record<string, Record<string, unknown>>; actors: Record<string, Record<string, unknown>> };
    const refuse = (mutate: (value: typeof raw) => void) => {
      const copy = structuredClone(raw);
      mutate(copy);
      try {
        sim.decode(JSON.stringify(copy));
      } catch (error) {
        return { code: (error as SimError).code, field: (error as SimError).field };
      }
      throw new Error('expected a refusal');
    };
    expect(refuse((value) => { value.progression.p0!.expCarry = 60_000; })).toEqual({ code: 'INVALID_STATE', field: 'progression.p0.expCarry' });
    expect(refuse((value) => { value.progression.p0!.level = 11; })).toMatchObject({ code: 'INVALID_STATE' });
    expect(refuse((value) => { delete value.progression.p1; })).toEqual({ code: 'INVALID_STATE', field: 'progression' });
  });

  test('a setup naming the wrong roster or an impossible character is refused', () => {
    const sim = lab();
    const refuse = (setupParty: unknown) => {
      try {
        sim.start(labInput(), { party: setupParty as Record<string, HuntPartyMember> });
      } catch (error) {
        return { code: (error as SimError).code, field: (error as SimError).field };
      }
      throw new Error('expected a refusal');
    };
    const short = party();
    delete short.p2;
    expect(refuse(short)).toEqual({ code: 'INVALID_INPUT', field: 'setup.party' });
    const bad = party();
    bad.p0!.progress.attributes.str = 100;
    expect(refuse(bad)).toEqual({ code: 'INVALID_INPUT', field: 'setup.party.p0.progress.attributes.str' });
    const dead = party();
    dead.p1!.hp = 0;
    expect(refuse(dead)).toEqual({ code: 'INVALID_INPUT', field: 'setup.party.p1.hp' });
  });

  test('characterMaxima is the derivation the town rules clamp with', () => {
    const maxima = characterMaxima(content);
    const character = { id: 'c', classId: 'cleric' as const, hp: 1, mp: 1, ...gainExp(createProgress(content.progression), 0) };
    const derived = deriveCharacter({ classId: 'cleric', level: 1, allocated: character.attributes, loadout: resolveLoadout([], content), content });
    expect(maxima(character, [])).toEqual({ maxHp: derived.maxHp, maxMp: derived.maxMp });
  });
});

/**
 * Part 3 §5.5's death rules as the owner decision of 2026-09-30 replaced them
 * (rulings R151–R155): a wipe ends the hunt, the town heals the whole party,
 * and a member dead at a win stays dead.
 */
describe('death regressions (Part 3 §5.5, owner decision 2026-09-30)', () => {
  test('a wipe moves no EXP, level, point or item field, and ends the hunt', () => {
    const state = fighting({ p0: { exp: 123, expCarry: 4_567, statPoints: 9, skillRanks: { cleave: 1 } } });
    const events: DomainEvent[] = [];
    const ctx = context(state, events);
    const before = structuredClone(state.progression);
    const bag = structuredClone(state.bagState);
    for (const actor of Object.values(state.actors)) if (actor.side === 'party') actor.hp = 0;
    finishEncounter(state, ctx);
    expect(state.metrics.wipes).toBe(1);
    expect(state.phase).toBe('stopped');
    expect(state.stopReason).toBe('wipe');
    expect(state.progression).toEqual(before);
    expect(state.bagState).toEqual(bag);
    expect(state.actors.p0!.level).toBe(10);
  });

  test('there is no wipe limit: a queued preset carrying one is refused, and a start drops it (R154)', () => {
    const sim = lab();
    const state = sim.start({ ...labInput(), wipeLimit: 1 } as never);
    expect(Object.hasOwn(state.input, 'wipeLimit')).toBe(false);
    const { placement, strategies, rest } = state.input;
    expect(() => sim.queueRules(state, { placement, strategies, rest, wipeLimit: 1 } as never)).toThrow();
  });

  test('the return to town after a wipe heals the whole party to full HP and MP (rulings R149, R155)', () => {
    const state = fighting();
    const ctx = context(state, []);
    const party = Object.values(state.actors).filter((actor) => actor.side === 'party');
    party.forEach((actor, index) => { actor.hp = 0; actor.mp = 7 + index; });
    finishEncounter(state, ctx);
    expect(state.stopReason).toBe('wipe');
    for (const actor of party) {
      expect(actor.hp).toBe(actor.stats.maxHp);
      expect(actor.mp).toBe(actor.stats.maxMp);
      expect(actor.position).toBe(state.input.placement[actor.id]);
    }
    // Rejoining is possible: the checkpoint round-trips through validation.
    expect(lab().decode(lab().encode(state)).actors.p0!.hp).toBeGreaterThan(0);
  });

  test('a player stop with one member dead heals the dead and the living alike (rulings R149, R155)', () => {
    const state = fighting();
    const fallen = state.actors.p1!;
    fallen.hp = 0;
    fallen.mp = 11;
    state.actors.p0!.hp = 17;
    state.actors.p2!.mp = 1;
    const stopped = lab().stop(state);
    for (const id of ['p0', 'p1', 'p2']) {
      const actor = stopped.actors[id]!;
      expect([actor.hp, actor.mp]).toEqual([actor.stats.maxHp, actor.stats.maxMp]);
    }
    expect(stopped.rng).toBe(state.rng);
    expect(stopped.metrics).toEqual(state.metrics);
    expect(stopped.progression).toEqual(state.progression);
  });

  test('a single dead member after a won encounter stays dead, keeps its MP and earns no EXP (ruling R151)', () => {
    const state = fighting();
    const ctx = context(state, []);
    const cleric = state.actors.p1!;
    cleric.hp = 0;
    cleric.mp = 7;
    for (const actor of Object.values(state.actors)) if (actor.side === 'enemy') actor.hp = 0;
    const before = structuredClone(state.progression);
    finishEncounter(state, ctx);
    expect(state.metrics.wins).toBe(1);
    expect(cleric.hp).toBe(0);
    expect(cleric.mp).toBe(7);
    expect(state.progression).toEqual(before);
  });
});
