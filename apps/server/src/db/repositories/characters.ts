/**
 * Characters rows ↔ `@narok/progression`'s `Character` (ruling R148).
 *
 * The column names are part 1 §5's; the field names are the progression
 * model's, which the simulation checkpoints. This is the one place the two are
 * mapped, so a hunt starts from exactly what the town commands wrote and a
 * settlement writes back exactly what the engine computed.
 */
import { and, eq } from 'drizzle-orm';
import type { Attributes, ClassId, SkillId } from '@narok/data';
import type { AutoSpendTemplate, Character, Progress } from '@narok/progression';
import type { Database, Tx } from '../tx';
import * as schema from '../schema';

export type CharacterRow = typeof schema.characters.$inferSelect;

export function toCharacter(row: CharacterRow): Character {
  return {
    id: row.id,
    classId: row.classId as ClassId,
    level: row.level,
    exp: row.exp,
    expCarry: row.expCarry,
    attributes: { ...(row.attributes as Attributes) },
    statPoints: row.unspentStatPoints,
    skillPoints: row.unspentSkillPoints,
    skillRanks: { ...(row.skills as Partial<Record<SkillId, number>>) },
    awardedLevels: row.awardedLevel,
    autoSpendTemplate: (row.autoSpend as AutoSpendTemplate | null) ?? null,
    hp: row.hp,
    mp: row.mp,
  };
}

/** The progression columns a town command or a settlement writes. */
export function progressionColumns(progress: Progress & { readonly hp: number; readonly mp: number }) {
  return {
    level: progress.level,
    exp: progress.exp,
    expCarry: progress.expCarry,
    awardedLevel: progress.awardedLevels,
    unspentStatPoints: progress.statPoints,
    unspentSkillPoints: progress.skillPoints,
    attributes: progress.attributes,
    skills: progress.skillRanks,
    autoSpend: progress.autoSpendTemplate,
    hp: progress.hp,
    mp: progress.mp,
    dead: progress.hp === 0,
  };
}

/**
 * What a hunt changes and a settlement writes back (ruling R148): level, EXP,
 * carry, awarded levels, points, auto-spent attributes and the absolute
 * resources. Skill ranks and the auto-spend template are town edits the hunt
 * only reads, so a settlement never writes them.
 */
export function settledColumns(progress: Progress, resources: { readonly hp: number; readonly mp: number }) {
  const columns: Partial<ReturnType<typeof progressionColumns>> = progressionColumns({ ...progress, ...resources });
  delete columns.skills;
  delete columns.autoSpend;
  return columns;
}

/** The account's character, or `undefined` for one that is absent or another account's (P-12). */
export async function ownedCharacter(db: Database | Tx, accountId: string, id: string): Promise<CharacterRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.characters)
    .where(and(eq(schema.characters.id, id), eq(schema.characters.accountId, accountId)));
  return row;
}

export async function writeCharacter(tx: Tx, accountId: string, character: Character): Promise<void> {
  await tx
    .update(schema.characters)
    .set(progressionColumns(character))
    .where(and(eq(schema.characters.id, character.id), eq(schema.characters.accountId, accountId)));
}
