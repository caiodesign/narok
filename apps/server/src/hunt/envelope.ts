/**
 * The checkpoint envelope (milestone B spec part 2 §2, layer-1 §4.3).
 *
 * `packages/sim` already encodes everything the *simulation* needs to resume:
 * time, RNG, queue, actors, metrics, the input. What it does not know about is
 * the account the hunt belongs to, the wall clock it is anchored to, or the
 * rewards that have been rolled but not yet committed. This module adds
 * exactly those, and adds them **around** the simulation's encoding rather
 * than inside it.
 *
 * That boundary is the point. `encodeSnapshot` stays the only serialiser of
 * simulation state — no second format, no re-parsing, no field of `SimState`
 * copied out and stored twice where the two could disagree. The envelope holds
 * the engine's output as an opaque string, so the byte-equality the
 * determinism tests rest on survives a round trip through the envelope
 * untouched.
 */
import { z } from 'zod';

/**
 * Bumped when the envelope's own shape changes, independent of the engine.
 * 3: the pending strategy carries its command id and acknowledgement instant
 * (ruling R115); its payload lives in the engine state that activates it.
 */
export const ENVELOPE_VERSION = 3;

/**
 * The carrier's hard bound (part 2 §9 #8). Reaching it forces a commit, the way
 * the work budget forces a yield; it never drops or truncates a reward.
 */
export const REWARD_CARRIER_CAP = 512;

/**
 * A reward rolled but not yet committed. Bounded, because the checkpoint is
 * read and written on every persist: past the cap a commit is forced, the same
 * way the work budget forces a yield (part 2 §9 #8).
 */
export const pendingRewardSchema = z
  .object({
    rewardId: z.string().max(128),
    atSimMs: z.number().int().nonnegative(),
    kind: z.enum(['item', 'gold', 'exp', 'consumable']),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export const pitySchema = z
  .object({ epicPlus: z.number().int().nonnegative(), legendary: z.number().int().nonnegative() })
  .strict();

export const presetRefSchema = z
  .object({ presetId: z.uuid(), presetVersion: z.number().int().positive() })
  .strict();

/**
 * A queued strategy (part 2 §2, §4; ruling R115). The payload itself is the
 * engine's `state.pendingRules` — a deep validated copy taken at apply time —
 * so there is one copy of it, inside the validator that checks it, and this
 * side records only which preset version it was and when it was acknowledged.
 */
export const pendingStrategySchema = presetRefSchema
  .extend({
    commandId: z.string().min(1).max(256),
    acknowledgedAtSimMs: z.number().int().nonnegative(),
  })
  .strict();

export const checkpointEnvelopeSchema = z
  .object({
    envelopeVersion: z.number().int().positive(),

    // Identity. `huntId` is the reward namespace, which is why starting again
    // allocates a new one rather than reusing the account's (P-29).
    accountId: z.uuid(),
    huntId: z.uuid(),
    generation: z.number().int().nonnegative(),
    checkpointSeq: z.number().int().nonnegative(),
    /** The account version this checkpoint was committed against. */
    accountStateVersion: z.number().int().nonnegative(),

    // Anchors. The arithmetic over them lives in `clock.ts`.
    wallAnchorMs: z.number().int(),
    simAnchorMs: z.number().int().nonnegative(),
    pausedWallMs: z.number().int().nonnegative(),
    lastSeenAt: z.number().int(),
    offlineCapMs: z.number().int().positive(),

    // Rewards. `rewardSeq` plus `huntId` is what makes a reward id reproducible
    // and collision-safe without a UUID generator (layer-1 §4.3).
    rewardSeq: z.number().int().nonnegative(),
    pendingRewards: z.array(pendingRewardSchema).max(REWARD_CARRIER_CAP),
    pity: pitySchema,

    // Strategy and loot: what is running, and what is queued for the next
    // encounter. A later edit to the saved preset must not mutate the queued
    // snapshot, which is why the pending side carries its own payload.
    activeStrategy: presetRefSchema,
    activeLoot: presetRefSchema,
    pendingStrategy: pendingStrategySchema.nullable(),
    pendingLoot: presetRefSchema.nullable(),

    /** What the simulation is allowed to assume about the bag (part 3 §2.5). */
    inventoryProjection: z
      .object({
        capacity: z.number().int().nonnegative(),
        usedSlots: z.number().int().nonnegative(),
        stackHeadroom: z.record(z.string(), z.number().int().nonnegative()),
      })
      .strict(),

    /**
     * Why the hunt ended, when it has. Never invented for a running hunt.
     * `inTownAtWallMs` is when the party reaches town: a player's stop costs
     * the content's travel time (spec §4.0.1), and a new hunt cannot start
     * before it. It is wall time, not sim time, so the stopped engine state is
     * never ahead of the clock a client may be shown.
     */
    stopContext: z
      .object({
        reason: z.string().max(64),
        atSimMs: z.number().int().nonnegative(),
        atWallMs: z.number().int(),
        inTownAtWallMs: z.number().int(),
      })
      .strict()
      .nullable(),

    /** The engine's own encoding, held opaque so its bytes survive unchanged. */
    state: z.string(),
  })
  .strict();

export type CheckpointEnvelope = z.infer<typeof checkpointEnvelopeSchema>;
export type PendingReward = z.infer<typeof pendingRewardSchema>;
export type PresetRef = z.infer<typeof presetRefSchema>;
export type PendingStrategy = z.infer<typeof pendingStrategySchema>;

export class EnvelopeError extends Error {
  readonly code = 'INVALID_ENVELOPE' as const;
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'EnvelopeError';
    this.field = field;
  }
}

/**
 * Canonical JSON: keys in a fixed order, so the stored bytes are a function of
 * the values and nothing else. `JSON.stringify` with an explicit key list is
 * enough here — the engine's own encoding is already canonical and travels as
 * one opaque string.
 */
const KEY_ORDER: readonly (keyof CheckpointEnvelope)[] = [
  'envelopeVersion',
  'accountId',
  'huntId',
  'generation',
  'checkpointSeq',
  'accountStateVersion',
  'wallAnchorMs',
  'simAnchorMs',
  'pausedWallMs',
  'lastSeenAt',
  'offlineCapMs',
  'rewardSeq',
  'pendingRewards',
  'pity',
  'activeStrategy',
  'activeLoot',
  'pendingStrategy',
  'pendingLoot',
  'inventoryProjection',
  'stopContext',
  'state',
];

export function encodeCheckpoint(envelope: CheckpointEnvelope): string {
  const parsed = checkpointEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EnvelopeError(issue?.path.join('.') ?? '$', 'envelope failed validation before encoding');
  }

  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) ordered[key] = parsed.data[key];
  return JSON.stringify(ordered);
}

export function decodeCheckpoint(text: string): CheckpointEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new EnvelopeError('$', 'checkpoint is not valid JSON');
  }

  const parsed = checkpointEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EnvelopeError(issue?.path.join('.') ?? '$', 'checkpoint envelope failed validation');
  }

  if (parsed.data.envelopeVersion !== ENVELOPE_VERSION) {
    // Fails closed, like every other version check: nothing is substituted to
    // make an old checkpoint load (layer-1 §11).
    throw new EnvelopeError('envelopeVersion', 'checkpoint envelope version does not match the deployed one');
  }

  return parsed.data;
}

/** The reward id for a sequence number, from the hunt namespace (P-29). */
export function rewardIdFor(huntId: string, rewardSeq: number): string {
  return `${huntId}:${rewardSeq}`;
}
