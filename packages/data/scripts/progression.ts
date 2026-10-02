import { PROGRESSION_SOURCE } from '../src/prototype';
import type { ProgressionTables } from '../src/types';

/**
 * Compiles the levelling tables (layer-1 §4.2, §5.3, §5.4; Part 3 §5.1; ruling
 * R134). The only place `level^2.2` is ever evaluated: the build writes the
 * integers into versioned content and the runtime only indexes them, so no
 * floating-point power can differ between two runtimes.
 */
export function compileProgression(source: typeof PROGRESSION_SOURCE = PROGRESSION_SOURCE): ProgressionTables {
  const expToNext: number[] = [];
  const statPoints: number[] = [];
  const skillPoints: number[] = [];
  for (let level = 1; level <= source.levelCap; level += 1) {
    if (level < source.levelCap) {
      expToNext.push(Math.floor(source.expBase * level ** source.expExponent));
    }
    statPoints.push(level === 1
      ? source.creationStatPoints
      : source.levelStatPoints + Math.floor(level / source.levelStatDivisor));
    skillPoints.push(level === 1
      ? source.creationSkillPoints
      : level % source.skillPointEveryLevels === 0 ? 1 : 0);
  }
  return {
    levelCap: source.levelCap,
    expToNext,
    statPoints,
    skillPoints,
    maxSkillRank: source.maxSkillRank,
    attributeCap: source.attributeCap,
  };
}
