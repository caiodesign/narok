/**
 * The hunt lifecycle's operational bounds (milestone B spec part 2 §1, P-40).
 *
 * Like the platform bounds in `../config.ts`, these are **proposed defaults**,
 * each named where the spec proposes it, and each refused at startup when it
 * is out of range rather than degraded into at runtime.
 */
import { OFFLINE_CAP_MS } from './clock';
import { REWARD_CARRIER_CAP } from './envelope';

/**
 * The retention `command_results` already uses (tx.ts, 24 h): part 1 §9 #8
 * leaves the retention of `command_results` and `hunt_reports` to one open
 * decision, and until it is taken the report borrows its sibling's value
 * rather than inventing one (ruling R118). Only the latest report is kept in
 * any case, so this bounds an unread report's age, not how many exist.
 */
const REPORT_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface HuntConfig {
  /** Step 6: how old the committed checkpoint may get. ~20 s, layer-1 §4.4 step 6. */
  readonly persistCadenceMs: number;
  /** Step 3: how far ahead of the committed state playback is computed. ~30 s, layer-1 §4.4. */
  readonly precomputeHorizonMs: number;
  /** The shared offline cap, 12 h (layer-1 §4.6). Recorded into each checkpoint. */
  readonly offlineCapMs: number;
  /**
   * Refused before insert, surfaced as a fault, never truncated (part 1 §9 #6).
   * Sized to hold the engine's own 1 MiB decode cap plus the bounded envelope;
   * the real figure is a VPS measurement, not this.
   */
  readonly maxCheckpointBytes: number;
  /** The reward carrier bound; reaching it forces a commit (part 2 §9 #8). At most the envelope's cap. */
  readonly rewardCarrierCap: number;
  /** How long the latest away report is retained unread (ruling R118, part 1 §9 #8 open). */
  readonly reportRetentionMs: number;
}

export function defaultHuntConfig(): HuntConfig {
  return {
    persistCadenceMs: 20_000,
    precomputeHorizonMs: 30_000,
    offlineCapMs: OFFLINE_CAP_MS,
    maxCheckpointBytes: 2 * 1024 * 1024,
    rewardCarrierCap: REWARD_CARRIER_CAP,
    reportRetentionMs: REPORT_RETENTION_MS,
  };
}

export function validateHuntConfig(config: HuntConfig): HuntConfig {
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw new RangeError(`hunt.${key} must be a positive integer, got ${String(value)}`);
    }
  }
  if (config.rewardCarrierCap > REWARD_CARRIER_CAP) {
    throw new RangeError(`hunt.rewardCarrierCap must not exceed the envelope's ${REWARD_CARRIER_CAP}`);
  }
  return config;
}
