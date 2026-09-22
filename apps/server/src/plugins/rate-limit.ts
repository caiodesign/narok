/**
 * P-13 and P-40: credential attempts are limited per source, gameplay commands
 * per account, and passing a bound produces the documented refusal —
 * `RATE_LIMITED` with `Retry-After` — rather than a slower or partial service.
 *
 * A fixed window in memory. Part 1 §9 #7 is explicit that the real values come
 * from the VPS load exercise, which is an open gate, so what matters here is
 * that the refusal exists, is tested, and is configuration.
 */
import { AppError } from '../errors';
import type { RateLimit } from '../config';

export interface Limiter {
  /** Throws `RATE_LIMITED` when the key has spent its window. */
  check(key: string, now: number): void;
}

export function fixedWindow(limit: RateLimit): Limiter {
  const windows = new Map<string, { count: number; resetAt: number }>();

  return {
    check(key, now) {
      const existing = windows.get(key);
      if (existing === undefined || existing.resetAt <= now) {
        windows.set(key, { count: 1, resetAt: now + limit.windowMs });
        return;
      }
      existing.count += 1;
      if (existing.count > limit.limit) {
        const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
        const error = new AppError('RATE_LIMITED', 'rate');
        // Carried on the error so the reply can set the header the spec names.
        (error as AppError & { retryAfter?: number }).retryAfter = retryAfter;
        throw error;
      }
    },
  };
}

/** The source a credential attempt is charged to. */
export function sourceKey(headers: Record<string, unknown>, fallback: string): string {
  const forwarded = headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
  return fallback;
}
