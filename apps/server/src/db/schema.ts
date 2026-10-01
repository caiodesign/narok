/**
 * The PostgreSQL schema of milestone B spec part 1 §5, one table per row of its
 * table, with every constraint enforced in the database *in addition to*
 * application validation (layer-1 §8.2).
 *
 * Two of these constraints are load-bearing rather than decorative:
 *
 * - `accounts.state_version` is the single optimistic-concurrency guard. It is
 *   what stops a stale snapshot overwriting a newer town action (P-20), so it
 *   is account-wide and every gameplay write goes through it.
 * - `items`' partial unique index plus its null-pairing check are what make
 *   "one item per slot" a database fact. They are also what make the owner's
 *   two-handed rule enforceable: a two-handed weapon leaves `offhand` with no
 *   row at all rather than with a sentinel the application has to remember.
 *
 * `hunts.checkpoint` is `bytea`, not `jsonb`, and that is deliberate: `jsonb`
 * normalises key order and numeric representation, which would destroy the
 * byte-equality the determinism and split-invariance tests rest on (P-30,
 * part 1 §9 #6).
 */
import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { EQUIPMENT_SLOTS } from '@narok/data';
import { EXP_SHARE_DENOMINATOR } from '@narok/progression';

/** Raw bytes, so a canonical encoding survives the round trip unchanged. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    passwordAlgorithm: text('password_algorithm').notNull(),
    passwordChangedAt: bigint('password_changed_at', { mode: 'number' }).notNull(),
    gold: integer('gold').notNull().default(0),
    bagCapacity: integer('bag_capacity').notNull(),
    stateVersion: bigint('state_version', { mode: 'number' }).notNull().default(0),
    premiumGrantedAt: timestamp('premium_granted_at', { withTimezone: true }),
    premiumExpiresAt: timestamp('premium_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('accounts_email_lower_idx').on(sql`lower(${table.email})`),
    check('accounts_gold_nonnegative', sql`${table.gold} >= 0`),
    check('accounts_bag_capacity_nonnegative', sql`${table.bagCapacity} >= 0`),
    check('accounts_state_version_nonnegative', sql`${table.stateVersion} >= 0`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    lastSeenAt: bigint('last_seen_at', { mode: 'number' }).notNull(),
    revokedAt: bigint('revoked_at', { mode: 'number' }),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_idx').on(table.tokenHash),
    index('sessions_account_idx').on(table.accountId),
    index('sessions_expires_idx').on(table.expiresAt),
  ],
);

export const characters = pgTable(
  'characters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    slot: smallint('slot').notNull(),
    name: text('name').notNull(),
    /** NFKC case-folded, so "globally unique" means what it says (part 1 §9 #5). */
    nameKey: text('name_key').notNull(),
    classId: text('class_id').notNull(),
    level: integer('level').notNull().default(1),
    exp: bigint('exp', { mode: 'number' }).notNull().default(0),
    /**
     * The party-split remainder in 1/60,000ths of an EXP point (ruling R135),
     * so EXP totals do not depend on how hunts are cut into settlements. The
     * sim's checkpoint `progression` is the source; a settlement copies it here.
     */
    expCarry: integer('exp_carry').notNull().default(0),
    awardedLevel: integer('awarded_level').notNull().default(1),
    unspentStatPoints: integer('unspent_stat_points').notNull().default(0),
    unspentSkillPoints: integer('unspent_skill_points').notNull().default(0),
    attributes: jsonb('attributes').notNull(),
    skills: jsonb('skills').notNull(),
    buildTemplate: jsonb('build_template'),
    autoSpend: jsonb('auto_spend'),
    hp: integer('hp').notNull(),
    mp: integer('mp').notNull(),
    dead: boolean('dead').notNull().default(false),
  },
  (table) => [
    uniqueIndex('characters_account_slot_idx').on(table.accountId, table.slot),
    uniqueIndex('characters_name_key_idx').on(table.nameKey),
    // Three slots per account (layer-1 §5.1).
    check('characters_slot_range', sql`${table.slot} >= 0 and ${table.slot} <= 2`),
    check('characters_level_positive', sql`${table.level} >= 1`),
    // A level may not be rewarded twice (layer-1 §5.3).
    check('characters_awarded_level', sql`${table.awardedLevel} <= ${table.level}`),
    check(
      'characters_exp_carry_range',
      sql`${table.expCarry} >= 0 and ${table.expCarry} < ${sql.raw(String(EXP_SHARE_DENOMINATOR))}`,
    ),
    check(
      'characters_points_nonnegative',
      sql`${table.unspentStatPoints} >= 0 and ${table.unspentSkillPoints} >= 0`,
    ),
    check('characters_hp_nonnegative', sql`${table.hp} >= 0`),
    check('characters_mp_nonnegative', sql`${table.mp} >= 0`),
  ],
);

export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    baseItemId: text('base_item_id').notNull(),
    baseContentVersion: text('base_content_version').notNull(),
    rarity: text('rarity').notNull(),
    itemLevel: integer('item_level').notNull(),
    bonuses: jsonb('bonuses').notNull(),
    tradeable: boolean('tradeable').notNull().default(false),
    locked: boolean('locked').notNull().default(false),
    /** Assigned at acquisition: a Legendary drop is protected (part 3 §3.2). */
    protected: boolean('protected').notNull().default(false),
    /**
     * Where the item came from: a reward id `"<huntId>:<rewardSeq>"` or a grant
     * key. Unique per account, so a re-simulated commit can never credit one
     * reward twice (part 2 §2, B-25).
     */
    sourceRef: text('source_ref'),
    equippedCharacterId: uuid('equipped_character_id').references(() => characters.id, { onDelete: 'set null' }),
    equippedSlot: text('equipped_slot'),
    /**
     * The definition's handedness, copied at acquisition from the pinned
     * content the instance was made under (ruling R145), so the owner's
     * two-handed rule can be a database fact: see `items_two_handed_offhand_idx`.
     */
    twoHanded: boolean('two_handed').notNull().default(false),
    /**
     * The one character that may wear this item (ruling R141, R145): the
     * starter weapon is bound so it cannot be cycled for value. A bound item
     * is never sellable. It leaves with its character — re-creating the slot
     * grants nothing (part 3 §8 #10) — so the binding can never dangle.
     */
    boundTo: uuid('bound_to').references(() => characters.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One item per slot, in the database rather than in a comment.
    uniqueIndex('items_equipped_slot_idx')
      .on(table.equippedCharacterId, table.equippedSlot)
      .where(sql`${table.equippedCharacterId} is not null`),
    // Equipped-ness is one fact, not two that can disagree.
    check(
      'items_equipped_pairing',
      sql`(${table.equippedCharacterId} is null) = (${table.equippedSlot} is null)`,
    ),
    // Layer-1 §7.1's eight slot names and no others (ruling R142).
    check(
      'items_equipped_slot_known',
      sql`${table.equippedSlot} is null or ${table.equippedSlot} in (${sql.raw(EQUIPMENT_SLOTS.map((slot) => `'${slot}'`).join(', '))})`,
    ),
    // A two-handed weapon locks the off-hand (owner decision 2026-09-21;
    // ruling R145): per character, at most one row is either the off-hand or
    // a two-handed weapon — so the two can never be worn together, whichever
    // write comes first. A one-handed weapon is outside the predicate.
    uniqueIndex('items_two_handed_offhand_idx')
      .on(table.equippedCharacterId)
      .where(
        sql`${table.equippedSlot} = 'offhand' or (${table.equippedSlot} = 'weapon' and ${table.twoHanded})`,
      ),
    // A bound item is worn by its own character or by no one.
    check(
      'items_bound_wearer',
      sql`${table.boundTo} is null or ${table.equippedCharacterId} is null or ${table.equippedCharacterId} = ${table.boundTo}`,
    ),
    // No trading before Layer 4 (layer-1 §7.1, §14).
    check('items_not_tradeable_in_beta', sql`${table.tradeable} = false`),
    index('items_bag_idx').on(table.accountId).where(sql`${table.equippedCharacterId} is null`),
    uniqueIndex('items_source_idx').on(table.accountId, table.sourceRef).where(sql`${table.sourceRef} is not null`),
  ],
);

export const stackItems = pgTable(
  'stack_items',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    definitionId: text('definition_id').notNull(),
    quantity: integer('quantity').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.definitionId] }),
    check('stack_items_quantity_nonnegative', sql`${table.quantity} >= 0`),
    // No upper bound here (ruling R137): `quantity` is the *total* held of one
    // consumable, which occupies ceil(quantity / 999) bag slots — 999 bounds a
    // stack, not a total, and the bag's capacity bounds the stacks.
  ],
);

export const strategyPresets = pgTable(
  'strategy_presets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    payload: jsonb('payload').notNull(),
    payloadSchemaVersion: integer('payload_schema_version').notNull(),
    /** Required for a preset carrying placement (contracts §2). */
    gridHash: text('grid_hash'),
    presetVersion: integer('preset_version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('strategy_presets_account_name_idx').on(table.accountId, table.name),
    index('strategy_presets_account_idx').on(table.accountId),
  ],
);

export const lootPresets = pgTable(
  'loot_presets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    payload: jsonb('payload').notNull(),
    payloadSchemaVersion: integer('payload_schema_version').notNull(),
    presetVersion: integer('preset_version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('loot_presets_account_name_idx').on(table.accountId, table.name),
    index('loot_presets_account_idx').on(table.accountId),
  ],
);

/** One hunt per account, by primary key rather than by convention (layer-1 §5.1). */
export const hunts = pgTable(
  'hunts',
  {
    accountId: uuid('account_id')
      .primaryKey()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    mapId: text('map_id').notNull(),
    checkpoint: bytea('checkpoint').notNull(),
    checkpointSchemaVersion: integer('checkpoint_schema_version').notNull(),
    simulationVersion: text('simulation_version').notNull(),
    contentVersion: text('content_version').notNull(),
    gridHash: text('grid_hash').notNull(),
    simAnchorMs: bigint('sim_anchor_ms', { mode: 'number' }).notNull(),
    wallAnchorAt: timestamp('wall_anchor_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    paused: boolean('paused').notNull().default(false),
    generation: bigint('generation', { mode: 'number' }).notNull().default(0),
    faultedReason: text('faulted_reason'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('hunts_running_idx').on(table.status).where(sql`${table.status} = 'running'`),
    check('hunts_generation_nonnegative', sql`${table.generation} >= 0`),
  ],
);

/**
 * Written only by migration (layer-1 §4.7 "retain the old artifacts") and by
 * fault capture (layer-1 §11). It is what makes the migration runbook's
 * rollback a replay rather than a hope.
 */
export const huntCheckpointArchive = pgTable(
  'hunt_checkpoint_archive',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull(),
    generation: bigint('generation', { mode: 'number' }).notNull(),
    capturedFor: text('captured_for').notNull(),
    checkpoint: bytea('checkpoint').notNull(),
    checkpointSchemaVersion: integer('checkpoint_schema_version').notNull(),
    simulationVersion: text('simulation_version').notNull(),
    contentVersion: text('content_version').notNull(),
    gridHash: text('grid_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('hunt_archive_account_idx').on(table.accountId, table.createdAt),
    check('hunt_archive_captured_for', sql`${table.capturedFor} in ('migration', 'fault')`),
  ],
);

export const accountDropProtection = pgTable(
  'account_drop_protection',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    rewardTier: text('reward_tier').notNull(),
    counter: integer('counter').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.rewardTier] }),
    check('drop_protection_counter_nonnegative', sql`${table.counter} >= 0`),
  ],
);

export const huntReports = pgTable(
  'hunt_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    generation: bigint('generation', { mode: 'number' }).notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('hunt_reports_account_idx').on(table.accountId, table.createdAt)],
);

export const commandResults = pgTable(
  'command_results',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    operation: text('operation').notNull(),
    requestHash: text('request_hash').notNull(),
    response: jsonb('response').notNull(),
    stateVersionAfter: bigint('state_version_after', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.idempotencyKey] }),
    index('command_results_expires_idx').on(table.expiresAt),
  ],
);

/**
 * Append-only. The application role holds INSERT and SELECT and nothing else,
 * because this is the only defence against a resource anomaly (layer-1 §8.4)
 * and a defence that can be rewritten is not one.
 */
export const resourceAudit = pgTable(
  'resource_audit',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    accountId: uuid('account_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    reason: text('reason').notNull(),
    sourceRef: text('source_ref').notNull(),
    delta: jsonb('delta').notNull(),
    stateVersionAfter: bigint('state_version_after', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('resource_audit_account_idx').on(table.accountId, table.occurredAt),
    index('resource_audit_source_idx').on(table.sourceRef),
  ],
);

/** Makes onboarding and admin grants idempotent (layer-1 §7.4, §8.2, P-36). */
export const accountGrants = pgTable(
  'account_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    grantKey: text('grant_key').notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    grantedBy: text('granted_by').notNull(),
  },
  (table) => [uniqueIndex('account_grants_key_idx').on(table.accountId, table.grantKey)],
);

/**
 * Exactly one row, so §4.7's cutoff is durable and visible to every process.
 * The check is what makes "single row" a fact rather than an assumption a
 * second `api` instance could break.
 */
export const maintenance = pgTable(
  'maintenance',
  {
    id: smallint('id').primaryKey().default(1),
    frozen: boolean('frozen').notNull().default(false),
    cutoffAt: timestamp('cutoff_at', { withTimezone: true }),
    note: text('note'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by').notNull().default('system'),
  },
  (table) => [check('maintenance_single_row', sql`${table.id} = 1`)],
);

/** Durable "last completed at" per periodic job, under an advisory lock (P-05). */
export const periodicJobs = pgTable('periodic_jobs', {
  name: text('name').primaryKey(),
  lastCompletedAt: timestamp('last_completed_at', { withTimezone: true }),
  lastError: text('last_error'),
});

export const accountRelations = relations(accounts, ({ many, one }) => ({
  sessions: many(sessions),
  characters: many(characters),
  items: many(items),
  hunt: one(hunts),
}));
