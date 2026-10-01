/**
 * P-17: a `snapshot` is a complete `PublicState` and never carries PRNG state,
 * a seed, a pending private future event, or any field absent from
 * `PublicActor`/`PublicState`.
 *
 * The protocol declares its own wire schema rather than importing the
 * simulation's at runtime (P-01, part 1 §1), so the two could silently drift.
 * The guard against that is a *type-level* conformance test: `expectAssignable`
 * below is checked by `tsc`, not by vitest, so a field added to either side
 * that the other lacks fails `pnpm typecheck`.
 */
import { describe, expect, test } from 'vitest';
import type { PublicActor as SimActor, PublicState as SimState } from '@narok/sim';
import { publicActorSchema, publicStateSchema, type PublicActorWire, type PublicStateWire } from '../src/public-state';

/**
 * Compile-time only. Each alias resolves to `true` when the two shapes are
 * mutually assignable and to `never` otherwise, so a drifting field fails
 * `pnpm typecheck` rather than any assertion at run time.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const STATE_CONFORMS: MutuallyAssignable<PublicStateWire, SimState> = true;
const ACTOR_CONFORMS: MutuallyAssignable<PublicActorWire, SimActor> = true;

const ACTOR = {
  id: 'p0',
  definitionId: 'guardian',
  side: 'party',
  position: '2,3',
  hp: 277,
  mp: 60,
  maxHp: 277,
  maxMp: 60,
  currentTarget: 'e0',
  casting: 'cleave',
  targetReason: 'priority',
  cooldowns: { cleave: 16645 },
};

const STATE = {
  nowMs: 32621,
  phase: 'fighting',
  stopReason: null,
  actors: [ACTOR],
  metrics: {
    kills: 6,
    wins: 2,
    wipes: 0,
    rawExp: 180,
    rawGold: 18,
    damageDealt: 1080,
    effectiveHealing: 82,
    walkMs: 4000,
    fightMs: 15016,
    restMs: 13605,
    consumed: {},
    actors: { p0: { damageDealt: 411, damageReceived: 232, healingDone: 0 } },
    drops: {
      rolled: { common: 1, uncommon: 0, rare: 0, epic: 0, legendary: 0 },
      consumables: 0, kept: 0, autoSold: 1, ignored: 0, lost: 0,
      firstDropMs: 20_500, firstDropRarity: 'common', epicPlusWaits: [], legendaryWaits: [],
    },
  },
};

describe('the wire schema and the simulation agree field for field', () => {
  test('the conformance aliases resolved to true, which only happens when they match', () => {
    expect(STATE_CONFORMS).toBe(true);
    expect(ACTOR_CONFORMS).toBe(true);
  });
});

describe('the public state wire schema', () => {
  test('accepts a real projection unchanged', () => {
    expect(publicStateSchema.parse(STATE)).toEqual(STATE);
  });

  test('accepts every phase and stop reason the simulation publishes', () => {
    for (const phase of ['walking', 'fighting', 'resting', 'stopped']) {
      expect(publicStateSchema.safeParse({ ...STATE, phase }).success, phase).toBe(true);
    }
    for (const stopReason of ['wipe', 'stalemate', 'operator', null]) {
      expect(publicStateSchema.safeParse({ ...STATE, stopReason }).success, String(stopReason)).toBe(true);
    }
  });

  test('the respawn phase and the wipe limit are gone (owner decision 2026-09-30)', () => {
    expect(publicStateSchema.safeParse({ ...STATE, phase: 'respawning' }).success).toBe(false);
    expect(publicStateSchema.safeParse({ ...STATE, stopReason: 'wipe-limit' }).success).toBe(false);
    expect(publicStateSchema.safeParse({ ...STATE, metrics: { ...STATE.metrics, respawnMs: 0 } }).success).toBe(false);
  });

  test('a null target, no cast and no reason are all legal', () => {
    const idle = { ...ACTOR, currentTarget: null, casting: null, targetReason: null, cooldowns: {} };
    expect(publicActorSchema.safeParse(idle).success).toBe(true);
  });

  test('a basic attack is a legal cast value alongside the skill ids', () => {
    expect(publicActorSchema.safeParse({ ...ACTOR, casting: 'basic' }).success).toBe(true);
  });
});

describe('what a snapshot may never carry (P-17)', () => {
  test.each([
    ['rng', { rng: 123456 }],
    ['seed', { seed: 1 }],
    ['queue', { queue: [{ at: 1, kind: 'resolve' }] }],
    ['input', { input: { seed: 1 } }],
    ['nextDomainSeq', { nextDomainSeq: 157 }],
    ['epoch', { epoch: 2 }],
  ])('rejects a state carrying %s', (_name, extra) => {
    expect(publicStateSchema.safeParse({ ...STATE, ...extra }).success).toBe(false);
  });

  test('rejects an actor carrying a field PublicActor does not have', () => {
    expect(publicActorSchema.safeParse({ ...ACTOR, threat: 400 }).success).toBe(false);
    expect(publicActorSchema.safeParse({ ...ACTOR, statuses: [] }).success).toBe(false);
  });
});
