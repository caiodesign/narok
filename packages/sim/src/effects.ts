import { schedule } from './scheduler';
import type { Actor, ActorId, Context, DomainEvent, PositionId, SimState, TimedStatus } from './types';

/**
 * A 100% slow would divide the recovery formula by zero and freeze an actor for
 * ever. Prototype content caps slow at 3,000 bp, but decoded/test states may carry
 * up to 10,000, so recovery clamps here to keep the schedule a finite integer.
 */
const MAX_SLOW_BP = 9_999;

/**
 * ASCII/UTF-16 code-unit comparison of actor ids — never `localeCompare`, whose
 * locale-aware collation would silently reorder tie-broken target lists.
 */
export function compareIds(left: ActorId, right: ActorId): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Every living actor in ascending id order. The single stable iteration source for
 * combat: `state.actors` key order comes from construction or from a decoded
 * snapshot, so it is never read directly by strategy, actions, or effects.
 */
export function livingActors(state: SimState): Actor[] {
  return Object.keys(state.actors)
    .sort(compareIds)
    .map((id) => state.actors[id])
    .filter((entry) => entry.hp > 0);
}

/** Fields of a {@link DomainEvent} a handler chooses; `at`/`encounter`/`seq` are stamped here. */
interface EventFields {
  kind: DomainEvent['kind'];
  actorId?: ActorId | null;
  targetId?: ActorId | null;
  amount?: number | null;
  reason?: string | null;
  position?: PositionId | null;
}

/** Emits a domain event stamped with the current simulation time and encounter index. */
export function emitEvent(state: SimState, ctx: Context, fields: EventFields): void {
  const event: Omit<DomainEvent, 'seq'> = {
    at: state.nowMs,
    encounter: state.encounterCount,
    kind: fields.kind,
    actorId: fields.actorId ?? null,
    targetId: fields.targetId ?? null,
    amount: fields.amount ?? null,
    reason: fields.reason ?? null,
    position: fields.position ?? null,
  };
  ctx.emit(event);
}

/**
 * Removes the actor's elapsed timed records (spec §7): statuses whose `expiresAt`
 * has been reached, and a forced-target record at or past its expiry. Emits
 * nothing — the contract gives `expire` no context. A force record whose source
 * died or became unreachable survives until its own expiry; enemy decisions
 * ignore it instead.
 */
export function expire(state: SimState, actorId: ActorId): void {
  const actor = state.actors[actorId];
  if (!actor) return;
  actor.statuses = actor.statuses.filter((status) => status.expiresAt > state.nowMs);
  if (actor.forcedTarget && actor.forcedTarget.expiresAt <= state.nowMs) {
    actor.forcedTarget = null;
  }
}

/** Strongest active attack-rate reduction in basis points — the maximum, never the sum. */
export function effectiveSlowBp(actor: Actor, nowMs: number): number {
  let strongest = 0;
  for (const status of actor.statuses) {
    if (status.kind !== 'slow' || status.expiresAt <= nowMs) continue;
    if (status.valueBp > strongest) strongest = status.valueBp;
  }
  return strongest;
}

/** Latest expiry among the actor's active stuns, or `null` when it is not stunned. */
export function activeStunExpiry(actor: Actor, nowMs: number): number | null {
  let latest: number | null = null;
  for (const status of actor.statuses) {
    if (status.kind !== 'stun' || status.expiresAt <= nowMs) continue;
    if (latest === null || status.expiresAt > latest) latest = status.expiresAt;
  }
  return latest;
}

/**
 * Action recovery for the actor's *next* scheduled decision (spec §7):
 * `ceil(interval * 10000 / (10000 - slow))` against the currently strongest slow.
 * Already-scheduled recovery, movement, and cast durations are never revised.
 */
export function recoveryMs(actor: Actor, nowMs: number): number {
  const slowBp = Math.min(effectiveSlowBp(actor, nowMs), MAX_SLOW_BP);
  return Math.ceil((actor.stats.intervalMs * 10_000) / (10_000 - slowBp));
}

/** Adds `amount` threat for `sourceId` on one enemy's threat table. */
export function addThreat(enemy: Actor, sourceId: ActorId, amount: number): void {
  enemy.threat[sourceId] = (enemy.threat[sourceId] ?? 0) + amount;
}

/**
 * Spreads heal threat (spec §7): every living enemy, in id order, gains
 * `floor(actualRestoration / 2)` for the caster. Overhealing therefore adds zero.
 */
export function addHealThreat(state: SimState, casterId: ActorId, restored: number): void {
  const added = Math.floor(restored / 2);
  for (const enemy of livingActors(state)) {
    if (enemy.side !== 'enemy') continue;
    addThreat(enemy, casterId, added);
  }
}

/**
 * Applies one Taunt to a single validated enemy (R31): caster threat becomes
 * `max(1, ceil(previousMaximum * 1.1))` in integer arithmetic, and the forced-target
 * record is replaced outright — the latest Taunt always wins, duplicate Guardians
 * included — with its own `expire` entry.
 */
export function applyTaunt(
  state: SimState,
  ctx: Context,
  caster: Actor,
  target: Actor,
  durationMs: number,
): void {
  const previous = Object.values(target.threat);
  const previousMax = previous.length === 0 ? 0 : Math.max(...previous);
  const threat = Math.max(1, Math.ceil((previousMax * 11) / 10));
  target.threat[caster.id] = threat;
  const expiresAt = state.nowMs + durationMs;
  target.forcedTarget = { actorId: caster.id, expiresAt };
  schedule(state, { at: expiresAt, kind: 'expire', actorId: target.id, epoch: state.epoch, token: null });
  emitEvent(state, ctx, { kind: 'taunt', actorId: caster.id, targetId: target.id, amount: threat });
}

/**
 * Applies (or refreshes) one source's slow on a target (R31). Slows are keyed per
 * source, so reapplying replaces the record instead of stacking a second one.
 */
export function applySlow(
  state: SimState,
  ctx: Context,
  caster: Actor,
  target: Actor,
  valueBp: number,
  durationMs: number,
): void {
  const expiresAt = state.nowMs + durationMs;
  const status: TimedStatus = {
    id: `slow:${caster.id}`,
    sourceId: caster.id,
    kind: 'slow',
    valueBp,
    expiresAt,
  };
  const index = target.statuses.findIndex((entry) => entry.id === status.id);
  if (index === -1) target.statuses.push(status);
  else target.statuses[index] = status;
  schedule(state, { at: expiresAt, kind: 'expire', actorId: target.id, epoch: state.epoch, token: null });
  emitEvent(state, ctx, {
    kind: 'status', actorId: target.id, targetId: caster.id, amount: valueBp, reason: 'slow',
  });
}
