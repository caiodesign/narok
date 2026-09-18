import { compareIds } from './effects';
import type { Actor, Metrics, PublicActor, PublicState, SimState } from './types';

/**
 * The factual reason the actor is currently pointed at `currentTarget` (ruling
 * R42), for labels such as "Taunted by Guardian" / "Highest threat". Derived only
 * from what has already happened: an unexpired forced-target record that names the
 * current target, otherwise an enemy's accumulated threat for it, otherwise the
 * strategy's own priority. Never a prediction of the next target.
 */
function targetReason(actor: Actor, nowMs: number): PublicActor['targetReason'] {
  const target = actor.currentTarget;
  if (target === null) return null;
  const forced = actor.forcedTarget;
  if (forced !== null && forced.expiresAt > nowMs && forced.actorId === target) return 'forced';
  if (actor.side === 'enemy' && (actor.threat[target] ?? 0) > 0) return 'threat';
  return 'priority';
}

/** Deep-copies metrics so a projection consumer can never write back into the state. */
function copyMetrics(metrics: Metrics): Metrics {
  const actors: Metrics['actors'] = {};
  for (const id of Object.keys(metrics.actors).sort(compareIds)) {
    actors[id] = { ...metrics.actors[id] };
  }
  return {
    kills: metrics.kills,
    wins: metrics.wins,
    wipes: metrics.wipes,
    rawExp: metrics.rawExp,
    rawGold: metrics.rawGold,
    damageDealt: metrics.damageDealt,
    effectiveHealing: metrics.effectiveHealing,
    walkMs: metrics.walkMs,
    fightMs: metrics.fightMs,
    restMs: metrics.restMs,
    respawnMs: metrics.respawnMs,
    actors,
  };
}

/**
 * Projects the safe public view of a state (ruling R42). Every field is listed
 * explicitly — never a spread of the runtime actor — so the queue, RNG, action
 * tokens, epochs, threat tables, status internals and pending-cast targets stay
 * inside the simulation. The only cast information published is the skill an actor
 * is currently casting, never its future outcome. Actors are listed in ASCII id
 * order; `cooldowns` (ruling R12) carries the actor's own ready-at timestamps so a
 * client can show factual remaining cooldown.
 */
export function project(state: SimState): PublicState {
  const actors: PublicActor[] = Object.keys(state.actors)
    .sort(compareIds)
    .map((id) => {
      const actor = state.actors[id];
      return {
        id: actor.id,
        definitionId: actor.definitionId,
        side: actor.side,
        position: actor.position,
        hp: actor.hp,
        mp: actor.mp,
        maxHp: actor.stats.maxHp,
        maxMp: actor.stats.maxMp,
        currentTarget: actor.currentTarget,
        casting: actor.pendingCast?.skillId ?? null,
        targetReason: targetReason(actor, state.nowMs),
        cooldowns: { ...actor.cooldowns },
      };
    });

  return {
    nowMs: state.nowMs,
    phase: state.phase,
    stopReason: state.stopReason,
    actors,
    metrics: copyMetrics(state.metrics),
  };
}
