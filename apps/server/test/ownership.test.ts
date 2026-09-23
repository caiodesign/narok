/**
 * P-12 and part 1 §2's "what the client may never assert" table, one test per
 * row. Ownership is checked before business validation, and the response
 * distinguishes nothing about whether the object exists.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { harness, ORIGIN, type Harness } from './helpers';

let h: Harness;
let mine: string;
let theirs: string;

beforeEach(async () => {
  h = await harness();
  mine = await h.signUp('mine@example.com');
  theirs = await h.signUp('theirs@example.com');
});

afterEach(async () => {
  await h.app.close();
});

const OTHER_ID = '99999999-9999-4999-8999-999999999999';

describe('P-12: ownership precedes business validation', () => {
  test("another account's item is NOT_OWNED, and so is an item that does not exist", async () => {
    const theirAccount = await h.stores.accounts.byEmail('theirs@example.com');
    const theirItem = await h.stores.items.create(theirAccount!.id);

    const owned = await h.app.inject({
      method: 'POST',
      url: '/api/inventory/lock',
      headers: { origin: ORIGIN, cookie: mine, 'idempotency-key': 'k1' },
      payload: { itemId: theirItem.id, locked: true, expectedStateVersion: 0 },
    });
    const missing = await h.app.inject({
      method: 'POST',
      url: '/api/inventory/lock',
      headers: { origin: ORIGIN, cookie: mine, 'idempotency-key': 'k2' },
      payload: { itemId: OTHER_ID, locked: true, expectedStateVersion: 0 },
    });

    expect(owned.statusCode).toBe(403);
    expect(owned.json().code).toBe('NOT_OWNED');
    // Indistinguishable: existence must not leak through the status or the body.
    expect(missing.statusCode).toBe(owned.statusCode);
    expect(missing.json()).toEqual(owned.json());
  });

  test('the owner can act on the same item', async () => {
    const myAccount = await h.stores.accounts.byEmail('mine@example.com');
    const myItem = await h.stores.items.create(myAccount!.id);
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/inventory/lock',
      headers: { origin: ORIGIN, cookie: mine, 'idempotency-key': 'k3' },
      payload: { itemId: myItem.id, locked: true, expectedStateVersion: 0 },
    });
    expect(response.statusCode).not.toBe(403);
  });

  test('an unauthenticated caller learns nothing either', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/inventory/lock',
      headers: { origin: ORIGIN, 'idempotency-key': 'k4' },
      payload: { itemId: OTHER_ID, locked: true, expectedStateVersion: 0 },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('what the client may never assert (part 1 §2)', () => {
  test('a client-supplied elapsed time is a validation error, not an input', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/hunts',
      headers: { origin: ORIGIN, cookie: mine, 'idempotency-key': 'h1' },
      payload: {
        characterIds: [OTHER_ID],
        mapId: 'meadow-outskirts',
        strategyPresetId: OTHER_ID,
        lootPresetId: OTHER_ID,
        expectedStateVersion: 0,
        elapsedMs: 60_000,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('VALIDATION');
  });

  test('a client-supplied command timestamp is a validation error', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/hunts/current/strategy',
      headers: { origin: ORIGIN, cookie: mine, 'idempotency-key': 'h2' },
      payload: { presetId: OTHER_ID, presetVersion: 1, expectedStateVersion: 0, commandAt: Date.now() },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('VALIDATION');
  });

  test('a client-supplied seed is a validation error', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/hunts',
      headers: { origin: ORIGIN, cookie: mine, 'idempotency-key': 'h3' },
      payload: {
        characterIds: [OTHER_ID],
        mapId: 'meadow-outskirts',
        strategyPresetId: OTHER_ID,
        lootPresetId: OTHER_ID,
        expectedStateVersion: 0,
        seed: 1,
      },
    });
    expect(response.statusCode).toBe(400);
  });

  test('expectedStateVersion is read as a guard and never written as a value', async () => {
    const account = (await h.stores.accounts.byEmail('mine@example.com'))!;
    const before = account.stateVersion;
    const myItem = await h.stores.items.create(account.id);

    await h.app.inject({
      method: 'POST',
      url: '/api/inventory/lock',
      headers: { origin: ORIGIN, cookie: mine, 'idempotency-key': 'g1' },
      payload: { itemId: myItem.id, locked: true, expectedStateVersion: 500 },
    });

    expect((await h.stores.accounts.byEmail('mine@example.com'))!.stateVersion).toBe(before);
  });

  test('every response carries the account state version the caller may guard against', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: theirs } });
    expect(response.statusCode).toBe(200);
    expect(typeof response.json().stateVersion).toBe('number');
  });
});
