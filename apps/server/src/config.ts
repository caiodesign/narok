/**
 * Every operational bound of milestone B spec part 1 §8 is configuration, is
 * logged at startup, and has a test that drives the system past it and asserts
 * the documented refusal rather than degradation (P-40).
 *
 * The values below are **proposed defaults**, not measurements. Part 1 §9 #7
 * is explicit that the real numbers come from the VPS load exercise, which is
 * an open gate (milestone A results §6.5). Nothing here may be quoted as a
 * measured capacity.
 */

export interface RateLimit {
  readonly limit: number;
  readonly windowMs: number;
}

export interface ServerConfig {
  /** Exactly the origins that may mutate or open a socket (P-08). */
  readonly allowedOrigins: readonly string[];
  /**
   * argon2id cost. Part 1 §9 #2: choose by measuring verification latency on
   * the target VPS under the login rate limit. These are library-shaped
   * starting points, deliberately not presented as tuned.
   */
  readonly argon2: { readonly memoryCost: number; readonly timeCost: number; readonly parallelism: number };
  readonly session: {
    /** Hard lifetime; a session dies at this age however active it was. */
    readonly absoluteMs: number;
    /** Idle lifetime, refreshed by a request or a heartbeat. */
    readonly idleMs: number;
  };
  readonly rateLimits: { readonly auth: RateLimit; readonly command: RateLimit };
  readonly bounds: {
    readonly requestBodyBytes: number;
    readonly socketMessageBytes: number;
    readonly socketsPerAccount: number;
    readonly unackedEventsPerSocket: number;
  };
  /** Prices are deferred (spec §4.0), so the shop answers MAINTENANCE. */
  readonly features: { readonly shop: boolean };
  /** Whether the session cookie is marked `Secure`; false only for plain-HTTP local runs. */
  readonly secureCookies: boolean;
  /**
   * Whether a reverse proxy we run sits in front and appends the client's
   * address to `X-Forwarded-For` (provisional decision D-02). Off, the header
   * is ignored: any client could write it.
   */
  readonly trustProxy: boolean;
}

export function defaultConfig(): ServerConfig {
  return {
    allowedOrigins: ['http://localhost:4173'],
    argon2: { memoryCost: 19456, timeCost: 2, parallelism: 1 },
    session: { absoluteMs: 30 * 24 * 60 * 60 * 1000, idleMs: 7 * 24 * 60 * 60 * 1000 },
    rateLimits: {
      auth: { limit: 10, windowMs: 15 * 60 * 1000 },
      command: { limit: 240, windowMs: 60 * 1000 },
    },
    bounds: {
      requestBodyBytes: 64 * 1024,
      socketMessageBytes: 8 * 1024,
      socketsPerAccount: 4,
      unackedEventsPerSocket: 2000,
    },
    features: { shop: false },
    secureCookies: true,
    trustProxy: false,
  };
}

/** The startup line. Every bound is visible, no secret is (P-40, P-35). */
export function describeConfig(config: ServerConfig): string {
  return JSON.stringify({
    allowedOrigins: config.allowedOrigins,
    argon2: config.argon2,
    session: config.session,
    rateLimits: config.rateLimits,
    bounds: config.bounds,
    features: config.features,
  });
}
