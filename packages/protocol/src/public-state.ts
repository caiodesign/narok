/**
 * The wire shape of `PublicState` (milestone B spec, part 1 §3, P-17).
 *
 * This is declared here rather than imported from `@narok/sim` at runtime, so
 * no simulation structure reaches the wire (P-01). The risk that buys is
 * drift, and the guard against drift is the mutual-assignability check in
 * `packages/protocol/test/public-state.test.ts`, which `tsc` decides: add a
 * field on either side and `pnpm typecheck` fails.
 *
 * Every object is `.strict()`. That is the enforcement of P-17 — a snapshot
 * carrying `rng`, a seed, a queue or any other private field is rejected here
 * rather than being quietly forwarded to a client.
 */
import { z } from 'zod';
import type { ActorId, PositionId } from '@narok/sim';
import type { SkillId } from '@narok/data';

/** Milliseconds and resource amounts are safe integers (contracts §3). */
const count = z.number().int();
const timestamp = z.number().int().nonnegative();

export const phaseSchema = z.enum(['walking', 'fighting', 'resting', 'respawning', 'stopped']);
export const stopReasonSchema = z.enum(['wipe-limit', 'stalemate', 'operator', 'retreat', 'potion-floor']);

/**
 * Three fields whose runtime check is "a string" but whose *type* is narrower
 * on the simulation side: a branded `PositionId`, a `SkillId | 'basic'`, and a
 * cooldown map keyed by `SkillId`.
 *
 * The runtime rule stays declared here and stays loose on purpose — the wire
 * must not duplicate the content enum, or shipping a new skill would mean
 * shipping a new protocol. The narrowing is a type assertion, which is safe in
 * exactly one direction: what arrives has already been validated as a string by
 * the schema above it, and the mutual-assignability test in
 * `test/public-state.test.ts` is what proves the resulting type still matches
 * `PublicActor` field for field.
 */
const positionId = z.string().transform((value) => value as PositionId);
const actorId = z.string().transform((value) => value as ActorId);
const castingSchema = z
  .string()
  .nullable()
  .transform((value) => value as SkillId | 'basic' | null);
const cooldownsSchema = z
  .record(z.string(), z.number())
  .transform((value) => value as Partial<Record<SkillId, number>>);

export const publicActorSchema = z
  .object({
    id: actorId,
    definitionId: z.string(),
    side: z.enum(['party', 'enemy']),
    position: positionId,
    hp: count,
    mp: count,
    maxHp: count,
    maxMp: count,
    currentTarget: actorId.nullable(),
    casting: castingSchema,
    targetReason: z.enum(['forced', 'threat', 'priority']).nullable(),
    cooldowns: cooldownsSchema,
  })
  .strict();

export const metricsSchema = z
  .object({
    kills: count,
    wins: count,
    wipes: count,
    rawExp: count,
    rawGold: count,
    damageDealt: count,
    effectiveHealing: count,
    walkMs: timestamp,
    fightMs: timestamp,
    restMs: timestamp,
    respawnMs: timestamp,
    actors: z.record(
      z.string(),
      z.object({ damageDealt: count, damageReceived: count, healingDone: count }).strict(),
    ),
  })
  .strict();

export const publicStateSchema = z
  .object({
    nowMs: timestamp,
    phase: phaseSchema,
    stopReason: stopReasonSchema.nullable(),
    actors: z.array(publicActorSchema),
    metrics: metricsSchema,
  })
  .strict();

export type PublicActorWire = z.infer<typeof publicActorSchema>;
export type PublicStateWire = z.infer<typeof publicStateSchema>;
export type MetricsWire = z.infer<typeof metricsSchema>;
