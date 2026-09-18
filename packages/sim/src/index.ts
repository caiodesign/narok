import { ContentError, validateContent } from '@narok/data';
import type { Content } from '@narok/data';
import { advance as runAdvance, cloneState } from './advance';
import { SimError } from './errors';
import { project as projectState } from './project';
import { decodeSnapshot, encodeSnapshot } from './snapshot';
import { startState } from './state';
import type { Battlefield } from './battlefield/types';
import type { AdvanceOptions, AdvanceResult, LabInput, PublicState, Simulation, SimState } from './types';

export * from './types';
export { drawBelow, nextU32 } from './rng';
export { SimError } from './errors';
export type { SimErrorCode } from './errors';
export { createGrid, gridCoordinates, gridPosition, defaultPlacement } from './battlefield/grid';
export type { Battlefield } from './battlefield/types';
export { derive, damage, effectiveHeal } from './math';
export type { DamageInput } from './math';
export { startState, defaultStrategy } from './state';
export { encodeSnapshot, decodeSnapshot } from './snapshot';
export { compareScheduled, schedule, takeNext, isStale } from './scheduler';
export { decide, resolveCast } from './actions';
export { expire } from './effects';
export { transition, regenerate, finishEncounter, deadline } from './lifecycle';
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
export function createSimulation(content: Content, battlefield: Battlefield): Simulation {
  const bound = guard('content', () => validateContent(content));

  return {
    start(input: LabInput): SimState {
      return guard('input', () => startState(bound, battlefield, input));
    },

    advance(state: SimState, untilMs: number, options?: AdvanceOptions): AdvanceResult {
      return guard('state', () => runAdvance(bound, battlefield, state, untilMs, options));
    },

    /**
     * Operator stop (ruling R43): the experiment keeps its exact time, metrics,
     * RNG and actor conditions, drops all scheduled work, and emits nothing — no
     * win, no wipe, no rewards.
     */
    stop(state: SimState): SimState {
      return guard('state', () => {
        const stopped = cloneState(state);
        stopped.phase = 'stopped';
        stopped.stopReason = 'operator';
        stopped.queue = [];
        return stopped;
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
