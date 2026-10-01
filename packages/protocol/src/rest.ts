/**
 * The REST surface of milestone B spec part 1 §3: one strict schema per route,
 * plus the route table itself with the auth, guard and idempotency columns the
 * spec fixes.
 *
 * Two rules give the schemas their shape:
 *
 * - **Strict, always.** A request carrying a field the server does not read is
 *   a client asserting something, and part 1 §2's table says a client's
 *   assertions are never trusted. Rejecting the whole request is how a
 *   smuggled `seed`, `elapsedMs` or `commandAt` becomes a test failure instead
 *   of a silently ignored field.
 * - **`expectedStateVersion` is required where it appears.** It guards an
 *   intent the user formed against a snapshot they read (P-23); making it
 *   optional would turn a guarded command into an unguarded one whenever a
 *   client forgot it.
 */
import { z } from 'zod';
import type { Slot } from '@narok/data';

const uuid = z.uuid();
const positiveInt = z.number().int().positive();
const version = z.number().int().nonnegative();

/** Long enough to be worth hashing; no composition rule (part 1 §9 #2). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;

/** Lowercased on the way in, so "globally unique" means what it says. */
const email = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());

const password = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

export const registerRequestSchema = z.object({ email, password }).strict();
export const loginRequestSchema = z.object({ email, password }).strict();

export const accountSummarySchema = z
  .object({
    id: uuid,
    email: z.string(),
    stateVersion: version,
    createdAt: z.string(),
  })
  .strict();

export const meResponseSchema = z
  .object({
    id: uuid,
    email: z.string(),
    stateVersion: version,
    premium: z.boolean(),
    versions: z
      .object({ simulationVersion: z.string(), contentVersion: z.string(), gridHash: z.string() })
      .strict(),
  })
  .strict();

/**
 * The eight equipment slots of layer-1 §7.1 — weapon, off-hand, head, body,
 * cloak, shoes and two accessories — which content declares once as
 * `@narok/data`'s `EQUIPMENT_SLOTS` (ruling R142: this list said `hands` and
 * `feet`, which no other package knew). The protocol may not import content
 * at runtime (P-01's boundary), so the tuple is repeated here and pinned to
 * content's `Slot` both ways at compile time, and to its order by test.
 */
export const EQUIPMENT_SLOTS = [
  'weapon',
  'offhand',
  'head',
  'body',
  'cloak',
  'shoes',
  'accessory1',
  'accessory2',
] as const satisfies readonly Slot[];
type ProtocolSlot = (typeof EQUIPMENT_SLOTS)[number];
/** Compiles only while the two lists name the same slots. */
export const SLOTS_MATCH_CONTENT: [Slot] extends [ProtocolSlot] ? true : never = true;
export const equipmentSlotSchema = z.enum(EQUIPMENT_SLOTS);

export const createCharacterSchema = z
  .object({ slot: z.number().int().min(0).max(2), name: z.string().min(3).max(16), classId: z.string() })
  .strict();

/**
 * A staged allocation, applied atomically (UI spec §7). The per-attribute
 * amounts are the delta the player staged, never the resulting total, so a
 * stale draft cannot overwrite a newer one with an absolute value.
 */
const attributeKey = z.enum(['str', 'agi', 'vit', 'int', 'dex', 'luk']);
export const allocateAttributesSchema = z
  .object({
    spend: z.record(attributeKey, z.number().int().nonnegative()),
    /**
     * The total the client's staging showed (part 3 §5.3 step 5): the server
     * replays the cost point by point and refuses a mismatch with
     * `COST_MISMATCH` rather than charging a number the player never saw.
     */
    quotedCost: z.number().int().nonnegative(),
  })
  .strict();

export const upgradeSkillSchema = z.object({ skillId: z.string(), targetRank: positiveInt }).strict();
export const respecSchema = z.object({ scope: z.enum(['attributes', 'skills', 'both']) }).strict();

/**
 * The stat auto-spend template (layer-1 §5.5; part 3 §5.2): ordered build
 * targets and a remainder attribute, or `null` to switch auto-spend off. The
 * attribute cap and the one-target-per-attribute rule are content and rule
 * checks, made by `@narok/progression` against the pinned content.
 */
export const autoSpendTemplateSchema = z
  .object({
    targets: z.array(z.object({ attribute: attributeKey, value: positiveInt }).strict()).max(6),
    remainder: attributeKey.nullable(),
  })
  .strict()
  .nullable();
export const autoSpendSchema = z.object({ template: autoSpendTemplateSchema }).strict();

export const equipRequestSchema = z
  .object({ itemId: uuid, characterId: uuid, slot: equipmentSlotSchema })
  .strict();

export const unequipRequestSchema = z.object({ characterId: uuid, slot: equipmentSlotSchema }).strict();

export const sellRequestSchema = z.object({ itemIds: z.array(uuid).min(1).max(200) }).strict();

export const lockRequestSchema = z.object({ itemId: uuid, locked: z.boolean() }).strict();

export const buyRequestSchema = z
  .object({ definitionId: z.string().min(1).max(64), quantity: positiveInt.max(999) })
  .strict();

export const presetPayloadSchema = z
  .object({ payload: z.unknown(), payloadSchemaVersion: positiveInt, name: z.string().min(1).max(40) })
  .strict();

/**
 * What a saved strategy preset holds, payload schema version 1 (owner decision
 * 2026-09-25, spec §4.0.1): placement and one strategy per party slot, plus
 * the rest thresholds. It holds no wipe limit: a full wipe ends the hunt
 * (owner decision 2026-09-30, ruling R154), so `.strict()` refuses one. Slots are `p0`–`p2` in party order.
 * The rules inside each strategy are validated by the engine itself at start,
 * so there is one validator for them, not two.
 */
const partySlot = z.string().regex(/^p[0-2]$/);
export const STRATEGY_PAYLOAD_SCHEMA_VERSION = 1;
export const strategyPresetPayloadSchema = z
  .object({
    placement: z.record(partySlot, z.string().min(1).max(16)),
    strategies: z.record(partySlot, z.unknown()),
    rest: z.object({ hpStart: z.number().int(), mpStart: z.number().int() }).strict(),
  })
  .strict();
export type StrategyPresetPayload = z.infer<typeof strategyPresetPayloadSchema>;

export const lootPreviewSchema = z.object({ payload: z.unknown(), payloadSchemaVersion: positiveInt }).strict();

/**
 * Starting a hunt names a party, a map and the presets to run. It does not name
 * a seed: the seed belongs to the hunt and is the server's (part 1 §2), which
 * `.strict()` turns from a convention into a rejection.
 */
export const startHuntSchema = z
  .object({
    characterIds: z.array(uuid).min(1).max(3),
    mapId: z.string().min(1).max(64),
    strategyPresetId: uuid,
    lootPresetId: uuid,
  })
  .strict();

/**
 * Apply-next-encounter (UI spec §5). `presetVersion` is the version the player
 * was looking at, so a later edit cannot be applied by an older intent.
 */
export const applyStrategySchema = z.object({ presetId: uuid, presetVersion: positiveInt }).strict();

/**
 * Apply loot filter (UI spec §6, part 3 §3.3): the preset and the version the
 * player saw. It governs drops after the acknowledged cutoff only.
 */
export const applyLootSchema = z.object({ presetId: uuid, presetVersion: positiveInt }).strict();

/**
 * Adds the optimistic-concurrency guard to a command formed against a read
 * (P-23). Required, never optional: a missing guard is a validation failure
 * rather than an unguarded write.
 */
export function guardedSchema<T extends z.ZodObject>(schema: T) {
  return schema.extend({ expectedStateVersion: version });
}

/**
 * The guarded commands, spelled out. `guardedSchema` above is the rule and is
 * what the test exercises; these are concrete so a route gets a real inferred
 * type instead of the `unknown`-shaped result a generic `.extend()` produces.
 */
export const lockCommandSchema = lockRequestSchema.extend({ expectedStateVersion: version });
export const equipCommandSchema = equipRequestSchema.extend({ expectedStateVersion: version });
export const unequipCommandSchema = unequipRequestSchema.extend({ expectedStateVersion: version });
export const createCharacterCommandSchema = createCharacterSchema.extend({ expectedStateVersion: version });
export const allocateAttributesCommandSchema = allocateAttributesSchema.extend({ expectedStateVersion: version });
export const upgradeSkillCommandSchema = upgradeSkillSchema.extend({ expectedStateVersion: version });
export const respecCommandSchema = respecSchema.extend({ expectedStateVersion: version });
export const autoSpendCommandSchema = autoSpendSchema.extend({ expectedStateVersion: version });
export const sellCommandSchema = sellRequestSchema.extend({ expectedStateVersion: version });
export const startHuntCommandSchema = startHuntSchema.extend({ expectedStateVersion: version });
/**
 * Apply-next-encounter is an intervention on the running hunt, so besides the
 * account guard it carries the hunt generation the player was looking at
 * (part 2 §4): a command formed before another intervention is refused as
 * stale rather than merged.
 */
export const applyStrategyCommandSchema = applyStrategySchema.extend({
  expectedStateVersion: version,
  expectedGeneration: z.number().int().nonnegative(),
});
/** Apply loot filter is the same kind of intervention, guarded the same way (part 2 §4). */
export const applyLootCommandSchema = applyLootSchema.extend({
  expectedStateVersion: version,
  expectedGeneration: z.number().int().nonnegative(),
});

export type RouteAuth = 'none' | 'session';

export interface RouteSpec {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  auth: RouteAuth;
  /** Carries `expectedStateVersion` because the intent was formed against a read. */
  guarded: boolean;
  /** Requires an `Idempotency-Key`, scoped to `(account, operation)`. */
  idempotent: boolean;
}

/** Part 1 §3's table, in its order. */
export const ROUTES: readonly RouteSpec[] = [
  { method: 'POST', path: '/api/auth/register', auth: 'none', guarded: false, idempotent: false },
  { method: 'POST', path: '/api/auth/login', auth: 'none', guarded: false, idempotent: false },
  { method: 'POST', path: '/api/auth/logout', auth: 'session', guarded: false, idempotent: false },
  { method: 'GET', path: '/api/me', auth: 'session', guarded: false, idempotent: false },
  { method: 'GET', path: '/api/characters', auth: 'session', guarded: false, idempotent: false },
  { method: 'POST', path: '/api/characters', auth: 'session', guarded: true, idempotent: true },
  { method: 'POST', path: '/api/characters/:id/attributes', auth: 'session', guarded: true, idempotent: true },
  { method: 'POST', path: '/api/characters/:id/skills', auth: 'session', guarded: true, idempotent: true },
  { method: 'POST', path: '/api/characters/:id/respec', auth: 'session', guarded: true, idempotent: true },
  // Task 7b (ruling R143): the town-only auto-spend template edit part 3 §4's
  // table lists and §5.2 relies on, which part 1 §3 lacked. Guarded and
  // idempotent like every other character command.
  { method: 'PUT', path: '/api/characters/:id/auto-spend', auth: 'session', guarded: true, idempotent: true },
  { method: 'GET', path: '/api/inventory', auth: 'session', guarded: false, idempotent: false },
  { method: 'POST', path: '/api/inventory/equip', auth: 'session', guarded: true, idempotent: true },
  { method: 'POST', path: '/api/inventory/unequip', auth: 'session', guarded: true, idempotent: true },
  { method: 'POST', path: '/api/inventory/sell', auth: 'session', guarded: true, idempotent: true },
  { method: 'POST', path: '/api/inventory/lock', auth: 'session', guarded: true, idempotent: true },
  { method: 'POST', path: '/api/shop/buy', auth: 'session', guarded: false, idempotent: true },
  { method: 'GET', path: '/api/presets', auth: 'session', guarded: false, idempotent: false },
  { method: 'PUT', path: '/api/presets/:id', auth: 'session', guarded: true, idempotent: true },
  { method: 'POST', path: '/api/presets/loot/preview', auth: 'session', guarded: false, idempotent: false },
  { method: 'POST', path: '/api/hunts', auth: 'session', guarded: true, idempotent: true },
  { method: 'POST', path: '/api/hunts/current/stop', auth: 'session', guarded: false, idempotent: true },
  { method: 'POST', path: '/api/hunts/current/strategy', auth: 'session', guarded: true, idempotent: true },
  // Task 6 (ruling R131): the loot filter's apply, "versioned with the hunt
  // state" (UI spec §6) — the command part 4 §3.3 lists and part 1 §3 lacked.
  { method: 'POST', path: '/api/hunts/current/loot', auth: 'session', guarded: true, idempotent: true },
  { method: 'GET', path: '/api/hunts/current', auth: 'session', guarded: false, idempotent: false },
  { method: 'GET', path: '/api/reports/:id', auth: 'session', guarded: false, idempotent: false },
];
