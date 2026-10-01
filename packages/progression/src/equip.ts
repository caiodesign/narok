import { slotAccepts } from '@narok/data';
import type { ItemInstance, Slot } from '@narok/data';
import { usedSlots } from './bag';
import { clampResources } from './resources';
import { fail, guard, rule } from './types';
import type { Bag, Character, Result, TownContext } from './types';

/**
 * Equip and unequip (Part 3 §4; layer-1 §4.5, §7.6; ruling R138). Town-only,
 * pure, all or nothing. Eligibility is level and class only (Part 3 §5.4);
 * a two-handed weapon locks the off-hand and takes it off on equip, failing
 * when the bag cannot hold what comes off (owner decision 2026-09-21); and
 * after the change HP and MP follow the one clamping rule — so an equip that
 * raises Max HP heals nothing.
 */

const SLOTS: readonly Slot[] = ['weapon', 'offhand', 'head', 'body', 'cloak', 'shoes', 'accessory1', 'accessory2'];

function copyItems(items: readonly ItemInstance[]): ItemInstance[] {
  return items.map((entry) => ({
    ...entry,
    bonuses: entry.bonuses.map((bonus) => ({ ...bonus })),
    equipped: entry.equipped === null ? null : { ...entry.equipped },
    source: { ...entry.source },
  }));
}

function wornBy(items: readonly ItemInstance[], characterId: string): ItemInstance[] {
  return items.filter((entry) => entry.equipped?.characterId === characterId);
}

function settle(character: Character, bag: Bag, ctx: TownContext): Result<{ character: Character; bag: Bag }> {
  const clamped = clampResources(character, ctx.maxima(character, wornBy(bag.items, character.id)));
  if (!clamped.ok) return clamped;
  return { ok: true, next: { character: { ...character, ...clamped.next }, bag } };
}

/**
 * Puts the bag's item `itemId` on `character` in `slot`. Checked in order:
 * the version and the town (Part 3 §5.3 steps 1–2), the slot name, ownership
 * (`NOT_OWNED`), then the rules — not already worn, the slot accepts the
 * definition, the class, the level requirement, a binding to another
 * character, no off-hand under a two-handed weapon — and finally room in the
 * bag for whatever comes off. A worn item of the target slot is swapped out.
 */
export function equip(
  character: Character,
  request: { itemId: string; slot: Slot },
  bag: Bag,
  ctx: TownContext,
): Result<{ character: Character; bag: Bag }> {
  const refused = guard(ctx);
  if (refused !== null) return refused;
  const { itemId, slot } = request;
  if (!SLOTS.includes(slot)) return fail('VALIDATION', 'slot');
  const instance = bag.items.find((entry) => entry.id === itemId);
  if (instance === undefined || instance.accountId !== bag.accountId) return fail('NOT_OWNED', 'itemId');
  const definition = Object.hasOwn(ctx.content.items, instance.definitionId)
    ? ctx.content.items[instance.definitionId]
    : undefined;
  if (definition === undefined) return fail('VALIDATION', 'itemId');
  if (instance.equipped !== null) return rule('ITEM_EQUIPPED');
  if (!slotAccepts(definition.slot, slot)) return rule('SLOT_MISMATCH');
  if (definition.classes !== null && !definition.classes.includes(character.classId)) return rule('CLASS_RESTRICTION');
  if (character.level < definition.levelRequirement) return rule('LEVEL_REQUIREMENT');
  if (instance.boundTo !== null && instance.boundTo !== character.id) return rule('CHARACTER_BOUND');

  const worn = wornBy(bag.items, character.id);
  const weapon = worn.find((entry) => entry.equipped!.slot === 'weapon');
  if (slot === 'offhand' && weapon !== undefined && ctx.content.items[weapon.definitionId]?.handedness === 'two-handed') {
    return rule('TWO_HANDED');
  }
  const comingOff = worn.filter((entry) =>
    entry.equipped!.slot === slot || (definition.handedness === 'two-handed' && entry.equipped!.slot === 'offhand'));
  // The equipped item leaves the bag; everything coming off needs a slot.
  if (usedSlots(bag) - 1 + comingOff.length > bag.capacity) return rule('BAG_FULL');

  const items = copyItems(bag.items);
  for (const entry of items) {
    if (comingOff.some((off) => off.id === entry.id)) entry.equipped = null;
    if (entry.id === itemId) entry.equipped = { characterId: character.id, slot };
  }
  return settle(character, { ...bag, items, consumables: { ...bag.consumables } }, ctx);
}

/** Takes off what `character` wears in `slot`, which needs a free bag slot to land in. */
export function unequip(
  character: Character,
  slot: Slot,
  bag: Bag,
  ctx: TownContext,
): Result<{ character: Character; bag: Bag }> {
  const refused = guard(ctx);
  if (refused !== null) return refused;
  if (!SLOTS.includes(slot)) return fail('VALIDATION', 'slot');
  const worn = wornBy(bag.items, character.id).find((entry) => entry.equipped!.slot === slot);
  if (worn === undefined) return rule('SLOT_EMPTY');
  if (usedSlots(bag) + 1 > bag.capacity) return rule('BAG_FULL');
  const items = copyItems(bag.items);
  for (const entry of items) if (entry.id === worn.id) entry.equipped = null;
  return settle(character, { ...bag, items, consumables: { ...bag.consumables } }, ctx);
}
