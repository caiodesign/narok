import { content } from '@narok/data';
import type { ClassId, ItemInstance } from '@narok/data';
import { createProgress, expToNext, gainExp, splitExp } from '@narok/progression';
import type { Progress } from '@narok/progression';
import { describe, expect, test } from 'vitest';
import { characterMaxima, deriveCharacter, resolveLoadout } from '../src/index';
import { finishEncounter, transition } from '../src/lifecycle';
import { awardKillExp } from '../src/rewards';
import { encodeSnapshot } from '../src/snapshot';
import { DEFAULT_WIPE_LIMIT } from '../src/state';
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

function started(overrides: Partial<Record<string, Partial<Progress>>> = {}, wipeLimit = 1): SimState {
  return lab().start(labInput({ wipeLimit }), { party: party(overrides) });
}

/** The fight at 2,000 ms with every party actor's progression recorded. */
function fighting(wipeLimit = 1, overrides: Partial<Record<string, Partial<Progress>>> = {}): SimState {
  const sim = lab();
  return runTo(sim, sim.start(labInput({ wipeLimit, recipe: 'melee' }), { party: party(overrides) }), 2_000).state;
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
    const state = fighting(1, {
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
    const state = fighting(1, { p1: { exp: expToNext(10, content.progression)! - 1 } });
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

describe('death regressions (Part 3 §5.5)', () => {
  test('a wipe moves no EXP, level, point or item field', () => {
    const state = fighting(2, { p0: { exp: 123, expCarry: 4_567, statPoints: 9, skillRanks: { cleave: 1 } } });
    const events: DomainEvent[] = [];
    const ctx = context(state, events);
    const before = structuredClone(state.progression);
    const bag = structuredClone(state.bagState);
    for (const actor of Object.values(state.actors)) if (actor.side === 'party') actor.hp = 0;
    finishEncounter(state, ctx);
    expect(state.metrics.wipes).toBe(1);
    expect(state.progression).toEqual(before);
    expect(state.bagState).toEqual(bag);
    // Nor does the respawn that follows: full recovery, and nothing else.
    const respawn = state.queue.find((entry) => entry.kind === 'transition')!;
    state.queue.splice(state.queue.indexOf(respawn), 1);
    state.nowMs = respawn.at;
    transition(state, ctx);
    expect(state.phase).toBe('walking');
    expect(state.progression).toEqual(before);
    expect(state.actors.p0!.level).toBe(10);
  });

  test('the wipe limit defaults to one and is a total of one to five wipes, not extra retries', () => {
    expect(DEFAULT_WIPE_LIMIT).toBe(1);
    for (const limit of [1, 2, 3, 4, 5]) {
      const state = fighting(limit);
      const ctx = context(state, []);
      for (let wipe = 1; wipe <= limit; wipe += 1) {
        state.phase = 'fighting';
        for (const actor of Object.values(state.actors)) if (actor.side === 'party') actor.hp = 0;
        finishEncounter(state, ctx);
        expect(state.phase).toBe(wipe === limit ? 'stopped' : 'respawning');
      }
      expect(state.stopReason).toBe('wipe-limit');
      expect(state.metrics.wipes).toBe(limit);
    }
    for (const limit of [0, 6]) {
      expect(() => lab().start(labInput({ wipeLimit: limit }))).toThrow(/wipeLimit|between 1 and 5/);
    }
  });

  test('the return to town revives the fallen like a won encounter (ruling R149): after a wipe-limit wipe', () => {
    const state = fighting(1);
    const ctx = context(state, []);
    const party = Object.values(state.actors).filter((actor) => actor.side === 'party');
    party.forEach((actor, index) => { actor.hp = 0; actor.mp = 7 + index; });
    finishEncounter(state, ctx);
    expect(state.stopReason).toBe('wipe-limit');
    for (const [index, actor] of party.entries()) {
      expect(actor.hp).toBe(Math.max(1, Math.floor(actor.stats.maxHp / 10)));
      expect(actor.mp).toBe(7 + index);
      expect(actor.position).toBe(state.input.placement[actor.id]);
    }
    // Rejoining is now possible: the checkpoint round-trips through validation.
    expect(lab().decode(lab().encode(state)).actors.p0!.hp).toBeGreaterThan(0);
  });

  test('the return to town revives the fallen like a won encounter (ruling R149): a player stop with one member dead', () => {
    const state = fighting(1);
    const fallen = state.actors.p1!;
    fallen.hp = 0;
    fallen.mp = 11;
    const others = { p0: { ...state.actors.p0! }, p2: { ...state.actors.p2! } };
    const stopped = lab().stop(state);
    expect(stopped.actors.p1!.hp).toBe(Math.max(1, Math.floor(fallen.stats.maxHp / 10)));
    expect(stopped.actors.p1!.mp).toBe(11);
    // The living keep their exact resources; nothing else moves.
    expect([stopped.actors.p0!.hp, stopped.actors.p0!.mp]).toEqual([others.p0.hp, others.p0.mp]);
    expect([stopped.actors.p2!.hp, stopped.actors.p2!.mp]).toEqual([others.p2.hp, others.p2.mp]);
    expect(stopped.rng).toBe(state.rng);
    expect(stopped.metrics).toEqual(state.metrics);
    expect(stopped.progression).toEqual(state.progression);
  });

  test('a single dead member after a won encounter revives at max(1, floor(maxHp / 10)) with MP preserved and no EXP', () => {
    const state = fighting();
    const ctx = context(state, []);
    const cleric = state.actors.p1!;
    cleric.hp = 0;
    cleric.mp = 7;
    for (const actor of Object.values(state.actors)) if (actor.side === 'enemy') actor.hp = 0;
    const before = structuredClone(state.progression);
    finishEncounter(state, ctx);
    expect(state.metrics.wins).toBe(1);
    expect(cleric.hp).toBe(Math.max(1, Math.floor(cleric.stats.maxHp / 10)));
    expect(cleric.mp).toBe(7);
    expect(state.progression).toEqual(before);
  });
});
