import { RARITY_RULES } from '@narok/data';
import type { ClassId, Content, ItemInstance, StarterWeapon } from '@narok/data';
import { bagPlace, bagPlaceConsumable } from './bag';
import type { Bag } from './types';

/**
 * One-time grants (Part 3 §6, §8 #10, #11; spec §4.0, §4.1; ruling R141):
 * fixed content placed in the bag under an idempotency key, with no PRNG
 * anywhere on the path — nothing here reads or advances a hunt's `rng`,
 * `rewardSeq` or pity counters, and the instance's `source` is its grant key,
 * so it is no drop and no drop metric counts it. The caller supplies the new
 * instance id and the account's grant ledger, and persists the result in one
 * transaction with its `account_grants` row.
 */

/** Part 3 §6: the onboarding grant's key within the account. */
export const ONBOARDING_GRANT_KEY = 'onboarding:first-equipment:v1';

/** Part 3 §8 #10: the starter kit is keyed per character slot, so recreating a slot grants nothing. */
export function starterKitKey(characterSlot: number): string {
  if (!Number.isSafeInteger(characterSlot) || characterSlot < 0) throw new RangeError('expected a character slot index');
  return `starter-kit:${characterSlot}`;
}

/** The account's grant ledger: each grant key already written, with the instance ids it created. */
export type GrantLedger = Readonly<Record<string, readonly string[]>>;

/**
 * `granted` placed the grant; `existing` found its key and returns the first
 * instance it created; `deferred` could not fit it in the bag and placed
 * nothing — a grant is not a drop, so the bag-full loss rule (Part 3 §3.4)
 * does not reach it, and the caller attempts it again at the next settlement.
 */
export interface GrantOutcome { outcome: 'granted' | 'existing' | 'deferred'; bag: Bag; itemId: string | null }

function fixedInstance(
  bag: Bag,
  itemId: string,
  fixed: StarterWeapon,
  grantId: string,
  boundTo: string | null,
  content: Content,
): ItemInstance {
  return {
    id: itemId,
    accountId: bag.accountId,
    definitionId: fixed.definitionId,
    contentVersion: content.version,
    rarity: fixed.rarity,
    itemLevel: fixed.itemLevel,
    bonuses: fixed.bonuses.map((bonus) => ({ ...bonus })),
    tradeable: false,
    locked: false,
    protected: RARITY_RULES[fixed.rarity].protected,
    equipped: null,
    boundTo,
    source: { grantId },
  };
}

/**
 * The first-equipment grant (owner decision 2026-09-21; Part 3 §6, §8 #11):
 * `content.onboardingGrant[classId]` — one fixed Uncommon at item level 1 with
 * one fixed bonus, identical for every account of the class — attempted at the
 * first settlement after the account's first won encounter.
 */
export function grantOnboarding(
  bag: Bag,
  ledger: GrantLedger,
  classId: ClassId,
  itemId: string,
  content: Content,
): GrantOutcome {
  const existing = ledger[ONBOARDING_GRANT_KEY];
  if (existing !== undefined) return { outcome: 'existing', bag, itemId: existing[0] ?? null };
  const instance = fixedInstance(bag, itemId, content.onboardingGrant[classId], ONBOARDING_GRANT_KEY, null, content);
  const placed = bagPlace(bag, instance);
  if (!placed.ok) return { outcome: 'deferred', bag, itemId: null };
  return { outcome: 'granted', bag: placed.next, itemId };
}

/**
 * The starter kit (layer-1 §7.6; Part 3 §8 #10, the spec §4.1 recommendation):
 * `content.starterKit.potions` with the first character slot (index 0) only,
 * and per slot one class weapon bound to the character it was made for, so
 * neither half can be cycled through character re-creation for value. All or
 * nothing: a bag that cannot hold the whole kit defers it.
 */
export function grantStarterKit(
  bag: Bag,
  ledger: GrantLedger,
  grant: { characterId: string; characterSlot: number; classId: ClassId; itemId: string },
  content: Content,
): GrantOutcome {
  const key = starterKitKey(grant.characterSlot);
  const existing = ledger[key];
  if (existing !== undefined) return { outcome: 'existing', bag, itemId: existing[0] ?? null };
  const weapon = fixedInstance(bag, grant.itemId, content.starterKit.weapons[grant.classId], key, grant.characterId, content);
  const placed = bagPlace(bag, weapon);
  if (!placed.ok) return { outcome: 'deferred', bag, itemId: null };
  let next = placed.next;
  if (grant.characterSlot === 0) {
    for (const potion of content.starterKit.potions) {
      const stocked = bagPlaceConsumable(next, potion.consumableId, potion.quantity, content);
      if (!stocked.ok) return { outcome: 'deferred', bag, itemId: null };
      next = stocked.next;
    }
  }
  return { outcome: 'granted', bag: next, itemId: grant.itemId };
}
