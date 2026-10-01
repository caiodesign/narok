/**
 * The default strategy per class (ruling R163): content-derived — it names
 * skills by id and nothing else — so it lives in `@narok/data`, where the
 * engine-free client can build a setup draft from it. `@narok/sim` re-exports
 * it unchanged; there is one implementation.
 */
import type { ClassId, Strategy } from './types';

/**
 * Spec §6 default rule tables (R22), all rules enabled. The Cleric's Revive
 * comes first (ruling R153): a fallen ally outranks a hurt one. It never fires
 * while the Cleric's Revive rank is 0, so a Cleric without the spell plays
 * exactly as before.
 */
export function defaultStrategy(classId: ClassId): Strategy {
  switch (classId) {
    case 'guardian':
      return {
        rules: [
          { skillId: 'taunt', enabled: true, condition: { kind: 'ally-targeted' } },
          { skillId: 'cleave', enabled: true, condition: { kind: 'targets-at-least', value: 2 } },
        ],
        target: { kind: 'nearest' },
      };
    case 'cleric':
      return {
        rules: [
          { skillId: 'revive', enabled: true, condition: { kind: 'ally-dead' } },
          { skillId: 'heal', enabled: true, condition: { kind: 'ally-hp-below', value: 60 } },
          { skillId: 'smite', enabled: true, condition: { kind: 'always' } },
        ],
        target: { kind: 'lowest-hp' },
      };
    case 'ranger':
      return {
        rules: [
          { skillId: 'arrow-rain', enabled: true, condition: { kind: 'targets-at-least', value: 3 } },
          { skillId: 'double-shot', enabled: true, condition: { kind: 'always' } },
        ],
        target: { kind: 'lowest-hp' },
      };
    case 'arcanist':
      return {
        rules: [
          { skillId: 'frost-nova', enabled: true, condition: { kind: 'targets-at-least', value: 3 } },
          { skillId: 'fire-bolt', enabled: true, condition: { kind: 'always' } },
        ],
        target: { kind: 'lowest-hp' },
      };
  }
}
