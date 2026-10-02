import { expect, test } from 'vitest';

import { content } from '../src/generated/content';
import { mapId, prototypeDefinition, shapeOffsets } from '../src/prototype';
import type { Content } from '../src/types';
import { ContentError, validateContent } from '../src/validate';
import { compileProgression } from '../scripts/progression';

/** A structurally complete `Content` built from the prototype table, deep-cloned per test. */
function baseContent(): Content {
  return structuredClone({
    ...prototypeDefinition,
    progression: compileProgression(),
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

// Owner decision 2026-09-25 (spec §4.0.1): stopping costs ten seconds of
// travel to town, against the prototype map's 2 s walk (part 3 §8 #9 bounds it
// below by the walk interval).
test("the town-return travel duration is the owner's ten seconds", () => {
  expect(prototypeDefinition.townReturnTravelMs).toBe(10_000);
  expect(prototypeDefinition.townReturnTravelMs).toBeGreaterThanOrEqual(prototypeDefinition.walkMs);
});

test('null remains a valid, explicit "no journey" for other content', () => {
  expect(validateContent({ ...baseContent(), townReturnTravelMs: null }).townReturnTravelMs).toBeNull();
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

// Ruling R134: the levelling tables are compiled at build time and only indexed at runtime.
test('the compiled levelling tables carry the layer-1 curves exactly', () => {
  const tables = compileProgression();
  expect(tables.levelCap).toBe(50);
  expect(tables.expToNext).toHaveLength(49);
  expect(tables.expToNext.slice(0, 3)).toEqual([50, 229, 560]);
  expect(tables.statPoints[0]).toBe(30);
  expect(tables.statPoints.reduce((sum, points) => sum + points, 0)).toBe(412);
  expect(tables.skillPoints.reduce((sum, points) => sum + points, 0)).toBe(13);
  expect(tables.skillPoints.flatMap((points, index) => (points === 1 ? [index + 1] : [])))
    .toEqual([1, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48]);
  expect(content.progression).toEqual(tables);
});

test('rejects a levelling table that does not rise or has the wrong length', () => {
  const flat = baseContent();
  flat.progression.expToNext[5] = flat.progression.expToNext[4]!;
  expectInvalidContent(flat, 'progression.expToNext.5');
  const short = baseContent();
  short.progression.statPoints.pop();
  expectInvalidContent(short, 'progression.statPoints');
});

test('the two potions, their shared cooldown and the starter kit are layer-1 §6.6 and §7.6', () => {
  const value = validateContent(baseContent());
  expect(value.consumables['small-hp-potion']).toEqual({ id: 'small-hp-potion', resource: 'hp', restoreBp: 2_500 });
  expect(value.consumables['small-mp-potion']).toEqual({ id: 'small-mp-potion', resource: 'mp', restoreBp: 2_000 });
  expect(value.potionCooldownMs).toBe(10_000);
  expect(value.starterKit.potions).toEqual([{ consumableId: 'small-hp-potion', quantity: 20 }]);
  expect(value.starterKit.weapons.ranger).toEqual({ definitionId: 'ranger-bow', rarity: 'common', itemLevel: 1, bonuses: [] });
  expect(JSON.stringify(value.consumables)).not.toMatch(/price/i);
});

test('rejects a monster consumable drop that names no consumable definition', () => {
  const value = baseContent();
  value.monsters.mossling.consumables = [{ consumableId: 'elixir', ppm: 10 }];
  expectInvalidContent(value, 'monsters.mossling.consumables.0.consumableId');
});

test('rejects a starter weapon its class cannot equip', () => {
  const value = baseContent();
  value.starterKit.weapons.guardian.definitionId = 'ranger-bow';
  expectInvalidContent(value, 'starterKit.weapons.guardian.definitionId');
});

test("Idun's Apple and the Cleric's Revive are content (owner decision 2026-09-30)", () => {
  const value = validateContent(baseContent());
  expect(value.consumables['idun-apple']).toEqual({ id: 'idun-apple', resource: 'revive', restoreBp: 5_000 });
  // Its drop source is open: no monster drops it yet, and nothing prices it.
  for (const monster of Object.values(value.monsters)) {
    expect(monster.consumables.map((entry) => entry.consumableId)).not.toContain('idun-apple');
  }
  expect(value.classes.cleric.skills).toContain('revive');
  // Owner placeholders 2026-09-30: Heal's MP cost and range, a 3 s cast, no cooldown.
  expect(value.skills.revive).toMatchObject({
    id: 'revive', effect: 'revive', mp: value.skills.heal.mp, range: value.skills.heal.range, baseCastMs: 3_000, cooldownMs: 0,
  });
  expect(value).not.toHaveProperty('respawnMs');
});

test("rejects content without Idun's Apple, which the simulation consumes", () => {
  const value = baseContent();
  delete (value.consumables as Record<string, unknown>)['idun-apple'];
  expectInvalidContent(value, 'consumables.idun-apple');
});
