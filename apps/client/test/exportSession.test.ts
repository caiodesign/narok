import { expect, test } from 'vitest';
import type { DomainEvent, LabInput, PublicState } from '@narok/sim';
import {
  buildSessionExport,
  sessionExportFilename,
  SESSION_EXPORT_FORMAT,
  type BuildSessionExportInput,
} from '../src/exportSession';
import type { Summary } from '../src/useExperiment';

const VERSIONS = { simulationVersion: 'a1', contentVersion: 'content-hash', gridHash: 'grid-hash' };
const AT = new Date('2026-09-19T04:05:06.789Z');

function input(seed: number): LabInput {
  return {
    seed,
    classes: ['guardian'],
    recipe: 'melee',
    placement: { p0: '2,3' },
    strategies: {},
    rest: { hpStart: 50, mpStart: 30 },
    wipeLimit: 1,
  } as unknown as LabInput;
}

function event(seq: number): DomainEvent {
  return {
    seq, at: seq * 10, encounter: 1, kind: 'damage',
    actorId: 'p0', targetId: 'e0', amount: 5, reason: 'basic', position: null,
  };
}

function state(nowMs: number): PublicState {
  return { nowMs, phase: 'fighting', stopReason: null, actors: [], metrics: {} as PublicState['metrics'] };
}

function summary(label: string, seed: number): Summary {
  return {
    label, input: input(seed), nowMs: 1000, stopReason: 'operator',
    metrics: {} as Summary['metrics'], state: state(1000),
  };
}

function source(overrides: Partial<BuildSessionExportInput> = {}): BuildSessionExportInput {
  return {
    versions: VERSIONS,
    status: 'stopped',
    input: input(7),
    state: state(3600000),
    events: [event(0), event(1)],
    eventHistoryLimit: 500,
    comparisonA: null,
    comparisonB: null,
    now: () => AT,
    ...overrides,
  };
}

test('the bundle carries the versions, the input and the observed record', () => {
  const bundle = buildSessionExport(source());

  expect(bundle.format).toBe(SESSION_EXPORT_FORMAT);
  expect(bundle.exportedAt).toBe('2026-09-19T04:05:06.789Z');
  expect(bundle.versions).toEqual(VERSIONS);
  expect(bundle.input?.seed).toBe(7);
  expect(bundle.state?.nowMs).toBe(3600000);
  expect(bundle.events).toHaveLength(2);
  expect(bundle.eventCount).toBe(2);
  expect(bundle.status).toBe('stopped');
});

/**
 * The hook caps retained history at 500 (ruling R54). A long run therefore
 * exports its most recent 500 events and no more, so the bundle has to SAY that
 * — reporting a truncated log as if it were the whole run is exactly the kind
 * of quiet misrepresentation ruling R65 exists to prevent.
 */
test('a log at the retention cap is flagged as truncated, and a shorter one is not', () => {
  const full = Array.from({ length: 500 }, (_unused, index) => event(index));

  expect(buildSessionExport(source({ events: full })).eventsTruncated).toBe(true);
  expect(buildSessionExport(source({ events: full.slice(0, 499) })).eventsTruncated).toBe(false);
});

test('both comparison slots are carried, and an empty slot stays null', () => {
  const bundle = buildSessionExport(
    source({ comparisonA: summary('Run 1', 1), comparisonB: summary('Run 2', 2) }),
  );

  expect(bundle.comparison.a?.label).toBe('Run 1');
  expect(bundle.comparison.a?.input.seed).toBe(1);
  expect(bundle.comparison.b?.input.seed).toBe(2);
  expect(buildSessionExport(source()).comparison).toEqual({ a: null, b: null });
});

test('the bundle is JSON-serializable and survives a round trip', () => {
  const bundle = buildSessionExport(source({ comparisonB: summary('Run 1', 3) }));
  const text = JSON.stringify(bundle);

  expect(JSON.parse(text)).toEqual(bundle);
});

test('the filename names the seed and carries a filesystem-safe timestamp', () => {
  const named = sessionExportFilename(buildSessionExport(source()));
  expect(named).toBe('narok-session-seed7-2026-09-19T04-05-06-789Z.json');
  expect(named).not.toMatch(/[:]/);

  // Before any run there is no seed to name, and the export must still work —
  // that is the state a user is in when the very first start fails.
  expect(sessionExportFilename(buildSessionExport(source({ input: null })))).toContain('unseeded');
});

test('an export before any run still produces a valid bundle rather than throwing', () => {
  const bundle = buildSessionExport(
    source({ status: 'idle', input: null, state: null, events: [] }),
  );

  expect(bundle.input).toBeNull();
  expect(bundle.state).toBeNull();
  expect(bundle.eventCount).toBe(0);
  expect(bundle.eventsTruncated).toBe(false);
});
