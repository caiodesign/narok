import { ContentError, validateContent } from '@narok/data';
import type { Content } from '@narok/data';
import type { LootPreset } from '@narok/loot';
import { advance as runAdvance, cloneState } from './advance';
import { SimError } from './errors';
import { project as projectState } from './project';
import { applyLoot, dispositionRewards } from './rewards';
import { decodeSnapshot, encodeSnapshot } from './snapshot';
import { startState, validateLoot, validatePendingRules } from './state';
import type { Battlefield } from './battlefield/types';
import type {
  AdvanceOptions,
  AdvanceResult,
  Context,
  HuntSetup,
  LabInput,
  PendingReward,
  PendingRules,
  PublicState,
  Simulation,
  SimState,
} from './types';

export * from './types';
export { drawBelow, nextU32 } from './rng';
export { SimError } from './errors';
export type { SimErrorCode } from './errors';
export { createGrid, gridCoordinates, gridPosition, defaultPlacement } from './battlefield/grid';
export type { Battlefield } from './battlefield/types';
export { derive, damage, effectiveHeal } from './math';
export type { DamageInput } from './math';
export { resolveLoadout, deriveCharacter, offenseBonusFor, resistFor, characterMaxima, refreshPartyActor } from './loadout';
export type { ResolvedLoadout } from './loadout';
export {
  startState, defaultStrategy, validatePendingRules, validateBag, validateLoot, validateProtection,
  DEFAULT_WIPE_LIMIT, WIPE_LIMIT_RANGE, validateProgress, validateEquipped, validateHuntCharacter,
} from './state';
export {
  bandFor, rollReward, rollKill, dispositionRewards, raiseToGuarantee, emptyDropMetrics, defaultBag, starterLoot,
  awardKillExp,
} from './rewards';
export { encodeSnapshot, decodeSnapshot } from './snapshot';
export { compareScheduled, schedule, takeNext, isStale } from './scheduler';
export { decide, resolveCast } from './actions';
export { expire } from './effects';
export { transition, regenerate, finishEncounter, deadline, activatePending } from './lifecycle';
export { advance } from './advance';
export { project } from './project';

/**
 * Runs `operation`, translating the errors raised beneath the public boundary into
 * `SimError` with the documented codes (ruling R43): a `ContentError` becomes
 * `INVALID_CONTENT` and a `RangeError` (the arithmetic guards in `math.ts`/`rng.ts`)
 * becomes `UNSAFE_INTEGER`, each keeping a bounded diagnostic field path. `SimError`
 * passes through unchanged; nothing ever embeds a serialized state in its message.
 */
function guard<T>(field: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof SimError) throw error;
    if (error instanceof ContentError) {
      throw new SimError('INVALID_CONTENT', error.field, error.message);
    }
    if (error instanceof RangeError) {
      throw new SimError('UNSAFE_INTEGER', field, error.message);
    }
    throw error;
  }
}

/**
 * The package's public entry point (contract §3, ruling R43). Binds validated
 * content and a battlefield adapter once, then exposes the whole `Simulation`
 * surface over them. Every method clones before it mutates, so neither the caller's
 * state nor the bound content is ever written to, and none of them reads wall time
 * or `Math.random()`.
 */
/**
 * Splits off the rewards that have been dispositioned (ruling R127), for the
 * commit that credits them: the returned state keeps only the rewards still
 * waiting for their encounter to end. Pure — the caller's state is cloned —
 * and harmless to the simulation, which never reads a dispositioned reward
 * again, so draining between two segments cannot change what follows.
 */
export function takeDispositionedRewards(state: SimState): { state: SimState; rewards: PendingReward[] } {
  const next = cloneState(state);
  const rewards = next.pendingRewards.filter((reward) => reward.disposition !== null);
  next.pendingRewards = next.pendingRewards.filter((reward) => reward.disposition === null);
  return { state: next, rewards };
}

export function createSimulation(content: Content, battlefield: Battlefield): Simulation {
  const bound = guard('content', () => validateContent(content));

  return {
    start(input: LabInput, setup?: HuntSetup): SimState {
      return guard('input', () => startState(bound, battlefield, input, setup));
    },

    advance(state: SimState, untilMs: number, options?: AdvanceOptions): AdvanceResult {
      return guard('state', () => runAdvance(bound, battlefield, state, untilMs, options));
    },

    /**
     * Operator stop (ruling R43): the experiment keeps its exact time, metrics,
     * RNG and actor conditions, drops all scheduled work, and emits nothing — no
     * win, no wipe, no new reward. Drops the abandoned encounter's kills already
     * rolled are dispositioned silently, so none is left waiting for an
     * encounter end that will never come (ruling R127).
     */
    stop(state: SimState): SimState {
      return guard('state', () => {
        const stopped = cloneState(state);
        const silent: Context = { content: bound, battlefield, emit: () => undefined };
        dispositionRewards(stopped, silent);
        stopped.phase = 'stopped';
        stopped.stopReason = 'operator';
        stopped.queue = [];
        return stopped;
      });
    },

    /**
     * Queues a strategy for the next spawn (ruling R115). Pure: the caller's
     * state is cloned, the rules are validated against its roster and copied,
     * and nothing else changes — no RNG, no time, no event.
     */
    queueRules(state: SimState, rules: PendingRules | null): SimState {
      return guard('state', () => {
        const queued = cloneState(state);
        queued.pendingRules = rules === null ? null : validatePendingRules(rules, queued.input, bound, battlefield);
        return queued;
      });
    },

    queueLoot(state: SimState, preset: LootPreset): SimState {
      return guard('state', () => {
        const applied = cloneState(state);
        applyLoot(applied, validateLoot(preset, 'loot', 'INVALID_INPUT'));
        return applied;
      });
    },

    encode(state: SimState): string {
      return guard('state', () => encodeSnapshot(state));
    },

    decode(text: string): SimState {
      return guard('$', () => decodeSnapshot(text, bound, battlefield));
    },

    project(state: SimState): PublicState {
      return guard('state', () => projectState(state));
    },
  };
}
