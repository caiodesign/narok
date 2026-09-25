/**
 * The pending-strategy contract on the server (milestone B spec part 2 §4,
 * UI spec §5): B-L14, B-L16, the separate active/pending projection, and the
 * activation reaching the envelope through an ordinary settlement.
 *
 * The engine owns activation (`activatePending`, packages/sim); the envelope
 * owns which preset version each side is, so the UI can name both.
 */
import { describe, expect, test } from 'vitest';
import { decodeCheckpoint, encodeCheckpoint } from '../src/hunt/envelope';
import { queueStrategy, strategyVersions } from '../src/hunt/pending';
import { settle, type SegmentRunner } from '../src/hunt/settle';
import { runSegment } from '../src/workers/segment';
import { envelope, labInput, presetPayload, sim, W0 } from './hunt-fixtures';

const real: SegmentRunner = (request) => runSegment(sim, request);
const PRESET = '55555555-5555-4555-8555-555555555555';

function swapped() {
  const input = labInput();
  return presetPayload({
    placement: { p0: input.placement.p1, p1: input.placement.p0, p2: input.placement.p2 },
    rest: { hpStart: 70, mpStart: 60 },
    wipeLimit: 3,
  });
}

function refusal(run: () => unknown): { code: string; field: string } {
  try {
    run();
  } catch (error) {
    return { code: (error as { code: string }).code, field: (error as { field: string }).field };
  }
  throw new Error('expected a refusal');
}

describe('the queued payload is a deep validated copy (B-L14)', () => {
  test('editing the preset row after the apply does not reach the queued snapshot', () => {
    const row = swapped();
    const queued = queueStrategy(sim, envelope(), { presetId: PRESET, presetVersion: 2, payload: row }, { commandId: 'c1' });

    // The same object the row was read into, edited in place afterwards.
    row.rest.hpStart = 5;
    row.wipeLimit = 1;
    (row.placement as Record<string, string>).p0 = '0,0';

    expect(sim.decode(queued.state).pendingRules).toEqual(swapped());
    expect(queued.pendingStrategy).toEqual({ presetId: PRESET, presetVersion: 2, commandId: 'c1', acknowledgedAtSimMs: 0 });
  });

  test('an unactivatable payload never reaches the checkpoint', () => {
    const before = envelope();
    expect(refusal(() => queueStrategy(sim, before, { presetId: PRESET, presetVersion: 1, payload: { ...swapped(), wipeLimit: 9 } }, { commandId: 'c1' }))).toEqual({
      code: 'VALIDATION',
      field: 'strategyPreset.wipeLimit',
    });
    expect(refusal(() => queueStrategy(sim, before, { presetId: PRESET, presetVersion: 1, payload: { ...swapped(), rest: { hpStart: 99, mpStart: 0 } } }, { commandId: 'c1' }))).toEqual({
      code: 'VALIDATION',
      field: 'strategyPreset.rest.hpStart',
    });
    expect(before.pendingStrategy).toBeNull();
  });

  test('the acknowledgement records the settled instant it was applied at', () => {
    const settledAt = sim.advance(sim.decode(envelope().state), 1_234).state;
    const queued = queueStrategy(sim, envelope({ state: sim.encode(settledAt) }), { presetId: PRESET, presetVersion: 1, payload: swapped() }, { commandId: 'c9' });
    expect(queued.pendingStrategy?.acknowledgedAtSimMs).toBe(1_234);
  });
});

describe('at most one pending strategy per hunt (B-L16)', () => {
  test('a newer acknowledged apply replaces the pending one; the replaced version is discarded', async () => {
    const first = queueStrategy(sim, envelope(), { presetId: PRESET, presetVersion: 2, payload: swapped() }, { commandId: 'c1' });
    const second = queueStrategy(sim, first, { presetId: PRESET, presetVersion: 3, payload: { ...swapped(), wipeLimit: 4 } }, { commandId: 'c2' });

    expect(second.pendingStrategy).toMatchObject({ presetVersion: 3, commandId: 'c2' });
    expect(sim.decode(second.state).pendingRules?.wipeLimit).toBe(4);

    const spawned = await settle(second, W0 + 2_000, real);
    expect(sim.decode(spawned.envelope.state).input.wipeLimit).toBe(4);
    expect(spawned.envelope.activeStrategy).toEqual({ presetId: PRESET, presetVersion: 3 });
  });
});

describe('active and pending are exposed separately', () => {
  test('before activation both versions are named; after it only the active one', async () => {
    const before = envelope();
    expect(strategyVersions(before)).toEqual({ activeVersion: before.activeStrategy, pendingVersion: null });

    const queued = queueStrategy(sim, before, { presetId: PRESET, presetVersion: 2, payload: swapped() }, { commandId: 'c1' });
    expect(strategyVersions(queued)).toEqual({
      activeVersion: before.activeStrategy,
      pendingVersion: { presetId: PRESET, presetVersion: 2 },
    });

    // Short of the first spawn (the walk completes at 2,000 ms) nothing activates.
    const walking = await settle(queued, W0 + 1_999, real);
    expect(strategyVersions(walking.envelope).pendingVersion).toEqual({ presetId: PRESET, presetVersion: 2 });
    expect(sim.decode(walking.envelope.state).input.wipeLimit).toBe(1);

    const spawned = await settle(walking.envelope, W0 + 2_000, real);
    expect(strategyVersions(spawned.envelope)).toEqual({
      activeVersion: { presetId: PRESET, presetVersion: 2 },
      pendingVersion: null,
    });
    expect(sim.decode(spawned.envelope.state).input).toEqual({ ...labInput(), ...swapped() });
  });

  test('the pending strategy is part of the checkpoint, so it survives a round trip (reconnect, recovery)', () => {
    const queued = queueStrategy(sim, envelope(), { presetId: PRESET, presetVersion: 2, payload: swapped() }, { commandId: 'c1' });
    const restored = decodeCheckpoint(encodeCheckpoint(queued));
    expect(restored.pendingStrategy).toEqual(queued.pendingStrategy);
    expect(sim.decode(restored.state).pendingRules).toEqual(swapped());
  });
});
