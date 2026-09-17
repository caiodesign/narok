import { content } from '@narok/data';
import type { Actor } from '../src/types';
import { derive } from '../src/math';
import { gridPosition } from '../src/battlefield/grid';

/**
 * Builds a living party Guardian `p0` fixture with preset stats derived from the
 * Guardian class definition via `derive()`.
 *
 * Every call returns fresh objects (no shared references across calls); pass
 * `overrides` to replace top-level fields explicitly.
 */
export function actor(overrides: Partial<Actor> = {}): Actor {
  const stats = derive(content.classes.guardian);
  const base: Actor = {
    id: 'p0',
    side: 'party',
    definitionId: 'guardian',
    level: 10,
    family: 'humanoid',
    element: 'neutral',
    attributes: { str: 11, agi: 1, vit: 11, int: 1, dex: 6, luk: 1 },
    stats,
    hp: stats.maxHp,
    mp: stats.maxMp,
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
