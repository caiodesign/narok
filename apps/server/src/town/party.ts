/**
 * The party a hunt starts from (part 3 §5; rulings R140, R148): each named
 * character's progression and the items it wears, read from the account's own
 * rows and handed to the engine as `HuntSetup.party`. The engine derives every
 * stat from them under the content the hunt is pinned to — the server derives
 * nothing and never falls back to bundled content.
 */
import type { ClassId } from '@narok/data';
import { cloneProgress } from '@narok/progression';
import type { HuntPartyMember } from '@narok/sim';
import { and, eq, inArray } from 'drizzle-orm';
import { toCharacter } from '../db/repositories/characters';
import { toInstance } from '../db/repositories/inventory';
import * as schema from '../db/schema';
import type { Database } from '../db/tx';
import { notOwned } from '../errors';

export interface LoadedParty {
  /** In the order named: the first character is `p0`. */
  readonly classes: ClassId[];
  readonly party: Record<string, HuntPartyMember>;
}

/** Absent and not-yours answer identically, as `NOT_OWNED` on `characterIds` (P-12). */
export async function loadParty(db: Database, accountId: string, characterIds: readonly string[]): Promise<LoadedParty> {
  const rows = await db
    .select()
    .from(schema.characters)
    .where(and(eq(schema.characters.accountId, accountId), inArray(schema.characters.id, [...characterIds])));
  if (rows.length !== new Set(characterIds).size || rows.length !== characterIds.length) throw notOwned('characterIds');
  const worn = await db
    .select()
    .from(schema.items)
    .where(and(eq(schema.items.accountId, accountId), inArray(schema.items.equippedCharacterId, [...characterIds])));

  const byId = new Map(rows.map((row) => [row.id, row]));
  const classes: ClassId[] = [];
  const party: Record<string, HuntPartyMember> = {};
  characterIds.forEach((id, index) => {
    const { id: characterId, classId, hp, mp, ...progress } = toCharacter(byId.get(id)!);
    classes.push(classId);
    party[`p${index}`] = {
      characterId,
      progress: cloneProgress(progress),
      equipped: worn.filter((row) => row.equippedCharacterId === id).map(toInstance),
      hp,
      mp,
    };
  });
  return { classes, party };
}
