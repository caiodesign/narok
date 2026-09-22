/**
 * The socket vocabulary of milestone B spec part 1 §3, continuing the one
 * `apps/client/src/worker-contract.ts` established in milestone A: `frame`,
 * `snapshot`, `error {code, field}`, and a `generation` on every message.
 *
 * One difference is decisive and is the reason this is not simply the worker
 * contract renamed: in the laboratory the client drives `advance`. In
 * production the client may never move the authoritative clock (layer-1 §4.4),
 * so **there is no `advance` message here and there never will be.** The three
 * client messages are a greeting, a heartbeat and an acknowledgement.
 */
import { z } from 'zod';
import { errorCodeSchema } from './codes';
import { publicStateSchema } from './public-state';

const generation = z.number().int().nonnegative();
const seq = z.number().int().nonnegative();

/**
 * A domain event as the client receives it. `at` is an *elapsed* authoritative
 * timestamp; the server never emits one that has not elapsed (P-16), so a
 * client rendering what it is given cannot show the future.
 */
export const domainEventSchema = z
  .object({
    seq,
    at: z.number().int().nonnegative(),
    encounter: z.number().int().nonnegative(),
    kind: z.string(),
    actorId: z.string().nullable(),
    targetId: z.string().nullable(),
    amount: z.number().nullable(),
    reason: z.string().nullable(),
    position: z.string().nullable(),
  })
  .strict();

export const helloSchema = z
  .object({ type: z.literal('hello'), lastGeneration: generation.optional(), lastSeq: seq.optional() })
  .strict();

export const heartbeatSchema = z.object({ type: z.literal('heartbeat') }).strict();

export const ackSchema = z.object({ type: z.literal('ack'), generation, seq }).strict();

export const clientMessageSchema = z.discriminatedUnion('type', [helloSchema, heartbeatSchema, ackSchema]);

export const frameSchema = z
  .object({
    type: z.literal('frame'),
    generation,
    firstSeq: seq,
    lastSeq: seq,
    events: z.array(domainEventSchema),
    state: publicStateSchema,
  })
  .strict();

export const snapshotSchema = z
  .object({ type: z.literal('snapshot'), generation, seq, state: publicStateSchema })
  .strict();

export const reportSchema = z.object({ type: z.literal('report'), generation, reportId: z.uuid() }).strict();

export const wsErrorSchema = z
  .object({ type: z.literal('error'), generation, code: errorCodeSchema, field: z.string().max(120) })
  .strict();

export const serverMessageSchema = z.discriminatedUnion('type', [
  frameSchema,
  snapshotSchema,
  reportSchema,
  wsErrorSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type Frame = z.infer<typeof frameSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type DomainEventWire = z.infer<typeof domainEventSchema>;
