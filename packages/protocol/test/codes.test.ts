/**
 * The error taxonomy is bounded on purpose (part 1 §7, P-39): the client
 * localizes from a stable code, so a code the table does not list is a code
 * nobody can translate. These tests are the enumeration's fence.
 */
import { describe, expect, test } from 'vitest';
import { ERROR_CODES, errorEnvelopeSchema, httpStatusFor, isErrorCode } from '../src/codes';

/** Transcribed from the milestone B spec, part 1 §7. Order is the table's. */
const TABLE = [
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

describe('the error taxonomy', () => {
  test('exports exactly the part 1 §7 table, with nothing added and nothing missing', () => {
    expect([...ERROR_CODES].sort()).toEqual([...TABLE].sort());
  });

  test('every HTTP code maps to the status the table names', () => {
    expect(httpStatusFor('VALIDATION')).toBe(400);
    expect(httpStatusFor('UNAUTHENTICATED')).toBe(401);
    expect(httpStatusFor('INVALID_CREDENTIALS')).toBe(401);
    expect(httpStatusFor('FORBIDDEN_ORIGIN')).toBe(403);
    expect(httpStatusFor('NOT_OWNED')).toBe(403);
    expect(httpStatusFor('NOT_FOUND')).toBe(404);
    expect(httpStatusFor('EMAIL_TAKEN')).toBe(409);
    expect(httpStatusFor('CONFLICT_STATE_VERSION')).toBe(409);
    expect(httpStatusFor('IDEMPOTENCY_KEY_REUSED')).toBe(409);
    expect(httpStatusFor('CONTENT_VERSION_MISMATCH')).toBe(409);
    expect(httpStatusFor('HUNT_FAULTED')).toBe(409);
    expect(httpStatusFor('RULE_VIOLATION')).toBe(422);
    expect(httpStatusFor('RATE_LIMITED')).toBe(429);
    expect(httpStatusFor('INTERNAL')).toBe(500);
    expect(httpStatusFor('MAINTENANCE')).toBe(503);
  });

  test('the three socket-only codes have no HTTP status at all', () => {
    expect(httpStatusFor('STALE_GENERATION')).toBeNull();
    expect(httpStatusFor('PROTOCOL')).toBeNull();
    expect(httpStatusFor('BACKPRESSURE')).toBeNull();
  });

  test('a code outside the table is not a code', () => {
    expect(isErrorCode('VALIDATION')).toBe(true);
    // Real `SimErrorCode` members (contracts §3). They are internal diagnostics
    // and must never reach a client as themselves.
    expect(isErrorCode('INVALID_STATE')).toBe(false);
    expect(isErrorCode('LOOP_DETECTED')).toBe(false);
    expect(isErrorCode('WRONG_VERSION')).toBe(false);
    expect(isErrorCode('')).toBe(false);
  });
});

describe('the error envelope', () => {
  test('carries the four fields of part 1 §3 and rejects anything else', () => {
    const parsed = errorEnvelopeSchema.parse({
      code: 'RULE_VIOLATION',
      field: 'placement.p0',
      retryable: false,
      stateVersion: 12,
    });
    expect(parsed.code).toBe('RULE_VIOLATION');
    expect(parsed.stateVersion).toBe(12);

    expect(errorEnvelopeSchema.safeParse({ code: 'VALIDATION', field: 'seed', retryable: false }).success).toBe(true);
  });

  test('refuses an unknown key rather than dropping it', () => {
    const result = errorEnvelopeSchema.safeParse({
      code: 'VALIDATION',
      field: 'seed',
      retryable: false,
      message: 'Seed must be an integer',
    });
    expect(result.success).toBe(false);
  });

  test('refuses a code outside the taxonomy', () => {
    expect(errorEnvelopeSchema.safeParse({ code: 'TEAPOT', field: '$', retryable: false }).success).toBe(false);
  });

  test('the field is a bounded diagnostic path, never a serialized state', () => {
    const serialized = JSON.stringify({ actors: Array.from({ length: 50 }, (_, i) => ({ id: `p${i}` })) });
    expect(errorEnvelopeSchema.safeParse({ code: 'INTERNAL', field: serialized, retryable: true }).success).toBe(false);
  });
});
