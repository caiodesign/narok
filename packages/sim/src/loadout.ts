import { bonusCount, content as bundledContent, slotAccepts, stackBonuses, valueTier } from '@narok/data';
import type {
  Attributes,
  ClassId,
  Content,
  DamageKind,
  Element,
  Family,
  ItemDefinition,
  ItemInstance,
  RolledBonus,
  Slot,
} from '@narok/data';
import { SimError } from './errors';
import { derive, scale } from './math';
import type { DerivedStats } from './types';

/**
 * One character's equipped items resolved against pinned content (Part 3
 * §1.4). Factor fields ending in `Bp` (`atkBp`, `matkBp`, `attackSpeedBp`,
 * `maxHpBp`, `healPowerBp`) are multipliers with 10,000 neutral; `critBpBonus`
 * adds crit chance in basis points; the `familyBp`/`elementBp`/`resistBp`
 * records hold summed bonus basis points per key, an absent key meaning none.
 *
 * The five weapon fields are `null` exactly when no weapon is equipped: the
 * class's own weapon fields are then the empty-slot defaults, which only
 * {@link deriveCharacter} can apply because a loadout names no class (ruling
 * R121). `armorDef`/`armorMdef` sum item armour only; the class's own armour is
 * its unarmoured baseline and item armour adds on top of it (ruling R121).
 */
export interface ResolvedLoadout {
  weaponAtk: number | null; weaponMatk: number | null;
  armorDef: number; armorMdef: number;
  basicIntervalMs: number | null; basicRange: number | null; basicKind: DamageKind | null;
  attributeBonus: Attributes;                       // flat, added to allocated attributes
  atkBp: number; matkBp: number; critBpBonus: number; attackSpeedBp: number;
  maxHpBp: number; healPowerBp: number;
  familyBp: Partial<Record<Family, number>>;
  elementBp: Partial<Record<Element, number>>;      // offensive, by attack element
  resistBp: Partial<Record<Element, number>>;       // defensive, by incoming element
  hpRegenFlat: number; mpRegenFlat: number;
}

function invalid(field: string, message: string): never {
  throw new SimError('INVALID_INPUT', field, message);
}

function addTo<K extends string>(record: Partial<Record<K, number>>, key: K, value: number): void {
  record[key] = (record[key] ?? 0) + value;
}

interface Occupant { index: number; definition: ItemDefinition }

/** Checks one instance against its definition and returns the slot it occupies. */
function checkInstance(item: ItemInstance, field: string, content: Content, characterId: string): Slot {
  if (item.contentVersion !== content.version) {
    // B-29: an instance resolves only under the content it was pinned to.
    throw new SimError('WRONG_VERSION', `${field}.contentVersion`, 'item content version does not match');
  }
  const definition = content.items[item.definitionId];
  if (definition === undefined) invalid(`${field}.definitionId`, `unknown item ${item.definitionId}`);
  if (item.equipped === null) invalid(`${field}.equipped`, 'item is not equipped');
  if (item.equipped.characterId !== characterId) {
    invalid(`${field}.equipped.characterId`, 'items belong to different characters');
  }
  if (!slotAccepts(definition.slot, item.equipped.slot)) {
    invalid(`${field}.equipped.slot`, `a ${definition.slot} item cannot occupy ${item.equipped.slot}`);
  }
  if (!Number.isSafeInteger(item.itemLevel) || item.itemLevel < 1) {
    invalid(`${field}.itemLevel`, 'expected a positive integer item level');
  }
  if (item.bonuses.length !== bonusCount(item.rarity)) {
    invalid(`${field}.bonuses`, `expected ${bonusCount(item.rarity)} bonuses for ${item.rarity}`);
  }
  const tier = valueTier(item.itemLevel);
  const seen = new Set<string>();
  item.bonuses.forEach(({ bonusId, value }, index) => {
    const bonusField = `${field}.bonuses.${index}`;
    const bonus = content.bonuses[bonusId];
    if (bonus === undefined || !bonus.slots.includes(definition.slot)) {
      invalid(`${bonusField}.bonusId`, `bonus ${bonusId} is not in the ${definition.slot} pool`);
    }
    // No duplicate bonus identity on one item (layer-1 §7.1).
    if (seen.has(bonusId)) invalid(`${bonusField}.bonusId`, `duplicate bonus identity ${bonusId}`);
    seen.add(bonusId);
    const span = bonus.spans[tier - 1];
    if (span === undefined || !Number.isSafeInteger(value) || value < span.min || value > span.max) {
      invalid(`${bonusField}.value`, `value outside value tier ${tier}`);
    }
  });
  return item.equipped.slot;
}

/**
 * Resolves one character's equipped items (Part 3 §1.4): checks each instance
 * against its pinned definition, refuses illegal occupancy — one item per slot,
 * and an empty `offhand` under a two-handed weapon (owner decision 2026-09-21,
 * Part 3 §8 #1) — then stacks every bonus identity by its declared `stacking`
 * rule and folds the identity totals into the loadout fields. Throws
 * `SimError` with a field path into `items`.
 */
export function resolveLoadout(items: readonly ItemInstance[], content: Content): ResolvedLoadout {
  const occupied = new Map<Slot, Occupant>();
  const rolled: RolledBonus[] = [];
  const characterId = items[0]?.equipped?.characterId ?? '';
  items.forEach((item, index) => {
    const field = `items.${index}`;
    const slot = checkInstance(item, field, content, characterId);
    if (occupied.has(slot)) invalid(`${field}.equipped.slot`, `slot ${slot} is already occupied`);
    occupied.set(slot, { index, definition: content.items[item.definitionId]! });
    rolled.push(...item.bonuses);
  });

  const weapon = occupied.get('weapon')?.definition;
  const offhand = occupied.get('offhand');
  if (weapon?.handedness === 'two-handed' && offhand !== undefined) {
    invalid(`items.${offhand.index}.equipped.slot`, 'a two-handed weapon leaves the offhand empty');
  }

  const loadout: ResolvedLoadout = {
    weaponAtk: weapon?.weaponAtk ?? null,
    weaponMatk: weapon?.weaponMatk ?? null,
    armorDef: 0,
    armorMdef: 0,
    basicIntervalMs: weapon?.basicIntervalMs ?? null,
    basicRange: weapon?.basicRange ?? null,
    basicKind: weapon?.basicKind ?? null,
    attributeBonus: { str: 0, agi: 0, vit: 0, int: 0, dex: 0, luk: 0 },
    atkBp: 10_000, matkBp: 10_000, critBpBonus: 0, attackSpeedBp: 10_000,
    maxHpBp: 10_000, healPowerBp: 10_000,
    familyBp: {}, elementBp: {}, resistBp: {},
    hpRegenFlat: 0, mpRegenFlat: 0,
  };
  for (const { definition } of occupied.values()) {
    loadout.armorDef += definition.armorDef;
    loadout.armorMdef += definition.armorMdef;
  }

  const totals = stackBonuses(rolled, content.bonuses);
  for (const bonusId of Object.keys(totals).sort()) {
    const bonus = content.bonuses[bonusId]!;
    const total = totals[bonusId]!;
    switch (bonus.kind) {
      case 'attribute': loadout.attributeBonus[bonus.attribute!] += total; break;
      case 'atk-pct': loadout.atkBp += total; break;
      case 'matk-pct': loadout.matkBp += total; break;
      case 'family-damage': addTo(loadout.familyBp, bonus.family!, total); break;
      case 'element-damage': addTo(loadout.elementBp, bonus.element!, total); break;
      case 'element-resist': addTo(loadout.resistBp, bonus.element!, total); break;
      case 'crit': loadout.critBpBonus += total; break;
      case 'attack-speed': loadout.attackSpeedBp += total; break;
      case 'max-hp': loadout.maxHpBp += total; break;
      case 'hp-regen': loadout.hpRegenFlat += total; break;
      case 'mp-regen': loadout.mpRegenFlat += total; break;
      case 'heal-power': loadout.healPowerBp += total; break;
      default: {
        const unreachable: never = bonus.kind;
        throw new SimError('INVALID_CONTENT', `bonuses.${bonusId}.kind`, `no composition for ${String(unreachable)}`);
      }
    }
  }
  return loadout;
}

function addAttributes(a: Attributes, b: Attributes): Attributes {
  return {
    str: a.str + b.str, agi: a.agi + b.agi, vit: a.vit + b.vit,
    int: a.int + b.int, dex: a.dex + b.dex, luk: a.luk + b.luk,
  };
}

/**
 * A character's derived stats under a loadout (Part 3 §1.4). Composes a
 * synthetic class definition and delegates to the existing {@link derive}, so
 * every stat formula has one implementation; the percentage factors `derive`
 * has no input for are then applied as one floored basis-point step each.
 * The class bases come from `content`, an optional addition to the Part 3
 * §1.4 signature (ruling R122): a loadout names no class, and a hunt or
 * checkpoint pinned to an older `contentVersion` must derive from that
 * content, never from whatever is deployed (B-29). It defaults to the bundled
 * content for callers that hold no pinned content.
 */
export function deriveCharacter(input: {
  classId: ClassId; level: number; allocated: Attributes; loadout: ResolvedLoadout;
  content?: Content;
}): DerivedStats {
  const { classId, level, allocated, loadout } = input;
  const definition = (input.content ?? bundledContent).classes[classId];
  const base = derive({ ...definition, level,
    attributes: addAttributes(allocated, loadout.attributeBonus),
    weaponAtk: loadout.weaponAtk ?? definition.weaponAtk,
    weaponMatk: loadout.weaponMatk ?? definition.weaponMatk,
    armorDef: definition.armorDef + loadout.armorDef,
    armorMdef: definition.armorMdef + loadout.armorMdef,
    basicIntervalMs: loadout.basicIntervalMs ?? definition.basicIntervalMs,
    basicRange: loadout.basicRange ?? definition.basicRange,
    basicKind: loadout.basicKind ?? definition.basicKind });
  return { ...base,
    atk: scale(base.atk, loadout.atkBp), matk: scale(base.matk, loadout.matkBp),
    maxHp: scale(base.maxHp, loadout.maxHpBp),
    critBp: Math.min(10_000, base.critBp + loadout.critBpBonus),
    intervalMs: Math.max(300, Math.ceil((base.intervalMs * 10_000) / loadout.attackSpeedBp)) };
}

/**
 * The attacker's `offenseBonusBp` for one hit (Part 3 §1.4): its family-damage
 * bonus against the defender's family plus its element-damage bonus for the
 * attack element, added into one factor (ruling R124).
 */
export function offenseBonusFor(loadout: ResolvedLoadout, family: Family, element: Element): number {
  return 10_000 + (loadout.familyBp[family] ?? 0) + (loadout.elementBp[element] ?? 0);
}

/**
 * The defender's `resistBp` against an incoming element (Part 3 §1.4): its
 * resistance subtracted from 10,000, never below zero (ruling R124).
 */
export function resistFor(loadout: ResolvedLoadout, element: Element): number {
  return Math.max(0, 10_000 - (loadout.resistBp[element] ?? 0));
}
