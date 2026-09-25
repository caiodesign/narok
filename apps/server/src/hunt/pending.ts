/**
 * The pending strategy, server side (milestone B spec part 2 §4; UI spec §5;
 * ruling R115).
 *
 * The four states of a strategy are kept apart on purpose: a draft never
 * leaves the client, a saved preset lives in `strategy_presets`, a pending one
 * is a **deep validated copy** inside the checkpoint, and the active one is
 * `state.input`. Only an apply command moves a preset into the pending slot,
 * and only the engine — at the next encounter spawn, before the recipe draw —
 * moves it on to active (`activatePending`, packages/sim).
 *
 * One copy of the payload exists, in the engine's `state.pendingRules`,
 * checked by the same validator that checks a hunt's start input. The envelope
 * records only which preset version it is, so the UI can name the active and
 * pending versions separately without inferring one from the other.
 */
import {
  STRATEGY_PAYLOAD_SCHEMA_VERSION,
  strategyPresetPayloadSchema,
} from '@narok/protocol';
import { SimError, type PendingRules, type PositionId, type Simulation, type Strategy } from '@narok/sim';
import { AppError } from '../errors';
import type { CheckpointEnvelope, PresetRef } from './envelope';

export interface PresetSnapshot {
  readonly presetId: string;
  readonly presetVersion: number;
  /** The row's payload as read; validated and copied here, never referenced. */
  readonly payload: unknown;
  /** Defaults to the current schema version; any other is refused. */
  readonly payloadSchemaVersion?: number;
}

/**
 * Validates a stored preset payload into engine rules, or refuses it with a
 * stable field under `strategyPreset.` — the protocol shape first, then the
 * engine's own input validator.
 */
export function presetRules(payload: unknown, payloadSchemaVersion: number = STRATEGY_PAYLOAD_SCHEMA_VERSION): PendingRules {
  if (payloadSchemaVersion !== STRATEGY_PAYLOAD_SCHEMA_VERSION) {
    throw new AppError('VALIDATION', 'strategyPreset.payloadSchemaVersion');
  }
  const parsed = strategyPresetPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join('.') ?? '';
    throw new AppError('VALIDATION', path === '' ? 'strategyPreset' : `strategyPreset.${path}`);
  }
  return {
    placement: parsed.data.placement as Record<string, PositionId>,
    strategies: parsed.data.strategies as Record<string, Strategy>,
    rest: parsed.data.rest,
    wipeLimit: parsed.data.wipeLimit,
  };
}

/** Maps the engine's `pendingRules.*` refusal onto the preset the player named. */
function engineRefusal(error: unknown): unknown {
  if (error instanceof SimError && error.code === 'INVALID_INPUT') {
    const field = error.field.startsWith('pendingRules.') ? error.field.slice('pendingRules.'.length) : error.field;
    return new AppError('VALIDATION', `strategyPreset.${field}`);
  }
  return error;
}

/**
 * Queues `preset` for the next spawn, replacing whatever was pending (B-L16).
 * Refuses a payload the engine could not activate, so an unactivatable queue
 * never reaches the checkpoint. Bumps nothing: the generation is the command's
 * business, not the queue's.
 */
export function queueStrategy(
  sim: Simulation,
  envelope: CheckpointEnvelope,
  preset: PresetSnapshot,
  ack: { readonly commandId: string },
): CheckpointEnvelope {
  const rules = presetRules(preset.payload, preset.payloadSchemaVersion);
  const state = sim.decode(envelope.state);

  let queued;
  try {
    queued = sim.queueRules(state, rules);
  } catch (error) {
    throw engineRefusal(error);
  }

  return {
    ...envelope,
    pendingStrategy: {
      presetId: preset.presetId,
      presetVersion: preset.presetVersion,
      commandId: ack.commandId,
      acknowledgedAtSimMs: state.nowMs,
    },
    state: sim.encode(queued),
  };
}

/**
 * After a settlement: if the engine has consumed the queued rules, the pending
 * version is now the active one. Driven by the engine's own state, so it can
 * neither lag nor lead the activation it names.
 */
export function reconcileActivation(envelope: CheckpointEnvelope, pendingRulesQueued: boolean): CheckpointEnvelope {
  if (envelope.pendingStrategy === null || pendingRulesQueued) return envelope;
  const { presetId, presetVersion } = envelope.pendingStrategy;
  return { ...envelope, activeStrategy: { presetId, presetVersion }, pendingStrategy: null };
}

export interface StrategyVersions {
  readonly activeVersion: PresetRef;
  readonly pendingVersion: PresetRef | null;
}

/** What the UI shows: both versions, separately (UI spec §5). */
export function strategyVersions(envelope: CheckpointEnvelope): StrategyVersions {
  const pending = envelope.pendingStrategy;
  return {
    activeVersion: envelope.activeStrategy,
    pendingVersion: pending === null ? null : { presetId: pending.presetId, presetVersion: pending.presetVersion },
  };
}
