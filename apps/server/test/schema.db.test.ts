/**
 * One assertion per constraint of milestone B spec part 1 §5. These run against
 * a real PostgreSQL, because a constraint that exists only in a Drizzle literal
 * is a constraint the database is not enforcing (layer-1 §8.2).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import {
  connect,
  databaseReachable,
  disconnect,
  expectViolation,
  insertAccount,
  insertCharacter,
  insertItem,
  truncateAll,
  type Db,
} from './db-helpers';
import * as schema from '../src/db/schema';

let db: Db;

beforeAll(async () => {
  expect(await databaseReachable(), 'PostgreSQL must be running: pnpm db:up').toBe(true);
  db = await connect();
});

afterAll(async () => {
  await disconnect();
});

beforeEach(async () => {
  await truncateAll(db);
});

describe('accounts', () => {
  test('email is unique case-insensitively, so one address is one account', async () => {
    await insertAccount(db, { email: 'player@example.com' });
    const message = await expectViolation(() => insertAccount(db, { email: 'PLAYER@Example.COM' }));
    expect(message).toContain('accounts_email_lower_idx');
  });

  test('gold and bag capacity cannot go negative', async () => {
    const account = await insertAccount(db);
    expect(await expectViolation(() =>
      db.update(schema.accounts).set({ gold: -1 }).where(eq(schema.accounts.id, account.id)),
    )).toContain('accounts_gold_nonnegative');
    expect(await expectViolation(() =>
      db.update(schema.accounts).set({ bagCapacity: -1 }).where(eq(schema.accounts.id, account.id)),
    )).toContain('accounts_bag_capacity_nonnegative');
  });

  test('state_version starts at zero and cannot go backwards past it', async () => {
    const account = await insertAccount(db);
    expect(account.stateVersion).toBe(0);
    expect(await expectViolation(() =>
      db.update(schema.accounts).set({ stateVersion: -1 }).where(eq(schema.accounts.id, account.id)),
    )).toContain('accounts_state_version_nonnegative');
  });
});

describe('characters', () => {
  test('one character per account slot', async () => {
    const account = await insertAccount(db);
    await insertCharacter(db, account.id, { slot: 0 });
    const message = await expectViolation(() => insertCharacter(db, account.id, { slot: 0 }));
    expect(message).toContain('characters_account_slot_idx');
  });

  test('slots are 0..2, matching the three-character party', async () => {
    const account = await insertAccount(db);
    expect(await expectViolation(() => insertCharacter(db, account.id, { slot: 3 }))).toContain(
      'characters_slot_range',
    );
    expect(await expectViolation(() => insertCharacter(db, account.id, { slot: -1 }))).toContain(
      'characters_slot_range',
    );
  });

  test('a name is globally unique on its folded key', async () => {
    const first = await insertAccount(db);
    const second = await insertAccount(db);
    await insertCharacter(db, first.id, { name: 'Bjorn', nameKey: 'bjorn' });
    const message = await expectViolation(() =>
      insertCharacter(db, second.id, { name: 'BJORN', nameKey: 'bjorn' }),
    );
    expect(message).toContain('characters_name_key_idx');
  });

  test('a level cannot be rewarded twice: awarded_level never exceeds level', async () => {
    const account = await insertAccount(db);
    const message = await expectViolation(() =>
      insertCharacter(db, account.id, { level: 5, awardedLevel: 6 }),
    );
    expect(message).toContain('characters_awarded_level');
  });

  test('level starts at one and cannot be zero', async () => {
    const account = await insertAccount(db);
    // `awardedLevel` is pinned to 0 too: left at its default of 1 it trips
    // `characters_awarded_level` first, and the test would pass while proving
    // nothing about the constraint it names.
    expect(await expectViolation(() =>
      insertCharacter(db, account.id, { level: 0, awardedLevel: 0 }),
    )).toContain('characters_level_positive');
  });
});

describe('items', () => {
  test('one item per equipped slot', async () => {
    const account = await insertAccount(db);
    const character = await insertCharacter(db, account.id);
    await insertItem(db, account.id, { equippedCharacterId: character.id, equippedSlot: 'weapon' });

    const message = await expectViolation(() =>
      insertItem(db, account.id, { equippedCharacterId: character.id, equippedSlot: 'weapon' }),
    );
    expect(message).toContain('items_equipped_slot_idx');
  });

  test('two items may share a slot name across different characters', async () => {
    const account = await insertAccount(db);
    const a = await insertCharacter(db, account.id, { slot: 0 });
    const b = await insertCharacter(db, account.id, { slot: 1 });
    await insertItem(db, account.id, { equippedCharacterId: a.id, equippedSlot: 'weapon' });
    await insertItem(db, account.id, { equippedCharacterId: b.id, equippedSlot: 'weapon' });
    const rows = await db.select().from(schema.items);
    expect(rows).toHaveLength(2);
  });

  test('equipped-ness is one fact: a character without a slot is rejected, and so is a slot without a character', async () => {
    const account = await insertAccount(db);
    const character = await insertCharacter(db, account.id);
    expect(await expectViolation(() =>
      insertItem(db, account.id, { equippedCharacterId: character.id }),
    )).toContain('items_equipped_pairing');
    expect(await expectViolation(() => insertItem(db, account.id, { equippedSlot: 'weapon' }))).toContain(
      'items_equipped_pairing',
    );
  });

  test('many unequipped items coexist: the unique index is partial', async () => {
    const account = await insertAccount(db);
    await insertItem(db, account.id);
    await insertItem(db, account.id);
    await insertItem(db, account.id);
    const rows = await db.select().from(schema.items);
    expect(rows).toHaveLength(3);
  });

  test('nothing is tradeable during beta', async () => {
    const account = await insertAccount(db);
    expect(await expectViolation(() => insertItem(db, account.id, { tradeable: true }))).toContain(
      'items_not_tradeable_in_beta',
    );
  });

  test('the off-hand a two-handed weapon locks is an absent row, not a sentinel', async () => {
    const account = await insertAccount(db);
    const character = await insertCharacter(db, account.id);
    await insertItem(db, account.id, { equippedCharacterId: character.id, equippedSlot: 'weapon' });

    const equipped = await db
      .select()
      .from(schema.items)
      .where(eq(schema.items.equippedCharacterId, character.id));
    expect(equipped.map((row) => row.equippedSlot)).toEqual(['weapon']);
  });
});

describe('stacks', () => {
  test('quantity is bounded below by zero, and a total past 999 is several stacks, not a refusal (ruling R137)', async () => {
    const account = await insertAccount(db);
    expect(await expectViolation(() =>
      db.insert(schema.stackItems).values({ accountId: account.id, definitionId: 'potion', quantity: -1 }),
    )).toContain('stack_items_quantity_nonnegative');
    // One total per consumable: 1,000 units occupy two slots, which the server counts.
    await db.insert(schema.stackItems).values({ accountId: account.id, definitionId: 'potion', quantity: 1000 });
  });
});

describe('the two-handed weapon and the off-hand (owner decision 2026-09-21; ruling R145)', () => {
  test('a character wearing a two-handed weapon cannot also hold an off-hand item, in either order', async () => {
    const account = await insertAccount(db);
    const a = await insertCharacter(db, account.id, { slot: 0 });
    await insertItem(db, account.id, { baseItemId: 'ranger-bow', twoHanded: true, equippedCharacterId: a.id, equippedSlot: 'weapon' });
    expect(await expectViolation(() =>
      insertItem(db, account.id, { baseItemId: 'wooden-buckler', equippedCharacterId: a.id, equippedSlot: 'offhand' }),
    )).toContain('items_two_handed_offhand_idx');

    const b = await insertCharacter(db, account.id, { slot: 1 });
    await insertItem(db, account.id, { baseItemId: 'wooden-buckler', equippedCharacterId: b.id, equippedSlot: 'offhand' });
    expect(await expectViolation(() =>
      insertItem(db, account.id, { baseItemId: 'ranger-bow', twoHanded: true, equippedCharacterId: b.id, equippedSlot: 'weapon' }),
    )).toContain('items_two_handed_offhand_idx');
  });

  test('a one-handed weapon and an off-hand coexist, and a two-handed weapon in the bag locks nothing', async () => {
    const account = await insertAccount(db);
    const character = await insertCharacter(db, account.id);
    await insertItem(db, account.id, { baseItemId: 'guardian-sword', equippedCharacterId: character.id, equippedSlot: 'weapon' });
    await insertItem(db, account.id, { baseItemId: 'wooden-buckler', equippedCharacterId: character.id, equippedSlot: 'offhand' });
    await insertItem(db, account.id, { baseItemId: 'ranger-bow', twoHanded: true });
    expect(await db.select().from(schema.items)).toHaveLength(3);
  });

  test('slot names are layer-1 §7.1 names: an unknown slot is refused', async () => {
    const account = await insertAccount(db);
    const character = await insertCharacter(db, account.id);
    expect(await expectViolation(() =>
      insertItem(db, account.id, { equippedCharacterId: character.id, equippedSlot: 'hands' }),
    )).toContain('items_equipped_slot_known');
  });

  test('a character-bound item can be worn by its own character only', async () => {
    const account = await insertAccount(db);
    const owner = await insertCharacter(db, account.id, { slot: 0 });
    const other = await insertCharacter(db, account.id, { slot: 1 });
    expect(await expectViolation(() =>
      insertItem(db, account.id, { boundTo: owner.id, equippedCharacterId: other.id, equippedSlot: 'weapon' }),
    )).toContain('items_bound_wearer');
    await insertItem(db, account.id, { boundTo: owner.id, equippedCharacterId: owner.id, equippedSlot: 'weapon' });
  });
});

describe('hunts', () => {
  const huntRow = (accountId: string) => ({
    accountId,
    status: 'running',
    mapId: 'meadow-outskirts',
    checkpoint: Buffer.from('{}'),
    checkpointSchemaVersion: 1,
    simulationVersion: 'a1',
    contentVersion: 'test',
    gridHash: 'test',
    simAnchorMs: 0,
    wallAnchorAt: new Date(),
    lastSeenAt: new Date(),
  });

  test('one hunt per account, by primary key', async () => {
    const account = await insertAccount(db);
    await db.insert(schema.hunts).values(huntRow(account.id));
    const message = await expectViolation(() => db.insert(schema.hunts).values(huntRow(account.id)));
    expect(message).toContain('hunts_pkey');
  });

  test('generation cannot go negative', async () => {
    const account = await insertAccount(db);
    const message = await expectViolation(() =>
      db.insert(schema.hunts).values({ ...huntRow(account.id), generation: -1 }),
    );
    expect(message).toContain('hunts_generation_nonnegative');
  });
});

describe('drop protection, grants and maintenance', () => {
  test('a pity counter cannot go negative', async () => {
    const account = await insertAccount(db);
    const message = await expectViolation(() =>
      db
        .insert(schema.accountDropProtection)
        .values({ accountId: account.id, rewardTier: 'epicPlus', counter: -1 }),
    );
    expect(message).toContain('drop_protection_counter_nonnegative');
  });

  test('a grant key is unique per account, which is what makes a grant idempotent', async () => {
    const account = await insertAccount(db);
    const row = { accountId: account.id, grantKey: 'starter-kit:0', kind: 'starter', payload: {}, grantedBy: 'system' };
    await db.insert(schema.accountGrants).values(row);
    expect(await expectViolation(() => db.insert(schema.accountGrants).values(row))).toContain(
      'account_grants_key_idx',
    );
  });

  test('maintenance holds exactly one row', async () => {
    await db.insert(schema.maintenance).values({ id: 1, updatedBy: 'test' });
    expect(await expectViolation(() =>
      db.insert(schema.maintenance).values({ id: 2, updatedBy: 'test' }),
    )).toContain('maintenance_single_row');
  });

  test('an archived checkpoint states why it was captured', async () => {
    const account = await insertAccount(db);
    const base = {
      accountId: account.id,
      generation: 1,
      checkpoint: Buffer.from('{}'),
      checkpointSchemaVersion: 1,
      simulationVersion: 'a1',
      contentVersion: 'test',
      gridHash: 'test',
    };
    await db.insert(schema.huntCheckpointArchive).values({ ...base, capturedFor: 'migration' });
    await db.insert(schema.huntCheckpointArchive).values({ ...base, capturedFor: 'fault' });
    expect(await expectViolation(() =>
      db.insert(schema.huntCheckpointArchive).values({ ...base, capturedFor: 'because' }),
    )).toContain('hunt_archive_captured_for');
  });
});

/**
 * An audit trail that can be rewritten is not an audit trail (layer-1 §8.4).
 *
 * This surfaced a deployment requirement rather than a schema one: a table's
 * **owner keeps implicit privileges that REVOKE does not remove**, so running
 * the application as the owner of its own tables makes "append-only"
 * unenforceable no matter what is granted. The application therefore connects
 * as a role that owns nothing, and `narok_app` below is that role.
 */
describe('resource_audit is append-only', () => {
  test('a non-owner application role may insert and select, but never update or delete', async () => {
    const account = await insertAccount(db);
    await db.insert(schema.resourceAudit).values({
      accountId: account.id,
      reason: 'kill-reward',
      sourceRef: 'hunt:1:7',
      delta: { gold: 12 },
      stateVersionAfter: 1,
    });

    await db.execute(sql`drop role if exists narok_app_test`);
    await db.execute(sql`create role narok_app_test login password 'app'`);
    await db.execute(sql`grant connect on database narok to narok_app_test`);
    await db.execute(sql`grant usage on schema public to narok_app_test`);
    await db.execute(sql`grant select, insert on resource_audit to narok_app_test`);
    await db.execute(sql`grant usage, select on all sequences in schema public to narok_app_test`);

    const appRole = postgres('postgres://narok_app_test:app@127.0.0.1:5433/narok', { max: 1, onnotice: () => {} });
    try {
      // Reading and appending are the two things it may do.
      const rows = await appRole`select count(*)::int as count from resource_audit`;
      expect(rows[0].count).toBe(1);
      await appRole`insert into resource_audit (account_id, reason, source_ref, delta, state_version_after)
                    values (${account.id}, 'kill-reward', 'hunt:1:8', '{}', 2)`;

      await expect(appRole`update resource_audit set reason = 'edited'`).rejects.toThrow(/permission denied/i);
      await expect(appRole`delete from resource_audit`).rejects.toThrow(/permission denied/i);
    } finally {
      await appRole.end({ timeout: 5 });
      await db.execute(sql`revoke all on resource_audit from narok_app_test`);
      await db.execute(sql`revoke all on all sequences in schema public from narok_app_test`);
      await db.execute(sql`revoke usage on schema public from narok_app_test`);
      await db.execute(sql`revoke connect on database narok from narok_app_test`);
      await db.execute(sql`drop role if exists narok_app_test`);
    }
  });
});
