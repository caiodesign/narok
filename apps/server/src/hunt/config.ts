/**
 * The hunt lifecycle's operational bounds (milestone B spec part 2 §1, P-40).
 *
 * Like the platform bounds in `../config.ts`, these are **proposed defaults**,
 * each named where the spec proposes it, and each refused at startup when it
 * is out of range rather than degraded into at runtime.
 */
import { OFFLINE_CAP_MS } from './clock';

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
}

export function defaultHuntConfig(): HuntConfig {
  return {
    persistCadenceMs: 20_000,
    precomputeHorizonMs: 30_000,
    offlineCapMs: OFFLINE_CAP_MS,
    maxCheckpointBytes: 2 * 1024 * 1024,
  };
}

export function validateHuntConfig(config: HuntConfig): HuntConfig {
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw new RangeError(`hunt.${key} must be a positive integer, got ${String(value)}`);
    }
  }
  return config;
}
