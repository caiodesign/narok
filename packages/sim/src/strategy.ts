import type { Content, SkillDefinition, SkillId } from '@narok/data';
import { compareIds, livingActors } from './effects';
import type { Battlefield } from './battlefield/types';
import type { Actor, ActorId, PositionId, Rule, SimState, TargetMode } from './types';

/**
 * The outcome of one action decision. Internal to the simulation package: the
 * dispatcher never sees it, `actions.ts` executes it immediately.
 */
export type Decision =
  | { kind: 'cast'; skillId: SkillId | 'basic'; targets: ActorId[] }
  | { kind: 'move'; position: PositionId; targetId: ActorId }
  | { kind: 'idle' };

/** The primary target a rule selected, plus the full target list the cast will carry. */
interface Choice { primary: Actor; targets: ActorId[] }

/** Up to three enemies are forced by one Taunt (spec §5). */
const TAUNT_TARGET_LIMIT = 3;

function compareByMode(mode: TargetMode, actor: Actor, battlefield: Battlefield) {
  return (left: Actor, right: Actor): number => {
    switch (mode.kind) {
      case 'lowest-hp':
        return left.hp - right.hp || compareIds(left.id, right.id);
      case 'highest-hp':
        return right.hp - left.hp || compareIds(left.id, right.id);
      case 'highest-level':
        return right.level - left.level || compareIds(left.id, right.id);
      case 'nearest':
        return (
          battlefield.distance(actor.position, left.position) -
            battlefield.distance(actor.position, right.position) ||
          compareIds(left.id, right.id)
        );
      case 'attacking':
        return compareIds(left.id, right.id);
    }
  };
}

/**
 * Orders enemy candidates by the configured priority mode (spec §6), always ending
 * ties on ASCII id. `attacking` filters first and falls back to `nearest` over the
 * unfiltered candidates when no enemy is hitting the chosen party member.
 */
function orderCandidates(
  candidates: Actor[],
  mode: TargetMode,
  actor: Actor,
  battlefield: Battlefield,
): Actor[] {
  if (mode.kind === 'attacking') {
    const matching = candidates.filter((entry) => entry.currentTarget === mode.partyId);
    if (matching.length === 0) {
      return orderCandidates(candidates, { kind: 'nearest' }, actor, battlefield);
    }
    return matching.sort(compareByMode(mode, actor, battlefield));
  }
  return [...candidates].sort(compareByMode(mode, actor, battlefield));
}

/** Cast when the primary is already in range, otherwise take one legal step toward it. */
function approach(
  actor: Actor,
  choice: Choice,
  skillId: SkillId | 'basic',
  range: number,
  battlefield: Battlefield,
  living: Actor[],
): Decision {
  if (battlefield.inRange(actor.position, choice.primary.position, range)) {
    return { kind: 'cast', skillId, targets: choice.targets };
  }
  const step = battlefield.nextStep(actor, choice.primary, range, living);
  if (step === null) return { kind: 'idle' };
  return { kind: 'move', position: step, targetId: choice.primary.id };
}

function reachableEnemies(
  actor: Actor,
  enemies: Actor[],
  range: number,
  battlefield: Battlefield,
  living: Actor[],
): Actor[] {
  return enemies.filter((enemy) => battlefield.canReach(actor, enemy, range, living));
}

/**
 * Evaluates one rule's condition (R28), returning its primary target and the target
 * list to carry into the cast, or `null` when the rule does not apply right now.
 */
function evaluateRule(
  state: SimState,
  actor: Actor,
  rule: Rule,
  skill: SkillDefinition,
  enemies: Actor[],
  allies: Actor[],
  living: Actor[],
  mode: TargetMode,
  battlefield: Battlefield,
): Choice | null {
  switch (rule.condition.kind) {
    case 'always': {
      const ordered = orderCandidates(
        reachableEnemies(actor, enemies, skill.range, battlefield, living), mode, actor, battlefield,
      );
      return ordered.length === 0 ? null : { primary: ordered[0], targets: [ordered[0].id] };
    }
    case 'ally-hp-below': {
      const threshold = rule.condition.value;
      const hurt = allies.filter(
        (ally) =>
          ally.hp * 100 < threshold * ally.stats.maxHp &&
          battlefield.canReach(actor, ally, skill.range, living),
      );
      if (hurt.length === 0) return null;
      // Integer cross-multiplication compares HP percentages without floating point.
      hurt.sort(
        (left, right) =>
          left.hp * right.stats.maxHp - right.hp * left.stats.maxHp ||
          compareIds(left.id, right.id),
      );
      return { primary: hurt[0], targets: [hurt[0].id] };
    }
    case 'targets-at-least': {
      const need = rule.condition.value;
      const candidates = reachableEnemies(actor, enemies, skill.range, battlefield, living)
        .map((enemy) => ({ enemy, count: battlefield.affected(enemy, skill.shape, enemies).length }))
        .filter((entry) => entry.count >= need);
      if (candidates.length === 0) return null;
      const ordered = orderCandidates(
        candidates.map((entry) => entry.enemy), mode, actor, battlefield,
      );
      // `attacking` mode filters instead of reordering, so candidates it drops are absent
      // from `ordered`; they rank behind every kept enemy rather than tying with the best
      // one. Ties end on id so the comparator is total and never leans on sort stability.
      const rank = new Map(ordered.map((entry, index) => [entry.id, index]));
      candidates.sort(
        (left, right) =>
          right.count - left.count ||
          (rank.get(left.enemy.id) ?? ordered.length) -
            (rank.get(right.enemy.id) ?? ordered.length) ||
          compareIds(left.enemy.id, right.enemy.id),
      );
      return { primary: candidates[0].enemy, targets: [candidates[0].enemy.id] };
    }
    case 'ally-dead': {
      // Ruling R153: Revive aims at a fallen ally it can reach — a corpse
      // occupies no cell, so it is approached like any target — lowest id first.
      const fallen = Object.keys(state.actors)
        .sort(compareIds)
        .map((id) => state.actors[id])
        .filter((ally) => ally.side === actor.side && ally.hp <= 0 && battlefield.canReach(actor, ally, skill.range, living));
      return fallen.length === 0 ? null : { primary: fallen[0], targets: [fallen[0].id] };
    }
    case 'ally-targeted': {
      const reachable = reachableEnemies(actor, enemies, skill.range, battlefield, living);
      const engaged = reachable.some((enemy) => {
        if (enemy.currentTarget === null || enemy.currentTarget === actor.id) return false;
        const ally = state.actors[enemy.currentTarget];
        return ally !== undefined && ally.side === actor.side && ally.hp > 0;
      });
      if (!engaged) return null;
      const present = orderCandidates(
        enemies.filter((enemy) => battlefield.inRange(actor.position, enemy.position, skill.range)),
        mode, actor, battlefield,
      );
      if (present.length > 0) {
        return {
          primary: present[0],
          targets: present.slice(0, TAUNT_TARGET_LIMIT).map((enemy) => enemy.id),
        };
      }
      // Condition holds but nothing is in range yet: walk toward the best candidate.
      const ordered = orderCandidates(reachable, mode, actor, battlefield);
      return ordered.length === 0 ? null : { primary: ordered[0], targets: [ordered[0].id] };
    }
  }
}

/**
 * Ruling R153 (owner decision 2026-09-30): a Cleric has Revive when its skill
 * rank in it is at least 1 — the one skill whose rank gates combat for now;
 * rank gating in general stays open. A laboratory run carries no ranks, so
 * its Cleric never casts it.
 */
function knowsRevive(state: SimState, actorId: ActorId): boolean {
  return (state.progression?.[actorId]?.skillRanks.revive ?? 0) >= 1;
}

/**
 * Party decision (spec §6, R28): scan the configured rules in order, skipping
 * disabled, unaffordable, cooling-down, unsatisfied, and unreachable choices. The
 * first eligible rule supplies the primary target; with none, fall back to a basic
 * attack, and idle when no enemy is reachable at all. Consumes no RNG.
 */
function partyDecision(
  state: SimState,
  actor: Actor,
  content: Content,
  battlefield: Battlefield,
): Decision {
  const strategy = state.input.strategies[actor.id];
  const living = livingActors(state);
  const enemies = living.filter((entry) => entry.side !== actor.side);
  const allies = living.filter((entry) => entry.side === actor.side);

  for (const rule of strategy.rules) {
    if (!rule.enabled) continue;
    if (rule.skillId === 'revive' && !knowsRevive(state, actor.id)) continue;
    const skill = content.skills[rule.skillId];
    if (actor.mp < skill.mp) continue;
    const readyAt = actor.cooldowns[rule.skillId];
    if (readyAt !== undefined && readyAt > state.nowMs) continue;
    const choice = evaluateRule(
      state, actor, rule, skill, enemies, allies, living, strategy.target, battlefield,
    );
    if (choice === null) continue;
    return approach(actor, choice, rule.skillId, skill.range, battlefield, living);
  }

  const ordered = orderCandidates(
    reachableEnemies(actor, enemies, actor.basicRange, battlefield, living),
    strategy.target, actor, battlefield,
  );
  if (ordered.length === 0) return { kind: 'idle' };
  return approach(
    actor, { primary: ordered[0], targets: [ordered[0].id] },
    'basic', actor.basicRange, battlefield, living,
  );
}

/**
 * Enemy decision (spec §6, R29): monsters have only basic attacks. An active forced
 * target whose source is alive and reachable wins outright; otherwise candidates sort
 * by threat descending, then distance, then id.
 */
function enemyDecision(state: SimState, actor: Actor, battlefield: Battlefield): Decision {
  const living = livingActors(state);
  const range = actor.basicRange;
  const forced = actor.forcedTarget;

  if (forced !== null && forced.expiresAt > state.nowMs) {
    const source = state.actors[forced.actorId];
    if (source !== undefined && source.hp > 0 && battlefield.canReach(actor, source, range, living)) {
      return approach(
        actor, { primary: source, targets: [source.id] }, 'basic', range, battlefield, living,
      );
    }
  }

  const candidates = living.filter(
    (entry) => entry.side !== actor.side && battlefield.canReach(actor, entry, range, living),
  );
  candidates.sort(
    (left, right) =>
      (actor.threat[right.id] ?? 0) - (actor.threat[left.id] ?? 0) ||
      battlefield.distance(actor.position, left.position) -
        battlefield.distance(actor.position, right.position) ||
      compareIds(left.id, right.id),
  );
  if (candidates.length === 0) return { kind: 'idle' };
  return approach(
    actor, { primary: candidates[0], targets: [candidates[0].id] },
    'basic', range, battlefield, living,
  );
}

/**
 * Pure action selection for one actor. Reads state, content, and the battlefield;
 * mutates nothing and draws no random numbers.
 */
export function selectDecision(
  state: SimState,
  actor: Actor,
  content: Content,
  battlefield: Battlefield,
): Decision {
  return actor.side === 'party'
    ? partyDecision(state, actor, content, battlefield)
    : enemyDecision(state, actor, battlefield);
}
