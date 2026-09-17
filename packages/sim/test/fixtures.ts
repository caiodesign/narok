import type { Actor } from '../src/types';
import { gridPosition } from '../src/battlefield/grid';

/**
 * Builds a living party Guardian `p0` fixture with preset stats. `derive()` does not
 * exist yet (Task 3), so stats are literal Guardian values computed by hand; Task 3
 * will replace these literals with `derive()` output.
 *
 * Every call returns fresh objects (no shared references across calls); pass
 * `overrides` to replace top-level fields explicitly.
 */
export function actor(overrides: Partial<Actor> = {}): Actor {
  const base: Actor = {
    id: 'p0',
    side: 'party',
    definitionId: 'guardian',
    level: 10,
    family: 'humanoid',
    element: 'neutral',
    attributes: { str: 11, agi: 1, vit: 11, int: 1, dex: 6, luk: 1 },
    stats: {
      maxHp: 277,
      maxMp: 60,
      atk: 37,
      matk: 1,
      def: 17,
      mdef: 3,
      hit: 16,
      flee: 11,
      critBp: 0,
      intervalMs: 1569,
    },
    hp: 277,
    mp: 60,
    position: gridPosition(2, 3),
    basicKind: 'physical',
    basicRange: 1,
    skills: ['taunt', 'cleave'],
    cooldowns: {},
    statuses: [],
    threat: {},
    forcedTarget: null,
    currentTarget: null,
    pendingCast: null,
    actionToken: 0,
  };
  return { ...base, ...overrides };
}
