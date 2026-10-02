import { content } from '@narok/data';
import type { Content, ItemInstance, Slot } from '@narok/data';
import { expect, test } from 'vitest';
import { clampResources, createCharacter, equip, gainExp, respec, unequip } from '../src/index';
import type { Bag, Character, MaximaOf, TownContext } from '../src/index';

/** Every equipped item adds 20 Max HP and 10 Max MP; VIT adds 10 Max HP. */
const maxima: MaximaOf = (character, equipped) => ({
  maxHp: 100 + 10 * character.attributes.vit + 20 * equipped.length + 5 * character.level,
  maxMp: 50 + 10 * equipped.length,
});

function town(overrides: Partial<TownContext> = {}): TownContext {
  return { content, stateVersion: 3, expectedStateVersion: 3, inTown: true, maxima, ...overrides };
}

function item(id: string, definitionId: string, overrides: Partial<ItemInstance> = {}): ItemInstance {
  return {
    id, accountId: 'a1', definitionId, contentVersion: content.version, rarity: 'common', itemLevel: 1,
    bonuses: [], tradeable: false, locked: false, protected: false, equipped: null, boundTo: null,
    source: { huntId: 'h1', rewardSeq: Number(id.replace(/\D/g, '') || 0) }, ...overrides,
  };
}

function worn(id: string, definitionId: string, characterId: string, slot: Slot): ItemInstance {
  return item(id, definitionId, { equipped: { characterId, slot } });
}

function bag(items: ItemInstance[], capacity = 100, consumables: Record<string, number> = {}): Bag {
  return { accountId: 'a1', capacity, items, consumables };
}

const guardian = (overrides: Partial<Character> = {}): Character =>
  ({ ...createCharacter('g1', 'guardian'), hp: 100, mp: 40, ...overrides });
const ranger = (overrides: Partial<Character> = {}): Character =>
  ({ ...createCharacter('r1', 'ranger'), hp: 100, mp: 40, ...overrides });

test('equips an owned, eligible item into an empty slot and frees its bag slot', () => {
  const result = equip(guardian(), { itemId: 'i1', slot: 'weapon' }, bag([item('i1', 'guardian-sword')]), town());
  if (!result.ok) throw new Error(result.field);
  expect(result.next.bag.items[0]!.equipped).toEqual({ characterId: 'g1', slot: 'weapon' });
});

test('refuses unowned, wrong-slot, wrong-class and under-level items', () => {
  const owned = bag([item('i1', 'guardian-sword'), item('i2', 'leather-cap'), item('x', 'leather-cap', { accountId: 'a2' })]);
  expect(equip(guardian(), { itemId: 'nope', slot: 'weapon' }, owned, town())).toEqual({ ok: false, code: 'NOT_OWNED', field: 'itemId' });
  expect(equip(guardian(), { itemId: 'x', slot: 'head' }, owned, town())).toEqual({ ok: false, code: 'NOT_OWNED', field: 'itemId' });
  expect(equip(guardian(), { itemId: 'i2', slot: 'body' }, owned, town()))
    .toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'SLOT_MISMATCH' });
  expect(equip(ranger(), { itemId: 'i1', slot: 'weapon' }, owned, town()))
    .toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'CLASS_RESTRICTION' });
  const strict: Content = structuredClone(content);
  strict.items['leather-cap']!.levelRequirement = 10;
  expect(equip(guardian(), { itemId: 'i2', slot: 'head' }, owned, town({ content: strict })))
    .toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'LEVEL_REQUIREMENT' });
  expect(equip(guardian({ level: 10 }), { itemId: 'i2', slot: 'head' }, owned, town({ content: strict })).ok).toBe(true);
  expect(equip(guardian(), { itemId: 'i2', slot: 'hands' as Slot }, owned, town()))
    .toEqual({ ok: false, code: 'VALIDATION', field: 'slot' });
});

test('refuses an item worn by someone, bound to someone else, or an off-hand under a two-handed weapon', () => {
  const owned = bag([
    worn('i1', 'guardian-sword', 'g2', 'weapon'),
    item('i2', 'guardian-sword', { boundTo: 'g2' }),
    worn('i3', 'ranger-bow', 'r1', 'weapon'),
    item('i4', 'wooden-buckler'),
  ]);
  expect(equip(guardian(), { itemId: 'i1', slot: 'weapon' }, owned, town()))
    .toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'ITEM_EQUIPPED' });
  expect(equip(guardian(), { itemId: 'i2', slot: 'weapon' }, owned, town()))
    .toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'CHARACTER_BOUND' });
  expect(equip(guardian({ id: 'g2' }), { itemId: 'i2', slot: 'weapon' }, owned, town()).ok).toBe(true);
  expect(equip(ranger(), { itemId: 'i4', slot: 'offhand' }, owned, town()))
    .toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'TWO_HANDED' });
});

test('an equip while hunting is refused with the town-only rule, after the version check', () => {
  const owned = bag([item('i1', 'guardian-sword')]);
  expect(equip(guardian(), { itemId: 'i1', slot: 'weapon' }, owned, town({ inTown: false })))
    .toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'TOWN_ONLY' });
  expect(equip(guardian(), { itemId: 'i1', slot: 'weapon' }, owned, town({ inTown: false, expectedStateVersion: 2 })))
    .toEqual({ ok: false, code: 'CONFLICT_STATE_VERSION', field: 'expectedStateVersion' });
  expect(unequip(guardian(), 'weapon', owned, town({ inTown: false })))
    .toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'TOWN_ONLY' });
});

test('a two-handed weapon auto-unequips the off-hand, and fails when the bag cannot hold what comes off', () => {
  // The ranger wears only an off-hand: the bow takes the bag slot it frees.
  const items = [worn('o1', 'wooden-buckler', 'r1', 'offhand'), item('b1', 'ranger-bow')];
  const roomy = equip(ranger(), { itemId: 'b1', slot: 'weapon' }, bag(items, 2), town());
  if (!roomy.ok) throw new Error(roomy.field);
  expect(roomy.next.bag.items.find((entry) => entry.id === 'o1')!.equipped).toBeNull();
  expect(roomy.next.bag.items.find((entry) => entry.id === 'b1')!.equipped).toEqual({ characterId: 'r1', slot: 'weapon' });

  // With an old weapon and the off-hand both coming off, the bow's slot alone is not enough.
  const crowded = [
    worn('w0', 'ranger-bow', 'r1', 'weapon'), item('b2', 'ranger-bow'),
    item('f1', 'leather-cap'), item('f2', 'leather-cap'),
  ];
  // Two-handed over two-handed: one item off, one item on — a full bag still fits.
  expect(equip(ranger(), { itemId: 'b2', slot: 'weapon' }, bag(crowded, 3), town()).ok).toBe(true);
  const guarded = [
    worn('w1', 'guardian-sword', 'g1', 'weapon'), worn('o2', 'wooden-buckler', 'g1', 'offhand'),
    item('f3', 'leather-cap'),
  ];
  const twoHanded: Content = structuredClone(content);
  twoHanded.items['guardian-greatsword'] = { ...twoHanded.items['guardian-sword']!, id: 'guardian-greatsword', handedness: 'two-handed' };
  const full = bag([...guarded, item('g9', 'guardian-greatsword')], 2);
  expect(equip(guardian(), { itemId: 'g9', slot: 'weapon' }, full, town({ content: twoHanded })))
    .toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'BAG_FULL' });
  const fits = equip(guardian(), { itemId: 'g9', slot: 'weapon' }, bag(full.items, 3), town({ content: twoHanded }));
  if (!fits.ok) throw new Error(fits.field);
  expect(fits.next.bag.items.filter((entry) => entry.equipped !== null).map((entry) => entry.id)).toEqual(['g9']);
});

test('unequip returns the item to the bag, refuses an empty slot and a full bag', () => {
  const owned = bag([worn('w1', 'guardian-sword', 'g1', 'weapon'), item('f1', 'leather-cap')], 1);
  expect(unequip(guardian(), 'weapon', owned, town())).toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'BAG_FULL' });
  expect(unequip(guardian(), 'head', owned, town())).toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'SLOT_EMPTY' });
  const off = unequip(guardian(), 'weapon', bag(owned.items, 2), town());
  if (!off.ok) throw new Error(off.field);
  expect(off.next.bag.items[0]!.equipped).toBeNull();
});

/**
 * Part 3 §5.4 / spec §4.1 option (a): every maximum change preserves absolute
 * HP and MP and clamps them to the new maximum — the same rule for a level-up,
 * an equip, an unequip and a respec, and never a heal.
 */
test.each([
  ['level-up', 1], ['equip', 1], ['unequip', 1], ['respec', 1],
  ['level-up', 9_999], ['equip', 9_999], ['unequip', 9_999], ['respec', 9_999],
] as const)('%s preserves absolute HP and MP and clamps them (from HP %i)', (change, startHp) => {
  const items = [worn('w1', 'guardian-sword', 'g1', 'weapon'), item('c1', 'leather-cap')];
  const spentVit = { ...createCharacter('g1', 'guardian'), attributes: { str: 1, agi: 1, vit: 30, int: 1, dex: 1, luk: 1 } };
  const character: Character = { ...spentVit, hp: startHp, mp: startHp };
  const before = maxima(character, items.filter((entry) => entry.equipped !== null));
  const start: Character = { ...character, ...clampOk(character, before) };

  let after: { character: Character; max: { maxHp: number; maxMp: number } };
  if (change === 'level-up') {
    const leveled = { ...start, ...gainExp(start, 1_000) };
    const max = maxima(leveled, [items[0]!]);
    after = { character: { ...leveled, ...clampOk(leveled, max) }, max };
  } else if (change === 'equip') {
    const result = equip(start, { itemId: 'c1', slot: 'head' }, bag(items), town());
    if (!result.ok) throw new Error(result.field);
    after = { character: result.next.character, max: maxima(result.next.character, result.next.bag.items.filter((entry) => entry.equipped)) };
  } else if (change === 'unequip') {
    const result = unequip(start, 'weapon', bag(items), town());
    if (!result.ok) throw new Error(result.field);
    after = { character: result.next.character, max: maxima(result.next.character, []) };
  } else {
    const result = respec(start, 'attributes', [items[0]!], town());
    if (!result.ok) throw new Error(result.field);
    after = { character: result.next, max: maxima(result.next, [items[0]!]) };
  }
  expect(after.character.hp).toBe(Math.min(start.hp, after.max.maxHp));
  expect(after.character.mp).toBe(Math.min(start.mp, after.max.maxMp));
});

test('an equip that raises Max HP heals nothing', () => {
  const start = guardian({ hp: 37, mp: 12 });
  const result = equip(start, { itemId: 'c1', slot: 'head' }, bag([item('c1', 'leather-cap')]), town());
  if (!result.ok) throw new Error(result.field);
  expect(maxima(result.next.character, [result.next.bag.items[0]!]).maxHp).toBeGreaterThan(maxima(start, []).maxHp);
  expect(result.next.character.hp).toBe(37);
  expect(result.next.character.mp).toBe(12);
});

test('clampResources refuses a negative or fractional resource', () => {
  expect(clampResources({ hp: -1, mp: 0 }, { maxHp: 10, maxMp: 10 })).toEqual({ ok: false, code: 'VALIDATION', field: 'hp' });
  expect(clampResources({ hp: 1, mp: 0.5 }, { maxHp: 10, maxMp: 10 })).toEqual({ ok: false, code: 'VALIDATION', field: 'mp' });
  expect(clampResources({ hp: 12, mp: 3 }, { maxHp: 10, maxMp: 10 })).toEqual({ ok: true, next: { hp: 10, mp: 3 } });
});

function clampOk(character: Character, max: { maxHp: number; maxMp: number }): { hp: number; mp: number } {
  const clamped = clampResources(character, max);
  if (!clamped.ok) throw new Error(clamped.field);
  return clamped.next;
}
