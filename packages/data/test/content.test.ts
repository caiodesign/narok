import { expect, test } from 'vitest';

import { mapId, prototypeDefinition, shapeOffsets } from '../src/prototype';
import type { Content } from '../src/types';
import { ContentError, validateContent } from '../src/validate';

/** A structurally complete `Content` built from the prototype table, deep-cloned per test. */
function baseContent(): Content {
  return structuredClone({
    ...prototypeDefinition,
    version: 'test-version',
    gridHash: 'test-grid-hash',
  });
}

function expectInvalidContent(value: unknown, field: string): void {
  let caught: unknown;
  try {
    validateContent(value);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ContentError);
  expect((caught as ContentError).code).toBe('INVALID_CONTENT');
  expect((caught as ContentError).field).toBe(field);
}

test('accepts the prototype content table', () => {
  const content = validateContent(baseContent());
  expect(content.classes.guardian.basicIntervalMs).toBe(1_600);
  expect(content.skills['frost-nova'].slowBp).toBe(3_000);
  expect(Object.keys(content.monsters).sort()).toEqual(['briar-boar', 'mossling', 'reed-slinger']);
});

test('exposes the exact shape offsets required by the contract', () => {
  expect(shapeOffsets).toEqual({
    single: [[0, 0]],
    cleave: [[-1, 0], [0, 0], [1, 0]],
    square: [[0, 0], [1, 0], [0, 1], [1, 1]],
    plus: [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]],
  });
});

test('exposes a fixed map id outside the Content contract', () => {
  expect(mapId).toBe('meadow-lab');
});

test('rejects a duplicated recipe spawn cell', () => {
  const value = baseContent();
  const monsters = value.recipes.melee.monsters;
  monsters[1] = { ...monsters[1], column: monsters[0].column, row: monsters[0].row };
  expectInvalidContent(value, 'recipes.melee.monsters.1');
});

test('rejects a class referencing a missing skill', () => {
  const value = baseContent();
  value.classes.guardian.skills = ['taunt', 'unknown-skill' as never];
  expectInvalidContent(value, 'classes.guardian.skills.1');
});

test('rejects a zero basic interval', () => {
  const value = baseContent();
  value.classes.guardian.basicIntervalMs = 0;
  expectInvalidContent(value, 'classes.guardian.basicIntervalMs');
});

test('rejects content missing an element pair', () => {
  const value = baseContent();
  delete (value.elements.fire as Partial<Record<string, number>>).water;
  expectInvalidContent(value, 'elements.fire.water');
});

test('rejects a noninteger monster HP', () => {
  const value = baseContent();
  value.monsters['briar-boar'].hp = 180.5;
  expectInvalidContent(value, 'monsters.briar-boar.hp');
});

// The owner decided (spec §4.0) that stopping a hunt returns to town through a
// simulated travel segment whose duration is a content constant. Neither
// layer-1 nor the milestone B parts give that number (part 3 §8 #9 only bounds
// it below by the map's walk interval), so it ships as an explicit open input:
// `null` until the owner sets it, never a placeholder value (ruling R114).
test('the town-return travel duration is an open content input', () => {
  expect(prototypeDefinition.townReturnTravelMs).toBeNull();
  expect(validateContent(baseContent()).townReturnTravelMs).toBeNull();
});

test('accepts a positive integer town-return travel duration once one is chosen', () => {
  const value = { ...baseContent(), townReturnTravelMs: 60_000 };
  expect(validateContent(value).townReturnTravelMs).toBe(60_000);
});

test.each([0, -1, 1.5, '60000', undefined])(
  'rejects the town-return travel duration %j',
  (travel) => {
    const value = { ...baseContent(), townReturnTravelMs: travel } as unknown;
    expectInvalidContent(value, 'townReturnTravelMs');
  },
);
