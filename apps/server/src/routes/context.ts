/**
 * What every route is handed. Nothing reads process state or wall time
 * directly: the clock is injected so session-expiry tests need no sleeps, and
 * the stores are ports so task 2 can swap in Drizzle underneath.
 */
import type { z } from 'zod';
import type { ServerConfig } from '../config';
import type { Hasher } from '../auth/password';
import type { Limiter } from '../plugins/rate-limit';
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
