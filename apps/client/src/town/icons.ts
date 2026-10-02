/**
 * Which sprite symbol draws an item or a consumable. Presentation only: the
 * reference draws by kind of object, so the symbol follows the definition's
 * slot (and, for a weapon, the class that wields it) — never a content figure.
 */
import type { Content, ItemInstance, Slot } from '@narok/data';
import { definitionOf } from './model';

const WEAPON_BY_CLASS: Record<string, string> = {
  ranger: 'it-bow',
  arcanist: 'it-staff',
  cleric: 'it-mace',
  guardian: 'it-sword',
};

const BY_SLOT: Record<Slot, string> = {
  weapon: 'it-sword',
  offhand: 'it-shield',
  head: 'it-helm',
  body: 'it-chest',
  cloak: 'it-cloak',
  shoes: 'it-boots',
  accessory1: 'it-ring',
  accessory2: 'it-amulet',
};

/** The empty-slot glyphs the Character reference draws on an unfilled slot. */
export const EMPTY_SLOT_ICON: Record<Slot, string> = {
  weapon: 'it-bow',
  offhand: 'it-quiver',
  head: 'it-hood',
  body: 'it-jerkin',
  cloak: 'it-cloak',
  shoes: 'it-greaves',
  accessory1: 'it-ring',
  accessory2: 'it-charm',
};

export function itemIcon(item: ItemInstance, content: Content): string {
  return definitionIcon(definitionOf(item, content));
}

/** The symbol for a definition read by id — a report names drops by definition only. */
export function definitionIconById(definitionId: string, content: Content): string {
  return definitionIcon(Object.hasOwn(content.items, definitionId) ? content.items[definitionId] : undefined);
}

function definitionIcon(definition: Content['items'][string] | undefined): string {
  if (definition === undefined) return 'it-chest';
  if (definition.slot === 'weapon') {
    const wielder = definition.classes?.[0];
    if (wielder !== undefined && WEAPON_BY_CLASS[wielder] !== undefined) return WEAPON_BY_CLASS[wielder];
  }
  return BY_SLOT[definition.slot];
}

const CONSUMABLE_ICONS: Record<string, string> = { hp: 'it-potion', mp: 'it-mpotion', revive: 'it-ember' };

export function consumableIcon(consumableId: string, content: Content): string {
  const definition = Object.hasOwn(content.consumables, consumableId) ? content.consumables[consumableId] : undefined;
  return CONSUMABLE_ICONS[definition?.resource ?? 'hp'] ?? 'it-potion';
}

/** The reference's rarity class for a bag cell (`r-*`) and for a list row (`drop--*`). */
export const rarityCell = (rarity: string): string => `r-${rarity}`;
export const rarityRow = (rarity: string): string => `drop--${rarity}`;
