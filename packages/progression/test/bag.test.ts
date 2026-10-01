import { CONSUMABLE_STACK_MAX, content } from '@narok/data';
import type { ItemInstance } from '@narok/data';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import {
  ONBOARDING_GRANT_KEY, bagLock, bagPlace, bagPlaceConsumable, bagState, consumePotion, consumePotions,
  grantOnboarding, grantStarterKit, starterKitKey, usedSlots,
} from '../src/index';
import type { Bag, PotionUser } from '../src/index';

function item(id: string, overrides: Partial<ItemInstance> = {}): ItemInstance {
  return {
    id, accountId: 'a1', definitionId: 'leather-cap', contentVersion: content.version, rarity: 'common', itemLevel: 1,
    bonuses: [], tradeable: false, locked: false, protected: false, equipped: null, boundTo: null,
    source: { huntId: 'h1', rewardSeq: 0 }, ...overrides,
  };
}

function bag(items: ItemInstance[] = [], capacity = 100, consumables: Record<string, number> = {}): Bag {
  return { accountId: 'a1', capacity, items, consumables };
}

function user(characterId: string, overrides: Partial<PotionUser> = {}): PotionUser {
  return { characterId, hp: 100, mp: 100, maxHp: 400, maxMp: 300, potionReadyAt: 0, ...overrides };
}

test('equipment takes one slot each, equipped items take none, and a full bag refuses', () => {
  const start = bag([item('w', { equipped: { characterId: 'c1', slot: 'weapon' } })], 2);
  expect(usedSlots(start)).toBe(0);
  const one = bagPlace(start, item('i1'));
  if (!one.ok) throw new Error(one.field);
  const two = bagPlace(one.next, item('i2'));
  if (!two.ok) throw new Error(two.field);
  expect(usedSlots(two.next)).toBe(2);
  expect(bagPlace(two.next, item('i3'))).toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'BAG_FULL' });
  expect(bagPlace(two.next, item('i1'))).toEqual({ ok: false, code: 'VALIDATION', field: 'instance.id' });
  expect(bagPlace(two.next, item('i9', { accountId: 'a2' }))).toEqual({ ok: false, code: 'NOT_OWNED', field: 'instance.accountId' });
  expect(start.items).toHaveLength(1);
});

test('consumables stack to 999 and every 999 more opens one more stack while a slot is free (R137)', () => {
  const placed = bagPlaceConsumable(bag([], 3), 'small-hp-potion', 998, content);
  if (!placed.ok) throw new Error(placed.field);
  expect(usedSlots(placed.next)).toBe(1);
  const topped = bagPlaceConsumable(placed.next, 'small-hp-potion', 1, content);
  if (!topped.ok) throw new Error(topped.field);
  expect(usedSlots(topped.next)).toBe(1);
  const spilled = bagPlaceConsumable(topped.next, 'small-hp-potion', 1, content);
  if (!spilled.ok) throw new Error(spilled.field);
  expect(usedSlots(spilled.next)).toBe(2);
  expect(spilled.next.consumables['small-hp-potion']).toBe(1_000);
  expect(bagPlaceConsumable(spilled.next, 'small-hp-potion', 2 * CONSUMABLE_STACK_MAX, content))
    .toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'BAG_FULL' });
  expect(bagPlaceConsumable(spilled.next, 'elixir', 1, content)).toEqual({ ok: false, code: 'VALIDATION', field: 'consumableId' });
  expect(bagPlaceConsumable(spilled.next, 'small-hp-potion', 0, content)).toEqual({ ok: false, code: 'VALIDATION', field: 'quantity' });
});

test("the bag's simulation view places exactly what the bag places (one stack model, R137)", () => {
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 5 }),
    fc.array(fc.integer({ min: 1, max: 1_500 }), { maxLength: 8 }),
    (equipment, quantities) => {
      let current = bag(Array.from({ length: equipment }, (_, index) => item(`i${index}`)), 6);
      for (const quantity of quantities) {
        const view = bagState(current);
        const units = view.held['small-hp-potion'] ?? 0;
        const headroom = Math.ceil(units / CONSUMABLE_STACK_MAX) * CONSUMABLE_STACK_MAX - units;
        const simFits = view.usedSlots + Math.ceil(Math.max(0, quantity - headroom) / CONSUMABLE_STACK_MAX) <= view.capacity;
        const placed = bagPlaceConsumable(current, 'small-hp-potion', quantity, content);
        expect(placed.ok).toBe(simFits);
        if (placed.ok) current = placed.next;
      }
    },
  ));
});

test('lock and unlock toggle the user flag on an owned item at any time', () => {
  const locked = bagLock(bag([item('i1')]), 'i1', true);
  if (!locked.ok) throw new Error(locked.field);
  expect(locked.next.items[0]!.locked).toBe(true);
  const unlocked = bagLock(locked.next, 'i1', false);
  expect(unlocked.ok && unlocked.next.items[0]!.locked).toBe(false);
  expect(bagLock(bag(), 'i9', true)).toEqual({ ok: false, code: 'NOT_OWNED', field: 'itemId' });
});

test('Small HP Potion heals 25% of Max HP and Small MP Potion restores 20% of Max MP, never past the maximum', () => {
  const stocked = bag([], 100, { 'small-hp-potion': 2, 'small-mp-potion': 1 });
  const hp = consumePotion(stocked, user('c1'), 'small-hp-potion', 1_000, content);
  if (!hp.ok) throw new Error(hp.field);
  expect(hp.next.user.hp).toBe(200);
  expect(hp.next.user.potionReadyAt).toBe(11_000);
  expect(hp.next.bag.consumables['small-hp-potion']).toBe(1);
  const mp = consumePotion(stocked, user('c1', { mp: 290 }), 'small-mp-potion', 1_000, content);
  if (!mp.ok) throw new Error(mp.field);
  expect(mp.next.user.mp).toBe(300);
  expect(mp.next.bag.consumables['small-mp-potion']).toBeUndefined();
});

test('the shared 10-second potion cooldown is per character and covers both potions', () => {
  const stocked = bag([], 100, { 'small-hp-potion': 5, 'small-mp-potion': 5 });
  const first = consumePotion(stocked, user('c1'), 'small-hp-potion', 0, content);
  if (!first.ok) throw new Error(first.field);
  expect(consumePotion(first.next.bag, first.next.user, 'small-mp-potion', 9_999, content))
    .toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'POTION_COOLDOWN' });
  expect(consumePotion(first.next.bag, first.next.user, 'small-mp-potion', 10_000, content).ok).toBe(true);
  expect(consumePotion(first.next.bag, user('c2'), 'small-hp-potion', 1, content).ok).toBe(true);
  expect(consumePotion(bag(), user('c1'), 'small-hp-potion', 0, content))
    .toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'NO_POTION' });
  expect(consumePotion(stocked, user('c1', { hp: 0 }), 'small-hp-potion', 0, content))
    .toEqual({ ok: false, code: 'RULE_VIOLATION', field: 'CHARACTER_DEAD' });
  expect(consumePotion(stocked, user('c1'), 'elixir', 0, content)).toEqual({ ok: false, code: 'VALIDATION', field: 'consumableId' });
  // Idun's Apple is no potion: only the simulation spends it, at a death (ruling R152).
  expect(consumePotion(bag([], 100, { 'idun-apple': 1 }), user('c1'), 'idun-apple', 0, content))
    .toEqual({ ok: false, code: 'VALIDATION', field: 'consumableId' });
});

test('simultaneous consumers resolve in ascending character id and never share a unit', () => {
  const lastOne = bag([], 100, { 'small-hp-potion': 1 });
  const resolved = consumePotions(lastOne, [
    { user: user('c3'), consumableId: 'small-hp-potion' },
    { user: user('c1'), consumableId: 'small-hp-potion' },
    { user: user('c2'), consumableId: 'small-hp-potion' },
  ], 0, content);
  expect(resolved.results.map((entry) => [entry.characterId, entry.result.ok])).toEqual([
    ['c1', true], ['c2', false], ['c3', false],
  ]);
  expect(resolved.bag.consumables['small-hp-potion']).toBeUndefined();
});

test('the onboarding grant is fixed content, idempotent, and deferred — not lost — by a full bag', () => {
  const full = bag([item('x')], 1);
  const deferred = grantOnboarding(full, {}, 'ranger', 'grant-item-1', content);
  expect(deferred).toEqual({ outcome: 'deferred', bag: full, itemId: null });

  const granted = grantOnboarding(bag(), {}, 'ranger', 'grant-item-1', content);
  expect(granted.outcome).toBe('granted');
  const instance = granted.bag.items[0]!;
  expect(instance).toEqual({
    id: 'grant-item-1', accountId: 'a1', definitionId: 'ranger-bow', contentVersion: content.version,
    rarity: 'uncommon', itemLevel: 1, bonuses: content.onboardingGrant.ranger.bonuses,
    tradeable: false, locked: false, protected: false, equipped: null, boundTo: null,
    source: { grantId: ONBOARDING_GRANT_KEY },
  });
  // Identical for every account of the class: only the ids differ.
  const other = grantOnboarding(bag([], 100), {}, 'ranger', 'z', content);
  expect({ ...other.bag.items[0], id: 'grant-item-1' }).toEqual(instance);
  // A repeat returns the existing instance and mints nothing.
  const repeated = grantOnboarding(granted.bag, { [ONBOARDING_GRANT_KEY]: ['grant-item-1'] }, 'ranger', 'grant-item-2', content);
  expect(repeated).toEqual({ outcome: 'existing', bag: granted.bag, itemId: 'grant-item-1' });
});

test('the starter kit: potions on the first slot only, a bound weapon per slot, once per slot', () => {
  const first = grantStarterKit(bag(), {}, { characterId: 'c1', characterSlot: 0, classId: 'guardian', itemId: 'sk-0' }, content);
  expect(first.outcome).toBe('granted');
  expect(first.bag.consumables).toEqual({ 'small-hp-potion': 20 });
  expect(first.bag.items[0]).toMatchObject({
    id: 'sk-0', definitionId: 'guardian-sword', rarity: 'common', itemLevel: 1, bonuses: [], boundTo: 'c1',
    source: { grantId: starterKitKey(0) },
  });
  const second = grantStarterKit(first.bag, { [starterKitKey(0)]: ['sk-0'] }, { characterId: 'c2', characterSlot: 1, classId: 'cleric', itemId: 'sk-1' }, content);
  expect(second.bag.consumables).toEqual({ 'small-hp-potion': 20 });
  expect(second.bag.items[1]).toMatchObject({ definitionId: 'cleric-mace', boundTo: 'c2' });
  // Recreating slot 0 grants nothing: the key is per slot, not per character.
  const ledger = { [starterKitKey(0)]: ['sk-0'], [starterKitKey(1)]: ['sk-1'] };
  const recreated = grantStarterKit(second.bag, ledger, { characterId: 'c9', characterSlot: 0, classId: 'arcanist', itemId: 'sk-9' }, content);
  expect(recreated).toEqual({ outcome: 'existing', bag: second.bag, itemId: 'sk-0' });
  expect(starterKitKey(2)).toBe('starter-kit:2');
});

test('only a full bag defers a grant: any other placement failure is refused, never retried as a deferral', () => {
  // A duplicate instance id is a caller fault, not a full bag (Task 7a review; ruling R146).
  const held = bag([item('dup')]);
  expect(grantOnboarding(held, {}, 'ranger', 'dup', content)).toEqual({
    outcome: 'refused', bag: held, itemId: null, failure: { ok: false, code: 'VALIDATION', field: 'instance.id' },
  });
  expect(grantStarterKit(held, {}, { characterId: 'c1', characterSlot: 1, classId: 'guardian', itemId: 'dup' }, content))
    .toEqual({ outcome: 'refused', bag: held, itemId: null, failure: { ok: false, code: 'VALIDATION', field: 'instance.id' } });
  // A full bag is still a deferral.
  expect(grantOnboarding(bag([item('x')], 1), {}, 'ranger', 'g', content).outcome).toBe('deferred');
});
