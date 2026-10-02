/**
 * What a settlement writes besides its rewards (part 3 §5.2, §6; rulings R146,
 * R148), inside the same transaction as the checkpoint and the rewards (P-27):
 *
 * - **Progression.** The engine's checkpointed progression — level, EXP,
 *   carry, awarded levels, points, auto-spent attributes — and each party
 *   actor's absolute HP and MP, copied onto the characters rows. The engine is
 *   the only author: nothing here computes a level or spends a point.
 * - **The first-win marker and the onboarding grant** (ruling R150): the
 *   first won encounter is recorded durably when settled, and the grant is
 *   attempted at each return to town until the account holds it. Both read
 *   the committed state and write nothing back into it, so the engine runs
 *   byte-identically with or without them (no draw, no `rewardSeq`, no pity).
 *
 * A laboratory hunt (`progression === null`) has neither.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Content } from '@narok/data';
import { ONBOARDING_GRANT_KEY } from '@narok/progression';
import { characterMaxima, type SimState } from '@narok/sim';
import { settledColumns, toCharacter } from '../db/repositories/characters';
import { toInstance } from '../db/repositories/inventory';
import { grantOnce } from '../db/repositories/grants';
import * as schema from '../db/schema';
import type { Tx } from '../db/tx';
import { grantOnboardingOnce } from '../town/grants';

/** The durable first-win marker's key in `account_grants` (ruling R150). */
export const FIRST_WIN_MARKER = 'onboarding:first-win:v1';

export async function commitProgression(
  tx: Tx,
  content: Content,
  accountId: string,
  state: SimState,
  stateVersionAfter: number,
): Promise<void> {
  if (state.progression === null) return;

  for (const [rosterId, character] of Object.entries(state.progression)) {
    const actor = state.actors[rosterId]!;
    await tx
      .update(schema.characters)
      .set(settledColumns(character, { hp: actor.hp, mp: actor.mp }))
      .where(and(eq(schema.characters.id, character.characterId), eq(schema.characters.accountId, accountId)));
  }

  // Ruling R150 (supersedes R146's trigger; controller ruling, Task 7b fix
  // round 1). The account's first won encounter is made durable here, in the
  // transaction that settles it, as an `account_grants` marker row: it records
  // a fact, grants nothing, and is idempotent by the same unique key.
  const ledger = await tx
    .select({ grantKey: schema.accountGrants.grantKey })
    .from(schema.accountGrants)
    .where(and(
      eq(schema.accountGrants.accountId, accountId),
      inArray(schema.accountGrants.grantKey, [FIRST_WIN_MARKER, ONBOARDING_GRANT_KEY]),
    ));
  const held = new Set(ledger.map((row) => row.grantKey));
  if (!held.has(FIRST_WIN_MARKER) && state.metrics.wins > 0) {
    await grantOnce(tx, { accountId, grantKey: FIRST_WIN_MARKER, kind: 'marker', payload: {}, grantedBy: 'system' });
    held.add(FIRST_WIN_MARKER);
  }

  // The grant itself is attempted only at the return to town — the settlement
  // that stops the hunt, by the player or by the engine — never mid-hunt, so
  // the bag a running hunt's engine was given never falls out of step with the
  // server's. Every return retries it while the account has won once and does
  // not hold it, whether or not that hunt won; a full bag defers it to the next
  // return. The item is the class of the party's first character (p0).
  if (state.phase !== 'stopped' || !held.has(FIRST_WIN_MARKER) || held.has(ONBOARDING_GRANT_KEY)) return;
  await grantOnboardingOnce(tx, content, accountId, state.input.classes[0]!, stateVersionAfter);
}

/**
 * A return to town the engine did not make — the explicit recovery of a
 * faulted hunt (P-38) — heals as every engine return does (rulings R149,
 * R155; owner rule "every return to town fully heals the whole party"). Each
 * named character is set to the maxima the one derivation gives its own row
 * and the items it wears — the derivation character creation and the town
 * rules use (`characterMaxima`) — read from the rows, never from a checkpoint
 * that may not decode. Rows of another account are left alone (P-12).
 */
export async function healToMaxima(tx: Tx, content: Content, accountId: string, characterIds: readonly string[]): Promise<void> {
  if (characterIds.length === 0) return;
  const rows = await tx
    .select()
    .from(schema.characters)
    .where(and(eq(schema.characters.accountId, accountId), inArray(schema.characters.id, [...characterIds])));
  const worn = await tx
    .select()
    .from(schema.items)
    .where(and(eq(schema.items.accountId, accountId), inArray(schema.items.equippedCharacterId, [...characterIds])));
  const maxima = characterMaxima(content);
  for (const row of rows) {
    const full = maxima(toCharacter(row), worn.filter((item) => item.equippedCharacterId === row.id).map(toInstance));
    await tx
      .update(schema.characters)
      .set({ hp: full.maxHp, mp: full.maxMp, dead: false })
      .where(and(eq(schema.characters.id, row.id), eq(schema.characters.accountId, accountId)));
  }
}
