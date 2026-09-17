import { SimError } from './errors';
import type { QueueKind, ScheduledEvent, SimState } from './types';

/** Fixed queue-phase priority table from the contract §5. Lower runs first. */
const priority: Record<QueueKind, number> = {
  expire: 0,
  regen: 10,
  resolve: 20,
  act: 30,
  deadline: 40,
  transition: 50,
};

/**
 * Canonical scheduling order: `(at, priority, actorId, seq)`. `actorId` compares
 * by ASCII/UTF-16 code-unit order via plain `<`/`>` — never `localeCompare`, whose
 * locale-aware collation would silently reorder equal-time global/actor ties.
 */
export function compareScheduled(a: ScheduledEvent, b: ScheduledEvent): number {
  return (
    a.at - b.at ||
    priority[a.kind] - priority[b.kind] ||
    (a.actorId < b.actorId ? -1 : a.actorId > b.actorId ? 1 : 0) ||
    a.seq - b.seq
  );
}

/**
 * Schedules `event`, assigning the next monotonic queue sequence and inserting it
 * to keep `state.queue` in canonical {@link compareScheduled} order at all times.
 * Rejects non-future scheduling (`event.at <= state.nowMs`) as a loop-detection
 * guard: nothing may schedule a same-time-or-earlier entry.
 */
export function schedule(state: SimState, event: Omit<ScheduledEvent, 'seq'>): void {
  if (event.at <= state.nowMs) {
    throw new SimError(
      'LOOP_DETECTED',
      'event.at',
      `scheduled event at ${event.at} must be strictly later than nowMs ${state.nowMs}`,
    );
  }
  const complete: ScheduledEvent = { ...event, seq: state.nextQueueSeq++ };
  const index = state.queue.findIndex((existing) => compareScheduled(complete, existing) < 0);
  if (index === -1) {
    state.queue.push(complete);
  } else {
    state.queue.splice(index, 0, complete);
  }
}

/** Removes and returns the canonically-smallest queued entry, or `undefined` when empty. */
export function takeNext(state: SimState): ScheduledEvent | undefined {
  return state.queue.shift();
}

/**
 * A queued entry is stale when its `epoch` no longer matches the state's current
 * epoch, or its `token` no longer matches the referenced actor's current
 * `actionToken` (including when the actor no longer exists). `null` epoch/token
 * never make an entry stale on that axis. Stale entries remain valid queue
 * members; callers (task 7's dispatcher) skip acting on them.
 */
export function isStale(state: Pick<SimState, 'epoch' | 'actors'>, event: ScheduledEvent): boolean {
  const epochStale = event.epoch !== null && event.epoch !== state.epoch;
  const actor = state.actors[event.actorId];
  const tokenStale = event.token !== null && event.token !== actor?.actionToken;
  return epochStale || tokenStale;
}
