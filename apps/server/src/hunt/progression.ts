/**
 * What a settlement writes besides its rewards (part 3 §5.2, §6; rulings R146,
 * R148), inside the same transaction as the checkpoint and the rewards (P-27):
 *
 * - **Progression.** The engine's checkpointed progression — level, EXP,
 *   carry, awarded levels, points, auto-spent attributes — and each party
 *   actor's absolute HP and MP, copied onto the characters rows. The engine is
 *   the only author: nothing here computes a level or spends a point.
 * - **The onboarding grant**, attempted at every settlement whose committed
 *   hunt has won an encounter until the account holds it. It reads the
 *   committed state and writes nothing back into it, so the engine runs
 *   byte-identically with or without it (no draw, no `rewardSeq`, no pity).
 *
 * A laboratory hunt (`progression === null`) has neither.
 */
import { and, eq } from 'drizzle-orm';
import type { Content } from '@narok/data';
import { ONBOARDING_GRANT_KEY } from '@narok/progression';
import type { SimState } from '@narok/sim';
import { settledColumns } from '../db/repositories/characters';
import * as schema from '../db/schema';
import type { Tx } from '../db/tx';
import { grantOnboardingOnce } from '../town/grants';

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

  // Ruling R146: the trigger is the account's first won encounter, read from
  // the committed hunt's own win count, and the item is the class of the
  // party's first character (p0) — the one fixed item per class (spec §4.0).
  // A full bag defers it to the next settlement that sees a win.
  if (state.metrics.wins === 0) return;
  const [held] = await tx
    .select({ id: schema.accountGrants.id })
    .from(schema.accountGrants)
    .where(and(eq(schema.accountGrants.accountId, accountId), eq(schema.accountGrants.grantKey, ONBOARDING_GRANT_KEY)));
  if (held !== undefined) return;
  await grantOnboardingOnce(tx, content, accountId, state.input.classes[0]!, stateVersionAfter);
}
