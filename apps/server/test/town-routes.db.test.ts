/**
 * The town commands over a real database (part 1 §3; part 3 §3–§5; gates B-13,
 * B-16). Every mutating route refuses in one order — ownership (absent and
 * not-yours identical, P-12), then the account guard (P-23), then town-only,
 * then the rule — and a refusal commits nothing: no row moves and the account
 * version stays where it was.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { content, validateContent, type Content } from '@narok/data';
import { pointBudget, statCost } from '@narok/progression';
import { createGrid, createSimulation } from '@narok/sim';
import { drizzleStores } from '../src/db/repositories/accounts';
import * as schema from '../src/db/schema';
import { memoryStores } from '../src/store/memory';
import { connect, databaseReachable, disconnect, insertItem, truncateAll, type Db } from './db-helpers';
import { harness, ORIGIN, type Harness } from './helpers';
import { rig } from './hunt-db-harness';

/**
 * The bundled content with the head piece raised to tier 2, so one definition
 * carries a level requirement a new character does not meet. Its own version
 * string: items made for it are pinned to it.
 */
const town: Content = validateContent({
  ...structuredClone(content),
  version: `${content.version}-town`,
  items: {
    ...structuredClone(content.items),
    'leather-cap': { ...structuredClone(content.items['leather-cap']!), tier: 2, levelRequirement: 10 },
  },
});
const townSim = createSimulation(town, createGrid(town.grid, town.shapes));

let db: Db;
let h: Harness;
let clock: { now: number };

beforeAll(async () => {
  expect(await databaseReachable(), 'PostgreSQL must be running: pnpm db:up').toBe(true);
  db = await connect();
});

afterAll(async () => {
  await disconnect();
});

beforeEach(async () => {
  await truncateAll(db);
  const r = rig(db, { engine: { sim: townSim, content: town } });
  clock = r.clock;
  const now = () => clock.now;
  const fallback = memoryStores({ now });
  h = await harness(
    { secureCookies: false },
    {
      now,
      stores: { ...drizzleStores(db, { now, bagCapacity: 100 }), audit: fallback.audit, commands: fallback.commands },
      hunts: { lifecycle: r.lifecycle, sequencer: r.commands.sequencer },
    },
  );
});

interface Player {
  readonly accountId: string;
  readonly cookie: string;
}

async function player(): Promise<Player> {
  const email = `p-${crypto.randomUUID()}@example.com`;
  const cookie = await h.signUp(email);
  const [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.email, email));
  return { accountId: account.id, cookie };
}

async function version(who: Player): Promise<number> {
  const [row] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, who.accountId));
  return row.stateVersion;
}

function call(who: Player, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, key: string = crypto.randomUUID()) {
  return h.app.inject({
    method,
    url,
    headers: { origin: ORIGIN, cookie: who.cookie, ...(method === 'GET' ? {} : { 'idempotency-key': key }) },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

let names = 0;
async function create(who: Player, slot: number, classId: string) {
  names += 1;
  const response = await call(who, 'POST', '/api/characters', {
    slot, name: `Hero${names}x`, classId, expectedStateVersion: await version(who),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().character as { id: string; [key: string]: unknown };
}

async function characterRow(id: string) {
  const [row] = await db.select().from(schema.characters).where(eq(schema.characters.id, id));
  return row;
}

/** A running hunt row: all town-only needs to see is that one exists. */
async function hunting(who: Player): Promise<void> {
  await db.insert(schema.hunts).values({
    accountId: who.accountId,
    status: 'running',
    mapId: 'prototype',
    checkpoint: Buffer.from('{}'),
    checkpointSchemaVersion: 1,
    simulationVersion: 'b1',
    contentVersion: town.version,
    gridHash: town.gridHash,
    simAnchorMs: 0,
    wallAnchorAt: new Date(clock.now),
    lastSeenAt: new Date(clock.now),
  });
}

function item(who: Player, baseItemId: string, overrides: Partial<typeof schema.items.$inferInsert> = {}) {
  return insertItem(db, who.accountId, {
    baseItemId,
    baseContentVersion: town.version,
    twoHanded: town.items[baseItemId]?.handedness === 'two-handed',
    ...overrides,
  });
}

const SPEND = { str: 0, agi: 0, vit: 0, int: 0, dex: 0, luk: 0 };

// ---------------------------------------------------------------------------

describe('POST /api/characters and the starter kit (part 3 §4 OPEN DECISION, spec §4.1)', () => {
  test('creates a level-1 character at full HP and MP and grants its starter kit in the same commit', async () => {
    const me = await player();
    const before = await version(me);
    const response = await call(me, 'POST', '/api/characters', {
      slot: 0, name: 'Aldric', classId: 'guardian', expectedStateVersion: before,
    });
    expect(response.statusCode, response.body).toBe(200);
    const { character, stateVersion } = response.json();
    expect(stateVersion).toBe(before + 1);
    expect(character).toMatchObject({ slot: 0, name: 'Aldric', classId: 'guardian', level: 1, statPoints: 30, skillPoints: 1 });
    expect(character.hp).toBe(character.maxHp);
    expect(character.mp).toBe(character.maxMp);

    const grants = await db.select().from(schema.accountGrants).where(eq(schema.accountGrants.accountId, me.accountId));
    expect(grants.map((row) => row.grantKey)).toEqual(['starter-kit:0']);
    const items = await db.select().from(schema.items).where(eq(schema.items.accountId, me.accountId));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ baseItemId: 'guardian-sword', boundTo: character.id, sourceRef: 'starter-kit:0' });
    expect(grants[0].payload).toEqual({ itemIds: [items[0].id] });
    const stacks = await db.select().from(schema.stackItems).where(eq(schema.stackItems.accountId, me.accountId));
    expect(stacks.map((row) => [row.definitionId, row.quantity])).toEqual([['small-hp-potion', 20]]);
    const audit = await db.select().from(schema.resourceAudit).where(eq(schema.resourceAudit.accountId, me.accountId));
    expect(audit.map((row) => [row.reason, row.sourceRef, row.stateVersionAfter])).toEqual([['grant', 'starter-kit:0', before + 1]]);
  });

  test('a later slot gets its own bound weapon and no potions', async () => {
    const me = await player();
    await create(me, 0, 'guardian');
    const cleric = await create(me, 1, 'cleric');
    const weapons = await db.select().from(schema.items).where(eq(schema.items.boundTo, cleric.id));
    expect(weapons.map((row) => row.baseItemId)).toEqual(['cleric-mace']);
    const stacks = await db.select().from(schema.stackItems).where(eq(schema.stackItems.accountId, me.accountId));
    expect(stacks.map((row) => row.quantity)).toEqual([20]);
  });

  test('recreating a slot grants nothing: one grant row, no second weapon, no second potion stack', async () => {
    const me = await player();
    const first = await create(me, 0, 'guardian');
    await db.delete(schema.characters).where(eq(schema.characters.id, first.id));
    await create(me, 0, 'arcanist');

    const grants = await db.select().from(schema.accountGrants).where(eq(schema.accountGrants.accountId, me.accountId));
    expect(grants).toHaveLength(1);
    const items = await db.select().from(schema.items).where(eq(schema.items.accountId, me.accountId));
    expect(items, 'the bound weapon left with its character; none replaces it').toHaveLength(0);
    const stacks = await db.select().from(schema.stackItems).where(eq(schema.stackItems.accountId, me.accountId));
    expect(stacks.map((row) => row.quantity)).toEqual([20]);
  });

  test('a taken slot, a taken name (case-folded, any account) and an unknown class are refused', async () => {
    const me = await player();
    const other = await player();
    await call(other, 'POST', '/api/characters', { slot: 0, name: 'Morwen', classId: 'cleric', expectedStateVersion: 0 });
    await create(me, 0, 'guardian');
    const at = await version(me);

    const slot = await call(me, 'POST', '/api/characters', { slot: 0, name: 'Fresh', classId: 'ranger', expectedStateVersion: at });
    expect(slot.json()).toMatchObject({ code: 'RULE_VIOLATION', field: 'SLOT_TAKEN' });
    const name = await call(me, 'POST', '/api/characters', { slot: 1, name: 'MORWEN', classId: 'ranger', expectedStateVersion: at });
    expect(name.json()).toMatchObject({ code: 'RULE_VIOLATION', field: 'NAME_TAKEN' });
    const unknown = await call(me, 'POST', '/api/characters', { slot: 1, name: 'Fresh', classId: 'bard', expectedStateVersion: at });
    expect(unknown.json()).toMatchObject({ code: 'VALIDATION', field: 'classId' });
    expect(await version(me)).toBe(at);
  });

  test('a bag too full for the kit refuses the creation and creates nothing (ruling R146)', async () => {
    const me = await player();
    await db.update(schema.accounts).set({ bagCapacity: 0 }).where(eq(schema.accounts.id, me.accountId));
    const response = await call(me, 'POST', '/api/characters', { slot: 0, name: 'Crowded', classId: 'guardian', expectedStateVersion: 0 });
    expect(response.json()).toMatchObject({ code: 'RULE_VIOLATION', field: 'BAG_FULL' });
    expect(await db.select().from(schema.characters)).toHaveLength(0);
    expect(await db.select().from(schema.accountGrants)).toHaveLength(0);
    expect(await version(me)).toBe(0);
  });

  test('a replayed creation answers the same and creates once; the stale guard and town-only still apply', async () => {
    const me = await player();
    const body = { slot: 0, name: 'Twice', classId: 'ranger', expectedStateVersion: 0 };
    const first = await call(me, 'POST', '/api/characters', body, 'create-key');
    const second = await call(me, 'POST', '/api/characters', body, 'create-key');
    expect(second.json()).toEqual(first.json());
    expect(await db.select().from(schema.characters)).toHaveLength(1);

    const stale = await call(me, 'POST', '/api/characters', { ...body, slot: 1, name: 'Other', expectedStateVersion: 0 });
    expect(stale.json()).toMatchObject({ code: 'CONFLICT_STATE_VERSION', stateVersion: 1 });
    await hunting(me);
    const away = await call(me, 'POST', '/api/characters', { ...body, slot: 1, name: 'Other', expectedStateVersion: 1 });
    expect(away.json()).toMatchObject({ code: 'RULE_VIOLATION', field: 'TOWN_ONLY' });
  });

  test('GET /api/characters lists the account\'s own characters with derived stats', async () => {
    const me = await player();
    const other = await player();
    const mine = await create(me, 0, 'guardian');
    await create(other, 0, 'cleric');
    const response = await call(me, 'GET', '/api/characters');
    const body = response.json();
    expect(body.characters.map((row: { id: string }) => row.id)).toEqual([mine.id]);
    expect(body.characters[0].stats).toMatchObject({ maxHp: expect.any(Number), atk: expect.any(Number) });
    expect(body.stateVersion).toBe(await version(me));
  });
});

describe('POST /api/characters/:id/attributes (part 3 §5.3; gate B-16)', () => {
  async function allocate(who: Player, id: string, spend: Record<string, number>, quotedCost: number, expectedStateVersion?: number, key?: string) {
    return call(who, 'POST', `/api/characters/${id}/attributes`, {
      spend: { ...SPEND, ...spend }, quotedCost, expectedStateVersion: expectedStateVersion ?? (await version(who)),
    }, key);
  }

  test('applies a staged allocation at the replayed cost, atomically with the version increment', async () => {
    const me = await player();
    const hero = await create(me, 0, 'guardian');
    const before = await version(me);
    const cost = statCost(1, 6);
    const response = await allocate(me, hero.id, { vit: 5 }, cost);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().stateVersion).toBe(before + 1);
    const row = await characterRow(hero.id);
    expect(row.attributes).toMatchObject({ vit: 6 });
    expect(row.unspentStatPoints).toBe(30 - cost);
    // Raising VIT raises Max HP and heals nothing (spec §4.1 option (a)).
    expect(row.hp).toBe(hero.hp);
    expect(response.json().character.maxHp).toBeGreaterThan(hero.maxHp as number);
  });

  test('refusals come in order: ownership, then the guard, then town-only, then the rule', async () => {
    const me = await player();
    const other = await player();
    const mine = await create(me, 0, 'guardian');
    const theirs = await create(other, 0, 'cleric');
    const current = await version(me);
    await hunting(me);

    // Not-yours and absent answer identically, even with a stale guard and a hunt running.
    const foreign = await allocate(me, theirs.id, { str: 1 }, 99, current + 9);
    const absent = await allocate(me, crypto.randomUUID(), { str: 1 }, 99, current + 9);
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toEqual(absent.json());
    expect(foreign.json()).toMatchObject({ code: 'NOT_OWNED', field: 'characterId' });

    const stale = await allocate(me, mine.id, { str: 1 }, 99, current + 9);
    expect(stale.json()).toMatchObject({ code: 'CONFLICT_STATE_VERSION', stateVersion: current });

    const away = await allocate(me, mine.id, { str: 1 }, 99, current);
    expect(away.json()).toMatchObject({ code: 'RULE_VIOLATION', field: 'TOWN_ONLY' });
  });

  test('CAP_EXCEEDED, then COST_MISMATCH, then INSUFFICIENT_POINTS — and a refusal changes nothing', async () => {
    const me = await player();
    const hero = await create(me, 0, 'guardian');
    const rowBefore = await characterRow(hero.id);
    const at = await version(me);

    expect((await allocate(me, hero.id, { str: 99 }, statCost(1, 100), at)).json())
      .toMatchObject({ code: 'RULE_VIOLATION', field: 'CAP_EXCEEDED', stateVersion: at });
    expect((await allocate(me, hero.id, { str: 2 }, statCost(1, 3) + 1, at)).json())
      .toMatchObject({ code: 'RULE_VIOLATION', field: 'COST_MISMATCH' });
    const tooDear = statCost(1, 17);
    expect(tooDear).toBeGreaterThan(30);
    expect((await allocate(me, hero.id, { str: 16 }, tooDear, at)).json())
      .toMatchObject({ code: 'RULE_VIOLATION', field: 'INSUFFICIENT_POINTS' });

    expect(await characterRow(hero.id)).toEqual(rowBefore);
    expect(await version(me)).toBe(at);
  });

  test('the same idempotency key replays the stored answer; reused for other input it is refused', async () => {
    const me = await player();
    const hero = await create(me, 0, 'guardian');
    const at = await version(me);
    const first = await allocate(me, hero.id, { dex: 1 }, statCost(1, 2), at, 'alloc-key');
    const again = await allocate(me, hero.id, { dex: 1 }, statCost(1, 2), at, 'alloc-key');
    expect(again.json()).toEqual(first.json());
    expect((await characterRow(hero.id)).unspentStatPoints).toBe(30 - statCost(1, 2));
    const reused = await allocate(me, hero.id, { luk: 1 }, statCost(1, 2), at + 1, 'alloc-key');
    expect(reused.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});

describe('skills, respec and the auto-spend template (part 3 §4, §5.2, §5.4)', () => {
  test('a skill rank costs one point, caps at the content maximum, and needs the points', async () => {
    const me = await player();
    const hero = await create(me, 0, 'guardian');
    const skillId = town.classes.guardian.skills[0]!;
    const at = await version(me);
    const over = await call(me, 'POST', `/api/characters/${hero.id}/skills`, { skillId, targetRank: 6, expectedStateVersion: at });
    expect(over.json()).toMatchObject({ code: 'RULE_VIOLATION', field: 'CAP_EXCEEDED' });
    const dear = await call(me, 'POST', `/api/characters/${hero.id}/skills`, { skillId, targetRank: 2, expectedStateVersion: at });
    expect(dear.json()).toMatchObject({ code: 'RULE_VIOLATION', field: 'INSUFFICIENT_POINTS' });
    const ok = await call(me, 'POST', `/api/characters/${hero.id}/skills`, { skillId, targetRank: 1, expectedStateVersion: at });
    expect(ok.statusCode, ok.body).toBe(200);
    const row = await characterRow(hero.id);
    expect(row.skills).toEqual({ [skillId]: 1 });
    expect(row.unspentSkillPoints).toBe(0);
  });

  test('respec awards any unawarded level first, refunds the full earned budget, and leaves equipment on', async () => {
    const me = await player();
    const hero = await create(me, 0, 'guardian');
    const [sword] = await db.select().from(schema.items).where(eq(schema.items.boundTo, hero.id));
    const equip = await call(me, 'POST', '/api/inventory/equip', {
      itemId: sword.id, characterId: hero.id, slot: 'weapon', expectedStateVersion: await version(me),
    });
    expect(equip.statusCode, equip.body).toBe(200);
    await call(me, 'POST', `/api/characters/${hero.id}/attributes`, {
      spend: { ...SPEND, str: 3 }, quotedCost: statCost(1, 4), expectedStateVersion: await version(me),
    });
    // Level 3 reached but only level 1 awarded: a respec must not refund less than was earned.
    await db.update(schema.characters).set({ level: 3 }).where(eq(schema.characters.id, hero.id));

    const response = await call(me, 'POST', `/api/characters/${hero.id}/respec`, { scope: 'both', expectedStateVersion: await version(me) });
    expect(response.statusCode, response.body).toBe(200);
    const row = await characterRow(hero.id);
    const budget = pointBudget(3, town.progression);
    expect(row.attributes).toEqual({ str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 });
    expect(row.unspentStatPoints).toBe(budget.statPoints);
    expect(row.unspentSkillPoints).toBe(budget.skillPoints);
    expect(row.awardedLevel).toBe(3);
    const [still] = await db.select().from(schema.items).where(eq(schema.items.id, sword.id));
    expect(still.equippedCharacterId).toBe(hero.id);
  });

  test('the auto-spend template is a town-only edit, validated, and cleared by null (ruling R143)', async () => {
    const me = await player();
    const hero = await create(me, 0, 'guardian');
    const template = { targets: [{ attribute: 'vit', value: 20 }], remainder: 'str' };
    const set = await call(me, 'PUT', `/api/characters/${hero.id}/auto-spend`, { template, expectedStateVersion: await version(me) });
    expect(set.statusCode, set.body).toBe(200);
    expect((await characterRow(hero.id)).autoSpend).toEqual(template);

    const duplicate = { targets: [{ attribute: 'vit', value: 20 }, { attribute: 'vit', value: 30 }], remainder: null };
    const bad = await call(me, 'PUT', `/api/characters/${hero.id}/auto-spend`, { template: duplicate, expectedStateVersion: await version(me) });
    expect(bad.json()).toMatchObject({ code: 'VALIDATION', field: 'template.targets.1.attribute' });

    await hunting(me);
    const away = await call(me, 'PUT', `/api/characters/${hero.id}/auto-spend`, { template: null, expectedStateVersion: await version(me) });
    expect(away.json()).toMatchObject({ code: 'RULE_VIOLATION', field: 'TOWN_ONLY' });
    expect((await characterRow(hero.id)).autoSpend).toEqual(template);
  });
});

describe('the inventory (part 3 §3–§4; gate B-13)', () => {
  test('GET /api/inventory lists every owned item, the stacks with their slot counts, and the capacity', async () => {
    const me = await player();
    await create(me, 0, 'guardian');
    const response = await call(me, 'GET', '/api/inventory');
    const body = response.json();
    expect(body).toMatchObject({ capacity: 100, usedSlots: 2, stateVersion: await version(me) });
    expect(body.items).toHaveLength(1);
    expect(body.consumables).toEqual([{ consumableId: 'small-hp-potion', quantity: 20, stacks: 1 }]);
  });

  test('equips an eligible item, frees its bag slot and heals nothing', async () => {
    const me = await player();
    const hero = await create(me, 0, 'guardian');
    const vest = await item(me, 'padded-vest');
    const response = await call(me, 'POST', '/api/inventory/equip', {
      itemId: vest.id, characterId: hero.id, slot: 'body', expectedStateVersion: await version(me),
    });
    expect(response.statusCode, response.body).toBe(200);
    const [row] = await db.select().from(schema.items).where(eq(schema.items.id, vest.id));
    expect([row.equippedCharacterId, row.equippedSlot]).toEqual([hero.id, 'body']);
    expect(response.json().inventory.usedSlots).toBe(2);
    expect((await characterRow(hero.id)).hp).toBe(hero.hp);
  });

  test('refuses a wrong slot, a wrong class, an unmet level, another character\'s bound item and a foreign item', async () => {
    const me = await player();
    const other = await player();
    const guardian = await create(me, 0, 'guardian');
    const cleric = await create(me, 1, 'cleric');
    const cap = await item(me, 'leather-cap');
    const mace = await item(me, 'cleric-mace');
    const vest = await item(me, 'padded-vest');
    const [clericWeapon] = await db.select().from(schema.items).where(eq(schema.items.boundTo, cleric.id));
    const foreign = await item(other, 'padded-vest');
    const at = await version(me);
    const equip = (itemId: string, slot: string) =>
      call(me, 'POST', '/api/inventory/equip', { itemId, characterId: guardian.id, slot, expectedStateVersion: at });

    expect((await equip(vest.id, 'head')).json()).toMatchObject({ code: 'RULE_VIOLATION', field: 'SLOT_MISMATCH' });
    expect((await equip(mace.id, 'weapon')).json()).toMatchObject({ code: 'RULE_VIOLATION', field: 'CLASS_RESTRICTION' });
    expect((await equip(cap.id, 'head')).json()).toMatchObject({ code: 'RULE_VIOLATION', field: 'LEVEL_REQUIREMENT' });
    expect((await equip(clericWeapon.id, 'weapon')).json()).toMatchObject({ code: 'RULE_VIOLATION', field: 'CLASS_RESTRICTION' });
    const absent = await equip(crypto.randomUUID(), 'body');
    expect((await equip(foreign.id, 'body')).json()).toEqual(absent.json());
    expect(absent.json()).toMatchObject({ code: 'NOT_OWNED', field: 'itemId' });
    expect(await version(me)).toBe(at);
  });

  test('another character\'s bound item is refused even when its class could wear it', async () => {
    const me = await player();
    const first = await create(me, 0, 'guardian');
    const second = await create(me, 1, 'guardian');
    const [bound] = await db.select().from(schema.items).where(eq(schema.items.boundTo, first.id));
    const response = await call(me, 'POST', '/api/inventory/equip', {
      itemId: bound.id, characterId: second.id, slot: 'weapon', expectedStateVersion: await version(me),
    });
    expect(response.json()).toMatchObject({ code: 'RULE_VIOLATION', field: 'CHARACTER_BOUND' });
  });

  test('a two-handed weapon takes the off-hand off into the bag, and fails whole when the bag cannot hold it', async () => {
    const me = await player();
    const ranger = await create(me, 0, 'ranger');
    const buckler = await item(me, 'wooden-buckler', { equippedCharacterId: ranger.id, equippedSlot: 'offhand' });
    const [bow] = await db.select().from(schema.items).where(eq(schema.items.boundTo, ranger.id));
    expect(bow.twoHanded).toBe(true);

    // The bag holds the bow and the potion stack: with the bow leaving and the
    // buckler arriving it is still full — so a capacity of 1 cannot take it.
    await db.update(schema.accounts).set({ bagCapacity: 1 }).where(eq(schema.accounts.id, me.accountId));
    const at = await version(me);
    const full = await call(me, 'POST', '/api/inventory/equip', { itemId: bow.id, characterId: ranger.id, slot: 'weapon', expectedStateVersion: at });
    expect(full.json()).toMatchObject({ code: 'RULE_VIOLATION', field: 'BAG_FULL' });
    const [unchanged] = await db.select().from(schema.items).where(eq(schema.items.id, buckler.id));
    expect(unchanged.equippedSlot).toBe('offhand');
    expect(await version(me)).toBe(at);

    await db.update(schema.accounts).set({ bagCapacity: 100 }).where(eq(schema.accounts.id, me.accountId));
    const ok = await call(me, 'POST', '/api/inventory/equip', { itemId: bow.id, characterId: ranger.id, slot: 'weapon', expectedStateVersion: at });
    expect(ok.statusCode, ok.body).toBe(200);
    const worn = await db.select().from(schema.items).where(eq(schema.items.equippedCharacterId, ranger.id));
    expect(worn.map((row) => row.equippedSlot)).toEqual(['weapon']);

    // And under the bow, the off-hand stays closed.
    const back = await call(me, 'POST', '/api/inventory/equip', { itemId: buckler.id, characterId: ranger.id, slot: 'offhand', expectedStateVersion: at + 1 });
    expect(back.json()).toMatchObject({ code: 'RULE_VIOLATION', field: 'TWO_HANDED' });
  });

  test('unequip returns the item to the bag; an empty slot is refused; both are town-only', async () => {
    const me = await player();
    const hero = await create(me, 0, 'guardian');
    const vest = await item(me, 'padded-vest', { equippedCharacterId: hero.id, equippedSlot: 'body' });
    const empty = await call(me, 'POST', '/api/inventory/unequip', { characterId: hero.id, slot: 'head', expectedStateVersion: await version(me) });
    expect(empty.json()).toMatchObject({ code: 'RULE_VIOLATION', field: 'SLOT_EMPTY' });
    const ok = await call(me, 'POST', '/api/inventory/unequip', { characterId: hero.id, slot: 'body', expectedStateVersion: await version(me) });
    expect(ok.statusCode, ok.body).toBe(200);
    const [row] = await db.select().from(schema.items).where(eq(schema.items.id, vest.id));
    expect(row.equippedCharacterId).toBeNull();

    await hunting(me);
    const equip = await call(me, 'POST', '/api/inventory/equip', { itemId: vest.id, characterId: hero.id, slot: 'body', expectedStateVersion: await version(me) });
    expect(equip.json()).toMatchObject({ code: 'RULE_VIOLATION', field: 'TOWN_ONLY' });
  });

  test('lock is guarded and versioned in one transaction, and allowed while a hunt runs (part 3 §4)', async () => {
    const me = await player();
    const vest = await item(me, 'padded-vest');
    await hunting(me);
    const at = await version(me);
    const stale = await call(me, 'POST', '/api/inventory/lock', { itemId: vest.id, locked: true, expectedStateVersion: at + 1 });
    expect(stale.json()).toMatchObject({ code: 'CONFLICT_STATE_VERSION', stateVersion: at });
    const ok = await call(me, 'POST', '/api/inventory/lock', { itemId: vest.id, locked: true, expectedStateVersion: at });
    expect(ok.json()).toEqual({ itemId: vest.id, locked: true, stateVersion: at + 1 });
    const [row] = await db.select().from(schema.items).where(and(eq(schema.items.id, vest.id)));
    expect(row.locked).toBe(true);
    expect(await version(me)).toBe(at + 1);
  });
});
