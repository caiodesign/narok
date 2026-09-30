/**
 * Per-kill drops, bad-luck plumbing and disposition (milestone B part 3 §2,
 * §3.3, §3.4; rulings R127–R131).
 *
 * Rewards are **rolled at death** and **dispositioned at encounter end**. The
 * roll is a fixed draw sequence that reads nothing of the account — not the
 * filter, not the bag, not the counters while the guarantee is off — so two
 * accounts killing the same monster at the same RNG state roll the same item.
 * Only the disposition varies, and it draws nothing, so it cannot perturb the
 * stream either (part 3 §2.3).
 */
import {
  BAG_CAPACITY,
  CONSUMABLE_STACK_MAX,
  RARITIES,
  RARITY_RULES,
  bonusCount,
  valueTier,
} from '@narok/data';
import type { MonsterDefinition, PityConfig, Rarity, RolledBonus } from '@narok/data';
import { evaluate, STARTER_LOOT_PRESET, validateLootPreset, type DropDescriptor, type LootPreset } from '@narok/loot';
import { emitEvent } from './effects';
import { drawBelow } from './rng';
import type {
  BagState,
  Context,
  DropMetrics,
  DropProtection,
  PendingReward,
  RewardItem,
  RewardOutcome,
  SimState,
} from './types';

/** Fitting bonuses are drawn at weight 2, other eligible bonuses at weight 1 (layer-1 §7.1). */
const FITTING_WEIGHT = 2;
const OTHER_WEIGHT = 1;
/** The band draw and the consumable draw are both parts-per-million draws (part 3 §2.2). */
const PPM_SPACE = 1_000_000;

/** ASCII order, never locale order: the canonical order every list is iterated in. */
function ascending(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The band ladder (part 3 §2.3): ascending rarity, each band `ppm * multiplier`
 * wide, and everything past the last band is no equipment. A total function of
 * the draw — every value in `[0, 1_000_000)` maps to exactly one outcome.
 */
export function bandFor(value: number, multiplier: number): Rarity | null {
  let edge = 0;
  for (const rarity of RARITIES) {
    edge += RARITY_RULES[rarity].ppm * multiplier;
    if (value < edge) return rarity;
  }
  return null;
}

function rank(rarity: Rarity): number {
  return RARITIES.indexOf(rarity);
}

/**
 * Raises a natural roll to a due guarantee (part 3 §2.4). A tier is due when
 * this opportunity is its threshold-th since the last award; when both are due
 * the higher tier wins, and a better natural roll is never lowered. Applied
 * only after the band draw, so a guarantee changes the outcome, never the
 * number of band draws.
 */
export function raiseToGuarantee(natural: Rarity | null, protection: DropProtection, pity: PityConfig): Rarity | null {
  if (pity.legendaryThreshold !== null && protection.legendary + 1 >= pity.legendaryThreshold) return 'legendary';
  if (pity.epicPlusThreshold !== null && protection.epicPlus + 1 >= pity.epicPlusThreshold) {
    return natural !== null && rank(natural) >= rank('epic') ? natural : 'epic';
  }
  return natural;
}

/**
 * Advances the counters over one eligible opportunity (part 3 §2.4, ruling
 * R128). An award resets its own tier and every lower one — a Legendary is
 * also an Epic-or-better — and each award records the wait it ended.
 */
function accrueProtection(state: SimState, rarity: Rarity | null): void {
  const counters = state.dropProtection;
  const waits = state.metrics.drops;
  const epicPlus = rarity !== null && rank(rarity) >= rank('epic');
  if (rarity === 'legendary') {
    waits.legendaryWaits.push(counters.legendary + 1);
    counters.legendary = 0;
  } else {
    counters.legendary += 1;
  }
  if (epicPlus) {
    waits.epicPlusWaits.push(counters.epicPlus + 1);
    counters.epicPlus = 0;
  } else {
    counters.epicPlus += 1;
  }
}

function draw(state: SimState, max: number): number {
  const result = drawBelow(state.rng, max);
  state.rng = result.state;
  return result.value;
}

function record(state: SimState, monster: MonsterDefinition, item: RewardItem): PendingReward {
  const reward: PendingReward = {
    rewardSeq: state.nextRewardSeq,
    atSimMs: state.nowMs,
    monsterId: monster.id,
    itemLevel: monster.level,
    item,
    disposition: null,
  };
  state.nextRewardSeq += 1;
  state.pendingRewards.push(reward);
  return reward;
}

/**
 * Rolls `bonusCount(rarity)` distinct bonuses (part 3 §2.2 step 3): each
 * iteration is one weighted identity draw over what remains of the slot pool,
 * then one value draw inside the identity's value-tier span. The chosen
 * identity leaves the pool and the weight is recomputed before the next.
 */
function rollBonuses(state: SimState, ctx: Context, definitionId: string, rarity: Rarity, itemLevel: number): RolledBonus[] {
  const definition = ctx.content.items[definitionId];
  const pool = Object.keys(ctx.content.bonuses)
    .sort(ascending)
    .filter((id) => ctx.content.bonuses[id].slots.includes(definition.slot));
  const weight = (id: string) => (definition.fittingBonuses.includes(id) ? FITTING_WEIGHT : OTHER_WEIGHT);
  const tier = valueTier(itemLevel);
  const rolled: RolledBonus[] = [];

  for (let index = 0; index < bonusCount(rarity); index++) {
    const total = pool.reduce((sum, id) => sum + weight(id), 0);
    let point = draw(state, total);
    let chosen = pool.length - 1;
    for (let at = 0; at < pool.length; at++) {
      point -= weight(pool[at]);
      if (point < 0) {
        chosen = at;
        break;
      }
    }
    const bonusId = pool[chosen];
    pool.splice(chosen, 1);
    const span = ctx.content.bonuses[bonusId].spans[tier - 1];
    rolled.push({ bonusId, value: span.min + draw(state, span.max - span.min + 1) });
  }
  return rolled;
}

/**
 * The equipment half of the per-kill sequence (part 3 §2.2 steps 1–3): the
 * band draw — always consumed — then, only on a hit, the definition draw over
 * the monster's list sorted by id and the bonus draws. Accrues the bad-luck
 * counters when the kill is an eligible opportunity (a monster with a
 * non-empty equipment list). Returns the rolled reward, already numbered and
 * queued for disposition, or `null` for no equipment.
 */
export function rollReward(state: SimState, monster: MonsterDefinition, ctx: Context): PendingReward | null {
  const band = drawBelow(state.rng, 1_000_000); state.rng = band.state;
  const natural = bandFor(band.value, monster.dropMultiplier);
  const rarity = ctx.content.pity.guaranteeEnabled
    ? raiseToGuarantee(natural, state.dropProtection, ctx.content.pity) : natural;

  const equipment = [...monster.equipment].sort(ascending);
  if (equipment.length === 0) return null;
  accrueProtection(state, rarity);
  if (rarity === null) return null;

  const definitionId = equipment[draw(state, equipment.length)];
  const bonuses = rollBonuses(state, ctx, definitionId, rarity, monster.level);

  const drops = state.metrics.drops;
  drops.rolled[rarity] += 1;
  if (drops.firstDropMs === null) {
    drops.firstDropMs = state.nowMs;
    drops.firstDropRarity = rarity;
  }
  return record(state, monster, { kind: 'equipment', definitionId, rarity, bonuses });
}

/**
 * Every draw one enemy death consumes, in part 3 §2.2's fixed order: the
 * equipment roll, the separate consumable roll against the monster's table in
 * consumable-id order, and the gold draw over `[goldMin, goldMax]`, which is
 * what `rawGold` banks.
 */
export function rollKill(state: SimState, monster: MonsterDefinition, ctx: Context): void {
  rollReward(state, monster, ctx);

  const consumable = draw(state, PPM_SPACE);
  let edge = 0;
  const table = [...monster.consumables].sort((a, b) => ascending(a.consumableId, b.consumableId));
  for (const entry of table) {
    edge += entry.ppm;
    if (consumable < edge) {
      state.metrics.drops.consumables += 1;
      record(state, monster, { kind: 'consumable', consumableId: entry.consumableId, quantity: 1 });
      break;
    }
  }

  state.metrics.rawGold += monster.goldMin + draw(state, monster.goldMax - monster.goldMin + 1);
}

function describe(reward: PendingReward, ctx: Context): DropDescriptor {
  const { item } = reward;
  if (item.kind === 'equipment') {
    return {
      category: 'equipment',
      definitionId: item.definitionId,
      slot: ctx.content.items[item.definitionId].slot,
      rarity: item.rarity,
      bonusIds: item.bonuses.map((bonus) => bonus.bonusId),
      itemLevel: reward.itemLevel,
    };
  }
  return {
    category: 'consumable', definitionId: item.consumableId, slot: null, rarity: null, bonusIds: [],
    itemLevel: reward.itemLevel,
  };
}

/**
 * Places a Keep in the bag (part 3 §3.1, §3.4): equipment takes a slot; a
 * consumable unit fills its open stack first and otherwise opens a new stack
 * in a free slot. Reports whether it fit — nothing is placed when it did not.
 */
function place(bag: BagState, item: RewardItem): boolean {
  if (item.kind === 'equipment') {
    if (bag.usedSlots >= bag.capacity) return false;
    bag.usedSlots += 1;
    return true;
  }
  let remaining = item.quantity;
  const headroom = Object.hasOwn(bag.stackHeadroom, item.consumableId) ? bag.stackHeadroom[item.consumableId] : 0;
  const slotsNeeded = Math.ceil(Math.max(0, remaining - headroom) / CONSUMABLE_STACK_MAX);
  if (bag.usedSlots + slotsNeeded > bag.capacity) return false;
  const fromHeadroom = Math.min(headroom, remaining);
  remaining -= fromHeadroom;
  bag.usedSlots += slotsNeeded;
  bag.stackHeadroom[item.consumableId] = headroom - fromHeadroom + slotsNeeded * CONSUMABLE_STACK_MAX - remaining;
  return true;
}

const OUTCOME: Record<'auto-sell' | 'ignore', RewardOutcome> = { 'auto-sell': 'auto-sold', ignore: 'ignored' };

/**
 * Dispositions every reward still waiting for one, in ascending `rewardSeq` —
 * kill order — with the checkpointed filter (part 3 §2.1, §3.3). Keep goes to
 * the bag, Auto-sell is credited without a slot (counted only: prices are
 * deferred), Ignore is dropped. A Keep that does not fit is **lost**: it is
 * recorded as such, announced with a `drop-lost` event and the hunt carries on
 * (spec §4.0; ruling R127). Draws nothing.
 *
 * A filter applied mid-encounter governs only the rewards from its cutoff
 * (ruling R131), and becomes the snapshot once nothing earlier is waiting.
 */
export function dispositionRewards(state: SimState, ctx: Context): void {
  const waiting = state.pendingRewards
    .filter((reward) => reward.disposition === null)
    .sort((a, b) => a.rewardSeq - b.rewardSeq);
  const drops = state.metrics.drops;

  for (const reward of waiting) {
    const pending = state.pendingLoot;
    const preset = pending !== null && reward.rewardSeq >= pending.fromRewardSeq ? pending.preset : state.lootPresetSnapshot;
    const decided = evaluate(describe(reward, ctx), preset);
    let outcome: RewardOutcome;
    if (decided.action === 'keep') {
      outcome = place(state.bagState, reward.item) ? 'kept' : 'lost';
    } else {
      outcome = OUTCOME[decided.action];
    }
    reward.disposition = { ...decided, outcome };

    if (outcome === 'kept') drops.kept += 1;
    else if (outcome === 'auto-sold') drops.autoSold += 1;
    else if (outcome === 'ignored') drops.ignored += 1;
    else {
      drops.lost += 1;
      const label = reward.item.kind === 'equipment' ? reward.item.definitionId : reward.item.consumableId;
      emitEvent(state, ctx, { kind: 'drop-lost', amount: reward.rewardSeq, reason: label });
    }
  }

  if (state.pendingLoot !== null) {
    state.lootPresetSnapshot = state.pendingLoot.preset;
    state.pendingLoot = null;
  }
}

/**
 * Applies `preset` to every drop from the next reward on (ruling R131). With
 * nothing awaiting disposition it takes effect at once; otherwise the rewards
 * already rolled keep their filter and the new one waits for them.
 */
export function applyLoot(state: SimState, preset: LootPreset): void {
  const copy = validateLootPreset(preset);
  if (state.pendingRewards.some((reward) => reward.disposition === null)) {
    state.pendingLoot = { preset: copy, fromRewardSeq: state.nextRewardSeq };
  } else {
    state.lootPresetSnapshot = copy;
    state.pendingLoot = null;
  }
}

/** Zeroed drop accounting for a new hunt. */
export function emptyDropMetrics(): DropMetrics {
  return {
    rolled: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 },
    consumables: 0,
    kept: 0,
    autoSold: 0,
    ignored: 0,
    lost: 0,
    firstDropMs: null,
    firstDropRarity: null,
    epicPlusWaits: [],
    legendaryWaits: [],
  };
}

/** A laboratory run's bag: the default size, empty (layer-1 §7.5). */
export function defaultBag(): BagState {
  return { capacity: BAG_CAPACITY, usedSlots: 0, stackHeadroom: {} };
}

/** A laboratory run's filter: the starter filter (layer-1 §7.5). */
export function starterLoot(): LootPreset {
  return validateLootPreset(STARTER_LOOT_PRESET);
}
