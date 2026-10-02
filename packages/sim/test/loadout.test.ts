import { expect, test } from 'vitest';
import { content } from '@narok/data';
import type { Content, ItemInstance as Instance, Slot } from '@narok/data';
import { damage, derive } from '../src/math';
import { deriveCharacter, offenseBonusFor, resistFor, resolveLoadout } from '../src/loadout';
test('an empty loadout reproduces the class definition exactly', () => {
  const guardian = content.classes.guardian;
  expect(deriveCharacter({ classId: 'guardian', level: guardian.level,
    allocated: guardian.attributes, loadout: resolveLoadout([], content) }))
    .toEqual(derive(guardian));
});
test('defaulted bonus factors leave A-era damage bit-identical', () => {
  const a = { offense: 100, powerBp: 12000, elementBp: 10000, familyBp: 10000,
    varianceBp: 10000, critical: false, defense: 20, hit: true };
  expect(damage({ ...a, offenseBonusBp: 10000, resistBp: 10000 })).toBe(damage(a));
});

// ---------------------------------------------------------------------------
// Remaining composition cases (task 5). Values come from the content's own
// spans and fields, never from the provisional prototype numbers.
// ---------------------------------------------------------------------------

function instance(definitionId: string, slot: Slot, overrides: Partial<Instance> = {},
  pinned: Content = content): Instance {
  return {
    id: `item-${definitionId}-${slot}`, accountId: 'account-1', definitionId,
    contentVersion: pinned.version, rarity: 'common', itemLevel: 1, bonuses: [],
    tradeable: false, locked: false, protected: false,
    equipped: { characterId: 'character-1', slot }, boundTo: null, source: { grantId: 'test' },
    ...overrides,
  };
}

function refusal(run: () => unknown): { code: string; field: string } {
  try {
    run();
  } catch (error) {
    const { code, field } = error as { code: string; field: string };
    return { code, field };
  }
  throw new Error('expected a refusal');
}

test('an equipped tier-1 class weapon reproduces its class baseline', () => {
  for (const classId of ['guardian', 'cleric', 'ranger', 'arcanist'] as const) {
    const cls = content.classes[classId];
    const weapon = Object.values(content.items)
      .find((item) => item.slot === 'weapon' && item.classes?.includes(classId))!;
    const loadout = resolveLoadout([instance(weapon.id, 'weapon')], content);
    expect(deriveCharacter({ classId, level: cls.level, allocated: cls.attributes, loadout }))
      .toEqual(derive(cls));
  }
});

test('a two-handed weapon refuses an occupied offhand', () => {
  const twoHanded = Object.values(content.items)
    .find((item) => item.slot === 'weapon' && item.handedness === 'two-handed')!;
  const oneHanded = Object.values(content.items)
    .find((item) => item.slot === 'weapon' && item.handedness === 'one-handed')!;
  const shield = Object.values(content.items).find((item) => item.slot === 'offhand')!;
  expect(refusal(() => resolveLoadout([
    instance(twoHanded.id, 'weapon'), instance(shield.id, 'offhand'),
  ], content))).toEqual({ code: 'INVALID_INPUT', field: 'items.1.equipped.slot' });
  expect(() => resolveLoadout([
    instance(oneHanded.id, 'weapon'), instance(shield.id, 'offhand'),
  ], content)).not.toThrow();
});

test('one item per slot; the same accessory definition may occupy both accessory slots', () => {
  const ring = Object.values(content.items).find((item) => item.slot === 'accessory1')!;
  expect(() => resolveLoadout([
    instance(ring.id, 'accessory1'), instance(ring.id, 'accessory2'),
  ], content)).not.toThrow();
  expect(refusal(() => resolveLoadout([
    instance(ring.id, 'accessory1'), instance(ring.id, 'accessory1'),
  ], content))).toEqual({ code: 'INVALID_INPUT', field: 'items.1.equipped.slot' });
});

test('refuses a duplicate bonus identity on one instance', () => {
  const weapon = content.items['guardian-sword']!;
  const bonusId = weapon.fittingBonuses[0]!;
  const { min, max } = content.bonuses[bonusId]!.spans[0]!;
  const item = instance(weapon.id, 'weapon', {
    rarity: 'rare', bonuses: [{ bonusId, value: min }, { bonusId, value: max }],
  });
  expect(refusal(() => resolveLoadout([item], content)))
    .toEqual({ code: 'INVALID_INPUT', field: 'items.0.bonuses.1.bonusId' });
});

test('an instance resolves only under its pinned content version (B-29)', () => {
  const item = instance('leather-cap', 'head', { contentVersion: 'some-older-version' });
  expect(refusal(() => resolveLoadout([item], content)))
    .toEqual({ code: 'WRONG_VERSION', field: 'items.0.contentVersion' });
});

test('value tier indexes spans at item level 1 and at the band maximum', () => {
  const pinned = structuredClone(content);
  const bonus = pinned.bonuses.str!;
  bonus.spans = [{ min: 1, max: 3 }, { min: 10, max: 20 }];
  const rolled = (itemLevel: number, value: number) => () => resolveLoadout([
    instance('guardian-sword', 'weapon', {
      rarity: 'uncommon', itemLevel, bonuses: [{ bonusId: 'str', value }],
    }, pinned),
  ], pinned);
  for (const level of [1, 10]) {
    expect(rolled(level, 3)().attributeBonus.str).toBe(3);
    expect(refusal(rolled(level, 10))).toEqual({ code: 'INVALID_INPUT', field: 'items.0.bonuses.0.value' });
  }
  for (const level of [11, 20]) {
    expect(rolled(level, 10)().attributeBonus.str).toBe(10);
    expect(refusal(rolled(level, 3))).toEqual({ code: 'INVALID_INPUT', field: 'items.0.bonuses.0.value' });
  }
});

test('max-stacked identities keep the largest value; sum-stacked identities add', () => {
  const pinned = structuredClone(content);
  pinned.bonuses.crit!.stacking = 'sum';
  pinned.bonuses['attack-speed']!.stacking = 'max';
  const critSpan = pinned.bonuses.crit!.spans[0]!;
  const speedSpan = pinned.bonuses['attack-speed']!.spans[0]!;
  const ring = Object.values(pinned.items).find((item) => item.slot === 'accessory1')!;
  const roll = (slot: Slot, crit: number, speed: number) => instance(ring.id, slot, {
    rarity: 'rare', bonuses: [{ bonusId: 'crit', value: crit }, { bonusId: 'attack-speed', value: speed }],
  }, pinned);
  const loadout = resolveLoadout([
    roll('accessory1', critSpan.min, speedSpan.min), roll('accessory2', critSpan.max, speedSpan.max),
  ], pinned);
  expect(loadout.critBpBonus).toBe(critSpan.min + critSpan.max);
  expect(loadout.attackSpeedBp).toBe(10_000 + speedSpan.max);
});

test('deriveCharacter is monotonic in weaponAtk', () => {
  for (const classId of ['guardian', 'cleric', 'ranger', 'arcanist'] as const) {
    const cls = content.classes[classId];
    let previous = -1;
    for (const weaponAtk of [0, 1, 5, 25, 100, 1_000]) {
      const loadout = { ...resolveLoadout([], content), weaponAtk, weaponMatk: cls.weaponMatk,
        basicIntervalMs: cls.basicIntervalMs, basicRange: cls.basicRange, basicKind: cls.basicKind };
      const { atk } = deriveCharacter({ classId, level: cls.level, allocated: cls.attributes, loadout });
      expect(atk).toBeGreaterThanOrEqual(previous);
      previous = atk;
    }
  }
});

test('armour adds to the class baseline; percentage factors apply after derive', () => {
  const guardian = content.classes.guardian;
  const base = derive(guardian);
  const cap = content.items['leather-cap']!;
  const loadout = { ...resolveLoadout([instance(cap.id, 'head')], content), atkBp: 11_000, maxHpBp: 12_000 };
  const stats = deriveCharacter({ classId: 'guardian', level: guardian.level,
    allocated: guardian.attributes, loadout });
  expect(stats.def).toBe(base.def + cap.armorDef);
  expect(stats.mdef).toBe(base.mdef + cap.armorMdef);
  expect(stats.atk).toBe(Math.floor((base.atk * 11_000) / 10_000));
  expect(stats.maxHp).toBe(Math.floor((base.maxHp * 12_000) / 10_000));
});

test('combat bonuses compose into one offense factor and one resistance factor', () => {
  const empty = resolveLoadout([], content);
  expect(offenseBonusFor(empty, 'beast', 'fire')).toBe(10_000);
  expect(resistFor(empty, 'fire')).toBe(10_000);
  const loadout = { ...empty, familyBp: { beast: 300 }, elementBp: { fire: 200 }, resistBp: { water: 700 } };
  expect(offenseBonusFor(loadout, 'beast', 'fire')).toBe(10_500);
  expect(offenseBonusFor(loadout, 'plant', 'fire')).toBe(10_200);
  expect(resistFor(loadout, 'water')).toBe(9_300);
  expect(resistFor({ ...empty, resistBp: { water: 12_000 } }, 'water')).toBe(0);
});

test('deriveCharacter reads the class from the content it is given', () => {
  const pinned = structuredClone(content);
  pinned.classes.guardian.baseHp += 100;
  const guardian = pinned.classes.guardian;
  expect(deriveCharacter({ classId: 'guardian', level: guardian.level, allocated: guardian.attributes,
    loadout: resolveLoadout([], pinned), content: pinned })).toEqual(derive(guardian));
});
