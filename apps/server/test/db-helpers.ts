/**
 * The live-database harness. Every suite that touches PostgreSQL goes through
 * here, so the connection string, the truncation between cases and the skip
 * behaviour are decided once.
 *
 * If no database is reachable these suites **skip loudly** rather than pass
 * quietly: a concurrency guarantee that silently did not run is worse than one
 * that visibly did not, because only the first kind gets believed.
 */
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema';

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://narok:narok@127.0.0.1:5433/narok';

export type Db = PostgresJsDatabase<typeof schema>;

/**
 * These suites truncate every table they touch, so they refuse to run against
 * a database that is not plainly a test one (final review, controller ruling):
 * the default URL names the dev database `narok`, which holds the owner's own
 * data. A database whose name ends in `_test` or `_e2e` is always allowed; any
 * other only under CI (the GitHub service container is disposable) or with the
 * explicit opt-in `NAROK_DB_TESTS_TRUNCATE=<database name>`.
 */
export function assertDisposableDatabase(url: string = DATABASE_URL, env: NodeJS.ProcessEnv = process.env): void {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (/_(test|e2e)$/.test(name)) return;
  if (env.CI !== undefined && env.CI !== '' && env.CI !== 'false') return;
  if (env.NAROK_DB_TESTS_TRUNCATE === name) return;
  throw new Error(
    `refusing to run the db suites against database "${name}": they truncate every table. ` +
      'Point DATABASE_URL at a database named *_test or *_e2e (for example narok_e2e), ' +
      `or opt in with NAROK_DB_TESTS_TRUNCATE=${name}.`,
  );
}

let client: postgres.Sql | undefined;
let db: Db | undefined;

export async function connect(): Promise<Db> {
  if (db !== undefined) return db;
  assertDisposableDatabase();
  client = postgres(DATABASE_URL, { max: 8, onnotice: () => {} });
  db = drizzle(client, { schema });
  return db;
}

export async function disconnect(): Promise<void> {
  await client?.end({ timeout: 5 });
  client = undefined;
  db = undefined;
}

/** True when a database answered. Used to fail a suite honestly, not to skip it. */
export async function databaseReachable(): Promise<boolean> {
  // Outside the try: a refused database is a loud error, never "unreachable".
  assertDisposableDatabase();
  try {
    const database = await connect();
    await database.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

/** Every table that holds per-test state, children first. */
const TABLES = [
  'resource_audit',
  'command_results',
  'hunt_reports',
  'hunt_checkpoint_archive',
  'account_drop_protection',
  'account_grants',
  'hunts',
  'items',
  'stack_items',
  'strategy_presets',
  'loot_presets',
  'characters',
  'sessions',
  'accounts',
  'maintenance',
  'periodic_jobs',
] as const;

export async function truncateAll(database: Db): Promise<void> {
  assertDisposableDatabase();
  await database.execute(sql.raw(`truncate table ${TABLES.join(', ')} restart identity cascade`));
}

/** A minimal account row; callers override what their assertion is about. */
export async function insertAccount(
  database: Db,
  overrides: Partial<typeof schema.accounts.$inferInsert> = {},
): Promise<typeof schema.accounts.$inferSelect> {
  const [row] = await database
    .insert(schema.accounts)
    .values({
      email: overrides.email ?? `player-${crypto.randomUUID()}@example.com`,
      passwordHash: 'hash',
      passwordAlgorithm: 'test',
      passwordChangedAt: Date.now(),
      bagCapacity: 100,
      ...overrides,
    })
    .returning();
  return row;
}

export async function insertCharacter(
  database: Db,
  accountId: string,
  overrides: Partial<typeof schema.characters.$inferInsert> = {},
): Promise<typeof schema.characters.$inferSelect> {
  const [row] = await database
    .insert(schema.characters)
    .values({
      accountId,
      slot: 0,
      name: `Name${Math.floor(Math.random() * 1e9)}`,
      nameKey: `namekey${Math.floor(Math.random() * 1e9)}`,
      classId: 'guardian',
      // A level-1 character as creation leaves it (layer-1 §5.3, §5.4), so a
      // hunt can start from it without a fixture of its own.
      attributes: { str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 },
      skills: {},
      unspentStatPoints: 30,
      unspentSkillPoints: 1,
      hp: 100,
      mp: 50,
      ...overrides,
    })
    .returning();
  return row;
}

export async function insertItem(
  database: Db,
  accountId: string,
  overrides: Partial<typeof schema.items.$inferInsert> = {},
): Promise<typeof schema.items.$inferSelect> {
  const [row] = await database
    .insert(schema.items)
    .values({
      accountId,
      baseItemId: 'iron-sword',
      baseContentVersion: 'test',
      rarity: 'common',
      itemLevel: 1,
      bonuses: [],
      ...overrides,
    })
    .returning();
  return row;
}

/**
 * Names the constraint a rejected write violated.
 *
 * Drizzle wraps a driver error and puts the *query text* in `message`, so
 * asserting on that proves only that something failed. The identity of the
 * constraint lives on the postgres.js error underneath, as `constraint_name`,
 * and that is the thing a test about a named constraint has to read.
 */
export async function expectViolation(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const parts: string[] = [];
    let current: unknown = error;
    for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
      const record = current as { message?: string; constraint_name?: string; detail?: string; cause?: unknown };
      if (record.constraint_name !== undefined) parts.push(record.constraint_name);
      if (record.detail !== undefined) parts.push(record.detail);
      if (record.message !== undefined) parts.push(record.message);
      current = record.cause;
    }
    return parts.join(' | ');
  }
  throw new Error('expected a constraint violation, but the write succeeded');
}
