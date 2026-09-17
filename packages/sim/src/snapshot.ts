import type { Content } from '@narok/data';
import { SimError } from './errors';
import { compareScheduled } from './scheduler';
import { validateSimState } from './validate-state';
import type { Battlefield } from './battlefield/types';
import type { SimState } from './types';

/** Contract §3: maximum decoded snapshot input, checked before `JSON.parse` runs. */
const MAX_TEXT_LENGTH = 1_048_576;

/**
 * Recursively sorts object keys by UTF-16 code-unit order (plain string `<`/`>`,
 * never `localeCompare`), preserves array order, and rejects non-finite numbers.
 * Producing the same canonical tree for equal states is what makes repeated
 * `encodeSnapshot` calls byte-identical.
 */
function canonicalize(value: unknown, path: string): unknown {
  if (value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new SimError('INVALID_STATE', path, 'cannot encode a non-finite number');
    }
    return value;
  }
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalize(entry, `${path}.${index}`));
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      result[key] = canonicalize(record[key], `${path}.${key}`);
    }
    return result;
  }
  throw new SimError('INVALID_STATE', path, `cannot encode a value of type ${typeof value}`);
}

/**
 * Serializes `state` to canonical JSON (ruling R23): the queue is emitted in
 * {@link compareScheduled} order regardless of its in-memory layout, and every
 * object's keys are sorted recursively, so repeated calls on equal states
 * produce byte-identical text.
 */
export function encodeSnapshot(state: SimState): string {
  const ordered: SimState = { ...state, queue: [...state.queue].sort(compareScheduled) };
  return JSON.stringify(canonicalize(ordered, '$'));
}

/**
 * Decodes and fully validates a snapshot (ruling R23). Rejects oversized text
 * before `JSON.parse` ever runs, then hands the parsed value to
 * {@link validateSimState} for complete runtime schema/invariant checking —
 * JSON parsing alone is never treated as validation, and snapshots are never
 * trusted as production accounts.
 */
export function decodeSnapshot(text: string, content: Content, battlefield: Battlefield): SimState {
  if (text.length > MAX_TEXT_LENGTH) {
    throw new SimError('INVALID_STATE', '$', 'snapshot text exceeds the 1 MiB limit');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SimError('INVALID_STATE', '$', 'snapshot text is not valid JSON');
  }
  return validateSimState(parsed, content, battlefield);
}
