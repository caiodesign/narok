/**
 * The Strategy lifecycle's pure half (milestone B spec part 4 §3.2): turning a
 * saved preset into the draft the editor mutates, the draft back into the
 * payload a Save or an Apply sends, and the dirty test the unsaved markers
 * render.
 *
 * A saved payload (schema version 1) holds placement, one strategy per party
 * slot and the rest thresholds; the party itself is the account's characters,
 * so `classes` comes from them and is never stored. A slot the payload does
 * not cover is filled from the content-derived defaults (`@narok/data`), and
 * the saved baseline is normalised the same way, so opening a preset never
 * reads as an edit.
 */
import type { ClassId } from '@narok/data';
import { defaultPlacement, defaultStrategy } from '@narok/data';
import type { ActorId, PositionId, Strategy } from '@narok/sim';
import type { StrategyPresetPayload } from '@narok/protocol';
import type { EditorDraft } from '../../ExperimentControls';
import type { StrategyPresetRecord } from '../../commands';

/** Three saved presets, never a fourth (part 4 §3.2; spec §2.2 forbids the premium slot). */
export const PRESET_TAB_LIMIT = 3;

export function draftFromPreset(record: StrategyPresetRecord, classes: readonly ClassId[]): EditorDraft {
  const ids = classes.map((_, index) => `p${index}`);
  const seats = defaultPlacement([...classes]);
  const payload = record.payload;
  const placement: Record<ActorId, PositionId> = {};
  const strategies: Record<ActorId, Strategy> = {};
  ids.forEach((id, index) => {
    placement[id] = (payload.placement[id] as PositionId | undefined) ?? seats[id]!;
    strategies[id] = (payload.strategies[id] as Strategy | undefined) ?? defaultStrategy(classes[index]!);
  });
  return { classes: [...classes], placement, strategies, rest: { ...payload.rest } };
}

/** What Save and Apply send: the draft's placement, rules and rest, and nothing the server owns. */
export function payloadOf(draft: EditorDraft): StrategyPresetPayload {
  return { placement: { ...draft.placement }, strategies: { ...draft.strategies }, rest: { ...draft.rest } };
}

/** Key-order-independent serialisation, so an equal draft is never "dirty". */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function samePayload(a: EditorDraft, b: EditorDraft): boolean {
  return canonical(payloadOf(a)) === canonical(payloadOf(b));
}

/** The characters whose placement or rules differ from the saved preset (the reference's per-tab pips). */
export function unsavedActorsOf(draft: EditorDraft, saved: EditorDraft): ReadonlySet<ActorId> {
  const changed = new Set<ActorId>();
  for (const id of Object.keys(draft.strategies)) {
    if (
      canonical(draft.strategies[id]) !== canonical(saved.strategies[id]) ||
      draft.placement[id] !== saved.placement[id]
    ) {
      changed.add(id);
    }
  }
  return changed;
}
