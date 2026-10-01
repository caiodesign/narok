/**
 * Loadout combat factors (Task 7d; rulings R158–R162): the family/element
 * offense bonus, elemental resistance, heal power and flat regeneration that
 * `resolveLoadout` produces reach the one combat path, and a hunt in which no
 * member wears any of them stays byte-identical to the pre-7d engine.
 */
import { content } from '@narok/data';
import type { ClassId, ItemInstance, RolledBonus, SkillId, Slot } from '@narok/data';
import { createProgress } from '@narok/progression';
import { describe, expect, test } from 'vitest';
import { resolveCast } from '../src/actions';
import { defaultPlacement } from '../src/battlefield/grid';
import { regenerate } from '../src/lifecycle';
import { damage, scale } from '../src/math';
import { drawBelow } from '../src/rng';
import { defaultStrategy } from '../src/state';
import type { DomainEvent, HuntPartyMember, SimState } from '../src/types';
import { context, lab, labInput, runTo } from './fixtures';

type Worn = Record<string, ItemInstance[]>;

/** One worn instance under the bundled content; `bonuses` sets its rarity by count. */
function worn(characterId: string, definitionId: string, slot: Slot, bonuses: RolledBonus[] = []): ItemInstance {
  const rarity = (['common', 'uncommon', 'rare', 'epic', 'legendary'] as const)[bonuses.length]!;
  return {
    id: `${characterId}:${slot}`, accountId: 'account-1', definitionId, contentVersion: content.version,
    rarity, itemLevel: 1, bonuses, tradeable: false, locked: false, protected: false,
    equipped: { characterId, slot }, boundTo: null, source: { grantId: 'test' },
  };
}

/** The bonus's tier-1 span maximum, read from content (never a number of our own). */
function top(bonusId: string): number {
  return content.bonuses[bonusId]!.spans[0]!.max;
}

function member(classId: ClassId, characterId: string, equipped: ItemInstance[]): HuntPartyMember {
  return {
    characterId,
    progress: {
      ...createProgress(content.progression),
      level: 10, awardedLevels: 10, attributes: { ...content.classes[classId].attributes },
      statPoints: 0, skillPoints: 0,
    },
    equipped, hp: 1_000_000, mp: 1_000_000,
  };
}

/** A hunt of `classes` wearing `items` (keyed by roster id), advanced to its first (melee) encounter. */
function fighting(classes: ClassId[], items: Worn = {}): SimState {
  const party = Object.fromEntries(classes.map((classId, index) => {
    const id = `p${index}`;
    return [id, member(classId, `char-${index}`, items[id] ?? [])];
  }));
  const input = labInput({
    classes, recipe: 'melee', placement: defaultPlacement(classes),
    strategies: Object.fromEntries(classes.map((classId, index) => [`p${index}`, defaultStrategy(classId)])),
  });
  const sim = lab();
  return runTo(sim, sim.start(input, { party }), 2_000).state;
}

/**
 * Arms `attackerId` with `skillId` on `targetId`, resolving now: it stands on
 * its target's cell so any range reaches, and the target's HP is raised so no
 * hit is clamped by what is left of it.
 */
function arm(state: SimState, attackerId: string, skillId: SkillId | 'basic', targetId: string): void {
  const attacker = state.actors[attackerId]!;
  const target = state.actors[targetId]!;
  attacker.position = target.position;
  target.hp = 1_000_000;
  attacker.actionToken += 1;
  attacker.pendingCast = {
    skillId, targets: [targetId], startedAt: state.nowMs, completesAt: state.nowMs, token: attacker.actionToken,
  };
}

/** Resolves the armed cast and returns the events it emitted. */
function resolve(state: SimState, attackerId: string): DomainEvent[] {
  const events: DomainEvent[] = [];
  resolveCast(state, attackerId, context(state, events));
  return events;
}

function dealt(events: DomainEvent[]): number {
  const hit = events.find((event) => event.kind === 'damage');
  if (hit === undefined) throw new Error('no damage event');
  return hit.amount!;
}

/** The variance a magic hit will draw from `rng` (its only draw). */
function magicVariance(rng: number): number {
  return 9_000 + drawBelow(rng, 2_001).value;
}

/** The variance a physical hit will draw from `rng`, after its crit and accuracy draws. */
function physicalVariance(rng: number): number {
  const afterCrit = drawBelow(rng, 10_000).state;
  const afterAccuracy = drawBelow(afterCrit, 10_000).state;
  return 9_000 + drawBelow(afterAccuracy, 2_001).value;
}

describe('offense bonus (R158)', () => {
  const fireDamage = top('fire-damage');

  test('an element-damage bonus raises a hit of that element by exactly its scale step', () => {
    const items = { p0: [worn('char-0', 'arcanist-staff', 'weapon', [{ bonusId: 'fire-damage', value: fireDamage }])] };
    for (const bonus of [0, fireDamage]) {
      const state = fighting(['arcanist', 'guardian'], bonus === 0 ? {} : items);
      const caster = state.actors.p0!;
      const boar = state.actors.e0!;
      arm(state, 'p0', 'fire-bolt', 'e0');
      const variance = magicVariance(state.rng);
      const expected = damage({
        offense: caster.stats.matk, powerBp: content.skills['fire-bolt'].powerBp,
        offenseBonusBp: 10_000 + bonus, elementBp: content.elements.fire[boar.element], familyBp: 10_000,
        resistBp: 10_000, varianceBp: variance, critical: false, defense: boar.stats.mdef, hit: true,
      });
      // Hand-composed: the bonus is one floored step between skill power and the element chart.
      const raw = scale(scale(scale(scale(scale(caster.stats.matk, content.skills['fire-bolt'].powerBp),
        10_000 + bonus), content.elements.fire[boar.element]), 10_000), variance);
      expect(expected).toBe(Math.max(1, Math.floor((raw * 100) / (100 + boar.stats.mdef))));
      expect(dealt(resolve(state, 'p0'))).toBe(expected);
    }
  });

  test('the bonus is real: the bonus hit exceeds the bare one on the same draws', () => {
    const bare = fighting(['arcanist', 'guardian']);
    const geared = fighting(['arcanist', 'guardian'],
      { p0: [worn('char-0', 'arcanist-staff', 'weapon', [{ bonusId: 'fire-damage', value: fireDamage }])] });
    expect(geared.rng).toBe(bare.rng);
    arm(bare, 'p0', 'fire-bolt', 'e0');
    arm(geared, 'p0', 'fire-bolt', 'e0');
    expect(dealt(resolve(geared, 'p0'))).toBeGreaterThan(dealt(resolve(bare, 'p0')));
  });

  test('an element-damage bonus of another element leaves the hit unchanged', () => {
    const bare = fighting(['arcanist', 'guardian']);
    const geared = fighting(['arcanist', 'guardian'],
      { p0: [worn('char-0', 'arcanist-staff', 'weapon', [{ bonusId: 'water-damage', value: top('water-damage') }])] });
    arm(bare, 'p0', 'fire-bolt', 'e0');
    arm(geared, 'p0', 'fire-bolt', 'e0');
    expect(dealt(resolve(geared, 'p0'))).toBe(dealt(resolve(bare, 'p0')));
  });

  test('a family bonus applies against that family only', () => {
    const beastDamage = top('beast-damage');
    const items = { p0: [worn('char-0', 'copper-ring', 'accessory1', [{ bonusId: 'beast-damage', value: beastDamage }])] };
    for (const family of ['beast', 'plant'] as const) {
      const state = fighting(['ranger', 'guardian'], items);
      const ranger = state.actors.p0!;
      const target = state.actors.e0!;
      target.family = family;
      ranger.stats = { ...ranger.stats, critBp: 10_000 }; // a certain critical always lands
      arm(state, 'p0', 'basic', 'e0');
      const expected = damage({
        offense: ranger.stats.atk, powerBp: 10_000,
        offenseBonusBp: family === 'beast' ? 10_000 + beastDamage : 10_000,
        elementBp: content.elements.neutral[target.element], familyBp: 10_000, resistBp: 10_000,
        varianceBp: physicalVariance(state.rng), critical: true, defense: target.stats.def, hit: true,
      });
      expect(dealt(resolve(state, 'p0')), family).toBe(expected);
    }
  });
});

describe('resistance (R159)', () => {
  const fireResist = top('fire-resist');
  const vest = { p0: [worn('char-0', 'padded-vest', 'body', [{ bonusId: 'fire-resist', value: fireResist }])] };

  test('fire resistance lowers an incoming fire hit by its scale step', () => {
    const state = fighting(['guardian', 'cleric'], vest);
    const boar = state.actors.e0!;
    const guardian = state.actors.p0!;
    boar.stats = { ...boar.stats, matk: 400 };
    arm(state, 'e0', 'fire-bolt', 'p0');
    const expected = damage({
      offense: 400, powerBp: content.skills['fire-bolt'].powerBp, offenseBonusBp: 10_000,
      elementBp: content.elements.fire[guardian.element], familyBp: 10_000, resistBp: 10_000 - fireResist,
      varianceBp: magicVariance(state.rng), critical: false, defense: guardian.stats.mdef, hit: true,
    });
    expect(dealt(resolve(state, 'e0'))).toBe(expected);
  });

  test('fire resistance leaves a neutral hit unchanged', () => {
    const bare = fighting(['guardian', 'cleric']);
    const geared = fighting(['guardian', 'cleric'], vest);
    for (const state of [bare, geared]) {
      state.actors.e0!.stats = { ...state.actors.e0!.stats, critBp: 10_000 };
      arm(state, 'e0', 'basic', 'p0');
    }
    // The vest's armour raises DEF; equalise it so only the resist could differ.
    geared.actors.p0!.stats = { ...geared.actors.p0!.stats, def: bare.actors.p0!.stats.def };
    expect(dealt(resolve(geared, 'e0'))).toBe(dealt(resolve(bare, 'e0')));
  });
});

describe('heal power (R160)', () => {
  const healPower = top('heal-power');
  const mace = { p1: [worn('char-1', 'cleric-mace', 'weapon', [{ bonusId: 'heal-power', value: healPower }])] };

  test('heal power raises Heal by one floored step', () => {
    const state = fighting(['guardian', 'cleric'], mace);
    const cleric = state.actors.p1!;
    arm(state, 'p1', 'heal', 'p0');
    state.actors.p0!.hp = 1;
    const requested = scale(50 + 2 * cleric.attributes.int, 10_000 + healPower);
    expect(requested).toBeGreaterThan(50 + 2 * cleric.attributes.int);
    const heal = resolve(state, 'p1').find((event) => event.kind === 'heal')!;
    expect(heal.amount).toBe(requested);
    expect(state.actors.p0!.hp).toBe(1 + requested);
  });

  test('a scaled Heal is still clamped to max HP', () => {
    const state = fighting(['guardian', 'cleric'], mace);
    arm(state, 'p1', 'heal', 'p0');
    const guardian = state.actors.p0!;
    guardian.hp = guardian.stats.maxHp - 3;
    const heal = resolve(state, 'p1').find((event) => event.kind === 'heal')!;
    expect(heal.amount).toBe(3);
    expect(guardian.hp).toBe(guardian.stats.maxHp);
  });

  test('Revive restores its fixed half regardless of heal power', () => {
    for (const items of [{}, mace]) {
      const state = fighting(['guardian', 'cleric'], items);
      const guardian = state.actors.p0!;
      arm(state, 'p1', 'revive', 'p0');
      guardian.hp = 0;
      guardian.actionToken += 1;
      const revive = resolve(state, 'p1').find((event) => event.kind === 'revive')!;
      expect(revive.amount).toBe(Math.max(1, Math.floor((guardian.stats.maxHp * 50) / 100)));
    }
  });
});

describe('flat regeneration (R161)', () => {
  const hpRegen = top('hp-regen');
  const mpRegen = top('mp-regen');
  const items = {
    p1: [
      worn('char-1', 'wool-cloak', 'cloak', [{ bonusId: 'hp-regen', value: hpRegen }]),
      worn('char-1', 'leather-cap', 'head', [{ bonusId: 'mp-regen', value: mpRegen }]),
    ],
  };

  function tick(state: SimState): DomainEvent[] {
    const events: DomainEvent[] = [];
    regenerate(state, context(state, events));
    return events;
  }

  function gains(events: DomainEvent[], id: string): { hp?: number; mp?: number } {
    const out: { hp?: number; mp?: number } = {};
    for (const event of events) {
      if (event.kind === 'regen' && event.actorId === id) out[event.reason as 'hp' | 'mp'] = event.amount!;
    }
    return out;
  }

  test('flat regen adds to the base before the phase multiplier', () => {
    for (const phase of ['fighting', 'resting'] as const) {
      const state = fighting(['guardian', 'cleric'], items);
      state.phase = phase;
      const cleric = state.actors.p1!;
      cleric.hp = 1;
      cleric.mp = 0;
      const [numerator, denominator] = phase === 'fighting' ? [1, 2] : [4, 1];
      const hpBase = Math.max(1, Math.floor(cleric.stats.maxHp / 100) + Math.floor(cleric.attributes.vit / 5)) + hpRegen;
      const mpBase = Math.max(1, Math.floor(cleric.stats.maxMp / 100) + Math.floor(cleric.attributes.int / 6)) + mpRegen;
      expect(gains(tick(state), 'p1'), phase).toEqual({
        hp: Math.max(1, Math.floor((hpBase * numerator) / denominator)),
        mp: Math.max(1, Math.floor((mpBase * numerator) / denominator)),
      });
    }
  });

  test('flat regen still clamps to max', () => {
    const state = fighting(['guardian', 'cleric'], items);
    const cleric = state.actors.p1!;
    cleric.hp = cleric.stats.maxHp - 1;
    cleric.mp = cleric.stats.maxMp - 1;
    expect(gains(tick(state), 'p1')).toEqual({ hp: 1, mp: 1 });
    expect(cleric.hp).toBe(cleric.stats.maxHp);
    expect(cleric.mp).toBe(cleric.stats.maxMp);
  });

  test('the dead do not regenerate, whatever they wear', () => {
    const state = fighting(['guardian', 'cleric'], items);
    const cleric = state.actors.p1!;
    cleric.hp = 0;
    cleric.mp = 0;
    expect(gains(tick(state), 'p1')).toEqual({});
    expect(cleric.hp).toBe(0);
    expect(cleric.mp).toBe(0);
  });
});

describe('the factors live on the checkpoint (R162)', () => {
  const items = { p0: [worn('char-0', 'arcanist-staff', 'weapon', [{ bonusId: 'fire-damage', value: top('fire-damage') }])] };

  test('an encode/decode round trip preserves the factors', () => {
    const sim = lab();
    const state = fighting(['arcanist', 'guardian'], items);
    const decoded = sim.decode(sim.encode(state));
    expect(decoded.progression!.p0!.equipped).toEqual(state.progression!.p0!.equipped);
    arm(state, 'p0', 'fire-bolt', 'e0');
    arm(decoded, 'p0', 'fire-bolt', 'e0');
    const bare = fighting(['arcanist', 'guardian']);
    arm(bare, 'p0', 'fire-bolt', 'e0');
    const original = dealt(resolve(state, 'p0'));
    expect(dealt(resolve(decoded, 'p0'))).toBe(original);
    expect(original).toBeGreaterThan(dealt(resolve(bare, 'p0')));
  });

  test('a checkpoint whose bonus leaves its span is refused', () => {
    const sim = lab();
    const state = fighting(['arcanist', 'guardian'], items);
    state.progression!.p0!.equipped[0]!.bonuses[0]!.value = top('fire-damage') + 1;
    let refusal: { code: string; field: string } | null = null;
    try {
      sim.decode(sim.encode(state));
    } catch (error) {
      refusal = { code: (error as { code: string }).code, field: (error as { field: string }).field };
    }
    expect(refusal).toEqual({ code: 'INVALID_STATE', field: 'progression.p0.equipped.0.bonuses.0.value' });
  });
});

/** 32-bit FNV-1a over a string's UTF-16 code units: a digest with no Node or browser global. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

describe('byte identity without these bonuses', () => {
  test('a geared hunt with none of the combat bonuses matches the pre-7d engine exactly', () => {
    // Pinned at e63373e, before any Task 7d source change: class weapons (one
    // carrying a STR bonus, which these factors do not read), a body armour
    // and a ring with no bonus, run for ten minutes of mixed encounters.
    const classes: ClassId[] = ['guardian', 'cleric', 'ranger'];
    const items: Worn = {
      p0: [
        worn('char-0', 'guardian-sword', 'weapon', [{ bonusId: 'str', value: top('str') }]),
        worn('char-0', 'padded-vest', 'body'),
      ],
      p1: [worn('char-1', 'cleric-mace', 'weapon'), worn('char-1', 'copper-ring', 'accessory1')],
      p2: [worn('char-2', 'ranger-bow', 'weapon')],
    };
    const party = Object.fromEntries(classes.map((classId, index) => {
      const id = `p${index}`;
      return [id, member(classId, `char-${index}`, items[id] ?? [])];
    }));
    const sim = lab();
    const result = runTo(sim, sim.start(labInput({ seed: 7 }), { party }), 600_000);
    expect(result.events.length).toBeGreaterThan(1_000);
    expect({
      rng: result.state.rng,
      events: fnv1a(JSON.stringify(result.events)),
      metrics: fnv1a(JSON.stringify(result.state.metrics)),
      checkpoint: fnv1a(sim.encode(result.state)),
    }).toEqual(PINNED_NO_BONUS_RUN);
  });
});

const PINNED_NO_BONUS_RUN = { rng: 3046643346, events: '140755f2', metrics: '3312267e', checkpoint: '2b0bd835' };
