/**
 * Shared pure fixtures for the settlement, pending, reward and report suites:
 * one bound simulation, a real engine state, and a complete envelope around
 * it. Nothing here touches a database.
 */
import { content, validateContent } from '@narok/data';
import {
  createGrid,
  createSimulation,
  defaultPlacement,
  defaultStrategy,
  type LabInput,
  type PendingRules,
  type SimState,
} from '@narok/sim';
import { ENVELOPE_VERSION, type CheckpointEnvelope } from '../src/hunt/envelope';

export const validated = validateContent(content);
export const sim = createSimulation(validated, createGrid(validated.grid, validated.shapes));
export const party = ['guardian', 'cleric', 'ranger'] as const;

/** An instant in 2027, far from zero so a wrong subtraction cannot hide. */
export const W0 = 1_800_000_000_000;

export function labInput(overrides: Partial<LabInput> = {}): LabInput {
  return {
    seed: 7,
    classes: [...party],
    recipe: 'mixed',
    placement: defaultPlacement([...party]),
    strategies: Object.fromEntries(party.map((id, index) => [`p${index}`, defaultStrategy(id)])),
    rest: { hpStart: 50, mpStart: 30 },
    wipeLimit: 1,
    ...overrides,
  };
}

/** A preset payload as `strategy_presets` stores it (payload schema version 1). */
export function presetPayload(overrides: Partial<PendingRules> = {}): PendingRules {
  const input = labInput();
  return {
    placement: input.placement,
    strategies: input.strategies,
    rest: input.rest,
    wipeLimit: input.wipeLimit,
    ...overrides,
  };
}

export function startState(overrides: Partial<LabInput> = {}): SimState {
  return sim.start(labInput(overrides));
}

export function envelope(overrides: Partial<CheckpointEnvelope> = {}): CheckpointEnvelope {
  return {
    envelopeVersion: ENVELOPE_VERSION,
    accountId: '11111111-1111-4111-8111-111111111111',
    huntId: '22222222-2222-4222-8222-222222222222',
    generation: 1,
    checkpointSeq: 0,
    accountStateVersion: 3,
    wallAnchorMs: W0,
    simAnchorMs: 0,
    pausedWallMs: 0,
    lastSeenAt: W0,
    offlineCapMs: 43_200_000,
    rewardSeq: 0,
    pendingRewards: [],
    pity: { epicPlus: 0, legendary: 0 },
    activeStrategy: { presetId: '33333333-3333-4333-8333-333333333333', presetVersion: 1 },
    activeLoot: { presetId: '44444444-4444-4444-8444-444444444444', presetVersion: 1 },
    pendingStrategy: null,
    pendingLoot: null,
    inventoryProjection: { capacity: 100, usedSlots: 0, stackHeadroom: {} },
    stopContext: null,
    state: sim.encode(startState()),
    ...overrides,
  };
}
