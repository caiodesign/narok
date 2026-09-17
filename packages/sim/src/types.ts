import type {
  Attributes,
  ClassId,
  Content,
  DamageKind,
  Element,
  Family,
  RecipeId,
  SkillId,
} from '@narok/data';
import type { Battlefield } from './battlefield/types';

export type ActorId = string;
export type PositionId = string & { readonly __position: unique symbol };
export type Phase = 'walking' | 'fighting' | 'resting' | 'respawning' | 'stopped';
export type StopReason = 'wipe-limit' | 'stalemate' | 'operator';
export type TargetMode =
  | { kind: 'lowest-hp' | 'highest-hp' | 'highest-level' | 'nearest' }
  | { kind: 'attacking'; partyId: ActorId };
export type Condition =
  | { kind: 'always' | 'ally-targeted' }
  | { kind: 'ally-hp-below' | 'targets-at-least'; value: number };
export interface Rule { skillId: SkillId; enabled: boolean; condition: Condition }
export interface Strategy { rules: Rule[]; target: TargetMode }
export interface LabInput {
  seed: number; classes: ClassId[]; recipe: RecipeId | 'mixed';
  placement: Record<ActorId, PositionId>;
  strategies: Record<ActorId, Strategy>;
  rest: { hpStart: number; mpStart: number }; wipeLimit: number;
}
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
export interface Metrics {
  kills: number; wins: number; wipes: number; rawExp: number; rawGold: number;
  damageDealt: number; effectiveHealing: number;
  walkMs: number; fightMs: number; restMs: number; respawnMs: number;
  actors: Record<ActorId, { damageDealt: number; damageReceived: number; healingDone: number }>;
}
export interface SimState {
  schemaVersion: 1; simulationVersion: 'a1'; contentVersion: string; gridHash: string;
  nowMs: number; rng: number; nextQueueSeq: number; nextDomainSeq: number;
  epoch: number; encounterCount: number; encounterStartedAt: number | null;
  phase: Phase; stopReason: StopReason | null; input: LabInput;
  actors: Record<ActorId, Actor>; queue: ScheduledEvent[]; metrics: Metrics;
}
export interface DomainEvent {
  seq: number; at: number; encounter: number;
  kind: 'phase' | 'spawn' | 'move' | 'cast' | 'damage' | 'miss' | 'heal'
    | 'death' | 'status' | 'taunt' | 'regen' | 'win' | 'wipe' | 'stop';
  actorId: ActorId | null; targetId: ActorId | null; amount: number | null;
  reason: string | null; position: PositionId | null;
}
export interface AdvanceOptions { collect?: 'events' | 'summary'; maxScheduledEvents?: number }
export interface AdvanceResult { state: SimState; events: DomainEvent[]; reachedTarget: boolean }
export interface PublicActor {
  id: ActorId; definitionId: string; side: 'party' | 'enemy'; position: PositionId;
  hp: number; mp: number; maxHp: number; maxMp: number; currentTarget: ActorId | null;
  casting: SkillId | 'basic' | null; targetReason: 'forced' | 'threat' | 'priority' | null;
}
export interface PublicState {
  nowMs: number; phase: Phase; stopReason: StopReason | null;
  actors: PublicActor[]; metrics: Metrics;
}
export interface Simulation {
  start(input: LabInput): SimState;
  advance(state: SimState, untilMs: number, options?: AdvanceOptions): AdvanceResult;
  stop(state: SimState): SimState;
  encode(state: SimState): string;
  decode(text: string): SimState;
  project(state: SimState): PublicState;
}
export interface Context {
  content: Content;
  battlefield: Battlefield;
  emit(event: Omit<DomainEvent, 'seq'>): void;
}
