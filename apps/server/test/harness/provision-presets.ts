/**
 * Provisions one strategy preset and one loot preset for an account, by email,
 * for the Task 11 end-to-end specs and drills (ruling R197).
 *
 * Milestone B has no route that *creates* a preset: `PUT /api/presets/:id`
 * edits an owned one and answers `NOT_OWNED` for an absent id
 * (`routes/hunts.ts`), and account onboarding is Phase C (layer-1 §2's phase
 * table). So a freshly registered account cannot start a hunt from the
 * product, and every harness that needs one seeds the rows directly — exactly
 * as the server's own route suites do (`client-reads.db.test.ts`,
 * `hunt-db-harness.ts`). This file is that seeding, made runnable from
 * outside vitest; it is test tooling, never imported by `src/`.
 *
 * The payloads are the engine's own defaults for the account's party in slot
 * order (`defaultPlacement`, `defaultStrategy`) and the starter loot filter
 * (`starterLoot`); nothing here invents a rule, a threshold or a price.
 *
 * Usage: DATABASE_URL=... node --import tsx apps/server/test/harness/provision-presets.ts <email> [<email> ...]
 * Prints one JSON line per account: `{ email, strategyPresetId, lootPresetId }`.
 */
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { content, validateContent, type ClassId } from '@narok/data';
import { defaultPlacement, defaultStrategy, starterLoot } from '@narok/sim';
import * as schema from '../../src/db/schema';

const validated = validateContent(content);

function strategyPayload(classes: readonly ClassId[]) {
  return {
    placement: defaultPlacement([...classes]),
    strategies: Object.fromEntries(classes.map((classId, index) => [`p${index}`, defaultStrategy(classId)])),
    rest: { hpStart: 50, mpStart: 30 },
  };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') throw new Error('DATABASE_URL is required');
  const emails = process.argv.slice(2);
  if (emails.length === 0) throw new Error('usage: provision-presets.ts <email> [<email> ...]');

  const client = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(client, { schema });
  try {
    for (const email of emails) {
      const [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.email, email.toLowerCase()));
      if (account === undefined) throw new Error(`no account ${email}`);
      const characters = await db
        .select()
        .from(schema.characters)
        .where(eq(schema.characters.accountId, account.id))
        .orderBy(asc(schema.characters.slot));
      if (characters.length === 0) throw new Error(`account ${email} has no characters`);
      const classes = characters.map((row) => row.classId as ClassId);
      const [strategy] = await db
        .insert(schema.strategyPresets)
        .values({
          accountId: account.id,
          name: 'Main',
          payload: strategyPayload(classes),
          payloadSchemaVersion: 1,
          gridHash: validated.gridHash,
        })
        .returning();
      const [loot] = await db
        .insert(schema.lootPresets)
        .values({ accountId: account.id, name: 'Starter', payload: starterLoot(), payloadSchemaVersion: 1 })
        .returning();
      console.log(JSON.stringify({ email, strategyPresetId: strategy.id, lootPresetId: loot.id }));
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

await main();
