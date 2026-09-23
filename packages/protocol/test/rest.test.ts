/**
 * Every REST pair in part 1 §3 round-trips and rejects unknown keys. Strictness
 * is the point: a request that carries a field the server does not read is a
 * client asserting something, and part 1 §2's table says the server never
 * trusts a client's assertion.
 */
import { describe, expect, test } from 'vitest';
import {
  ROUTES,
  applyStrategySchema,
  buyRequestSchema,
  equipRequestSchema,
  guardedSchema,
  loginRequestSchema,
  registerRequestSchema,
  sellRequestSchema,
  startHuntSchema,
} from '../src/rest';

describe('the route table', () => {
  test('lists every row of part 1 §3 with its method, auth, guard and idempotency', () => {
    expect(ROUTES.length).toBe(23);
    const paths = ROUTES.map((route) => `${route.method} ${route.path}`);
    expect(paths).toContain('POST /api/auth/register');
    expect(paths).toContain('POST /api/auth/login');
    expect(paths).toContain('POST /api/hunts/current/strategy');
    expect(paths).toContain('POST /api/presets/loot/preview');
  });

  test('the preview route mutates nothing, so it takes no idempotency key and no guard', () => {
    const preview = ROUTES.find((route) => route.path === '/api/presets/loot/preview');
    expect(preview?.idempotent).toBe(false);
    expect(preview?.guarded).toBe(false);
  });

  test('every guarded route is also idempotent: an intent formed against a read is retried, not re-formed', () => {
    for (const route of ROUTES) {
      if (route.guarded) expect(route.idempotent, `${route.method} ${route.path}`).toBe(true);
    }
  });

  test('only the two credential routes are unauthenticated', () => {
    const open = ROUTES.filter((route) => route.auth === 'none').map((route) => route.path);
    expect(open.sort()).toEqual(['/api/auth/login', '/api/auth/register']);
  });
});

describe('request schemas', () => {
  test('register and login round-trip and refuse unknown keys', () => {
    const credentials = { email: 'player@example.com', password: 'a-sufficiently-long-password' };
    expect(registerRequestSchema.parse(credentials)).toEqual(credentials);
    expect(loginRequestSchema.parse(credentials)).toEqual(credentials);
    expect(registerRequestSchema.safeParse({ ...credentials, admin: true }).success).toBe(false);
  });

  test('an email is normalized to lower case so uniqueness means what it says', () => {
    expect(registerRequestSchema.parse({ email: 'Player@Example.COM', password: 'a-sufficiently-long-password' }).email)
      .toBe('player@example.com');
  });

  test('equip names an item, a character and a slot, and nothing else', () => {
    const request = { itemId: '11111111-1111-4111-8111-111111111111', characterId: '22222222-2222-4222-8222-222222222222', slot: 'weapon' };
    expect(equipRequestSchema.parse(request)).toEqual(request);
    expect(equipRequestSchema.safeParse({ ...request, slot: 'wings' }).success).toBe(false);
  });

  test('sell takes a bounded list of owned ids', () => {
    expect(sellRequestSchema.safeParse({ itemIds: [] }).success).toBe(false);
    expect(sellRequestSchema.safeParse({ itemIds: ['11111111-1111-4111-8111-111111111111'] }).success).toBe(true);
  });

  test('a purchase quantity is a positive integer', () => {
    expect(buyRequestSchema.safeParse({ definitionId: 'small-hp-potion', quantity: 0 }).success).toBe(false);
    expect(buyRequestSchema.safeParse({ definitionId: 'small-hp-potion', quantity: 1.5 }).success).toBe(false);
    expect(buyRequestSchema.safeParse({ definitionId: 'small-hp-potion', quantity: 5 }).success).toBe(true);
  });

  test('starting a hunt names a party, a map and presets, never a seed', () => {
    const request = {
      characterIds: ['11111111-1111-4111-8111-111111111111'],
      mapId: 'meadow-outskirts',
      strategyPresetId: '33333333-3333-4333-8333-333333333333',
      lootPresetId: '44444444-4444-4444-8444-444444444444',
    };
    expect(startHuntSchema.parse(request)).toEqual(request);
    // A seed is the server's (part 1 §2: seeds are never accepted from a client).
    expect(startHuntSchema.safeParse({ ...request, seed: 1 }).success).toBe(false);
  });

  test('applying a strategy names the preset and the version the player saw', () => {
    const request = { presetId: '33333333-3333-4333-8333-333333333333', presetVersion: 4 };
    expect(applyStrategySchema.parse(request)).toEqual(request);
    expect(applyStrategySchema.safeParse({ presetId: request.presetId }).success).toBe(false);
  });
});

describe('the optimistic-concurrency guard', () => {
  test('adds expectedStateVersion to a command formed against a read', () => {
    const schema = guardedSchema(buyRequestSchema);
    const parsed = schema.parse({ definitionId: 'small-hp-potion', quantity: 2, expectedStateVersion: 7 });
    expect(parsed.expectedStateVersion).toBe(7);
  });

  test('refuses a negative or fractional version', () => {
    const schema = guardedSchema(buyRequestSchema);
    expect(schema.safeParse({ definitionId: 'x', quantity: 1, expectedStateVersion: -1 }).success).toBe(false);
    expect(schema.safeParse({ definitionId: 'x', quantity: 1, expectedStateVersion: 1.5 }).success).toBe(false);
  });

  test('the guard is required: omitting it is a validation failure, not an unguarded write', () => {
    const schema = guardedSchema(buyRequestSchema);
    expect(schema.safeParse({ definitionId: 'small-hp-potion', quantity: 2 }).success).toBe(false);
  });
});
