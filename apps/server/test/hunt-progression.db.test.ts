/**
 * The loadout and progression a hunt runs on, and what a settlement writes
 * back (part 3 §5, §6; ruling R140): the party is read from the account's own
 * rows, the engine derives from them under pinned content, and every
 * settlement commits the engine's progression and the onboarding grant in the
 * same transaction as its rewards. The grants never touch the engine.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { content } from '@narok/data';
import { ONBOARDING_GRANT_KEY, bagState } from '@narok/progression';
import { deriveCharacter, resolveLoadout, type SimState } from '@narok/sim';
import { IDUN_APPLE_ID } from '@narok/data';
import { drizzleStores } from '../src/db/repositories/accounts';
import { loadBag } from '../src/db/repositories/inventory';
import * as schema from '../src/db/schema';
import { withAccountTx, type Tx } from '../src/db/tx';
import { persistHunt, stopHunt } from '../src/hunt/lifecycle';
import { FIRST_WIN_MARKER } from '../src/hunt/progression';
import { commitConsumption, commitRewards, type HuntReward } from '../src/hunt/rewards';
import { memoryStores } from '../src/store/memory';
import { grantOnboardingOnce, grantStarterKitOnce } from '../src/town/grants';
import { connect, databaseReachable, disconnect, insertAccount, insertCharacter, insertItem, truncateAll, type Db } from './db-helpers';
import { harness, ORIGIN, type Harness } from './helpers';
import { checkpointOf, insertLootPreset, insertStrategyPreset, rig, rules } from './hunt-db-harness';
import { party, validated } from './hunt-fixtures';

let db: Db;
let h: Harness;
let r: ReturnType<typeof rig>;

beforeAll(async () => {
  expect(await databaseReachable(), 'PostgreSQL must be running: pnpm db:up').toBe(true);
  db = await connect();
});

afterAll(async () => {
  await disconnect();
});

beforeEach(async () => {
  await truncateAll(db);
  r = rig(db);
  const now = () => r.clock.now;
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

async function version(accountId: string): Promise<number> {
  const [row] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
  return row.stateVersion;
}

/** The fixture party, as level-1 rows of the account, at full resources (clamped to the maxima at start). */
async function roster(who: Player, overrides: Partial<typeof schema.characters.$inferInsert> = {}) {
  const rows = [];
  for (const [slot, classId] of party.entries()) {
    rows.push(await insertCharacter(db, who.accountId, { slot, classId, hp: 1_000_000, mp: 1_000_000, ...overrides }));
  }
  return rows;
}

async function start(who: Player, characterIds: readonly string[], payload: unknown = rules()) {
  const strategy = await insertStrategyPreset(db, who.accountId, payload);
  const loot = await insertLootPreset(db, who.accountId);
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/hunts',
    headers: { origin: ORIGIN, cookie: who.cookie, 'idempotency-key': crypto.randomUUID() },
    payload: {
      characterIds, mapId: 'prototype', strategyPresetId: strategy.id, lootPresetId: loot.id,
      expectedStateVersion: await version(who.accountId),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function engineState(accountId: string): Promise<SimState> {
  return r.lifecycle.sim.decode((await checkpointOf(db, accountId)).state);
}

/** Settles the hunt `ms` of wall time later, as an offline catch-up would. */
async function settleAfter(accountId: string, ms: number) {
  r.clock.now += ms;
  return persistHunt(r.lifecycle, accountId, { live: false });
}

async function onboardingItems(accountId: string) {
  return db.select().from(schema.items)
    .where(and(eq(schema.items.accountId, accountId), eq(schema.items.sourceRef, ONBOARDING_GRANT_KEY)));
}

// ---------------------------------------------------------------------------

describe('the party a hunt starts from (ruling R148)', () => {
  test('equipped stats reach the engine actor: a weapon changes the attack the engine derives', async () => {
    const armed = await player();
    const bare = await player();
    const armedRoster = await roster(armed);
    const bareRoster = await roster(bare);
    const grant = validated.onboardingGrant.guardian;
    await insertItem(db, armed.accountId, {
      baseItemId: grant.definitionId, baseContentVersion: validated.version, rarity: grant.rarity,
      itemLevel: grant.itemLevel, bonuses: grant.bonuses, sourceRef: `${crypto.randomUUID()}:0`,
      equippedCharacterId: armedRoster[0].id, equippedSlot: 'weapon',
    });

    await start(armed, armedRoster.map((row) => row.id));
    await start(bare, bareRoster.map((row) => row.id));
    const withWeapon = await engineState(armed.accountId);
    const without = await engineState(bare.accountId);

    expect(withWeapon.progression!.p0.equipped).toHaveLength(1);
    expect(withWeapon.actors.p0.stats.atk).toBeGreaterThan(without.actors.p0.stats.atk);
    const expected = deriveCharacter({
      classId: 'guardian', level: 1, allocated: withWeapon.progression!.p0.attributes,
      loadout: resolveLoadout(withWeapon.progression!.p0.equipped, validated), content: validated,
    });
    expect(withWeapon.actors.p0.stats).toEqual(expected);
    expect(withWeapon.progression!.p0.characterId).toBe(armedRoster[0].id);
  });

  test('a preset naming a wipe limit is refused: a wipe ends the hunt (owner decision 2026-09-30)', async () => {
    const me = await player();
    const rows = await roster(me);
    const strategy = await insertStrategyPreset(db, me.accountId, { ...rules(), wipeLimit: 1 });
    const loot = await insertLootPreset(db, me.accountId);
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/hunts',
      headers: { origin: ORIGIN, cookie: me.cookie, 'idempotency-key': crypto.randomUUID() },
      payload: {
        characterIds: rows.map((row) => row.id), mapId: 'prototype', strategyPresetId: strategy.id, lootPresetId: loot.id,
        expectedStateVersion: await version(me.accountId),
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION' });
  });

  test('the engine\'s bag counts a consumable total past 999 as two slots, as the server does (ruling R137)', async () => {
    const me = await player();
    const rows = await roster(me);
    await db.insert(schema.stackItems).values({ accountId: me.accountId, definitionId: 'small-hp-potion', quantity: 990 });
    const kept = {
      rewardSeq: 0, atSimMs: 0, monsterId: 'm', itemLevel: 1,
      item: { kind: 'consumable', consumableId: 'small-hp-potion', quantity: 20 },
      disposition: { outcome: 'kept', action: 'keep', matched: 'default' },
      rewardId: 'h:0', lootPreset: { presetId: crypto.randomUUID(), presetVersion: 1 },
    } as unknown as HuntReward;
    await withAccountTx(db, { accountId: me.accountId, expectedStateVersion: await version(me.accountId), operation: 'test' }, (tx) =>
      commitRewards(tx, [kept], { accountId: me.accountId, stateVersionAfter: 1, contentVersion: validated.version, content: validated }));

    const [stack] = await db.select().from(schema.stackItems).where(eq(schema.stackItems.accountId, me.accountId));
    expect(stack.quantity).toBe(1_010);
    expect(bagState(await loadBag(db, me.accountId))).toMatchObject({ usedSlots: 2, held: { 'small-hp-potion': 1_010 } });
    const inventory = await h.app.inject({ method: 'GET', url: '/api/inventory', headers: { origin: ORIGIN, cookie: me.cookie } });
    expect(inventory.json()).toMatchObject({ usedSlots: 2, consumables: [{ consumableId: 'small-hp-potion', quantity: 1_010, stacks: 2 }] });

    await start(me, rows.map((row) => row.id));
    expect((await engineState(me.accountId)).bagState).toMatchObject({ usedSlots: 2, held: { 'small-hp-potion': 1_010 } });
  });
});

describe('what a settlement writes back (ruling R148)', () => {
  test('a settlement that levels a character persists its level, points, auto-spend and resources', async () => {
    const me = await player();
    const template = { targets: [{ attribute: 'vit', value: 10 }], remainder: 'str' };
    const rows = await roster(me, { autoSpend: template });
    // Apples keep a fresh level-1 party hunting long enough to level: one wipe now ends the hunt.
    await db.insert(schema.stackItems).values({ accountId: me.accountId, definitionId: IDUN_APPLE_ID, quantity: 200 });
    await start(me, rows.map((row) => row.id));
    await settleAfter(me.accountId, 300_000);

    const state = await engineState(me.accountId);
    for (const [index, row] of rows.entries()) {
      const [after] = await db.select().from(schema.characters).where(eq(schema.characters.id, row.id));
      const progress = state.progression![`p${index}`];
      expect(progress.level, 'five minutes levels a fresh party').toBeGreaterThan(1);
      expect(after).toMatchObject({
        level: progress.level, exp: progress.exp, expCarry: progress.expCarry, awardedLevel: progress.awardedLevels,
        unspentStatPoints: progress.statPoints, unspentSkillPoints: progress.skillPoints,
        attributes: progress.attributes, hp: state.actors[`p${index}`].hp, mp: state.actors[`p${index}`].mp,
      });
      expect((after.attributes as { vit: number }).vit, 'the template was followed').toBe(10);
      expect(after.autoSpend).toEqual(template);
    }
  });
});

describe('the onboarding grant (part 3 §6; rulings R146, R150)', () => {
  async function firstWinMarker(accountId: string) {
    return db.select().from(schema.accountGrants)
      .where(and(eq(schema.accountGrants.accountId, accountId), eq(schema.accountGrants.grantKey, FIRST_WIN_MARKER)));
  }

  test('the first win is marked when settled, and the grant lands at the return to town — never mid-hunt', async () => {
    const me = await player();
    const rows = await roster(me);
    await start(me, rows.map((row) => row.id));
    await settleAfter(me.accountId, 5_000);
    expect(await firstWinMarker(me.accountId), 'no win yet').toHaveLength(0);

    await settleAfter(me.accountId, 55_000);
    expect((await engineState(me.accountId)).metrics.wins).toBeGreaterThan(0);
    expect(await firstWinMarker(me.accountId), 'the first win is durable').toHaveLength(1);
    expect(await onboardingItems(me.accountId), 'a mid-hunt settlement grants nothing').toHaveLength(0);

    r.clock.now += 1_000;
    await stopHunt(r.lifecycle, { accountId: me.accountId });
    const granted = await onboardingItems(me.accountId);
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({ baseItemId: validated.onboardingGrant.guardian.definitionId, rarity: 'uncommon', boundTo: null });
    const audit = await db.select().from(schema.resourceAudit).where(eq(schema.resourceAudit.sourceRef, ONBOARDING_GRANT_KEY));
    expect(audit.map((row) => row.reason)).toEqual(['grant']);
    const [grant] = await db.select().from(schema.accountGrants)
      .where(and(eq(schema.accountGrants.accountId, me.accountId), eq(schema.accountGrants.grantKey, ONBOARDING_GRANT_KEY)));
    expect(grant.payload).toEqual({ itemIds: [granted[0].id] });

    // A later return grants nothing more.
    r.clock.now += 20_000;
    await start(me, rows.map((row) => row.id));
    r.clock.now += 1_000;
    await stopHunt(r.lifecycle, { accountId: me.accountId });
    expect((await onboardingItems(me.accountId)).map((row) => row.id)).toEqual([granted[0].id]);
  });

  test('a full bag at the return defers it; the next return grants it, even from a hunt with no win', async () => {
    const me = await player();
    const rows = await roster(me);
    await db.update(schema.accounts).set({ bagCapacity: 0 }).where(eq(schema.accounts.id, me.accountId));
    await start(me, rows.map((row) => row.id));
    await settleAfter(me.accountId, 60_000);
    r.clock.now += 1_000;
    await stopHunt(r.lifecycle, { accountId: me.accountId });
    expect(await onboardingItems(me.accountId)).toHaveLength(0);
    expect(await firstWinMarker(me.accountId)).toHaveLength(1);

    await db.update(schema.accounts).set({ bagCapacity: 100 }).where(eq(schema.accounts.id, me.accountId));
    r.clock.now += 20_000;
    await start(me, rows.map((row) => row.id));
    r.clock.now += 1_000;
    await stopHunt(r.lifecycle, { accountId: me.accountId });
    expect((await engineState(me.accountId)).metrics.wins, 'this hunt won nothing').toBe(0);
    expect(await onboardingItems(me.accountId)).toHaveLength(1);
  });

  test('the grant draws nothing and counts as no drop: the engine runs identically with and without it', async () => {
    const granting = await player();
    const holding = await player();
    const a = await roster(granting);
    const b = await roster(holding);
    // `holding` already has the grant, so nothing is granted at its return.
    await db.insert(schema.accountGrants).values({
      accountId: holding.accountId, grantKey: ONBOARDING_GRANT_KEY, kind: 'onboarding', payload: { itemIds: [] }, grantedBy: 'system',
    });
    await start(granting, a.map((row) => row.id));
    await start(holding, b.map((row) => row.id));
    // Inside the hunt: a level-1 party now wipes before 120 s, since the fallen stay dead (ruling R151).
    r.clock.now += 60_000;
    await stopHunt(r.lifecycle, { accountId: granting.accountId });
    await stopHunt(r.lifecycle, { accountId: holding.accountId });

    expect(await onboardingItems(granting.accountId)).toHaveLength(1);
    const with_ = await engineState(granting.accountId);
    const without = await engineState(holding.accountId);
    expect(with_.rng).toBe(without.rng);
    expect(with_.nextRewardSeq).toBe(without.nextRewardSeq);
    expect(with_.metrics).toEqual(without.metrics);
    expect(with_.dropProtection).toEqual(without.dropProtection);
    expect(with_.bagState).toEqual(without.bagState);
    const drops = await db.select().from(schema.resourceAudit).where(eq(schema.resourceAudit.accountId, granting.accountId));
    expect(drops.filter((row) => row.sourceRef === ONBOARDING_GRANT_KEY).map((row) => row.reason)).toEqual(['grant']);
  });
});

describe('death and the return to town (owner decision 2026-09-30; rulings R152, R154, R155)', () => {
  async function characterRow(id: string) {
    const [row] = await db.select().from(schema.characters).where(eq(schema.characters.id, id));
    return row;
  }

  test("an apple consumed mid-hunt is taken off its stack in the settlement's commit", async () => {
    const me = await player();
    const rows = await roster(me);
    await db.insert(schema.stackItems).values({ accountId: me.accountId, definitionId: IDUN_APPLE_ID, quantity: 5 });
    await start(me, rows.map((row) => row.id));
    expect((await engineState(me.accountId)).bagState.held).toEqual({ [IDUN_APPLE_ID]: 5 });

    await settleAfter(me.accountId, 300_000);
    const state = await engineState(me.accountId);
    const eaten = state.metrics.consumed[IDUN_APPLE_ID] ?? 0;
    expect(eaten, 'a level-1 party loses someone in five minutes').toBeGreaterThan(0);
    const [stack] = await db.select().from(schema.stackItems)
      .where(and(eq(schema.stackItems.accountId, me.accountId), eq(schema.stackItems.definitionId, IDUN_APPLE_ID)));
    expect(stack.quantity).toBe(5 - eaten);
    const audit = await db.select().from(schema.resourceAudit)
      .where(and(eq(schema.resourceAudit.accountId, me.accountId), eq(schema.resourceAudit.reason, 'consumed')));
    expect(audit.map((row) => row.delta)).toEqual([{ consumed: { [IDUN_APPLE_ID]: eaten } }]);
  });

  test('the last apple eaten leaves a zero stack the inventory does not list', async () => {
    const me = await player();
    const rows = await roster(me);
    await db.insert(schema.stackItems).values({ accountId: me.accountId, definitionId: IDUN_APPLE_ID, quantity: 1 });
    await start(me, rows.map((row) => row.id));

    await settleAfter(me.accountId, 300_000);
    expect((await engineState(me.accountId)).metrics.consumed[IDUN_APPLE_ID]).toBe(1);
    const [stack] = await db.select().from(schema.stackItems)
      .where(and(eq(schema.stackItems.accountId, me.accountId), eq(schema.stackItems.definitionId, IDUN_APPLE_ID)));
    expect(stack.quantity, 'the row stays, at zero').toBe(0);
    expect((await loadBag(db, me.accountId)).consumables).toEqual({});
    const inventory = await h.app.inject({ method: 'GET', url: '/api/inventory', headers: { origin: ORIGIN, cookie: me.cookie } });
    expect(inventory.json().consumables).toEqual([]);
  });

  test('consumption with no stack row to take it from fails the commit instead of passing silently', async () => {
    const me = await player();
    const attempt = withAccountTx(db, { accountId: me.accountId, expectedStateVersion: await version(me.accountId), operation: 'test' }, (tx) =>
      commitConsumption(tx, me.accountId, { [IDUN_APPLE_ID]: 1 }, 'h:span', 1));
    await expect(attempt).rejects.toThrow(/no idun-apple stack/);
    const audit = await db.select().from(schema.resourceAudit).where(eq(schema.resourceAudit.accountId, me.accountId));
    expect(audit.filter((row) => row.reason === 'consumed')).toEqual([]);
  });

  test('a player stop heals every character row, the dead and the living, to full HP and MP (R155)', async () => {
    const me = await player();
    const rows = await roster(me);
    await start(me, rows.map((row) => row.id));
    await settleAfter(me.accountId, 30_000);
    const midHunt = await engineState(me.accountId);
    const hurt = rows.filter((_, index) => {
      const actor = midHunt.actors[`p${index}`];
      return actor.hp < actor.stats.maxHp || actor.mp < actor.stats.maxMp;
    });
    expect(hurt.length, 'the party has spent something by 30 s').toBeGreaterThan(0);

    await stopHunt(r.lifecycle, { accountId: me.accountId });
    const home = await engineState(me.accountId);
    for (const [index, row] of rows.entries()) {
      const after = await characterRow(row.id);
      const { maxHp, maxMp } = home.actors[`p${index}`].stats;
      expect({ hp: after.hp, mp: after.mp, dead: after.dead }).toEqual({ hp: maxHp, mp: maxMp, dead: false });
    }
  });

  test('a full wipe stops the hunt, and the party starts again at full HP and MP', async () => {
    const me = await player();
    const rows = await roster(me);
    await start(me, rows.map((row) => row.id));
    await settleAfter(me.accountId, 600_000);
    const state = await engineState(me.accountId);
    expect(state.stopReason).toBe('wipe');
    expect(state.metrics.wipes).toBe(1);
    for (const [index, row] of rows.entries()) {
      const after = await characterRow(row.id);
      const { maxHp, maxMp } = state.actors[`p${index}`].stats;
      expect({ hp: after.hp, mp: after.mp, dead: after.dead }).toEqual({ hp: maxHp, mp: maxMp, dead: false });
    }

    r.clock.now += 60_000;
    await start(me, rows.map((row) => row.id));
    const next = await engineState(me.accountId);
    expect(next.phase).not.toBe('stopped');
    for (const id of ['p0', 'p1', 'p2']) {
      const actor = next.actors[id];
      expect([actor.hp, actor.mp]).toEqual([actor.stats.maxHp, actor.stats.maxMp]);
    }
  });
});

describe('grants repeat as no-ops returning the first instance (P-36)', () => {
  test('the starter kit and the onboarding grant, twice each: one row, one item, the same instance id', async () => {
    const account = await insertAccount(db);
    const hero = await insertCharacter(db, account.id, { slot: 0, classId: 'ranger' });
    const twice = async <T>(run: (tx: Tx, after: number) => Promise<T>): Promise<readonly [T, T]> => {
      const first = await withAccountTx<T>(db, { accountId: account.id, expectedStateVersion: await version(account.id), operation: 'test' },
        (tx) => run(tx, 1));
      const second = await withAccountTx<T>(db, { accountId: account.id, expectedStateVersion: await version(account.id), operation: 'test' },
        (tx) => run(tx, 2));
      return [first, second] as const;
    };

    const [kit1, kit2] = await twice((tx, after) => grantStarterKitOnce(tx, content, {
      accountId: account.id, characterId: hero.id, characterSlot: 0, classId: 'ranger',
    }, after));
    expect(kit1.outcome).toBe('granted');
    expect(kit2).toEqual({ outcome: 'existing', itemId: kit1.itemId });

    const [on1, on2] = await twice((tx, after) => grantOnboardingOnce(tx, content, account.id, 'ranger', after));
    expect(on1.outcome).toBe('granted');
    expect(on2).toEqual({ outcome: 'existing', itemId: on1.itemId });

    const grants = await db.select().from(schema.accountGrants).where(eq(schema.accountGrants.accountId, account.id));
    expect(grants.map((row) => row.grantKey).sort()).toEqual([ONBOARDING_GRANT_KEY, 'starter-kit:0']);
    const items = await db.select().from(schema.items).where(eq(schema.items.accountId, account.id));
    expect(items.map((row) => row.id).sort()).toEqual([kit1.itemId, on1.itemId].sort());
    const [stack] = await db.select().from(schema.stackItems).where(eq(schema.stackItems.accountId, account.id));
    expect(stack.quantity).toBe(20);
  });
});
