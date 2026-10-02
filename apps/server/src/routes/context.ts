/**
 * What every route is handed. Nothing reads process state or wall time
 * directly: the clock is injected so session-expiry tests need no sleeps, and
 * the stores are ports so task 2 can swap in Drizzle underneath.
 */
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { ServerConfig } from '../config';
import type { Hasher } from '../auth/password';
import type { Limiter } from '../plugins/rate-limit';
import { requireSession, type Caller } from '../plugins/session';
import type { Stores } from '../store/ports';

export interface RouteContext {
  readonly stores: Stores;
  readonly config: ServerConfig;
  readonly hasher: Hasher;
  readonly now: () => number;
  readonly limiters: { readonly auth: Limiter; readonly command: Limiter };
  readonly hashToken: (token: string) => string;
  /**
   * Validates at the boundary and translates a rejection into `VALIDATION`
   * with a bounded field path — never a zod message, which would be display
   * text the client is supposed to localize itself (part 1 §3).
   */
  readonly parse: <T extends z.ZodType>(schema: T, value: unknown) => z.infer<T>;
}

/**
 * The caller of a gameplay command (P-13: "gameplay commands are rate-limited
 * per account"; final review I2): the session is resolved first — an
 * anonymous request is `UNAUTHENTICATED`, never charged — then the account is
 * charged one unit of `limiters.command`, the limiter configured in
 * `config.rateLimits.command`. Over its window the answer is `RATE_LIMITED`
 * with `Retry-After`, before any read, rule or write. Reads are not charged.
 */
export async function requireCommander(ctx: RouteContext, request: FastifyRequest): Promise<Caller> {
  const now = ctx.now();
  const resolved = await requireSession(request, ctx.stores, ctx.config, now);
  ctx.limiters.command.check(resolved.account.id, now);
  return resolved;
}
