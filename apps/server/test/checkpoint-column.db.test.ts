/**
 * P-28 and P-30: the checkpoint survives the database byte for byte, and a
 * checkpoint whose version columns do not match the deployed pins fails closed.
 *
 * The byte-equality is not a preference. The determinism and split-invariance
 * tests in `packages/sim` compare canonical encodings, and `jsonb` would
 * reorder keys and renormalise numbers underneath them — so the storage choice
 * is what keeps those tests meaningful (part 1 §9 #6).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { content, validateContent } from '@narok/data';
import { createGrid, createSimulation, defaultPlacement, defaultStrategy } from '@narok/sim';
import { connect, databaseReachable, disconnect, insertAccount, truncateAll, type Db } from './db-helpers';
import { loadCheckpoint, saveCheckpoint, CheckpointTooLargeError } from '../src/db/repositories/hunts';
import { withAccountTx } from '../src/db/tx';

let db: Db;

const validated = validateContent(content);
const sim = createSimulation(validated, createGrid(validated.grid, validated.shapes));

const PINS = {
  simulationVersion: 'a1',
  contentVersion: validated.version,
  gridHash: validated.gridHash,
} as const;

function sampleState() {
  // A real roster: `startState` validates that placement keys match the roster
  // exactly, so an empty placement is not a smaller fixture, it is an invalid one.
  const classes = ['guardian', 'cleric', 'ranger'] as const;
  const strategies = Object.fromEntries(classes.map((classId, index) => [`p${index}`, defaultStrategy(classId)]));
  return sim.start({
    seed: 7,
    classes: [...classes],
    recipe: 'mixed',
    placement: defaultPlacement([...classes]),
    strategies,
    rest: { hpStart: 50, mpStart: 30 },
    wipeLimit: 1,
  });
}

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

describe('P-30: bytes in, the same bytes out', () => {
  test('an encoded checkpoint round-trips byte-identically', async () => {
    const account = await insertAccount(db);
    const encoded = sim.encode(sampleState());

    await withAccountTx(db, { accountId: account.id, expectedStateVersion: 0, operation: 'hunt.start' }, async (tx) =>
      saveCheckpoint(tx, {
        accountId: account.id,
        status: 'running',
        mapId: 'meadow-outskirts',
        encoded,
        ...PINS,
        checkpointSchemaVersion: 1,
        simAnchorMs: 0,
        wallAnchorAt: new Date(),
        lastSeenAt: new Date(),
        maxBytes: 1024 * 1024,
      }),
    );

    const loaded = await loadCheckpoint(db, account.id, PINS);
    expect(loaded.encoded).toBe(encoded);
    expect(Buffer.from(loaded.encoded, 'utf8').equals(Buffer.from(encoded, 'utf8'))).toBe(true);
  });

  test('the round-tripped checkpoint still decodes into the state it came from', async () => {
    const account = await insertAccount(db);
    const before = sampleState();
    const encoded = sim.encode(before);

    await withAccountTx(db, { accountId: account.id, expectedStateVersion: 0, operation: 'hunt.start' }, async (tx) =>
      saveCheckpoint(tx, {
        accountId: account.id,
        status: 'running',
        mapId: 'meadow-outskirts',
        encoded,
        ...PINS,
        checkpointSchemaVersion: 1,
        simAnchorMs: 0,
        wallAnchorAt: new Date(),
        lastSeenAt: new Date(),
        maxBytes: 1024 * 1024,
      }),
    );

    const loaded = await loadCheckpoint(db, account.id, PINS);
    const after = sim.decode(loaded.encoded);
    // Re-encoding is the strongest available equality: canonical encoding is
    // exactly what the determinism tests compare (contracts §3).
    expect(sim.encode(after)).toBe(sim.encode(before));
  });

  test('a key order that jsonb would rewrite survives unchanged', async () => {
    const account = await insertAccount(db);
    // Deliberately un-sorted keys and a number jsonb would renormalise.
    const encoded = '{"zebra":1,"alpha":2,"scaled":1.50,"big":10000000000}';

    await withAccountTx(db, { accountId: account.id, expectedStateVersion: 0, operation: 'hunt.start' }, async (tx) =>
      saveCheckpoint(tx, {
        accountId: account.id,
        status: 'running',
        mapId: 'meadow-outskirts',
        encoded,
        ...PINS,
        checkpointSchemaVersion: 1,
        simAnchorMs: 0,
        wallAnchorAt: new Date(),
        lastSeenAt: new Date(),
        maxBytes: 1024 * 1024,
      }),
    );

    const loaded = await loadCheckpoint(db, account.id, PINS);
    expect(loaded.encoded).toBe(encoded);
  });
});

describe('P-28: a version mismatch fails closed', () => {
  test('the server substitutes nothing when the content version moved', async () => {
    const account = await insertAccount(db);
    const encoded = sim.encode(sampleState());

    await withAccountTx(db, { accountId: account.id, expectedStateVersion: 0, operation: 'hunt.start' }, async (tx) =>
      saveCheckpoint(tx, {
        accountId: account.id,
        status: 'running',
        mapId: 'meadow-outskirts',
        encoded,
        ...PINS,
        checkpointSchemaVersion: 1,
        simAnchorMs: 0,
        wallAnchorAt: new Date(),
        lastSeenAt: new Date(),
        maxBytes: 1024 * 1024,
      }),
    );

    await expect(
      loadCheckpoint(db, account.id, { ...PINS, contentVersion: 'a-different-content-version' }),
    ).rejects.toMatchObject({ code: 'WRONG_VERSION', field: 'contentVersion' });
  });

  test.each(['simulationVersion', 'gridHash'] as const)('a mismatched %s fails closed too', async (field) => {
    const account = await insertAccount(db);
    const encoded = sim.encode(sampleState());

    await withAccountTx(db, { accountId: account.id, expectedStateVersion: 0, operation: 'hunt.start' }, async (tx) =>
      saveCheckpoint(tx, {
        accountId: account.id,
        status: 'running',
        mapId: 'meadow-outskirts',
        encoded,
        ...PINS,
        checkpointSchemaVersion: 1,
        simAnchorMs: 0,
        wallAnchorAt: new Date(),
        lastSeenAt: new Date(),
        maxBytes: 1024 * 1024,
      }),
    );

    await expect(loadCheckpoint(db, account.id, { ...PINS, [field]: 'wrong' })).rejects.toMatchObject({
      code: 'WRONG_VERSION',
      field,
    });
  });
});

describe('the size cap refuses rather than truncates', () => {
  test('a blob past the configured cap is rejected before it is written', async () => {
    const account = await insertAccount(db);
    const encoded = 'x'.repeat(5_000);

    await expect(
      withAccountTx(db, { accountId: account.id, expectedStateVersion: 0, operation: 'hunt.start' }, async (tx) =>
        saveCheckpoint(tx, {
          accountId: account.id,
          status: 'running',
          mapId: 'meadow-outskirts',
          encoded,
          ...PINS,
          checkpointSchemaVersion: 1,
          simAnchorMs: 0,
          wallAnchorAt: new Date(),
          lastSeenAt: new Date(),
          maxBytes: 1_000,
        }),
      ),
    ).rejects.toBeInstanceOf(CheckpointTooLargeError);

    // Nothing partial was stored: a truncated checkpoint is a corrupt one.
    await expect(loadCheckpoint(db, account.id, PINS)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
