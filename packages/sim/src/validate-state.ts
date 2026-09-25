import type { Attributes, Content, DamageKind, Element, Family, SkillId } from '@narok/data';
import { SimError, type SimErrorCode } from './errors';
import { compareScheduled, isStale } from './scheduler';
import { validateLabInput, validatePendingRules } from './state';
import type { Battlefield } from './battlefield/types';
import type {
  Actor,
  ActorId,
  DerivedStats,
  Metrics,
  Phase,
  PositionId,
  QueueKind,
  ScheduledEvent,
  SimState,
  StopReason,
  TimedStatus,
} from './types';

/** Generous but finite bound for timestamp/counter fields, well under the safe-integer ceiling. */
const MAX_TIME = 1_000_000_000_000;

const PHASES: readonly Phase[] = ['walking', 'fighting', 'resting', 'respawning', 'stopped'];
/** Ruling R114: the closed `b1` union; any other value is refused, never passed through. */
const STOP_REASONS: readonly StopReason[] = ['wipe-limit', 'stalemate', 'operator', 'retreat', 'potion-floor'];
const SIDES = ['party', 'enemy'] as const;
const FAMILIES: readonly Family[] = ['beast', 'undead', 'demon', 'plant', 'insect', 'humanoid'];
const ELEMENTS: readonly Element[] = ['neutral', 'fire', 'water', 'earth', 'wind'];
const DAMAGE_KINDS: readonly DamageKind[] = ['physical', 'magic'];
const SKILL_IDS: readonly SkillId[] = [
  'taunt', 'cleave', 'heal', 'smite', 'double-shot', 'arrow-rain', 'fire-bolt', 'frost-nova',
];
const QUEUE_KINDS: readonly QueueKind[] = ['expire', 'regen', 'resolve', 'act', 'deadline', 'transition'];
const STATUS_KINDS = ['slow', 'stun'] as const;
/** Queue kinds that carry a real actor `token` (R19); every other kind carries `null`. */
const TOKEN_KINDS: readonly QueueKind[] = ['act', 'resolve'];
/** Queue kinds that carry `epoch: null` (global regen/phase-transition, per R19). */
const GLOBAL_EPOCH_KINDS: readonly QueueKind[] = ['regen', 'transition'];

const POSITION_PATTERN = /^(\d+),(\d+)$/;

function fail(code: SimErrorCode, field: string, message: string): never {
  throw new SimError(code, field, message);
}

/**
 * The complete set of actor ids a decoded state may legally use as an `actors`
 * key (or reference from `threat`/`metrics.actors`/queue `actorId`/etc): the
 * current roster's `p0..p{n-1}` plus `e0..e{maxEnemies-1}` for the content's
 * enemy cap. Building this whitelist up front means every place that later
 * uses an attacker-controlled string as a property key (`actors[id] = ...`,
 * `metricsActors[id] = ...`, a `threat` accumulator) can reject anything
 * outside it *before* assigning — including `'__proto__'`, which would
 * otherwise hit the inherited setter on a plain `{}` instead of creating an
 * own property, and which `x in obj`-style existence checks always report as
 * present regardless of the object's own keys.
 */
function buildAllowedActorIds(content: Content, rosterIds: readonly ActorId[]): ReadonlySet<string> {
  const ids = new Set<string>(rosterIds);
  for (let i = 0; i < content.grid.maxEnemies; i++) ids.add(`e${i}`);
  return ids;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('INVALID_STATE', field, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) fail('INVALID_STATE', field, 'expected an array');
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') fail('INVALID_STATE', field, 'expected a string');
  return value;
}

function requireOneOf<T extends string>(value: unknown, field: string, options: readonly T[]): T {
  const candidate = requireString(value, field);
  if (!options.includes(candidate as T)) {
    fail('INVALID_STATE', field, `expected one of ${options.join(', ')}`);
  }
  return candidate as T;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) fail('INVALID_STATE', field, 'expected a number');
  return value;
}

/** A number that is safe (finite, integral, magnitude-bounded) but not yet range-checked. */
function requireSafeInteger(value: unknown, field: string): number {
  const num = requireNumber(value, field);
  if (!Number.isFinite(num) || !Number.isSafeInteger(num)) {
    fail('UNSAFE_INTEGER', field, 'expected a safe integer');
  }
  return num;
}

function requireIntRange(value: unknown, field: string, min: number, max: number): number {
  const num = requireSafeInteger(value, field);
  if (num < min || num > max) fail('INVALID_STATE', field, `expected an integer between ${min} and ${max}`);
  return num;
}

function requireVersion<T>(value: unknown, field: string, expected: T): T {
  if (value !== expected) fail('WRONG_VERSION', field, `expected ${String(expected)}`);
  return expected;
}

function requireRng(value: unknown, field: string): number {
  const num = requireSafeInteger(value, field);
  if (num < 1 || num > 0xffffffff) fail('INVALID_STATE', field, 'expected a nonzero uint32');
  return num;
}

function validateAttributes(value: unknown, field: string): Attributes {
  const record = requireRecord(value, field);
  return {
    str: requireIntRange(record.str, `${field}.str`, 0, 999),
    agi: requireIntRange(record.agi, `${field}.agi`, 0, 999),
    vit: requireIntRange(record.vit, `${field}.vit`, 0, 999),
    int: requireIntRange(record.int, `${field}.int`, 0, 999),
    dex: requireIntRange(record.dex, `${field}.dex`, 0, 999),
    luk: requireIntRange(record.luk, `${field}.luk`, 0, 999),
  };
}

function validateStats(value: unknown, field: string): DerivedStats {
  const record = requireRecord(value, field);
  return {
    maxHp: requireIntRange(record.maxHp, `${field}.maxHp`, 0, 1_000_000_000),
    maxMp: requireIntRange(record.maxMp, `${field}.maxMp`, 0, 1_000_000_000),
    atk: requireIntRange(record.atk, `${field}.atk`, 0, 1_000_000_000),
    matk: requireIntRange(record.matk, `${field}.matk`, 0, 1_000_000_000),
    def: requireIntRange(record.def, `${field}.def`, 0, 1_000_000_000),
    mdef: requireIntRange(record.mdef, `${field}.mdef`, 0, 1_000_000_000),
    hit: requireIntRange(record.hit, `${field}.hit`, 0, 1_000_000),
    flee: requireIntRange(record.flee, `${field}.flee`, 0, 1_000_000),
    critBp: requireIntRange(record.critBp, `${field}.critBp`, 0, 10_000),
    intervalMs: requireIntRange(record.intervalMs, `${field}.intervalMs`, 1, 1_000_000),
  };
}

function validateStatus(value: unknown, field: string): TimedStatus {
  const record = requireRecord(value, field);
  return {
    id: requireString(record.id, `${field}.id`),
    sourceId: requireString(record.sourceId, `${field}.sourceId`),
    kind: requireOneOf(record.kind, `${field}.kind`, STATUS_KINDS),
    valueBp: requireIntRange(record.valueBp, `${field}.valueBp`, 0, 10_000),
    expiresAt: requireIntRange(record.expiresAt, `${field}.expiresAt`, 0, MAX_TIME),
  };
}

function validateCooldowns(value: unknown, field: string): Partial<Record<SkillId, number>> {
  const record = requireRecord(value, field);
  const result: Partial<Record<SkillId, number>> = {};
  for (const key of Object.keys(record)) {
    if (!SKILL_IDS.includes(key as SkillId)) fail('INVALID_STATE', `${field}.${key}`, 'unknown skill id');
    result[key as SkillId] = requireIntRange(record[key], `${field}.${key}`, 0, MAX_TIME);
  }
  return result;
}

function validateThreat(
  value: unknown,
  field: string,
  allowedActorIds: ReadonlySet<string>,
): Record<ActorId, number> {
  const record = requireRecord(value, field);
  const result: Record<ActorId, number> = {};
  for (const key of Object.keys(record)) {
    if (!allowedActorIds.has(key)) fail('INVALID_STATE', `${field}.${key}`, 'threat key is not an allowed actor id');
    result[key] = requireIntRange(record[key], `${field}.${key}`, 0, MAX_TIME);
  }
  return result;
}

function validateForcedTarget(value: unknown, field: string): Actor['forcedTarget'] {
  if (value === null) return null;
  const record = requireRecord(value, field);
  return {
    actorId: requireString(record.actorId, `${field}.actorId`),
    expiresAt: requireIntRange(record.expiresAt, `${field}.expiresAt`, 0, MAX_TIME),
  };
}

function validatePendingCast(
  value: unknown,
  field: string,
  actorSkills: readonly SkillId[],
  actionToken: number,
): Actor['pendingCast'] {
  if (value === null) return null;
  const record = requireRecord(value, field);
  const skillIdRaw = requireString(record.skillId, `${field}.skillId`);
  if (skillIdRaw !== 'basic' && !actorSkills.includes(skillIdRaw as SkillId)) {
    fail('INVALID_STATE', `${field}.skillId`, 'skillId must be "basic" or one of the actor skills');
  }
  const targetsRaw = requireArray(record.targets, `${field}.targets`);
  const targets = targetsRaw.map((entry, index) => requireString(entry, `${field}.targets.${index}`));
  const startedAt = requireIntRange(record.startedAt, `${field}.startedAt`, 0, MAX_TIME);
  const completesAt = requireIntRange(record.completesAt, `${field}.completesAt`, 0, MAX_TIME);
  if (completesAt < startedAt) fail('INVALID_STATE', `${field}.completesAt`, 'completesAt must be >= startedAt');
  const token = requireIntRange(record.token, `${field}.token`, 0, MAX_TIME);
  if (token !== actionToken) fail('INVALID_STATE', `${field}.token`, 'token must equal the actor actionToken');
  return { skillId: skillIdRaw as SkillId | 'basic', targets, startedAt, completesAt, token };
}

function validateActor(
  value: unknown,
  field: string,
  id: string,
  content: Content,
  allowedActorIds: ReadonlySet<string>,
): Actor {
  const record = requireRecord(value, field);
  const declaredId = requireString(record.id, `${field}.id`);
  if (declaredId !== id) fail('INVALID_STATE', `${field}.id`, 'actor id must match its map key');
  const side = requireOneOf(record.side, `${field}.side`, SIDES);
  const definitionId = requireString(record.definitionId, `${field}.definitionId`);
  if (side === 'party') {
    if (!Object.hasOwn(content.classes, definitionId)) {
      fail('INVALID_STATE', `${field}.definitionId`, 'unknown class id');
    }
  } else if (!Object.hasOwn(content.monsters, definitionId)) {
    fail('INVALID_STATE', `${field}.definitionId`, 'unknown monster id');
  }
  const level = requireIntRange(record.level, `${field}.level`, 1, 999);
  const family = requireOneOf(record.family, `${field}.family`, FAMILIES);
  const element = requireOneOf(record.element, `${field}.element`, ELEMENTS);
  const attributes = validateAttributes(record.attributes, `${field}.attributes`);
  const stats = validateStats(record.stats, `${field}.stats`);
  const hp = requireIntRange(record.hp, `${field}.hp`, 0, stats.maxHp);
  const mp = requireIntRange(record.mp, `${field}.mp`, 0, stats.maxMp);
  const positionRaw = requireString(record.position, `${field}.position`);
  const match = POSITION_PATTERN.exec(positionRaw);
  if (!match) fail('INVALID_STATE', `${field}.position`, 'malformed position id');
  const column = Number(match[1]);
  const row = Number(match[2]);
  if (column >= content.grid.width || row >= content.grid.height) {
    fail('INVALID_STATE', `${field}.position`, 'position is out of board');
  }
  const position = positionRaw as PositionId;
  const basicKind = requireOneOf(record.basicKind, `${field}.basicKind`, DAMAGE_KINDS);
  const basicRange = requireIntRange(record.basicRange, `${field}.basicRange`, 1, 20);
  const skillsRaw = requireArray(record.skills, `${field}.skills`);
  const skills = skillsRaw.map((entry, index) => requireOneOf(entry, `${field}.skills.${index}`, SKILL_IDS));
  const cooldowns = validateCooldowns(record.cooldowns, `${field}.cooldowns`);
  const statusesRaw = requireArray(record.statuses, `${field}.statuses`);
  const statuses = statusesRaw.map((entry, index) => validateStatus(entry, `${field}.statuses.${index}`));
  const threat = validateThreat(record.threat, `${field}.threat`, allowedActorIds);
  const forcedTarget = validateForcedTarget(record.forcedTarget, `${field}.forcedTarget`);
  const currentTarget = record.currentTarget === null
    ? null
    : requireString(record.currentTarget, `${field}.currentTarget`);
  const actionToken = requireIntRange(record.actionToken, `${field}.actionToken`, 0, MAX_TIME);
  const pendingCast = validatePendingCast(record.pendingCast, `${field}.pendingCast`, skills, actionToken);
  return {
    id, side, definitionId, level, family, element, attributes, stats, hp, mp, position,
    basicKind, basicRange, skills, cooldowns, statuses, threat, forcedTarget, currentTarget,
    pendingCast, actionToken,
  };
}

function validateQueueEntry(
  value: unknown,
  field: string,
  actors: Record<ActorId, Actor>,
): ScheduledEvent {
  const record = requireRecord(value, field);
  const kind = requireOneOf(record.kind, `${field}.kind`, QUEUE_KINDS);
  const at = requireIntRange(record.at, `${field}.at`, 0, MAX_TIME);
  const actorId = requireString(record.actorId, `${field}.actorId`);
  if (actorId !== '' && !Object.hasOwn(actors, actorId)) {
    fail('INVALID_STATE', `${field}.actorId`, 'unknown actor id');
  }
  const epoch = record.epoch === null ? null : requireIntRange(record.epoch, `${field}.epoch`, 0, MAX_TIME);
  if (GLOBAL_EPOCH_KINDS.includes(kind)) {
    if (epoch !== null) fail('INVALID_STATE', `${field}.epoch`, `${kind} events carry a null epoch`);
  } else if (epoch === null) {
    fail('INVALID_STATE', `${field}.epoch`, `${kind} events carry a numeric epoch`);
  }
  const token = record.token === null ? null : requireIntRange(record.token, `${field}.token`, 0, MAX_TIME);
  if (TOKEN_KINDS.includes(kind)) {
    if (token === null) fail('INVALID_STATE', `${field}.token`, `${kind} events carry a numeric token`);
  } else if (token !== null) {
    fail('INVALID_STATE', `${field}.token`, `${kind} events carry a null token`);
  }
  const seq = requireIntRange(record.seq, `${field}.seq`, 0, MAX_TIME);
  return { at, kind, actorId, seq, epoch, token };
}

function validateMetrics(
  value: unknown,
  field: string,
  actors: Record<ActorId, Actor>,
  allowedActorIds: ReadonlySet<string>,
): Metrics {
  const record = requireRecord(value, field);
  const nonNegativeInt = (key: string) => requireIntRange(record[key], `${field}.${key}`, 0, MAX_TIME);
  const actorsRecord = requireRecord(record.actors, `${field}.actors`);
  const metricsActors: Metrics['actors'] = {};
  for (const id of Object.keys(actorsRecord)) {
    if (!allowedActorIds.has(id)) fail('INVALID_STATE', `${field}.actors.${id}`, 'actor id is not an allowed id');
    if (!Object.hasOwn(actors, id)) fail('INVALID_STATE', `${field}.actors.${id}`, 'unknown actor id');
    const entry = requireRecord(actorsRecord[id], `${field}.actors.${id}`);
    metricsActors[id] = {
      damageDealt: requireIntRange(entry.damageDealt, `${field}.actors.${id}.damageDealt`, 0, MAX_TIME),
      damageReceived: requireIntRange(entry.damageReceived, `${field}.actors.${id}.damageReceived`, 0, MAX_TIME),
      healingDone: requireIntRange(entry.healingDone, `${field}.actors.${id}.healingDone`, 0, MAX_TIME),
    };
  }
  return {
    kills: nonNegativeInt('kills'),
    wins: nonNegativeInt('wins'),
    wipes: nonNegativeInt('wipes'),
    rawExp: nonNegativeInt('rawExp'),
    rawGold: nonNegativeInt('rawGold'),
    damageDealt: nonNegativeInt('damageDealt'),
    effectiveHealing: nonNegativeInt('effectiveHealing'),
    walkMs: nonNegativeInt('walkMs'),
    fightMs: nonNegativeInt('fightMs'),
    restMs: nonNegativeInt('restMs'),
    respawnMs: nonNegativeInt('respawnMs'),
    actors: metricsActors,
  };
}

/**
 * Full runtime validation for a decoded `SimState` (ruling R23): schema/version
 * identity, safe/ranged numbers, known ids, actor and queue shape/invariants
 * (including at most one current, non-stale `act`/`resolve` entry per actor
 * token, and pending-cast target/identity consistency), and `input` re-validated
 * with the same rules `startState` uses. Stale queued entries are allowed to
 * remain. Never embeds the decoded value in a thrown message.
 */
export function validateSimState(value: unknown, content: Content, battlefield: Battlefield): SimState {
  const root = requireRecord(value, '$');

  requireVersion(root.schemaVersion, 'schemaVersion', 1);
  // R114: `b1` came with the closed B stop vocabulary, so an A-era `a1` snapshot is refused.
  requireVersion(root.simulationVersion, 'simulationVersion', 'b1');
  requireVersion(root.contentVersion, 'contentVersion', content.version);
  requireVersion(root.gridHash, 'gridHash', content.gridHash);

  const nowMs = requireIntRange(root.nowMs, 'nowMs', 0, MAX_TIME);
  const rng = requireRng(root.rng, 'rng');
  const nextQueueSeq = requireIntRange(root.nextQueueSeq, 'nextQueueSeq', 0, MAX_TIME);
  const nextDomainSeq = requireIntRange(root.nextDomainSeq, 'nextDomainSeq', 0, MAX_TIME);
  const epoch = requireIntRange(root.epoch, 'epoch', 0, MAX_TIME);
  const encounterCount = requireIntRange(root.encounterCount, 'encounterCount', 0, MAX_TIME);
  const encounterStartedAt = root.encounterStartedAt === null
    ? null
    : requireIntRange(root.encounterStartedAt, 'encounterStartedAt', 0, MAX_TIME);
  const phase = requireOneOf(root.phase, 'phase', PHASES);
  const stopReason = root.stopReason === null ? null : requireOneOf(root.stopReason, 'stopReason', STOP_REASONS);

  const input = validateLabInput(root.input, content, battlefield);
  // R115: the queued rule set is re-validated against this roster on every decode.
  const pendingRules = root.pendingRules === null
    ? null
    : validatePendingRules(root.pendingRules, input, content, battlefield);
  const rosterIds = input.classes.map((_, index) => `p${index}`);
  const allowedActorIds = buildAllowedActorIds(content, rosterIds);

  const actorsRecord = requireRecord(root.actors, 'actors');
  const actors: Record<ActorId, Actor> = {};
  for (const id of Object.keys(actorsRecord)) {
    if (!allowedActorIds.has(id)) fail('INVALID_STATE', `actors.${id}`, 'actor id is not an allowed id');
    actors[id] = validateActor(actorsRecord[id], `actors.${id}`, id, content, allowedActorIds);
  }
  for (const id of rosterIds) {
    if (!Object.hasOwn(actors, id)) fail('INVALID_STATE', `actors.${id}`, 'missing party actor for roster id');
  }

  const seenPositions = new Map<string, string>();
  for (const [id, actor] of Object.entries(actors)) {
    if (actor.hp <= 0) continue;
    const owner = seenPositions.get(actor.position);
    if (owner) fail('INVALID_STATE', `actors.${id}.position`, `duplicate live position with ${owner}`);
    seenPositions.set(actor.position, id);
  }

  for (const [id, actor] of Object.entries(actors)) {
    if (actor.pendingCast) {
      actor.pendingCast.targets.forEach((targetId, index) => {
        if (!Object.hasOwn(actors, targetId)) {
          fail('INVALID_STATE', `actors.${id}.pendingCast.targets.${index}`, 'unknown target actor');
        }
      });
    }
    for (const threatId of Object.keys(actor.threat)) {
      if (!Object.hasOwn(actors, threatId)) {
        fail('INVALID_STATE', `actors.${id}.threat.${threatId}`, 'unknown threat source');
      }
    }
    if (actor.forcedTarget && !Object.hasOwn(actors, actor.forcedTarget.actorId)) {
      fail('INVALID_STATE', `actors.${id}.forcedTarget.actorId`, 'unknown forced target actor');
    }
    if (actor.currentTarget !== null && !Object.hasOwn(actors, actor.currentTarget)) {
      fail('INVALID_STATE', `actors.${id}.currentTarget`, 'unknown current target actor');
    }
  }

  const queueRaw = requireArray(root.queue, 'queue');
  const queue: ScheduledEvent[] = queueRaw.map((raw, index) => validateQueueEntry(raw, `queue.${index}`, actors));

  // `takeNext()`/`schedule()` rely entirely on `state.queue` staying in
  // continuous canonical order (compareScheduled); encodeSnapshot always
  // emits it that way, so a decoded queue that is out of order, or whose
  // `seq` values are not all `< nextQueueSeq` and pairwise distinct (so a
  // later `schedule()` call cannot collide with a decoded entry), is
  // rejected outright rather than silently re-sorted.
  const seenSeqs = new Set<number>();
  queue.forEach((event, index) => {
    const field = `queue.${index}`;
    if (event.seq >= nextQueueSeq) {
      fail('INVALID_STATE', `${field}.seq`, 'seq must be less than nextQueueSeq');
    }
    if (seenSeqs.has(event.seq)) fail('INVALID_STATE', `${field}.seq`, 'duplicate seq value');
    seenSeqs.add(event.seq);
    if (index > 0 && compareScheduled(queue[index - 1], event) > 0) {
      fail('INVALID_STATE', field, 'queue is not in canonical scheduled order');
    }
  });

  const currentByActorToken = new Set<string>();
  for (const event of queue) {
    if (event.kind !== 'act' && event.kind !== 'resolve') continue;
    if (isStale({ epoch, actors }, event)) continue;
    const key = `${event.actorId}#${event.token}`;
    if (currentByActorToken.has(key)) {
      fail('INVALID_STATE', 'queue', `duplicate current ${event.kind} for actor ${event.actorId}`);
    }
    currentByActorToken.add(key);
  }

  const metrics = validateMetrics(root.metrics, 'metrics', actors, allowedActorIds);

  return {
    schemaVersion: 1,
    simulationVersion: 'b1',
    contentVersion: content.version,
    gridHash: content.gridHash,
    nowMs,
    rng,
    nextQueueSeq,
    nextDomainSeq,
    epoch,
    encounterCount,
    encounterStartedAt,
    phase,
    stopReason,
    input,
    pendingRules,
    actors,
    queue,
    metrics,
  };
}
