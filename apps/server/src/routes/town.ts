/**
 * The town routes (part 1 §3; part 3 §3–§6; gates B-13, B-16): characters,
 * allocation, skills, respec, the auto-spend template, the inventory, equip,
 * unequip and lock.
 *
 * Each mutating route resolves the caller, checks ownership of everything it
 * names — absent and not-yours answer identically (P-12) — and then hands the
 * rule to `runTownCommand`, which orders it with the account's hunt commands,
 * guards it, applies town-only and commits it whole (ruling R144). The rules
 * themselves are `@narok/progression`'s and the derivations `@narok/sim`'s;
 * this file computes no formula.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CONSUMABLE_STACK_MAX, type ClassId, type Content, type ItemInstance, type SkillId } from '@narok/data';
import {
  applyAllocation,
  awardLevels,
  bagLock,
  bagState,
  createCharacter,
  equip,
  expToNext,
  guard,
  respec,
  setAutoSpendTemplate,
  unequip,
  upgradeSkill,
  usedSlots,
  type Bag,
  type Character,
  type Result,
  type TownContext,
} from '@narok/progression';
import {
  allocateAttributesCommandSchema,
  autoSpendCommandSchema,
  createCharacterCommandSchema,
  equipCommandSchema,
  lockCommandSchema,
  respecCommandSchema,
  unequipCommandSchema,
  upgradeSkillCommandSchema,
} from '@narok/protocol';
import { deriveCharacter, resolveLoadout } from '@narok/sim';
import { ownedCharacter, progressionColumns, toCharacter, writeCharacter, type CharacterRow } from '../db/repositories/characters';
import { loadBag, persistBag, wornBy } from '../db/repositories/inventory';
import * as schema from '../db/schema';
import { AppError, notOwned } from '../errors';
import type { CommandSequencer } from '../hunt/commands';
import { readAccountVersion, type LifecycleDeps } from '../hunt/lifecycle';
import { requireSession } from '../plugins/session';
import { runTownCommand, unwrap, type TownDeps, type TownTx } from '../town/commands';
import { grantStarterKitOnce } from '../town/grants';
import type { RouteContext } from './context';
import { hashRequest, requireIdempotencyKey } from './hunts';

export interface TownServices {
  readonly lifecycle: LifecycleDeps;
  /** The account command order the hunt routes and the socket share (R116). */
  readonly sequencer: CommandSequencer;
}

const idSchema = z.uuid();

/** A character as a client reads it: progression, resources, and the stats the engine derives. */
function characterView(meta: Pick<CharacterRow, 'slot' | 'name'>, character: Character, worn: readonly ItemInstance[], content: Content) {
  const stats = deriveCharacter({
    classId: character.classId, level: character.level, allocated: character.attributes,
    loadout: resolveLoadout(worn, content), content,
  });
  return {
    id: character.id,
    slot: meta.slot,
    name: meta.name,
    classId: character.classId,
    level: character.level,
    exp: character.exp,
    expToNext: expToNext(character.level, content.progression),
    attributes: character.attributes,
    statPoints: character.statPoints,
    skillPoints: character.skillPoints,
    skillRanks: character.skillRanks,
    autoSpendTemplate: character.autoSpendTemplate,
    hp: character.hp,
    mp: character.mp,
    maxHp: stats.maxHp,
    maxMp: stats.maxMp,
    stats,
  };
}

/** The bag as a client reads it; slot counts come from the one rule (ruling R137). */
function inventoryView(bag: Bag) {
  const state = bagState(bag);
  return {
    capacity: bag.capacity,
    usedSlots: usedSlots(bag),
    items: bag.items,
    consumables: Object.keys(bag.consumables).sort().map((consumableId) => {
      const quantity = bag.consumables[consumableId]!;
      return { consumableId, quantity, stacks: (quantity + state.stackHeadroom[consumableId]!) / CONSUMABLE_STACK_MAX };
    }),
  };
}

/** The constraint a rejected write named, read off the driver error under drizzle's wrapper. */
function constraintOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
    const record = current as { constraint_name?: string; cause?: unknown };
    if (record.constraint_name !== undefined) return record.constraint_name;
    current = record.cause;
  }
  return undefined;
}

/**
 * The uniqueness key of a character name (ruling R147): NFKC-normalised, then
 * case-folded, so names differing only in width or case collide — part 1 §9
 * #5's recommendation. The allowed character set is still open there.
 */
export function nameKeyOf(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

export function registerTownRoutes(app: FastifyInstance, ctx: RouteContext, services: TownServices): void {
  const { stores, config, now, parse } = ctx;
  const { db, content } = services.lifecycle;
  const deps: TownDeps = { db, content, sequencer: services.sequencer };
  const caller = (request: FastifyRequest) => requireSession(request, stores, config, now());

  /** The named character of the caller, or `NOT_OWNED` — a malformed id is as absent as a missing one. */
  async function requireCharacter(accountId: string, id: unknown): Promise<string> {
    const parsed = idSchema.safeParse(id);
    if (!parsed.success || (await ownedCharacter(db, accountId, parsed.data)) === undefined) throw notOwned('characterId');
    return parsed.data;
  }

  async function requireItem(accountId: string, itemId: string): Promise<void> {
    const [row] = await db
      .select({ id: schema.items.id })
      .from(schema.items)
      .where(and(eq(schema.items.id, itemId), eq(schema.items.accountId, accountId)));
    if (row === undefined) throw notOwned('itemId');
  }

  /** Loads the character and the bag inside the command's transaction. */
  async function loadTown(town: TownTx, accountId: string, characterId: string) {
    const row = await ownedCharacter(town.tx, accountId, characterId);
    if (row === undefined) throw notOwned('characterId');
    const bag = await loadBag(town.tx, accountId);
    return { row, character: toCharacter(row), bag };
  }

  /**
   * One character command: ownership, then the shared sequence, then `rule`
   * over the character and what it wears; the result replaces the row.
   */
  function characterRoute<S extends z.ZodType<{ expectedStateVersion: number }>>(
    path: string,
    method: 'POST' | 'PUT',
    operation: string,
    bodySchema: S,
    rule: (character: Character, body: z.infer<S>, ctx: TownContext, worn: readonly ItemInstance[]) => Result<Character>,
  ): void {
    app.route({
      method,
      url: path,
      handler: async (request) => {
        const { account } = await caller(request);
        const key = requireIdempotencyKey(request);
        const body = parse(bodySchema, request.body);
        const id = await requireCharacter(account.id, (request.params as { id?: unknown }).id);

        return runTownCommand(deps, {
          accountId: account.id,
          expectedStateVersion: body.expectedStateVersion,
          operation,
          idempotency: { key: `${operation}:${key}`, requestHash: await hashRequest({ id, body }) },
        }, async (town) => {
          const { row, character, bag } = await loadTown(town, account.id, id);
          const worn = wornBy(bag, id);
          const next = unwrap(rule(character, body, town.ctx, worn), town.ctx.stateVersion);
          await writeCharacter(town.tx, account.id, next);
          return { character: characterView(row, next, worn, content), stateVersion: town.stateVersionAfter };
        });
      },
    });
  }

  app.get('/api/characters', async (request) => {
    const { account } = await caller(request);
    const stateVersion = await readAccountVersion(db, account.id);
    const rows = await db
      .select()
      .from(schema.characters)
      .where(eq(schema.characters.accountId, account.id))
      .orderBy(asc(schema.characters.slot));
    const bag = await loadBag(db, account.id);
    return {
      characters: rows.map((row) => characterView(row, toCharacter(row), wornBy(bag, row.id), content)),
      stateVersion,
    };
  });

  /**
   * Character creation, with the slot's starter kit in the same commit (part 3
   * §4 OPEN DECISION, the spec §4.1 recommendation; rulings R146, R147).
   */
  app.post('/api/characters', async (request) => {
    const { account } = await caller(request);
    const key = requireIdempotencyKey(request);
    const body = parse(createCharacterCommandSchema, request.body);
    const nameKey = nameKeyOf(body.name);

    try {
      return await runTownCommand(deps, {
        accountId: account.id,
        expectedStateVersion: body.expectedStateVersion,
        operation: 'character.create',
        idempotency: { key: `character.create:${key}`, requestHash: await hashRequest(body) },
      }, async (town) => {
        const refused = guard(town.ctx);
        if (refused !== null) unwrap(refused, town.ctx.stateVersion);
        if (!Object.hasOwn(content.classes, body.classId)) throw new AppError('VALIDATION', 'classId');
        const classId = body.classId as ClassId;

        const [slotTaken] = await town.tx
          .select({ id: schema.characters.id })
          .from(schema.characters)
          .where(and(eq(schema.characters.accountId, account.id), eq(schema.characters.slot, body.slot)));
        if (slotTaken !== undefined) throw new AppError('RULE_VIOLATION', 'SLOT_TAKEN', town.ctx.stateVersion);
        const [nameTaken] = await town.tx
          .select({ id: schema.characters.id })
          .from(schema.characters)
          .where(eq(schema.characters.nameKey, nameKey));
        if (nameTaken !== undefined) throw new AppError('RULE_VIOLATION', 'NAME_TAKEN', town.ctx.stateVersion);

        // A new character starts at full HP and MP (layer-1 §5.4): the one
        // derivation's maxima, wearing nothing — the starter weapon goes to the bag.
        const id = crypto.randomUUID();
        const fresh = createCharacter(id, classId, content.progression);
        const full = town.ctx.maxima({ ...fresh, hp: 0, mp: 0 }, []);
        const character: Character = { ...fresh, hp: full.maxHp, mp: full.maxMp };
        await town.tx.insert(schema.characters).values({
          id, accountId: account.id, slot: body.slot, name: body.name, nameKey, classId, ...progressionColumns(character),
        });

        // Ruling R146: creation is the kit's only attempt, so a bag that
        // cannot hold it refuses the creation rather than losing the kit.
        const kit = await grantStarterKitOnce(town.tx, content, {
          accountId: account.id, characterId: id, characterSlot: body.slot, classId,
        }, town.stateVersionAfter);
        if (kit.outcome === 'deferred') throw new AppError('RULE_VIOLATION', 'BAG_FULL', town.ctx.stateVersion);

        return { character: characterView({ slot: body.slot, name: body.name }, character, [], content), stateVersion: town.stateVersionAfter };
      });
    } catch (error) {
      // Two accounts racing for one name: the index answers, as the same rule.
      if (constraintOf(error) === 'characters_name_key_idx') throw new AppError('RULE_VIOLATION', 'NAME_TAKEN');
      throw error;
    }
  });

  characterRoute('/api/characters/:id/attributes', 'POST', 'character.attributes', allocateAttributesCommandSchema,
    (character, body, town) => applyAllocation(character, body.spend, body.quotedCost, town));

  characterRoute('/api/characters/:id/skills', 'POST', 'character.skills', upgradeSkillCommandSchema,
    (character, body, town) => upgradeSkill(character, body.skillId as SkillId, body.targetRank, town));

  // Every level reached is awarded before the refund, so a character whose
  // awarded level lags its level gets its whole earned budget back (Task 7a
  // review). Controller ruling (Task 7a): saved presets are NOT revalidated
  // here yet — skill ranks do not gate combat skills (the engine gives every
  // actor its class skills), so `revalidateRules` would disable every rule of
  // a level-1 character. Respec never touches equipment.
  characterRoute('/api/characters/:id/respec', 'POST', 'character.respec', respecCommandSchema,
    (character, body, town, worn) => respec(awardLevels(character, content.progression), body.scope, worn, town));

  characterRoute('/api/characters/:id/auto-spend', 'PUT', 'character.auto-spend', autoSpendCommandSchema,
    (character, body, town) => setAutoSpendTemplate(character, body.template, town));

  app.get('/api/inventory', async (request) => {
    const { account } = await caller(request);
    const stateVersion = await readAccountVersion(db, account.id);
    return { ...inventoryView(await loadBag(db, account.id)), stateVersion };
  });

  /** Equip and unequip: the character and the bag change together (part 3 §4; gate B-13). */
  function equipRoute<S extends z.ZodType<{ expectedStateVersion: number; characterId: string }>>(
    path: string,
    operation: string,
    bodySchema: S,
    itemOf: (body: z.infer<S>) => string | null,
    rule: (character: Character, body: z.infer<S>, bag: Bag, ctx: TownContext) => Result<{ character: Character; bag: Bag }>,
  ): void {
    app.post(path, async (request) => {
      const { account } = await caller(request);
      const key = requireIdempotencyKey(request);
      const body = parse(bodySchema, request.body);
      await requireCharacter(account.id, body.characterId);
      const itemId = itemOf(body);
      if (itemId !== null) await requireItem(account.id, itemId);

      return runTownCommand(deps, {
        accountId: account.id,
        expectedStateVersion: body.expectedStateVersion,
        operation,
        idempotency: { key: `${operation}:${key}`, requestHash: await hashRequest(body) },
      }, async (town) => {
        const { row, character, bag } = await loadTown(town, account.id, body.characterId);
        const next = unwrap(rule(character, body, bag, town.ctx), town.ctx.stateVersion);
        await persistBag(town.tx, bag, next.bag, content);
        await writeCharacter(town.tx, account.id, next.character);
        return {
          character: characterView(row, next.character, wornBy(next.bag, character.id), content),
          inventory: inventoryView(next.bag),
          stateVersion: town.stateVersionAfter,
        };
      });
    });
  }

  equipRoute('/api/inventory/equip', 'inventory.equip', equipCommandSchema, (body) => body.itemId,
    (character, body, bag, town) => equip(character, { itemId: body.itemId, slot: body.slot }, bag, town));

  equipRoute('/api/inventory/unequip', 'inventory.unequip', unequipCommandSchema, () => null,
    (character, body, bag, town) => unequip(character, body.slot, bag, town));

  /**
   * Lock and unlock (part 3 §3.2): allowed at any time, a hunt running or not
   * (part 3 §4), but guarded and versioned like every other write — the guard
   * and the increment now in the write's own transaction (R144).
   */
  app.post('/api/inventory/lock', async (request) => {
    const { account } = await caller(request);
    const key = requireIdempotencyKey(request);
    const body = parse(lockCommandSchema, request.body);
    await requireItem(account.id, body.itemId);

    return runTownCommand(deps, {
      accountId: account.id,
      expectedStateVersion: body.expectedStateVersion,
      operation: 'inventory.lock',
      idempotency: { key: `inventory.lock:${key}`, requestHash: await hashRequest(body) },
      townOnly: false,
    }, async (town) => {
      const bag = await loadBag(town.tx, account.id);
      const next = unwrap(bagLock(bag, body.itemId, body.locked), town.ctx.stateVersion);
      await persistBag(town.tx, bag, next, content);
      return { itemId: body.itemId, locked: body.locked, stateVersion: town.stateVersionAfter };
    });
  });
}
