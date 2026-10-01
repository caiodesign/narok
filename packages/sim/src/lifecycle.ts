import { CONSUMABLE_STACK_MAX, IDUN_APPLE_ID } from '@narok/data';
import type { Content, RecipeId } from '@narok/data';
import { gridPosition } from './battlefield/grid';
import { compareIds, emitEvent, livingActors } from './effects';
import { dispositionRewards } from './rewards';
import { SimError } from './errors';
import { drawBelow } from './rng';
import { schedule } from './scheduler';
import type { Actor, ActorId, Context, Phase, PositionId, SimState } from './types';

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
 * Ruling R155 (owner decision 2026-09-30, amended the same day; supersedes
 * R149's amount): the return to town heals the whole party — every member,
 * living or dead — to full HP and MP. The owner set this aside of layer-1
 * §4.5's "stop/start grants no free recovery" for the town return only.
 * Returns whether anyone had fallen.
 */
function healParty(state: SimState): boolean {
  let fallen = false;
  for (const id of partyIds(state)) {
    const member = state.actors[id];
    if (member.hp <= 0) fallen = true;
    member.hp = member.stats.maxHp;
    member.mp = member.stats.maxMp;
  }
  return fallen;
}

/**
 * Every transition into `stopped` — the operator's stop, a full wipe, the
 * stalemate deadline — is the party's return to town, and goes through here.
 *
 * Ruling R149, as R155 amends it: the return heals the whole party to full HP
 * and MP, so no member comes home dead and every one can hunt again. It draws
 * nothing and touches no reward, pity or metric. When anyone had fallen, the
 * whole party is re-seated at its input placement, as the encounter exit does
 * (ruling R92), because a corpse may share a cell with a living ally.
 */
export function returnToTown(state: SimState, reason: NonNullable<SimState['stopReason']>): void {
  state.phase = 'stopped';
  state.stopReason = reason;
  state.queue = [];
  if (!healParty(state)) return;
  for (const id of partyIds(state)) state.actors[id].position = state.input.placement[id];
}

/** A rejoining member decides as a freshly spawned one does: half a second later. */
const REJOIN_DECISION_MS = 500;

/**
 * The HP a revived member returns with: Idun's Apple's share of its maximum,
 * `max(1, floor(maxHp * 5000 / 10000))` (owner decision 2026-09-30). The
 * Cleric's Revive restores exactly what the apple does (ruling R153), so both
 * read this one definition.
 */
function revivedHp(maxHp: number, content: Content): number {
  return Math.max(1, Math.floor((maxHp * content.consumables[IDUN_APPLE_ID].restoreBp) / 10_000));
}

/**
 * Ruling R156 (owner decision 2026-09-30): where a revived member stands — its
 * death cell when no living actor holds it (a corpse does not occupy its cell,
 * ruling R92), else its input placement, else the first free party-side slot
 * in row-major order. The party side has more cells than a party and an
 * encounter's enemies together, so a free one always exists.
 */
function rejoinCell(state: SimState, ctx: Context, member: Actor): PositionId {
  const taken = new Set(livingActors(state).map((entry) => entry.position));
  const candidates = [member.position, state.input.placement[member.id], ...ctx.battlefield.placementSlots('party')];
  const free = candidates.find((cell) => !taken.has(cell));
  /* istanbul ignore next -- the party side always has a free cell */
  if (free === undefined) throw new SimError('INVALID_STATE', `actors.${member.id}.position`, 'no free cell to rejoin');
  return free;
}

/**
 * Brings a fallen party member back into the running encounter (rulings
 * R152, R153, R156): HP from {@link revivedHp}, MP exactly as at its death,
 * its statuses, cast in progress, targets and threat cleared — including the
 * threat and taunt records the enemies hold for it — and its cooldown
 * timestamps kept. It rejoins at {@link rejoinCell} under a fresh action
 * token and decides {@link REJOIN_DECISION_MS} later. Draws nothing.
 *
 * Announced as a `revive` event: `actorId` the revived member, `targetId` the
 * Cleric who cast Revive (`null` for an apple), `amount` the HP restored,
 * `reason` the apple's id or `revive`, `position` where it rejoined.
 */
export function reviveMember(
  state: SimState, ctx: Context, member: Actor, source: typeof IDUN_APPLE_ID | 'revive', casterId: ActorId | null,
): void {
  const cell = rejoinCell(state, ctx, member);
  member.hp = revivedHp(member.stats.maxHp, ctx.content);
  member.position = cell;
  member.statuses = [];
  member.pendingCast = null;
  member.currentTarget = null;
  member.forcedTarget = null;
  member.threat = {};
  for (const id of enemyIds(state)) {
    const enemy = state.actors[id];
    delete enemy.threat[member.id];
    if (enemy.forcedTarget?.actorId === member.id) enemy.forcedTarget = null;
  }
  member.actionToken += 1;
  schedule(state, {
    at: state.nowMs + REJOIN_DECISION_MS, kind: 'act', actorId: member.id, epoch: state.epoch, token: member.actionToken,
  });
  emitEvent(state, ctx, {
    kind: 'revive', actorId: member.id, targetId: casterId, amount: member.hp, reason: source, position: cell,
  });
}

/** The account's id for a roster member, its roster id in a laboratory run. */
function characterIdOf(state: SimState, id: ActorId): string {
  return state.progression?.[id]?.characterId ?? id;
}

/**
 * Ruling R152 (owner decision 2026-09-30), as R157 refines it: Idun's Apple.
 * Called with the party members who died at one instant — one simulated
 * millisecond, across every cast resolution at it (ruling R157, controller
 * ruling 2026-10-01; `advance.ts` gathers them before the encounter is
 * judged) — each of them is revived at once by one apple from the shared
 * bag while the bag holds one, in ascending character id (ASCII), the order
 * simultaneous potion use resolves in, so two members never eat the same
 * apple and queue order never decides who does. Each apple eaten leaves the bag (its
 * stack and, when emptied, its slot) and is counted in `metrics.consumed`,
 * which the settlement's commit takes off the account's stack. Draws nothing.
 */
export function reviveWithApples(state: SimState, ctx: Context, fallen: readonly ActorId[]): void {
  const order = fallen
    .filter((id) => state.actors[id]?.side === 'party' && state.actors[id].hp <= 0)
    .sort((left, right) => compareIds(characterIdOf(state, left), characterIdOf(state, right)));
  const bag = state.bagState;
  for (const id of order) {
    const apples = bag.held[IDUN_APPLE_ID] ?? 0;
    if (apples < 1) return;
    const stacksBefore = Math.ceil(apples / CONSUMABLE_STACK_MAX);
    if (apples === 1) delete bag.held[IDUN_APPLE_ID];
    else bag.held[IDUN_APPLE_ID] = apples - 1;
    bag.usedSlots -= stacksBefore - Math.ceil((apples - 1) / CONSUMABLE_STACK_MAX);
    state.metrics.consumed[IDUN_APPLE_ID] = (state.metrics.consumed[IDUN_APPLE_ID] ?? 0) + 1;
    reviveMember(state, ctx, state.actors[id], IDUN_APPLE_ID, null);
  }
}

/**
 * Drops every queued entry whose `epoch` is non-null and no longer matches the
 * current epoch (ruling R45). Global entries (`epoch: null` — regen ticks, walking
 * and rest-exit transitions) always survive. Applied at encounter exit, right after
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
 * reached from a completed walk (after a win or a rest), it can never land
 * mid-fight. One atomic activation: placement, per-character strategies and
 * rest thresholds all become active together (spec §4.1).
 */
export function activatePending(state: SimState): void {
  const pending = state.pendingRules;
  if (pending === null) return;

  state.input = {
    ...state.input,
    placement: pending.placement,
    strategies: pending.strategies,
    rest: pending.rest,
  };
  state.pendingRules = null;
}

/**
 * Spawns the next encounter on a completed walk (ruling R34): rolls the recipe,
 * advances encounter bookkeeping, resets the party to its input placement, creates
 * the enemy roster from the monster definitions, and schedules first decisions plus
 * the encounter deadline.
 */
function spawnEncounter(state: SimState, ctx: Context): void {
  // R115: before `chooseRecipe` draws, so activation never touches the RNG.
  activatePending(state);
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
 * Global `transition` handler (ruling R34): fires for a completed `walking`
 * phase and spawns the next encounter. There is no respawn to complete: a full
 * wipe ends the hunt (owner decision 2026-09-30; ruling R154).
 */
export function transition(state: SimState, ctx: Context): void {
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
 * the experiment is stopped; applies no regeneration while `stopped`. Only
 * living party members regenerate, HP before MP, in id order.
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
  if (state.phase === 'stopped') return;

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
 * encounter's drops (part 3 §2.1), and chooses what follows: a win rests or
 * walks on, a wipe ends the hunt.
 *
 * Ruling R151 (owner decision 2026-09-30; supersedes milestone A spec §10's
 * won-encounter revive): a member dead at the win stays dead for the rest of
 * the hunt, until Idun's Apple, a Cleric's Revive or the town brings it back.
 * It still counts in the EXP divisor and earns nothing (ruling R135). Only the
 * living decide whether the party rests, as only the living decide when the
 * rest ends: a corpse at 0 HP would otherwise force a rest after every win.
 *
 * Ruling R154 (owner decision 2026-09-30; supersedes layer-1 §5.6's wipe limit
 * and 30-second respawn, and milestone A spec §10's respawn): a full wipe —
 * every member dead, with no apple or Revive left to act, since apples are
 * spent before this runs — is counted and ends the hunt with `wipe`.
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
    // cell. Reviving in place at the return to town would then put two *living*
    // actors on one cell and trip both occupancy checks. `input.placement` is the same source `spawnEncounter` uses
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
    returnToTown(state, 'wipe');
    emitEvent(state, ctx, { kind: 'stop', reason: 'wipe' });
    return;
  }

  state.metrics.wins += 1;
  emitEvent(state, ctx, { kind: 'win' });
  // Walk → fight → loot filter → rest (layer-1 §6.1): disposition, never at death.
  dispositionRewards(state, ctx);

  const { hpStart, mpStart } = state.input.rest;
  const needsRest = partyIds(state).some((id) => {
    const member = state.actors[id];
    if (member.hp <= 0) return false;
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
