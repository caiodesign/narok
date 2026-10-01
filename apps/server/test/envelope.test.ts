/**
 * The checkpoint envelope (part 2 §2, B-L08, P-28).
 *
 * The property that matters most is the boundary: the engine's encoding
 * travels through the envelope as an opaque string, so the byte-equality the
 * determinism tests rest on survives the round trip. Everything else here is
 * the envelope failing closed rather than guessing.
 */
import { describe, expect, test } from 'vitest';
import { content, validateContent } from '@narok/data';
import { createGrid, createSimulation, defaultPlacement, defaultStrategy } from '@narok/sim';
import {
  decodeCheckpoint,
  encodeCheckpoint,
  ENVELOPE_VERSION,
  EnvelopeError,
  rewardIdFor,
  type CheckpointEnvelope,
} from '../src/hunt/envelope';

const validated = validateContent(content);
const sim = createSimulation(validated, createGrid(validated.grid, validated.shapes));

function engineState(): string {
  const classes = ['guardian', 'cleric', 'ranger'] as const;
  return sim.encode(
    sim.start({
      seed: 7,
      classes: [...classes],
      recipe: 'mixed',
      placement: defaultPlacement([...classes]),
      strategies: Object.fromEntries(classes.map((id, index) => [`p${index}`, defaultStrategy(id)])),
      rest: { hpStart: 50, mpStart: 30 },
    }),
  );
}

function envelope(overrides: Partial<CheckpointEnvelope> = {}): CheckpointEnvelope {
  return {
    envelopeVersion: ENVELOPE_VERSION,
    accountId: '11111111-1111-4111-8111-111111111111',
    huntId: '22222222-2222-4222-8222-222222222222',
    generation: 1,
    checkpointSeq: 0,
    accountStateVersion: 3,
    wallAnchorMs: 1_800_000_000_000,
    simAnchorMs: 0,
    pausedWallMs: 0,
    lastSeenAt: 1_800_000_000_000,
    offlineCapMs: 43_200_000,
    activeStrategy: { presetId: '33333333-3333-4333-8333-333333333333', presetVersion: 1 },
    activeLoot: { presetId: '44444444-4444-4444-8444-444444444444', presetVersion: 1 },
    pendingStrategy: null,
    pendingLoot: [],
    stopContext: null,
    state: engineState(),
    ...overrides,
  };
}

describe('the engine encoding survives the envelope untouched', () => {
  test('the state string comes back byte-identical', () => {
    const state = engineState();
    const decoded = decodeCheckpoint(encodeCheckpoint(envelope({ state })));
    expect(decoded.state).toBe(state);
  });

  test('and still decodes into the state it came from', () => {
    const before = sim.decode(engineState());
    const decoded = decodeCheckpoint(encodeCheckpoint(envelope({ state: sim.encode(before) })));
    expect(sim.encode(sim.decode(decoded.state))).toBe(sim.encode(before));
  });

  test('the envelope never parses what the engine wrote', () => {
    // A state the envelope cannot interpret round-trips anyway, because it is
    // held opaque. If this ever fails, something started re-serialising it.
    const opaque = '{"not":"a real sim state","order":["z","a"],"n":1.50}';
    expect(decodeCheckpoint(encodeCheckpoint(envelope({ state: opaque }))).state).toBe(opaque);
  });
});

describe('canonical encoding', () => {
  test('the same envelope encodes to the same bytes, whatever order it was built in', () => {
    const base = envelope();
    const shuffled: CheckpointEnvelope = {
      state: base.state,
      accountId: base.accountId,
      envelopeVersion: base.envelopeVersion,
      huntId: base.huntId,
      generation: base.generation,
      checkpointSeq: base.checkpointSeq,
      accountStateVersion: base.accountStateVersion,
      wallAnchorMs: base.wallAnchorMs,
      simAnchorMs: base.simAnchorMs,
      pausedWallMs: base.pausedWallMs,
      lastSeenAt: base.lastSeenAt,
      offlineCapMs: base.offlineCapMs,
      activeStrategy: base.activeStrategy,
      activeLoot: base.activeLoot,
      pendingStrategy: base.pendingStrategy,
      pendingLoot: base.pendingLoot,
      stopContext: base.stopContext,
    };
    expect(encodeCheckpoint(shuffled)).toBe(encodeCheckpoint(base));
  });
});

describe('it fails closed rather than guessing', () => {
  test('an envelope from another version is refused, not migrated in place', () => {
    const encoded = encodeCheckpoint(envelope());
    const older = JSON.stringify({ ...JSON.parse(encoded), envelopeVersion: ENVELOPE_VERSION + 1 });
    expect(() => decodeCheckpoint(older)).toThrowError(EnvelopeError);
    try {
      decodeCheckpoint(older);
    } catch (error) {
      expect((error as EnvelopeError).field).toBe('envelopeVersion');
    }
  });

  test('a truncated checkpoint is a failure, never a partial load', () => {
    const encoded = encodeCheckpoint(envelope());
    expect(() => decodeCheckpoint(encoded.slice(0, encoded.length - 20))).toThrowError(EnvelopeError);
  });

  test('a missing field is named', () => {
    const raw = JSON.parse(encodeCheckpoint(envelope())) as Record<string, unknown>;
    delete raw.checkpointSeq;
    try {
      decodeCheckpoint(JSON.stringify(raw));
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as EnvelopeError).field).toBe('checkpointSeq');
    }
  });

  test('an unknown field is refused rather than dropped', () => {
    const raw = JSON.parse(encodeCheckpoint(envelope())) as Record<string, unknown>;
    raw.seed = 12345;
    expect(() => decodeCheckpoint(JSON.stringify(raw))).toThrowError(EnvelopeError);
  });

  test('a negative anchor or sequence is refused', () => {
    expect(() => encodeCheckpoint(envelope({ checkpointSeq: -1 }))).toThrowError(EnvelopeError);
    expect(() => encodeCheckpoint(envelope({ simAnchorMs: -1 }))).toThrowError(EnvelopeError);
  });

  test('the reward ordinal, the rewards, the counters and the bag live only in the engine state (R132)', () => {
    // One copy each: a v3 envelope's own copies are unknown fields now, refused
    // rather than silently preferred over the engine's.
    for (const [key, value] of [
      ['rewardSeq', 0],
      ['pendingRewards', []],
      ['pity', { epicPlus: 0, legendary: 0 }],
      ['inventoryProjection', { capacity: 100, usedSlots: 0, stackHeadroom: {} }],
    ] as const) {
      const raw = { ...(JSON.parse(encodeCheckpoint(envelope())) as Record<string, unknown>), [key]: value };
      expect(() => decodeCheckpoint(JSON.stringify(raw)), key).toThrowError(EnvelopeError);
    }
    const state = sim.decode(engineState());
    expect(state.nextRewardSeq).toBe(0);
    expect(state.dropProtection).toEqual({ epicPlus: 0, legendary: 0 });
  });
});

describe('reward identity (P-29)', () => {
  test('is the hunt namespace plus the sequence, with no UUID involved', () => {
    expect(rewardIdFor('22222222-2222-4222-8222-222222222222', 7)).toBe(
      '22222222-2222-4222-8222-222222222222:7',
    );
  });

  test('the same replay produces the same ids', () => {
    const first = [0, 1, 2].map((seq) => rewardIdFor('hunt-a', seq));
    const replay = [0, 1, 2].map((seq) => rewardIdFor('hunt-a', seq));
    expect(replay).toEqual(first);
  });

  test('a new hunt is a new namespace, so ids never collide across restarts', () => {
    expect(rewardIdFor('hunt-a', 0)).not.toBe(rewardIdFor('hunt-b', 0));
  });
});

describe('the pending loot filter is acknowledged like the pending strategy (R131)', () => {
  test('each window names the version, the command, the acknowledged instant and its first reward', () => {
    const pending = [
      { presetId: '44444444-4444-4444-8444-444444444444', presetVersion: 2, commandId: 'hunt.loot:k1', acknowledgedAtSimMs: 9_000, fromRewardSeq: 3 },
      { presetId: '55555555-5555-4555-8555-555555555555', presetVersion: 1, commandId: 'hunt.loot:k2', acknowledgedAtSimMs: 9_500, fromRewardSeq: 5 },
    ];
    expect(decodeCheckpoint(encodeCheckpoint(envelope({ pendingLoot: pending }))).pendingLoot).toEqual(pending);
    const unbounded = Array.from({ length: 33 }, (_, index) => ({ ...pending[0], fromRewardSeq: index }));
    expect(() => encodeCheckpoint(envelope({ pendingLoot: unbounded }))).toThrowError(EnvelopeError);
  });
});

describe('the pending strategy is a snapshot, not a pointer to a live preset', () => {
  test('it carries its own version, so a later edit cannot rewrite what was queued', () => {
    const pending = {
      presetId: '33333333-3333-4333-8333-333333333333',
      presetVersion: 4,
      commandId: 'hunt.strategy:k1',
      acknowledgedAtSimMs: 12_000,
    };
    const decoded = decodeCheckpoint(encodeCheckpoint(envelope({ pendingStrategy: pending })));
    expect(decoded.pendingStrategy).toEqual(pending);
    expect(decoded.activeStrategy.presetVersion, 'the active version is untouched').toBe(1);
  });
});
