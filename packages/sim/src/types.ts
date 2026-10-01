import type {
  Attributes,
  ClassId,
  Content,
  DamageKind,
  Element,
  Family,
  ItemInstance,
  Rarity,
  RecipeId,
  RolledBonus,
  SkillId,
} from '@narok/data';
import type { Disposition, LootPreset } from '@narok/loot';
import type { Progress } from '@narok/progression';
import type { Battlefield } from './battlefield/types';

export type ActorId = string;
export type PositionId = string & { readonly __position: unique symbol };
/**
 * There is no respawn phase (owner decision 2026-09-30; ruling R154): a full
 * wipe ends the hunt.
 */
export type Phase = 'walking' | 'fighting' | 'resting' | 'stopped';
/**
 * The closed stop vocabulary of simulation version `b1` (ruling R114, part 2
 * §9 #5): `wipe` (every member dead with no apple or revive left to act —
 * owner decision 2026-09-30, ruling R154, replacing A's `wipe-limit`),
 * `stalemate` and `operator`, plus `retreat` (the party abandons its encounter
 * for town) and `potion-floor` (layer-1 §6.6's "return when HP potions fall
 * below N"). A full bag is not a stop — the drop is lost and the hunt
 * continues (spec §4.0) — and reaching the offline cap is not a stop either:
 * it bounds accrual and leaves the hunt running.
 */
export type StopReason = 'wipe' | 'stalemate' | 'operator' | 'retreat' | 'potion-floor';
export type TargetMode =
  | { kind: 'lowest-hp' | 'highest-hp' | 'highest-level' | 'nearest' }
  | { kind: 'attacking'; partyId: ActorId };
export type Condition =
  | { kind: 'always' | 'ally-targeted' | 'ally-dead' }
  | { kind: 'ally-hp-below' | 'targets-at-least'; value: number };
export interface Rule { skillId: SkillId; enabled: boolean; condition: Condition }
export interface Strategy { rules: Rule[]; target: TargetMode }
export interface LabInput {
  seed: number; classes: ClassId[]; recipe: RecipeId | 'mixed';
  placement: Record<ActorId, PositionId>;
  strategies: Record<ActorId, Strategy>;
  rest: { hpStart: number; mpStart: number };
}
/**
 * A queued strategy (milestone B part 2 §4, ruling R115): exactly what a
 * strategy preset holds — placement, per-character strategies and rest
 * thresholds (owner decision 2026-09-25; the wipe limit went with the owner
 * decision of 2026-09-30, ruling R154) — and nothing of the roster, recipe or
 * seed. It activates as one atomic replacement of those three `input` fields
 * at the next encounter spawn, before the recipe draw.
 */
export type PendingRules = Pick<LabInput, 'placement' | 'strategies' | 'rest'>;
export interface DerivedStats {
  maxHp: number; maxMp: number; atk: number; matk: number; def: number; mdef: number;
  hit: number; flee: number; critBp: number; intervalMs: number;
}
export interface TimedStatus {
  id: string; sourceId: ActorId; kind: 'slow' | 'stun'; valueBp: number; expiresAt: number;
}
export interface PendingCast {
  skillId: SkillId | 'basic'; targets: ActorId[]; startedAt: number; completesAt: number;
  token: number;
}
export interface Actor {
  id: ActorId; side: 'party' | 'enemy'; definitionId: string; level: number;
  family: Family; element: Element; attributes: Attributes;
  stats: DerivedStats; hp: number; mp: number; position: PositionId;
  basicKind: DamageKind; basicRange: number; skills: SkillId[];
  cooldowns: Partial<Record<SkillId, number>>; statuses: TimedStatus[];
  threat: Record<ActorId, number>;
  forcedTarget: { actorId: ActorId; expiresAt: number } | null;
  currentTarget: ActorId | null; pendingCast: PendingCast | null; actionToken: number;
}
export type QueueKind = 'expire' | 'regen' | 'resolve' | 'act' | 'deadline' | 'transition';
export interface ScheduledEvent {
  at: number; kind: QueueKind; actorId: ActorId; seq: number;
  epoch: number | null; token: number | null;
}
/**
 * Drop accounting (part 3 §7, layer-1 §12). `rolled` counts equipment by
 * rarity at the roll; the four outcomes count every reward, equipment and
 * consumable, at disposition. The waits are the eligible opportunities each
 * Epic-or-better (`epicPlusWaits`) or Legendary award took, one entry per award
 * — the bad-luck counters' own measure, kept as a distribution, never a mean.
 */
export interface DropMetrics {
  rolled: Record<Rarity, number>;
  consumables: number;
  kept: number; autoSold: number; ignored: number; lost: number;
  firstDropMs: number | null; firstDropRarity: Rarity | null;
  epicPlusWaits: number[]; legendaryWaits: number[];
}
export interface Metrics {
  kills: number; wins: number; wipes: number; rawExp: number; rawGold: number;
  damageDealt: number; effectiveHealing: number;
  walkMs: number; fightMs: number; restMs: number;
  actors: Record<ActorId, { damageDealt: number; damageReceived: number; healingDone: number }>;
  drops: DropMetrics;
  /**
   * Units of each consumable the hunt has spent from the bag, cumulative —
   * Idun's Apples (ruling R152). The commit that settles a span takes the
   * span's increase off the account's stacks.
   */
  consumed: Record<string, number>;
}
/**
 * Bad-luck counters (part 3 §2.4): eligible opportunities since the last award
 * of each tier. They belong to the account and outlive a hunt; the hunt's
 * checkpoint carries them and the server indexes them (ruling R128).
 */
export interface DropProtection { epicPlus: number; legendary: number }
/**
 * What the simulation may assume about the shared bag (part 3 §2.5): slots in
 * use of `capacity`, and the total held of each consumable, which its stacks
 * follow from (`ceil(n / 999)`, ruling R137). A simulation input, because a
 * Keep that does not fit is lost, and Idun's Apples are spent from it (ruling
 * R152).
 */
export interface BagState { capacity: number; usedSlots: number; held: Record<string, number> }
/**
 * A loot filter applied mid-hunt (part 3 §3.3; ruling R131): it governs the
 * rewards numbered from `fromRewardSeq`, the acknowledged cutoff, and replaces
 * the snapshot once no earlier reward still waits for its disposition.
 */
export interface PendingLoot { preset: LootPreset; fromRewardSeq: number }
export type RewardItem =
  | { kind: 'equipment'; definitionId: string; rarity: Rarity; bonuses: RolledBonus[] }
  | { kind: 'consumable'; consumableId: string; quantity: number };
/** What became of a reward: the filter's action, and for a Keep whether it fit. */
export type RewardOutcome = 'kept' | 'auto-sold' | 'ignored' | 'lost';
/**
 * One rolled reward (part 3 §2; ruling R127). Rolled at the kill with
 * `disposition: null`, dispositioned at encounter end, and held until the
 * server drains it into the commit that credits it. Its id is
 * `"<huntId>:<rewardSeq>"`; nothing here reveals the seed or the RNG.
 */
export interface PendingReward {
  rewardSeq: number; atSimMs: number; monsterId: string; itemLevel: number;
  item: RewardItem;
  disposition: (Disposition & { outcome: RewardOutcome }) | null;
}
/**
 * The account-side inputs a hunt starts from (part 3 §2.5). Each is optional
 * for a laboratory run: the starter filter, an empty bag of the default size
 * and zeroed counters.
 */
export interface HuntSetup {
  loot?: LootPreset; bag?: BagState; dropProtection?: DropProtection;
  /**
   * The roster's characters (Part 3 §5; ruling R140), keyed by roster id:
   * progression, worn items and absolute current HP/MP. Without it the hunt is
   * a laboratory run of milestone A's fixed level-10 characters and nothing
   * levels.
   */
  party?: Record<ActorId, HuntPartyMember>;
}
/** One character as a hunt receives it. `hp`/`mp` are clamped to the derived maxima at start. */
export interface HuntPartyMember {
  characterId: string; progress: Progress; equipped: ItemInstance[]; hp: number; mp: number;
}
/**
 * One character's checkpointed progression (Part 3 §5.1–§5.2; ruling R140):
 * EXP, carry, points, awarded levels and the auto-spend template snapshotted at
 * hunt start — never a live account read — plus the worn items its stats are
 * re-derived from at each level-up. Current HP/MP live on the actor.
 */
export interface HuntCharacter extends Progress { characterId: string; equipped: ItemInstance[] }
export interface SimState {
  schemaVersion: 1; simulationVersion: 'b1'; contentVersion: string; gridHash: string;
  nowMs: number; rng: number; nextQueueSeq: number; nextDomainSeq: number;
  epoch: number; encounterCount: number; encounterStartedAt: number | null;
  phase: Phase; stopReason: StopReason | null; input: LabInput;
  /** At most one queued rule set; `null` when nothing is pending (R115). */
  pendingRules: PendingRules | null;
  actors: Record<ActorId, Actor>; queue: ScheduledEvent[]; metrics: Metrics;
  /** The next reward ordinal; reward ids are `"<huntId>:<rewardSeq>"` (part 2 §2). */
  nextRewardSeq: number;
  /** Rolled rewards in `rewardSeq` order: undispositioned ones, then dispositioned ones awaiting a commit. */
  pendingRewards: PendingReward[];
  dropProtection: DropProtection;
  /** The filter that runs at encounter end — not the preset the player is editing. */
  lootPresetSnapshot: LootPreset;
  /** Applied filters still waiting for earlier drops, ascending by cutoff; empty when none (R131). */
  pendingLoot: PendingLoot[];
  bagState: BagState;
  /** Per roster id; `null` for a laboratory run, which carries none (R140). */
  progression: Record<ActorId, HuntCharacter> | null;
}
export interface DomainEvent {
  seq: number; at: number; encounter: number;
  kind: 'phase' | 'spawn' | 'move' | 'cast' | 'damage' | 'miss' | 'heal'
    | 'death' | 'revive' | 'status' | 'taunt' | 'regen' | 'win' | 'wipe' | 'stop' | 'drop-lost';
  actorId: ActorId | null; targetId: ActorId | null; amount: number | null;
  reason: string | null; position: PositionId | null;
}
export interface AdvanceOptions { collect?: 'events' | 'summary'; maxScheduledEvents?: number }
export interface AdvanceResult { state: SimState; events: DomainEvent[]; reachedTarget: boolean }
export interface PublicActor {
  id: ActorId; definitionId: string; side: 'party' | 'enemy'; position: PositionId;
  hp: number; mp: number; maxHp: number; maxMp: number; currentTarget: ActorId | null;
  casting: SkillId | 'basic' | null; targetReason: 'forced' | 'threat' | 'priority' | null;
  /** Additive per ruling R12/R42: ready-at timestamps, so a client can show factual
   * remaining cooldown. Already-observed state, never a future outcome. */
  cooldowns: Partial<Record<SkillId, number>>;
}
export interface PublicState {
  nowMs: number; phase: Phase; stopReason: StopReason | null;
  actors: PublicActor[]; metrics: Metrics;
}
export interface Simulation {
  start(input: LabInput, setup?: HuntSetup): SimState;
  advance(state: SimState, untilMs: number, options?: AdvanceOptions): AdvanceResult;
  stop(state: SimState): SimState;
  /**
   * Queues `rules` for activation at the next encounter spawn, replacing any
   * rules already queued (`null` clears the queue). The rules are validated by
   * the same validator `start` uses and deep-copied, so a later edit to the
   * caller's object never reaches the queued snapshot (R115).
   */
  queueRules(state: SimState, rules: PendingRules | null): SimState;
  /**
   * Applies a loot filter to every drop from now on (ruling R131): rewards
   * already rolled keep the filter they were rolled under, so nothing is
   * dispositioned retroactively. Validated and deep-copied; no RNG, no time.
   */
  queueLoot(state: SimState, preset: LootPreset): SimState;
  encode(state: SimState): string;
  decode(text: string): SimState;
  project(state: SimState): PublicState;
}
export interface Context {
  content: Content;
  battlefield: Battlefield;
  emit(event: Omit<DomainEvent, 'seq'>): void;
}
