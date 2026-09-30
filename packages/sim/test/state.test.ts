import { expect, test } from 'vitest';
import { content } from '@narok/data';
import { startState, defaultStrategy } from '../src/state';
import { createGrid, defaultPlacement } from '../src/battlefield/grid';
import { SimError } from '../src/errors';
import { labInput } from './fixtures';

function expectSimError(action: () => void): SimError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SimError);
    return error as SimError;
  }
  throw new Error('expected action to throw a SimError');
}

test('startState builds a full-resource party at default placement with zero cooldowns', () => {
  const grid = createGrid(content.grid);
  const state = startState(content, grid, labInput());

  expect(state.schemaVersion).toBe(1);
  expect(state.simulationVersion).toBe('b1');
  expect(state.contentVersion).toBe(content.version);
  expect(state.gridHash).toBe(content.gridHash);
  expect(state.nowMs).toBe(0);
  expect(state.rng).toBe(1);
  expect(state.phase).toBe('walking');
  expect(state.stopReason).toBeNull();
  expect(state.epoch).toBe(0);
  expect(state.encounterCount).toBe(0);
  expect(state.encounterStartedAt).toBeNull();

  expect(Object.keys(state.actors).sort()).toEqual(['p0', 'p1', 'p2']);
  const guardian = state.actors.p0;
  expect(guardian.definitionId).toBe('guardian');
  expect(guardian.hp).toBe(guardian.stats.maxHp);
  expect(guardian.mp).toBe(guardian.stats.maxMp);
  expect(guardian.cooldowns).toEqual({});
  expect(guardian.statuses).toEqual([]);
  expect(guardian.actionToken).toBe(0);
  expect(guardian.pendingCast).toBeNull();
  expect(guardian.position).toBe(defaultPlacement(['guardian', 'cleric', 'ranger']).p0);

  expect(state.metrics).toEqual({
    kills: 0, wins: 0, wipes: 0, rawExp: 0, rawGold: 0,
    damageDealt: 0, effectiveHealing: 0,
    walkMs: 0, fightMs: 0, restMs: 0, respawnMs: 0,
    actors: {
      p0: { damageDealt: 0, damageReceived: 0, healingDone: 0 },
      p1: { damageDealt: 0, damageReceived: 0, healingDone: 0 },
      p2: { damageDealt: 0, damageReceived: 0, healingDone: 0 },
    },
    drops: {
      rolled: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 },
      consumables: 0, kept: 0, autoSold: 0, ignored: 0, lost: 0,
      firstDropMs: null, firstDropRarity: null, epicPlusWaits: [], legendaryWaits: [],
    },
  });
});

test('startState schedules the first walk completion and the first regen tick', () => {
  const grid = createGrid(content.grid);
  const state = startState(content, grid, labInput());
  expect(state.queue).toEqual([
    { at: content.walkMs, kind: 'transition', actorId: '', seq: 0, epoch: null, token: null },
    { at: content.regenMs, kind: 'regen', actorId: '', seq: 1, epoch: null, token: null },
  ]);
});

test('startState deep-clones the caller input instead of aliasing it', () => {
  const grid = createGrid(content.grid);
  const input = labInput();
  const state = startState(content, grid, input);
  input.classes.push('arcanist');
  input.rest.hpStart = 89;
  expect(state.input.classes).toEqual(['guardian', 'cleric', 'ranger']);
  expect(state.input.rest.hpStart).toBe(50);
});

test('defaultStrategy matches the spec §6 default rule table', () => {
  expect(defaultStrategy('guardian')).toEqual({
    rules: [
      { skillId: 'taunt', enabled: true, condition: { kind: 'ally-targeted' } },
      { skillId: 'cleave', enabled: true, condition: { kind: 'targets-at-least', value: 2 } },
    ],
    target: { kind: 'nearest' },
  });
  expect(defaultStrategy('cleric')).toEqual({
    rules: [
      { skillId: 'heal', enabled: true, condition: { kind: 'ally-hp-below', value: 60 } },
      { skillId: 'smite', enabled: true, condition: { kind: 'always' } },
    ],
    target: { kind: 'lowest-hp' },
  });
  expect(defaultStrategy('ranger')).toEqual({
    rules: [
      { skillId: 'arrow-rain', enabled: true, condition: { kind: 'targets-at-least', value: 3 } },
      { skillId: 'double-shot', enabled: true, condition: { kind: 'always' } },
    ],
    target: { kind: 'lowest-hp' },
  });
  expect(defaultStrategy('arcanist')).toEqual({
    rules: [
      { skillId: 'frost-nova', enabled: true, condition: { kind: 'targets-at-least', value: 3 } },
      { skillId: 'fire-bolt', enabled: true, condition: { kind: 'always' } },
    ],
    target: { kind: 'lowest-hp' },
  });
});

test('rejects a roster outside 1..3 members', () => {
  const grid = createGrid(content.grid);
  const empty = expectSimError(() => startState(content, grid, labInput({ classes: [] })));
  expect(empty.code).toBe('INVALID_INPUT');
  const oversized = expectSimError(() => startState(content, grid, labInput({
    classes: ['guardian', 'cleric', 'ranger', 'arcanist'],
  })));
  expect(oversized.code).toBe('INVALID_INPUT');
});

test('rejects an unknown class id', () => {
  const grid = createGrid(content.grid);
  const error = expectSimError(() => startState(content, grid, labInput({
    classes: ['guardian', 'cleric', 'wizard' as never],
  })));
  expect(error.code).toBe('INVALID_INPUT');
});

test('rejects placement missing a roster id', () => {
  const grid = createGrid(content.grid);
  const input = labInput();
  const rest = { ...input.placement };
  delete rest.p0;
  const error = expectSimError(() => startState(content, grid, { ...input, placement: rest }));
  expect(error.code).toBe('INVALID_INPUT');
  expect(error.field).toBe('input.placement');
});

test('rejects placement with an extra key beyond the roster', () => {
  const grid = createGrid(content.grid);
  const input = labInput();
  const error = expectSimError(() => startState(content, grid, {
    ...input,
    placement: { ...input.placement, p9: input.placement.p0 },
  }));
  expect(error.code).toBe('INVALID_INPUT');
});

test('rejects a placement position outside the party zone', () => {
  const grid = createGrid(content.grid);
  const input = labInput();
  const error = expectSimError(() => startState(content, grid, {
    ...input,
    placement: { ...input.placement, p0: '2,0' as never },
  }));
  expect(error.code).toBe('INVALID_INPUT');
});

test('rejects strategies missing a roster id', () => {
  const grid = createGrid(content.grid);
  const input = labInput();
  const rest = { ...input.strategies };
  delete rest.p1;
  const error = expectSimError(() => startState(content, grid, { ...input, strategies: rest }));
  expect(error.code).toBe('INVALID_INPUT');
  expect(error.field).toBe('input.strategies');
});

test('rejects an invalid rule/class pairing (a skill the actor\'s class does not have)', () => {
  const grid = createGrid(content.grid);
  const input = labInput();
  const error = expectSimError(() => startState(content, grid, {
    ...input,
    strategies: { ...input.strategies, p0: defaultStrategy('cleric') }, // p0 is a guardian
  }));
  expect(error.code).toBe('INVALID_INPUT');
});

test('rejects a condition/skill pairing mismatch', () => {
  const grid = createGrid(content.grid);
  const input = labInput();
  const badTaunt = {
    rules: [
      { skillId: 'taunt' as const, enabled: true, condition: { kind: 'always' as const } },
      { skillId: 'cleave' as const, enabled: true, condition: { kind: 'targets-at-least' as const, value: 2 } },
    ],
    target: { kind: 'nearest' as const },
  };
  const error = expectSimError(() => startState(content, grid, {
    ...input,
    strategies: { ...input.strategies, p0: badTaunt },
  }));
  expect(error.code).toBe('INVALID_INPUT');
});

test('rejects an out-of-range condition value', () => {
  const grid = createGrid(content.grid);
  const input = labInput();
  const badHeal = {
    rules: [
      { skillId: 'heal' as const, enabled: true, condition: { kind: 'ally-hp-below' as const, value: 100 } },
      { skillId: 'smite' as const, enabled: true, condition: { kind: 'always' as const } },
    ],
    target: { kind: 'lowest-hp' as const },
  };
  const error = expectSimError(() => startState(content, grid, {
    ...input,
    strategies: { ...input.strategies, p1: badHeal },
  }));
  expect(error.code).toBe('INVALID_INPUT');
});

test('rejects an "attacking" target whose partyId is not in the roster', () => {
  const grid = createGrid(content.grid);
  const input = labInput();
  const badTarget = { ...defaultStrategy('guardian'), target: { kind: 'attacking' as const, partyId: 'p9' } };
  const error = expectSimError(() => startState(content, grid, {
    ...input,
    strategies: { ...input.strategies, p0: badTarget },
  }));
  expect(error.code).toBe('INVALID_INPUT');
});

test('rejects rest thresholds outside their ranges', () => {
  const grid = createGrid(content.grid);
  expect(expectSimError(() => startState(content, grid, labInput({ rest: { hpStart: 90, mpStart: 30 } }))).code)
    .toBe('INVALID_INPUT');
  expect(expectSimError(() => startState(content, grid, labInput({ rest: { hpStart: 50, mpStart: 80 } }))).code)
    .toBe('INVALID_INPUT');
});

test('rejects a wipeLimit outside 1..5', () => {
  const grid = createGrid(content.grid);
  expect(expectSimError(() => startState(content, grid, labInput({ wipeLimit: 0 }))).code).toBe('INVALID_INPUT');
  expect(expectSimError(() => startState(content, grid, labInput({ wipeLimit: 6 }))).code).toBe('INVALID_INPUT');
});

test('rejects a seed outside 1..4294967295', () => {
  const grid = createGrid(content.grid);
  expect(expectSimError(() => startState(content, grid, labInput({ seed: 0 }))).code).toBe('INVALID_INPUT');
  expect(expectSimError(() => startState(content, grid, labInput({ seed: 4_294_967_296 }))).code)
    .toBe('INVALID_INPUT');
});

test('rejects an unknown recipe id', () => {
  const grid = createGrid(content.grid);
  const error = expectSimError(() => startState(content, grid, labInput({ recipe: 'bogus' as never })));
  expect(error.code).toBe('INVALID_INPUT');
});
