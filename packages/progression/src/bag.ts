import { CONSUMABLE_STACK_MAX } from '@narok/data';
import type { Content, ItemInstance } from '@narok/data';
import { fail, isCount, rule } from './types';
import type { Bag, Result } from './types';

/**
 * The shared account bag (Part 3 §3.1; layer-1 §7.5; ruling R137).
 *
 * One stack model, the one the simulation already assumes (`BagState` in
 * `packages/sim`): a consumable is held as one total per id, and a total of
 * `n` units occupies `ceil(n / 999)` slots — every stack full but the last.
 * A unit placed tops up the open stack before a new stack opens in a free
 * slot (Part 3 §8 #6), and a unit consumed comes off the open stack, so the
 * total alone decides the slots. Several stacks of one consumable are allowed;
 * the 999 bound is per stack, not per id. Equipment never stacks and takes one
 * slot while unequipped; equipped items take none.
 */

function stacks(units: number): number {
  return Math.ceil(units / CONSUMABLE_STACK_MAX);
}

/** Slots in use: one per unequipped instance plus every consumable stack. */
export function usedSlots(bag: Bag): number {
  let used = bag.items.filter((entry) => entry.equipped === null).length;
  for (const id of Object.keys(bag.consumables)) used += stacks(bag.consumables[id]!);
  return used;
}

function copy(bag: Bag): Bag {
  return {
    ...bag,
    items: bag.items.map((entry) => ({
      ...entry,
      bonuses: entry.bonuses.map((bonus) => ({ ...bonus })),
      equipped: entry.equipped === null ? null : { ...entry.equipped },
      source: { ...entry.source },
    })),
    consumables: { ...bag.consumables },
  };
}

/**
 * What a hunt may assume about this bag (Part 3 §2.5): the simulation's
 * `BagState`, whose `stackHeadroom` is the units still free in each
 * consumable's open stack. Built here so the server never re-derives it.
 */
export function bagState(bag: Bag): { capacity: number; usedSlots: number; stackHeadroom: Record<string, number> } {
  const stackHeadroom: Record<string, number> = {};
  for (const id of Object.keys(bag.consumables).sort()) {
    const units = bag.consumables[id]!;
    stackHeadroom[id] = stacks(units) * CONSUMABLE_STACK_MAX - units;
  }
  return { capacity: bag.capacity, usedSlots: usedSlots(bag), stackHeadroom };
}

/** Places an unequipped equipment instance in a free slot. */
export function bagPlace(bag: Bag, instance: ItemInstance): Result<Bag> {
  if (instance.accountId !== bag.accountId) return fail('NOT_OWNED', 'instance.accountId');
  if (bag.items.some((entry) => entry.id === instance.id)) return fail('VALIDATION', 'instance.id');
  if (instance.equipped !== null) return fail('VALIDATION', 'instance.equipped');
  if (usedSlots(bag) + 1 > bag.capacity) return rule('BAG_FULL');
  const next = copy(bag);
  next.items.push({ ...instance, bonuses: instance.bonuses.map((bonus) => ({ ...bonus })), source: { ...instance.source } });
  return { ok: true, next };
}

/**
 * Places `quantity` units of a consumable: the open stack first, then new
 * stacks while slots are free. All or nothing — a placement that does not
 * fit changes nothing.
 */
export function bagPlaceConsumable(bag: Bag, consumableId: string, quantity: number, content: Content): Result<Bag> {
  if (!Object.hasOwn(content.consumables, consumableId)) return fail('VALIDATION', 'consumableId');
  if (!isCount(quantity) || quantity < 1) return fail('VALIDATION', 'quantity');
  const before = bag.consumables[consumableId] ?? 0;
  const after = before + quantity;
  if (!Number.isSafeInteger(after)) return fail('VALIDATION', 'quantity');
  if (usedSlots(bag) - stacks(before) + stacks(after) > bag.capacity) return rule('BAG_FULL');
  const next = copy(bag);
  next.consumables[consumableId] = after;
  return { ok: true, next };
}

/** Sets the user lock flag (Part 3 §3.2): allowed at any time, in town or not. */
export function bagLock(bag: Bag, itemId: string, locked: boolean): Result<Bag> {
  const index = bag.items.findIndex((entry) => entry.id === itemId && entry.accountId === bag.accountId);
  if (index < 0) return fail('NOT_OWNED', 'itemId');
  if (typeof locked !== 'boolean') return fail('VALIDATION', 'locked');
  const next = copy(bag);
  next.items[index]!.locked = locked;
  return { ok: true, next };
}

/** One character as a potion consumer: absolute resources, maxima and the cooldown's ready time. */
export interface PotionUser {
  characterId: string; hp: number; mp: number; maxHp: number; maxMp: number; potionReadyAt: number;
}

/**
 * Drinks one potion from the shared bag (layer-1 §6.6, §7.6): Small HP Potion
 * heals 25% of Max HP, Small MP Potion restores 20% of Max MP — the share
 * floored, never past the maximum — and either starts the character's one
 * shared potion cooldown. A dead character drinks nothing.
 */
export function consumePotion(
  bag: Bag,
  user: PotionUser,
  consumableId: string,
  nowMs: number,
  content: Content,
): Result<{ bag: Bag; user: PotionUser }> {
  const potion = Object.hasOwn(content.consumables, consumableId) ? content.consumables[consumableId] : undefined;
  if (potion === undefined) return fail('VALIDATION', 'consumableId');
  if (!isCount(nowMs)) return fail('VALIDATION', 'nowMs');
  if (user.hp <= 0) return rule('CHARACTER_DEAD');
  if (nowMs < user.potionReadyAt) return rule('POTION_COOLDOWN');
  const units = bag.consumables[consumableId] ?? 0;
  if (units < 1) return rule('NO_POTION');

  const next = copy(bag);
  if (units === 1) delete next.consumables[consumableId];
  else next.consumables[consumableId] = units - 1;
  const drinker = { ...user, potionReadyAt: nowMs + content.potionCooldownMs };
  if (potion.resource === 'hp') {
    drinker.hp = Math.min(user.maxHp, user.hp + Math.floor((user.maxHp * potion.restoreBp) / 10_000));
  } else {
    drinker.mp = Math.min(user.maxMp, user.mp + Math.floor((user.maxMp * potion.restoreBp) / 10_000));
  }
  return { ok: true, next: { bag: next, user: drinker } };
}

/**
 * Simultaneous potion use (layer-1 §7.5; Part 3 §3.1): resolved one at a time
 * in ascending character id (ASCII order, never locale order), each against
 * the bag the previous one left, so two characters can never drink the same
 * unit. Results come back in that resolution order.
 */
export function consumePotions(
  bag: Bag,
  requests: readonly { user: PotionUser; consumableId: string }[],
  nowMs: number,
  content: Content,
): { bag: Bag; results: { characterId: string; result: Result<{ bag: Bag; user: PotionUser }> }[] } {
  const ordered = [...requests].sort((a, b) =>
    a.user.characterId < b.user.characterId ? -1 : a.user.characterId > b.user.characterId ? 1 : 0);
  let current = bag;
  const results = ordered.map(({ user, consumableId }) => {
    const result = consumePotion(current, user, consumableId, nowMs, content);
    if (result.ok) current = result.next.bag;
    return { characterId: user.characterId, result };
  });
  return { bag: current, results };
}
