/**
 * Everything that leaves the server as a failure goes through here.
 *
 * Two rules from milestone B spec part 1 §7, both testable:
 *
 * - The emitted set is a subset of the taxonomy (P-39). `AppError` cannot be
 *   constructed with anything else, because its code is typed `ErrorCode`.
 * - A simulation error is *mapped*, never forwarded. `WRONG_VERSION` becomes
 *   `CONTENT_VERSION_MISMATCH` — the one distinction a client can act on — and
 *   every other `SimErrorCode` becomes `INTERNAL` with the detail kept for the
 *   fault bundle (part 1 §9 #14). The engine's vocabulary is an internal
 *   diagnostic and stays internal.
 */
import { httpStatusFor, type ErrorCode, type ErrorEnvelope } from '@narok/protocol';
import { SimError } from '@narok/sim';

/** Codes the client may sensibly retry, possibly after a refetch. */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'CONFLICT_STATE_VERSION',
  'CONTENT_VERSION_MISMATCH',
  'RATE_LIMITED',
  'INTERNAL',
  'MAINTENANCE',
  'BACKPRESSURE',
]);

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly field: string;
  readonly stateVersion?: number;

  constructor(code: ErrorCode, field: string, stateVersion?: number) {
    // The message is for a server log, never for a response body.
    super(`${code}:${field}`);
    this.name = 'AppError';
    this.code = code;
    this.field = field;
    this.stateVersion = stateVersion;
  }

  get status(): number {
    return httpStatusFor(this.code) ?? 500;
  }

  toEnvelope(): ErrorEnvelope {
    const envelope: ErrorEnvelope = {
      code: this.code,
      field: this.field,
      retryable: RETRYABLE.has(this.code),
    };
    return this.stateVersion === undefined ? envelope : { ...envelope, stateVersion: this.stateVersion };
  }
}

/**
 * The single translation point from any thrown value to what a client sees.
 * `field` falls back to the caller's bounded label, so an unclassified failure
 * still says *where* without saying what.
 */
export function toEnvelope(error: unknown, field = '$'): ErrorEnvelope {
  if (error instanceof AppError) return error.toEnvelope();

  if (error instanceof SimError) {
    const code: ErrorCode = error.code === 'WRONG_VERSION' ? 'CONTENT_VERSION_MISMATCH' : 'INTERNAL';
    // A mapped simulation error keeps the engine's field path only when the
    // client can act on it; an INTERNAL says nothing about the engine at all.
    const safeField = code === 'CONTENT_VERSION_MISMATCH' ? error.field : field;
    return { code, field: safeField, retryable: RETRYABLE.has(code) };
  }

  return { code: 'INTERNAL', field, retryable: true };
}

export function validation(field: string): AppError {
  return new AppError('VALIDATION', field);
}

export function unauthenticated(field = 'session'): AppError {
  return new AppError('UNAUTHENTICATED', field);
}

/**
 * Ownership and absence answer identically (P-12): the body must distinguish
 * nothing about whether the object exists, so both go through this one call.
 */
export function notOwned(field: string): AppError {
  return new AppError('NOT_OWNED', field);
}
