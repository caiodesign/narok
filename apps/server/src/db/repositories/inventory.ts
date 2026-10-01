/**
 * The account bag as `@narok/progression` sees it (part 3 §3.1; rulings R137,
 * R145): every owned equipment instance — equipped or not — and the total held
 * of each consumable. Loaded inside a command's transaction, handed to a pure
 * rule, and the rule's result written back as the difference.
 *
 * Slots are never counted here: `usedSlots` and `bagState` in
 * `@narok/progression` are the one count, `ceil(total / 999)` per consumable,
 * which is also what the engine assumes.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Content, ItemInstance, Rarity, RolledBonus, Slot } from '@narok/data';
import type { Bag, GrantLedger } from '@narok/progression';
import type { Database, Tx } from '../tx';
import * as schema from '../schema';

type ItemRow = typeof schema.items.$inferSelect;

/** `"<huntId>:<rewardSeq>"` (part 2 §2), the reward id a dropped item's `source_ref` holds; a hunt id is a UUID. */
const REWARD_REF = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d+)$/;

/** A row as the instance the rules and the engine read. */
export function toInstance(row: ItemRow): ItemInstance {
  const ref = row.sourceRef ?? '';
  const reward = REWARD_REF.exec(ref);
  return {
    id: row.id,
    accountId: row.accountId,
    definitionId: row.baseItemId,
    contentVersion: row.baseContentVersion,
    rarity: row.rarity as Rarity,
    itemLevel: row.itemLevel,
    bonuses: (row.bonuses as RolledBonus[]).map((bonus) => ({ ...bonus })),
    tradeable: false,
    locked: row.locked,
    protected: row.protected,
    equipped: row.equippedCharacterId === null
      ? null
      : { characterId: row.equippedCharacterId, slot: row.equippedSlot as Slot },
    boundTo: row.boundTo,
    // Anything that is not a reward id is a grant key (`starter-kit:0`, `onboarding:…`).
    source: reward === null ? { grantId: ref } : { huntId: reward[1]!, rewardSeq: Number(reward[2]) },
  };
}

export async function loadBag(db: Database | Tx, accountId: string): Promise<Bag> {
  const [account] = await db
    .select({ bagCapacity: schema.accounts.bagCapacity })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId));
  const rows = await db.select().from(schema.items).where(eq(schema.items.accountId, accountId)).orderBy(schema.items.createdAt, schema.items.id);
  const stacks = await db
    .select({ definitionId: schema.stackItems.definitionId, quantity: schema.stackItems.quantity })
    .from(schema.stackItems)
    .where(eq(schema.stackItems.accountId, accountId));
  const consumables: Record<string, number> = {};
  for (const stack of stacks) if (stack.quantity > 0) consumables[stack.definitionId] = stack.quantity;
  return { accountId, capacity: account?.bagCapacity ?? 0, items: rows.map(toInstance), consumables };
}

/** The items one character wears, from a loaded bag. */
export function wornBy(bag: Bag, characterId: string): ItemInstance[] {
  return bag.items.filter((item) => item.equipped?.characterId === characterId);
}

/** `source_ref` for a new instance: its grant key, or its reward id. */
function sourceRef(item: ItemInstance): string {
  return 'grantId' in item.source ? item.source.grantId : `${item.source.huntId}:${item.source.rewardSeq}`;
}

/**
 * Writes `after` over `before`: new instances inserted, changed equip and lock
 * state updated, consumable totals set. Every slot a change frees is written
 * before any slot it fills, so a swap or a two-handed equip never trips the
 * one-item-per-slot indexes mid-statement.
 */
export async function persistBag(tx: Tx, before: Bag, after: Bag, content: Content): Promise<void> {
  const previous = new Map(before.items.map((item) => [item.id, item]));
  const freed: string[] = [];
  const filled: ItemInstance[] = [];
  const locks: ItemInstance[] = [];
  for (const item of after.items) {
    const was = previous.get(item.id);
    if (was === undefined) {
      await tx.insert(schema.items).values({
        id: item.id,
        accountId: item.accountId,
        baseItemId: item.definitionId,
        baseContentVersion: item.contentVersion,
        rarity: item.rarity,
        itemLevel: item.itemLevel,
        bonuses: item.bonuses,
        locked: item.locked,
        protected: item.protected,
        sourceRef: sourceRef(item),
        twoHanded: content.items[item.definitionId]?.handedness === 'two-handed',
        boundTo: item.boundTo,
        equippedCharacterId: item.equipped?.characterId ?? null,
        equippedSlot: item.equipped?.slot ?? null,
      });
      continue;
    }
    const moved = was.equipped?.characterId !== item.equipped?.characterId || was.equipped?.slot !== item.equipped?.slot;
    if (moved && was.equipped !== null) freed.push(item.id);
    if (moved && item.equipped !== null) filled.push(item);
    if (was.locked !== item.locked) locks.push(item);
  }

  if (freed.length > 0) {
    await tx
      .update(schema.items)
      .set({ equippedCharacterId: null, equippedSlot: null })
      .where(and(eq(schema.items.accountId, after.accountId), inArray(schema.items.id, freed)));
  }
  for (const item of filled) {
    await tx
      .update(schema.items)
      .set({ equippedCharacterId: item.equipped!.characterId, equippedSlot: item.equipped!.slot })
      .where(and(eq(schema.items.accountId, after.accountId), eq(schema.items.id, item.id)));
  }
  for (const item of locks) {
    await tx
      .update(schema.items)
      .set({ locked: item.locked })
      .where(and(eq(schema.items.accountId, after.accountId), eq(schema.items.id, item.id)));
  }

  const ids = new Set([...Object.keys(before.consumables), ...Object.keys(after.consumables)]);
  for (const consumableId of ids) {
    const quantity = after.consumables[consumableId] ?? 0;
    if (quantity === (before.consumables[consumableId] ?? 0)) continue;
    await tx
      .insert(schema.stackItems)
      .values({ accountId: after.accountId, definitionId: consumableId, quantity })
      .onConflictDoUpdate({ target: [schema.stackItems.accountId, schema.stackItems.definitionId], set: { quantity } });
  }
}

/** The account's grant ledger: each key written, with the instance ids its payload records. */
export async function loadLedger(db: Database | Tx, accountId: string): Promise<GrantLedger> {
  const rows = await db
    .select({ grantKey: schema.accountGrants.grantKey, payload: schema.accountGrants.payload })
    .from(schema.accountGrants)
    .where(eq(schema.accountGrants.accountId, accountId));
  const ledger: Record<string, readonly string[]> = {};
  for (const row of rows) {
    const itemIds = (row.payload as { itemIds?: unknown }).itemIds;
    ledger[row.grantKey] = Array.isArray(itemIds) ? itemIds.filter((id): id is string => typeof id === 'string') : [];
  }
  return ledger;
}
