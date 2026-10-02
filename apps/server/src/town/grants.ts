/**
 * The one-time grants, over the database (part 3 §4, §6; spec §4.0, §4.1;
 * rulings R141, R146).
 *
 * `@narok/progression` decides what a grant places; this file commits it, in
 * the caller's transaction, with its `account_grants` row and its
 * `resource_audit` row — so an item exists only together with the key that
 * makes it idempotent and the audit that accounts for it (layer-1 §8.2). No
 * PRNG, no `rewardSeq`, no pity counter is read or written: a grant is not a
 * drop, its audit reason is `grant` rather than any `drop-*`, and no drop
 * metric counts it.
 *
 * Only `deferred` — a full bag — is a normal outcome besides `granted` and
 * `existing`. Any other placement failure is a fault in the caller and
 * surfaces as one, never as a deferral retried at every settlement.
 */
import type { ClassId, Content } from '@narok/data';
import { grantOnboarding, grantStarterKit, starterKitKey, ONBOARDING_GRANT_KEY, type GrantOutcome } from '@narok/progression';
import { grantOnce } from '../db/repositories/grants';
import { loadBag, loadLedger, persistBag } from '../db/repositories/inventory';
import * as schema from '../db/schema';
import type { Tx } from '../db/tx';

export interface GrantResult {
  readonly outcome: 'granted' | 'existing' | 'deferred';
  /** The instance granted, or the one an earlier grant created; `null` when deferred. */
  readonly itemId: string | null;
}

async function commit(
  tx: Tx,
  content: Content,
  accountId: string,
  grantKey: string,
  kind: string,
  stateVersionAfter: number,
  decide: (bag: Awaited<ReturnType<typeof loadBag>>, ledger: Awaited<ReturnType<typeof loadLedger>>) => GrantOutcome,
): Promise<GrantResult> {
  const before = await loadBag(tx, accountId);
  const decided = decide(before, await loadLedger(tx, accountId));
  if (decided.outcome === 'refused') {
    throw new Error(`grant ${grantKey} refused: ${decided.failure.code}:${decided.failure.field}`);
  }
  if (decided.outcome !== 'granted') return { outcome: decided.outcome, itemId: decided.itemId };

  const itemId = decided.itemId!;
  const { granted } = await grantOnce(tx, { accountId, grantKey, kind, payload: { itemIds: [itemId] }, grantedBy: 'system' });
  // The ledger was read under the account lock, so a racing writer cannot have
  // inserted the key since; refusing here keeps the item and its key one fact.
  if (!granted) throw new Error(`grant ${grantKey} was written concurrently`);
  await persistBag(tx, before, decided.bag, content);

  const item = decided.bag.items.find((entry) => entry.id === itemId)!;
  const consumables: Record<string, number> = {};
  for (const [id, total] of Object.entries(decided.bag.consumables)) {
    const added = total - (before.consumables[id] ?? 0);
    if (added > 0) consumables[id] = added;
  }
  await tx.insert(schema.resourceAudit).values({
    accountId,
    reason: 'grant',
    sourceRef: grantKey,
    delta: {
      item: { definitionId: item.definitionId, rarity: item.rarity, itemLevel: item.itemLevel, bonuses: item.bonuses, itemId },
      consumables,
      gold: 0,
    },
    stateVersionAfter,
  });
  return { outcome: 'granted', itemId };
}

/**
 * The starter kit of one character slot (part 3 §8 #10): the class weapon,
 * bound to the character it was made for, and the first slot's potions. Keyed
 * per slot, so re-creating a slot grants nothing.
 */
export function grantStarterKitOnce(
  tx: Tx,
  content: Content,
  spec: { readonly accountId: string; readonly characterId: string; readonly characterSlot: number; readonly classId: ClassId },
  stateVersionAfter: number,
): Promise<GrantResult> {
  const itemId = crypto.randomUUID();
  return commit(tx, content, spec.accountId, starterKitKey(spec.characterSlot), 'starter-kit', stateVersionAfter, (bag, ledger) =>
    grantStarterKit(bag, ledger, { characterId: spec.characterId, characterSlot: spec.characterSlot, classId: spec.classId, itemId }, content));
}

/**
 * The first-equipment grant (owner decision 2026-09-21; part 3 §6): the fixed
 * Uncommon of `classId`, once per account, under `onboarding:first-equipment:v1`.
 */
export function grantOnboardingOnce(
  tx: Tx,
  content: Content,
  accountId: string,
  classId: ClassId,
  stateVersionAfter: number,
): Promise<GrantResult> {
  const itemId = crypto.randomUUID();
  return commit(tx, content, accountId, ONBOARDING_GRANT_KEY, 'onboarding', stateVersionAfter, (bag, ledger) =>
    grantOnboarding(bag, ledger, classId, itemId, content));
}
