/**
 * The bounded error taxonomy (milestone B spec, part 1 §7).
 *
 * The server returns a stable code and a bounded diagnostic field; the client
 * localizes from the code (layer-1 §9). That contract only holds while the set
 * is closed, so the tuple below is the enumeration and `packages/protocol/test/
 * codes.test.ts` is its fence. A failure class that needs a new code needs a
 * spec amendment first, not an ad-hoc string.
 */
import { z } from 'zod';

export const ERROR_CODES = [
  'VALIDATION',
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'FORBIDDEN_ORIGIN',
  'NOT_OWNED',
  'NOT_FOUND',
  'EMAIL_TAKEN',
  'CONFLICT_STATE_VERSION',
  'IDEMPOTENCY_KEY_REUSED',
  'CONTENT_VERSION_MISMATCH',
  'HUNT_FAULTED',
  'RULE_VIOLATION',
  'RATE_LIMITED',
  'INTERNAL',
  'MAINTENANCE',
  'STALE_GENERATION',
  'PROTOCOL',
  'BACKPRESSURE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * The status each code answers with. The three socket-only codes map to `null`:
 * they close a connection and never travel over HTTP, and giving them a status
 * would invite exactly that.
 */
const HTTP_STATUS: Record<ErrorCode, number | null> = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN_ORIGIN: 403,
  NOT_OWNED: 403,
  NOT_FOUND: 404,
  EMAIL_TAKEN: 409,
  CONFLICT_STATE_VERSION: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  CONTENT_VERSION_MISMATCH: 409,
  HUNT_FAULTED: 409,
  RULE_VIOLATION: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  MAINTENANCE: 503,
  STALE_GENERATION: null,
  PROTOCOL: null,
  BACKPRESSURE: null,
};

export function httpStatusFor(code: ErrorCode): number | null {
  return HTTP_STATUS[code];
}

export function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value);
}

export const errorCodeSchema = z.enum(ERROR_CODES);

/**
 * `field` is a bounded diagnostic path in the style of `SimError.field`
 * (contracts §3), never a serialized state and never a sentence: the 120
 * characters below fit any path this protocol can produce and refuse a payload
 * that someone tried to smuggle through the diagnostic.
 */
export const DIAGNOSTIC_FIELD_MAX = 120;

export const errorEnvelopeSchema = z
  .object({
    code: errorCodeSchema,
    field: z.string().max(DIAGNOSTIC_FIELD_MAX),
    retryable: z.boolean(),
    stateVersion: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
