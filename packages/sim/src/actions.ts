import type { SkillDefinition, SkillId } from '@narok/data';
import {
  activeStunExpiry,
  addHealThreat,
  addThreat,
  applySlow,
  applyTaunt,
  emitEvent,
  livingActors,
  recoveryMs,
} from './effects';
import { damage, effectiveHeal } from './math';
import { drawBelow } from './rng';
import { schedule } from './scheduler';
import { selectDecision } from './strategy';
import type { Actor, ActorId, Context, PendingCast, PositionId, SimState } from './types';

/** Basics resolve one millisecond after they start (spec §5). */
const BASIC_CAST_MS = 1;
/** An actor with nothing reachable retries its decision in half a second (spec §5). */
const IDLE_RETRY_MS = 500;
/** Family multiplier Smite applies to Undead/Demon defenders (spec §4). */
const SMITE_FAMILY_BP = 15_000;
const NEUTRAL_FAMILY_BP = 10_000;
/** Basic attacks carry full power and no elemental identity. */
const BASIC_POWER_BP = 10_000;
/** Variance is an integer in `[9000, 11000]`, drawn as `9000 + drawBelow(2001)`. */
const VARIANCE_FLOOR_BP = 9_000;
const VARIANCE_SPAN = 2_001;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Cast duration from spec §5: `ceil(base * (150 - min(DEX,99)) / 150)`, never below 1 ms. */
function castDuration(baseCastMs: number, dex: number): number {
  return Math.max(1, Math.ceil((baseCastMs * (150 - Math.min(dex, 99))) / 150));
}

function skillOf(ctx: Context, skillId: SkillId | 'basic'): SkillDefinition | null {
  return skillId === 'basic' ? null : ctx.content.skills[skillId];
}

/** Manhattan reach of a cast: the skill's declared range, or the actor's basic range. */
function rangeOf(actor: Actor, skill: SkillDefinition | null): number {
  return skill === null ? actor.basicRange : skill.range;
}

/**
 * Starts one cast (R27): spend MP, begin the cooldown, record the pending cast under
 * a freshly incremented action token, schedule its `resolve`, and announce it. Every
 * replacement of an actor's queued work bumps `actionToken`, which is what makes the
 * superseded `act`/`resolve` entries stale.
 */
function startCast(
  state: SimState,
  ctx: Context,
  actor: Actor,
  skillId: SkillId | 'basic',
  targets: ActorId[],
): void {
  const skill = skillOf(ctx, skillId);
  let castMs = BASIC_CAST_MS;
  if (skill !== null) {
    actor.mp -= skill.mp;
    actor.cooldowns[skill.id] = state.nowMs + skill.cooldownMs;
    castMs = castDuration(skill.baseCastMs, actor.attributes.dex);
  }
  const completesAt = state.nowMs + castMs;
  actor.actionToken += 1;
  actor.pendingCast = {
    skillId,
    targets: [...targets],
    startedAt: state.nowMs,
    completesAt,
    token: actor.actionToken,
  };
  actor.currentTarget = targets[0] ?? null;
  schedule(state, {
    at: completesAt, kind: 'resolve', actorId: actor.id, epoch: state.epoch, token: actor.actionToken,
  });
  emitEvent(state, ctx, {
    kind: 'cast', actorId: actor.id, targetId: targets[0] ?? null, reason: skillId,
  });
}

/**
 * Executes one step at decision time (R27). Occupancy is rechecked immediately before
 * the assignment — queue order decides who wins a contested cell — and the next
 * decision follows one move interval later either way.
 */
function executeMove(
  state: SimState,
  ctx: Context,
  actor: Actor,
  position: PositionId,
  targetId: ActorId,
): void {
  actor.currentTarget = targetId;
  const blocked = livingActors(state).some(
    (other) => other.id !== actor.id && other.position === position,
  );
  if (!blocked) {
    actor.position = position;
    emitEvent(state, ctx, { kind: 'move', actorId: actor.id, targetId, position });
  }
  actor.actionToken += 1;
  schedule(state, {
    at: state.nowMs + ctx.content.grid.moveMs, kind: 'act',
    actorId: actor.id, epoch: state.epoch, token: actor.actionToken,
  });
}

/**
 * One actor's action decision. A stunned actor postpones the whole decision to the
 * latest active stun expiry under its *current* token: nothing is cancelled and no
 * resources move.
 */
export function decide(state: SimState, actorId: ActorId, ctx: Context): void {
  const actor = state.actors[actorId];
  if (actor === undefined || actor.hp <= 0) return;

  const stunnedUntil = activeStunExpiry(actor, state.nowMs);
  if (stunnedUntil !== null) {
    schedule(state, {
      at: stunnedUntil, kind: 'act', actorId, epoch: state.epoch, token: actor.actionToken,
    });
    return;
  }

  const decision = selectDecision(state, actor, ctx.content, ctx.battlefield);
  switch (decision.kind) {
    case 'cast':
      startCast(state, ctx, actor, decision.skillId, decision.targets);
      return;
    case 'move':
      executeMove(state, ctx, actor, decision.position, decision.targetId);
      return;
    case 'idle':
      actor.currentTarget = null;
      actor.actionToken += 1;
      schedule(state, {
        at: state.nowMs + IDLE_RETRY_MS, kind: 'act',
        actorId, epoch: state.epoch, token: actor.actionToken,
      });
      return;
  }
}

/** Marks a dead actor (R30): announce it, invalidate its queued work, bank the reward. */
function processDeath(state: SimState, ctx: Context, dead: Actor, killer: Actor): void {
  emitEvent(state, ctx, { kind: 'death', actorId: dead.id, targetId: killer.id });
  dead.actionToken += 1;
  dead.pendingCast = null;
  dead.currentTarget = null;
  dead.forcedTarget = null;
  if (dead.side === 'enemy') {
    const monster = ctx.content.monsters[dead.definitionId];
    state.metrics.kills += 1;
    state.metrics.rawExp += monster.rawExp;
    state.metrics.rawGold += monster.rawGold;
  }
}

/**
 * Resolves one hit attempt (R30) and reports whether it landed. Physical attempts
 * always consume crit, accuracy, and variance draws in that order — even on a miss —
 * while magic consumes variance only, always hits, and never crits.
 */
function performHit(
  state: SimState,
  ctx: Context,
  attacker: Actor,
  defender: Actor,
  label: string,
  skill: SkillDefinition | null,
): boolean {
  const kind = skill === null ? attacker.basicKind : skill.damageKind;
  let critical = false;
  let landed = true;

  if (kind === 'physical') {
    const crit = drawBelow(state.rng, 10_000);
    state.rng = crit.state;
    const accuracy = drawBelow(state.rng, 10_000);
    state.rng = accuracy.state;
    critical = crit.value < attacker.stats.critBp;
    const chanceBp = clamp(80 + attacker.stats.hit - defender.stats.flee, 5, 95) * 100;
    landed = critical || accuracy.value < chanceBp;
  }
  const variance = drawBelow(state.rng, VARIANCE_SPAN);
  state.rng = variance.state;

  const element = skill === null ? 'neutral' : skill.element;
  const familyBp =
    skill?.id === 'smite' && (defender.family === 'undead' || defender.family === 'demon')
      ? SMITE_FAMILY_BP
      : NEUTRAL_FAMILY_BP;
  const amount = damage({
    offense: kind === 'physical' ? attacker.stats.atk : attacker.stats.matk,
    powerBp: skill === null ? BASIC_POWER_BP : skill.powerBp,
    elementBp: ctx.content.elements[element][defender.element],
    familyBp,
    varianceBp: VARIANCE_FLOOR_BP + variance.value,
    critical,
    defense: kind === 'physical' ? defender.stats.def : defender.stats.mdef,
    hit: landed,
  });

  if (!landed) {
    emitEvent(state, ctx, { kind: 'miss', actorId: attacker.id, targetId: defender.id, reason: label });
    return false;
  }

  const effective = Math.min(amount, defender.hp);
  defender.hp -= effective;
  emitEvent(state, ctx, {
    kind: 'damage', actorId: attacker.id, targetId: defender.id, amount: effective,
    reason: critical ? `${label}:critical` : label,
  });

  if (attacker.side === 'party') {
    state.metrics.damageDealt += effective;
    state.metrics.actors[attacker.id].damageDealt += effective;
    if (defender.side === 'enemy') addThreat(defender, attacker.id, effective);
  }
  if (defender.side === 'party') {
    state.metrics.actors[defender.id].damageReceived += effective;
  }
  if (defender.hp <= 0) processDeath(state, ctx, defender, attacker);
  return true;
}

/**
 * Lands a skill's declared hit count on one target, stopping the moment it dies —
 * Double Shot's second arrow only flies at a target that survived the first, with no
 * retarget in between. Reports whether the last attempt landed (Frost Nova's slow
 * only follows a hit).
 */
function strike(
  state: SimState,
  ctx: Context,
  caster: Actor,
  target: Actor,
  label: string,
  skill: SkillDefinition | null,
): boolean {
  const hits = skill === null ? 1 : skill.hits;
  let landed = false;
  for (let index = 0; index < hits; index++) {
    if (target.hp <= 0) break;
    landed = performHit(state, ctx, caster, target, label, skill);
  }
  return landed;
}

/** A cast that found nothing legal to affect: announced, never refunded, no RNG spent. */
function fizzle(state: SimState, ctx: Context, caster: Actor, cast: PendingCast): void {
  emitEvent(state, ctx, {
    kind: 'miss', actorId: caster.id, targetId: cast.targets[0] ?? null,
    reason: `${cast.skillId}:fizzle`,
  });
}

/** A single-target cast requires its target to be alive and still inside the cast's range. */
function validSingleTarget(
  state: SimState,
  ctx: Context,
  caster: Actor,
  cast: PendingCast,
  range: number,
): Actor | null {
  const target = cast.targets[0] === undefined ? undefined : state.actors[cast.targets[0]];
  if (target === undefined || target.hp <= 0) return null;
  if (!ctx.battlefield.inRange(caster.position, target.position, range)) return null;
  return target;
}

function resolveHeal(
  state: SimState,
  ctx: Context,
  caster: Actor,
  cast: PendingCast,
  skill: SkillDefinition,
): void {
  const target = validSingleTarget(state, ctx, caster, cast, skill.range);
  if (target === null) {
    fizzle(state, ctx, caster, cast);
    return;
  }
  const restored = effectiveHeal(target.hp, target.stats.maxHp, 50 + 2 * caster.attributes.int);
  target.hp += restored;
  emitEvent(state, ctx, {
    kind: 'heal', actorId: caster.id, targetId: target.id, amount: restored, reason: skill.id,
  });
  state.metrics.effectiveHealing += restored;
  state.metrics.actors[caster.id].healingDone += restored;
  // Threat follows the restoration that actually landed, so overhealing adds nothing.
  addHealThreat(state, caster.id, restored);
}

function resolveTaunt(
  state: SimState,
  ctx: Context,
  caster: Actor,
  cast: PendingCast,
  skill: SkillDefinition,
): void {
  const valid = cast.targets
    .map((id) => state.actors[id])
    .filter(
      (target) =>
        target !== undefined &&
        target.hp > 0 &&
        ctx.battlefield.inRange(caster.position, target.position, skill.range),
    );
  if (valid.length === 0) {
    fizzle(state, ctx, caster, cast);
    return;
  }
  for (const target of valid) applyTaunt(state, ctx, caster, target, skill.durationMs);
}

/**
 * Area damage (R30): the primary must still be alive and in range or the whole cast
 * fizzles. The clipped shape is anchored on the primary's *current* cell, only hostile
 * actors are eligible, and the affected ids are struck in ascending id order with
 * death processing completed after each hit.
 */
function resolveArea(
  state: SimState,
  ctx: Context,
  caster: Actor,
  cast: PendingCast,
  skill: SkillDefinition,
): void {
  const primary = validSingleTarget(state, ctx, caster, cast, skill.range);
  if (primary === null) {
    fizzle(state, ctx, caster, cast);
    return;
  }
  const eligible = livingActors(state).filter((entry) => entry.side !== caster.side);
  for (const id of ctx.battlefield.affected(primary, skill.shape, eligible)) {
    const target = state.actors[id];
    if (target === undefined || target.hp <= 0) continue;
    const landed = strike(state, ctx, caster, target, skill.id, skill);
    if (landed && skill.slowBp > 0 && target.hp > 0) {
      applySlow(state, ctx, caster, target, skill.slowBp, skill.durationMs);
    }
  }
}

function applyCast(state: SimState, ctx: Context, caster: Actor, cast: PendingCast): void {
  const skill = skillOf(ctx, cast.skillId);
  if (skill !== null && skill.effect === 'heal') {
    resolveHeal(state, ctx, caster, cast, skill);
    return;
  }
  if (skill !== null && skill.effect === 'taunt') {
    resolveTaunt(state, ctx, caster, cast, skill);
    return;
  }
  if (skill !== null && skill.shape !== 'single') {
    resolveArea(state, ctx, caster, cast, skill);
    return;
  }
  const target = validSingleTarget(state, ctx, caster, cast, rangeOf(caster, skill));
  if (target === null) {
    fizzle(state, ctx, caster, cast);
    return;
  }
  strike(state, ctx, caster, target, cast.skillId, skill);
}

/**
 * Completes one pending cast atomically (R27/R30), then books the actor's next
 * decision at `now + recovery` under a fresh token. A stunned actor postpones the
 * whole completion to the latest stun expiry with the *same* token, keeping the MP
 * already spent and the cooldown already running. Encounter completion is not
 * evaluated here: the advance dispatcher calls `finishEncounter` afterwards.
 */
export function resolveCast(state: SimState, actorId: ActorId, ctx: Context): void {
  const actor = state.actors[actorId];
  if (actor === undefined || actor.hp <= 0) return;
  const cast = actor.pendingCast;
  if (cast === null) return;

  const stunnedUntil = activeStunExpiry(actor, state.nowMs);
  if (stunnedUntil !== null) {
    cast.completesAt = stunnedUntil;
    schedule(state, {
      at: stunnedUntil, kind: 'resolve', actorId, epoch: state.epoch, token: cast.token,
    });
    return;
  }

  applyCast(state, ctx, actor, cast);

  actor.pendingCast = null;
  actor.actionToken += 1;
  schedule(state, {
    at: state.nowMs + recoveryMs(actor, state.nowMs), kind: 'act',
    actorId, epoch: state.epoch, token: actor.actionToken,
  });
}
