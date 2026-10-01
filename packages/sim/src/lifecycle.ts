import type { RecipeId } from '@narok/data';
import { gridPosition } from './battlefield/grid';
import { compareIds, emitEvent, livingActors } from './effects';
import { dispositionRewards } from './rewards';
import { drawBelow } from './rng';
import { schedule } from './scheduler';
import type { Actor, ActorId, Context, Phase, SimState } from './types';

/** Fixed roll order for a `'mixed'` recipe draw (ruling R34): melee, ranged, clustered. */
const RECIPE_ORDER: readonly RecipeId[] = ['melee', 'ranged', 'clustered'];

/** Party actor ids present in `state.actors`, in ascending id order. */
function partyIds(state: SimState): ActorId[] {
  return Object.keys(state.actors)
    .filter((id) => state.actors[id].side === 'party')
    .sort(compareIds);
}

/** Enemy actor ids present in `state.actors`, in ascending id order. */
function enemyIds(state: SimState): ActorId[] {
  return Object.keys(state.actors)
    .filter((id) => state.actors[id].side === 'enemy')
    .sort(compareIds);
}

/**
 * A fallen member's revival: `max(1, floor(maxHp / 10))` HP, MP kept (milestone
 * A spec §10). Shared by the won encounter and the return to town, so the two
 * cannot drift. Returns whether anyone was revived.
 */
function reviveFallen(state: SimState): boolean {
  let revived = false;
  for (const id of partyIds(state)) {
    const member = state.actors[id];
    if (member.hp > 0) continue;
    member.hp = Math.max(1, Math.floor(member.stats.maxHp / 10));
    revived = true;
  }
  return revived;
}

/**
 * Every transition into `stopped` — the operator's stop, the wipe limit, the
 * stalemate deadline — is the party's return to town, and goes through here.
 *
 * Ruling R149 (controller ruling, Task 7b fix round 1): the return revives
 * each dead member exactly as a won encounter does, `max(1, floor(maxHp/10))`
 * HP with MP preserved. Layer-1 §4.5 forbids town granting recovery, but a
 * member left at 0 HP could never hunt again — the engine refuses a party
 * member below 1 HP and town has no other way back — so this is the least
 * recovery possible. It draws nothing and touches no reward, pity or metric.
 * A revived member is re-seated with the whole party at its input placement,
 * as the encounter exit does (ruling R92), because a corpse may share a cell
 * with a living ally.
 */
export function returnToTown(state: SimState, reason: NonNullable<SimState['stopReason']>): void {
  state.phase = 'stopped';
  state.stopReason = reason;
  state.queue = [];
  if (!reviveFallen(state)) return;
  for (const id of partyIds(state)) state.actors[id].position = state.input.placement[id];
}

/**
 * Drops every queued entry whose `epoch` is non-null and no longer matches the
 * current epoch (ruling R45). Global entries (`epoch: null` — regen ticks, walking
 * and respawn transitions) always survive. Applied at encounter exit, right after
 * the epoch bump and enemy-actor deletion, so a snapshot taken between the
 * conclusion of one encounter and the queue's natural drain never carries a
 * queued entry referencing an actor `validateSimState` can no longer find —
 * `validate-state.ts`'s unknown-actor-id check would otherwise reject it. Stop
 * paths that already replace the whole queue with `[]` do not need this: an
 * empty array has nothing left to prune.
 */
function pruneStaleEpochEntries(state: SimState): void {
  state.queue = state.queue.filter((event) => event.epoch === null || event.epoch === state.epoch);
}

/**
 * Resolves this encounter's recipe (ruling R34). A fixed `input.recipe` consumes no
 * RNG. `'mixed'` consumes exactly one `drawBelow(rng, totalWeight)` over the recipes
 * in the fixed melee/ranged/clustered order, updating `state.rng`.
 */
function chooseRecipe(state: SimState, ctx: Context): RecipeId {
  if (state.input.recipe !== 'mixed') return state.input.recipe;

  const totalWeight = RECIPE_ORDER.reduce((sum, id) => sum + ctx.content.recipes[id].weight, 0);
  const draw = drawBelow(state.rng, totalWeight);
  state.rng = draw.state;

  let accumulated = 0;
  for (const id of RECIPE_ORDER) {
    accumulated += ctx.content.recipes[id].weight;
    if (draw.value < accumulated) return id;
  }
  /* istanbul ignore next -- draw.value is always < totalWeight */
  return RECIPE_ORDER[RECIPE_ORDER.length - 1];
}

/**
 * Activates the queued strategy, if any (milestone B part 2 §4, §9 #4; ruling
 * R115). Called at the top of {@link spawnEncounter}, before the recipe draw, so
 * it consumes no RNG and cannot reroll the encounter — and since every spawn is
 * reached from a completed walk (after a win, a rest or a respawn), it can never
 * land mid-fight.
 *
 * One atomic activation: placement, per-character strategies, rest thresholds
 * and wipe limit all become active together (spec §4.1). Its stated
 * consequence: when the activated wipe limit is at or below the wipes already
 * used, the hunt stops here with the ordinary `wipe-limit` reason — no free
 * encounter, no recovery. Returns `true` when it stopped the hunt.
 */
export function activatePending(state: SimState, ctx: Context): boolean {
  const pending = state.pendingRules;
  if (pending === null) return false;

  state.input = {
    ...state.input,
    placement: pending.placement,
    strategies: pending.strategies,
    rest: pending.rest,
    wipeLimit: pending.wipeLimit,
  };
  state.pendingRules = null;

  if (state.metrics.wipes >= state.input.wipeLimit) {
    returnToTown(state, 'wipe-limit');
    emitEvent(state, ctx, { kind: 'stop', reason: 'wipe-limit' });
    return true;
  }
  return false;
}

/**
 * Spawns the next encounter on a completed walk (ruling R34): rolls the recipe,
 * advances encounter bookkeeping, resets the party to its input placement, creates
 * the enemy roster from the monster definitions, and schedules first decisions plus
 * the encounter deadline.
 */
function spawnEncounter(state: SimState, ctx: Context): void {
  // R115: before `chooseRecipe` draws, so activation never touches the RNG.
  if (activatePending(state, ctx)) return;
  const recipe = ctx.content.recipes[chooseRecipe(state, ctx)];

  state.encounterCount += 1;
  state.encounterStartedAt = state.nowMs;
  state.phase = 'fighting';

  for (const id of partyIds(state)) {
    const member = state.actors[id];
    member.position = state.input.placement[id];
    member.statuses = [];
    member.pendingCast = null;
    member.currentTarget = null;
    member.forcedTarget = null;
    member.threat = {};
    member.actionToken += 1;
  }

  const positions = recipe.monsters.map((entry) => gridPosition(entry.column, entry.row));
  ctx.battlefield.validatePlacement(positions, 'enemy');

  recipe.monsters.forEach((entry, index) => {
    const id = `e${index}`;
    const monster = ctx.content.monsters[entry.monsterId];
    const spawned: Actor = {
      id,
      side: 'enemy',
      definitionId: monster.id,
      level: monster.level,
      family: monster.family,
      element: monster.element,
      attributes: { str: 0, agi: 0, vit: 0, int: 0, dex: 0, luk: 0 },
      stats: {
        maxHp: monster.hp,
        maxMp: monster.mp,
        atk: monster.atk,
        matk: monster.matk,
        def: monster.def,
        mdef: monster.mdef,
        hit: monster.hit,
        flee: monster.flee,
        critBp: 0,
        intervalMs: monster.intervalMs,
      },
      hp: monster.hp,
      mp: monster.mp,
      position: positions[index],
      basicKind: 'physical',
      basicRange: monster.range,
      skills: [],
      cooldowns: {},
      statuses: [],
      threat: {},
      forcedTarget: null,
      currentTarget: null,
      pendingCast: null,
      actionToken: 0,
    };
    state.actors[id] = spawned;
    state.metrics.actors[id] = { damageDealt: 0, damageReceived: 0, healingDone: 0 };
  });

  emitEvent(state, ctx, { kind: 'phase', reason: 'fighting' });
  for (const id of enemyIds(state)) {
    emitEvent(state, ctx, { kind: 'spawn', actorId: id, position: state.actors[id].position });
  }

  for (const actor of livingActors(state)) {
    schedule(state, {
      at: state.nowMs + 500,
      kind: 'act',
      actorId: actor.id,
      epoch: state.epoch,
      token: actor.actionToken,
    });
  }
  schedule(state, {
    at: state.nowMs + ctx.content.encounterLimitMs,
    kind: 'deadline',
    actorId: '',
    epoch: state.epoch,
    token: null,
  });
}

/**
 * Completes a respawn wait (ruling R34): the only full HP/MP reset after initial
 * experiment setup. Clears encounter state, preserves cooldown timestamps, and
 * resumes walking toward the next group.
 */
function completeRespawn(state: SimState, ctx: Context): void {
  for (const id of partyIds(state)) {
    const member = state.actors[id];
    member.hp = member.stats.maxHp;
    member.mp = member.stats.maxMp;
    member.statuses = [];
    member.pendingCast = null;
    member.currentTarget = null;
    member.forcedTarget = null;
    member.threat = {};
    member.actionToken += 1;
  }
  state.phase = 'walking';
  emitEvent(state, ctx, { kind: 'phase', reason: 'walking' });
  schedule(state, {
    at: state.nowMs + ctx.content.walkMs,
    kind: 'transition',
    actorId: '',
    epoch: null,
    token: null,
  });
}

/**
 * Global `transition` handler (ruling R34): fires for a completed `walking` phase
 * (spawn the next encounter) or a completed `respawning` phase (restore the party
 * and resume walking). The dispatcher (Task 7) routes queued `kind: 'transition'`
 * entries here; this is the only place either completion is decided.
 */
export function transition(state: SimState, ctx: Context): void {
  if (state.phase === 'respawning') {
    completeRespawn(state, ctx);
    return;
  }
  spawnEncounter(state, ctx);
}

/** Regeneration multiplier numerator/denominator by phase (layer-1 §6.2, ruling R35). */
function regenMultiplier(phase: Phase): [numerator: number, denominator: number] {
  if (phase === 'fighting') return [1, 2];
  if (phase === 'resting') return [4, 1];
  return [1, 1];
}

/**
 * Global 5,000 ms regen tick (ruling R35). Always reschedules its successor unless
 * the experiment is stopped; applies no regeneration while `respawning` or
 * `stopped`. Only living party members regenerate, HP before MP, in id order.
 * While resting, reevaluates the (fixed 90%/80%) exit thresholds after applying
 * regeneration and may resume walking on this same tick.
 */
export function regenerate(state: SimState, ctx: Context): void {
  if (state.phase !== 'stopped') {
    schedule(state, {
      at: state.nowMs + ctx.content.regenMs,
      kind: 'regen',
      actorId: '',
      epoch: null,
      token: null,
    });
  }
  if (state.phase === 'respawning' || state.phase === 'stopped') return;

  const [numerator, denominator] = regenMultiplier(state.phase);
  const party = livingActors(state).filter((entry) => entry.side === 'party');

  for (const member of party) {
    const hpBase = Math.max(
      1,
      Math.floor(member.stats.maxHp / 100) + Math.floor(member.attributes.vit / 5),
    );
    const hpGain = Math.min(
      member.stats.maxHp - member.hp,
      Math.max(1, Math.floor((hpBase * numerator) / denominator)),
    );
    if (hpGain > 0) {
      member.hp += hpGain;
      emitEvent(state, ctx, { kind: 'regen', actorId: member.id, amount: hpGain, reason: 'hp' });
    }

    if (member.stats.maxMp > 0) {
      const mpBase = Math.max(
        1,
        Math.floor(member.stats.maxMp / 100) + Math.floor(member.attributes.int / 6),
      );
      const mpGain = Math.min(
        member.stats.maxMp - member.mp,
        Math.max(1, Math.floor((mpBase * numerator) / denominator)),
      );
      if (mpGain > 0) {
        member.mp += mpGain;
        emitEvent(state, ctx, { kind: 'regen', actorId: member.id, amount: mpGain, reason: 'mp' });
      }
    }
  }

  if (state.phase === 'resting') {
    const canExit = party.every(
      (entry) =>
        entry.hp * 100 >= 90 * entry.stats.maxHp &&
        (entry.stats.maxMp === 0 || entry.mp * 100 >= 80 * entry.stats.maxMp),
    );
    if (canExit) {
      state.phase = 'walking';
      emitEvent(state, ctx, { kind: 'phase', reason: 'walking' });
      schedule(state, {
        at: state.nowMs + ctx.content.walkMs,
        kind: 'transition',
        actorId: '',
        epoch: null,
        token: null,
      });
    }
  }
}

/**
 * Encounter completion (ruling R36). Called by the dispatcher after a whole cast
 * resolution; returns immediately unless the encounter is decided (`fighting` with
 * one side fully dead). Records exactly one win or wipe, invalidates the encounter
 * epoch, prunes the now-stale queue (ruling R45), dispositions the
 * encounter's drops (part 3 §2.1), and chooses the next recovery phase.
 */
export function finishEncounter(state: SimState, ctx: Context): void {
  if (state.phase !== 'fighting') return;

  const living = livingActors(state);
  const partyAlive = living.some((entry) => entry.side === 'party');
  const enemiesAlive = living.some((entry) => entry.side === 'enemy');
  if (partyAlive && enemiesAlive) return;

  const wipe = !partyAlive;

  state.epoch += 1;
  for (const id of enemyIds(state)) {
    delete state.actors[id];
    delete state.metrics.actors[id];
  }
  pruneStaleEpochEntries(state);
  for (const id of partyIds(state)) {
    const member = state.actors[id];
    // Ruling R92: re-seat before anything revives. A corpse does not occupy its
    // cell (`executeMove` tests occupancy with `livingActors`, and
    // `assertInvariants`/`validateSimState` both skip actors at `hp <= 0`), so an
    // ally may legally step onto a fallen member — and two members may die on one
    // cell. Reviving in place, here on the win branch or later in
    // `completeRespawn`, then put two *living* actors on one cell and tripped both
    // occupancy checks. `input.placement` is the same source `spawnEncounter` uses
    // and `startState` validated it collision-free, so this makes the party-reset
    // sites consistent instead of inventing a placement rule. It is a teleport,
    // not a step: no `move` event, and no RNG is drawn.
    member.position = state.input.placement[id];
    member.statuses = [];
    member.pendingCast = null;
    member.currentTarget = null;
    member.forcedTarget = null;
    member.threat = {};
    member.actionToken += 1;
  }
  state.encounterStartedAt = null;

  if (wipe) {
    state.metrics.wipes += 1;
    emitEvent(state, ctx, { kind: 'wipe' });
    // Kills made before the wipe still dropped: their rewards are dispositioned too.
    dispositionRewards(state, ctx);
    if (state.metrics.wipes >= state.input.wipeLimit) {
      returnToTown(state, 'wipe-limit');
      emitEvent(state, ctx, { kind: 'stop', reason: 'wipe-limit' });
    } else {
      state.phase = 'respawning';
      schedule(state, {
        at: state.nowMs + ctx.content.respawnMs,
        kind: 'transition',
        actorId: '',
        epoch: null,
        token: null,
      });
    }
    return;
  }

  state.metrics.wins += 1;
  emitEvent(state, ctx, { kind: 'win' });
  // Walk → fight → loot filter → rest (layer-1 §6.1): disposition, never at death.
  dispositionRewards(state, ctx);
  reviveFallen(state);

  const { hpStart, mpStart } = state.input.rest;
  const needsRest = partyIds(state).some((id) => {
    const member = state.actors[id];
    const hpLow = hpStart > 0 && member.hp * 100 < hpStart * member.stats.maxHp;
    const mpLow = mpStart > 0 && member.stats.maxMp > 0 && member.mp * 100 < mpStart * member.stats.maxMp;
    return hpLow || mpLow;
  });

  if (needsRest) {
    state.phase = 'resting';
    emitEvent(state, ctx, { kind: 'phase', reason: 'resting' });
  } else {
    state.phase = 'walking';
    emitEvent(state, ctx, { kind: 'phase', reason: 'walking' });
    schedule(state, {
      at: state.nowMs + ctx.content.walkMs,
      kind: 'transition',
      actorId: '',
      epoch: null,
      token: null,
    });
  }
}

/**
 * Encounter deadline (ruling R37). Stops the experiment only while still
 * `fighting` — a decided encounter has already left that phase via
 * {@link finishEncounter}, so a stale or already-resolved deadline is a no-op.
 * No win, no wipe and no new reward; the drops the encounter's kills already
 * rolled are dispositioned like at any encounter end (ruling R127), and state
 * is preserved for inspection.
 */
export function deadline(state: SimState, ctx: Context): void {
  if (state.phase !== 'fighting') return;
  // The encounter ends here: kills already made keep their drops (ruling R127).
  dispositionRewards(state, ctx);
  returnToTown(state, 'stalemate');
  emitEvent(state, ctx, { kind: 'stop', reason: 'stalemate' });
}
