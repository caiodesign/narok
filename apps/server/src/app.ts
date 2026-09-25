/**
 * The Fastify application factory (milestone B spec part 1 §1).
 *
 * It takes its ports and its configuration and reads no process state at
 * import time, so a test builds one per case and task 2 substitutes the
 * Drizzle adapter without touching a line of task 1's tests.
 *
 * The hook order below is the contract, not a convenience:
 *
 *   1. origin guard — before body parsing and before any session lookup, so a
 *      cross-site caller cannot use the response as an existence oracle (P-08);
 *   2. cookie parsing — the session travels nowhere else (P-07);
 *   3. the route, which resolves the caller, checks ownership, then validates.
 *
 * Every failure leaves through one error handler, which is what makes P-39
 * — "no code outside the table reaches a client" — a property of the server
 * rather than of each route's discipline.
 */
import { registerHuntRoutes, type HuntServices } from './routes/hunts';
import { registerReportRoutes } from './routes/reports';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, toEnvelope } from './errors';
import { argon2Hasher, type Hasher } from './auth/password';
import { hashToken } from './auth/sessions';
import { defaultConfig, describeConfig, type ServerConfig } from './config';
import { fixedWindow } from './plugins/rate-limit';
import { registerOriginGuard } from './plugins/origin';
import { requireSession } from './plugins/session';
import { registerAuthRoutes } from './routes/auth';
import { registerAccountRoutes } from './routes/me';
import { registerSocket, type HuntFeed } from './ws/socket';
import { memoryStores } from './store/memory';
import type { RouteContext } from './routes/context';
import type { Stores } from './store/ports';

export interface AppDeps {
  readonly config?: ServerConfig;
  readonly stores?: Stores;
  readonly hasher?: Hasher;
  /** Injected so session-expiry behaviour is testable without sleeping. */
  readonly now?: () => number;
  /** Captures the startup line and every request log, for the P-06 test. */
  readonly onLog?: (line: string) => void;
  /**
   * The hunt lifecycle as the socket sees it. Absent until the lifecycle is
   * wired, in which case `/ws` keeps its task 1 refusals and answers
   * MAINTENANCE past them.
   */
  readonly huntFeed?: HuntFeed;
  /**
   * The lifecycle behind the hunt routes. Absent, `POST /api/hunts` keeps its
   * task 1 stub, which validates and refuses.
   */
  readonly hunts?: HuntServices;
}

/**
 * Turns a zod rejection into `VALIDATION` naming the first failing path.
 * The message never travels: the client localizes from the code (part 1 §3).
 */
function makeParse(): RouteContext['parse'] {
  return <T extends z.ZodType>(schema: T, value: unknown): z.infer<T> => {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    const issue = result.error.issues[0];
    const path = issue?.path.join('.') ?? '$';
    throw new AppError('VALIDATION', path === '' ? '$' : path);
  };
}

export async function createApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  const config = deps.config ?? defaultConfig();
  const stores = deps.stores ?? memoryStores();
  const hasher = deps.hasher ?? argon2Hasher(config.argon2);
  const now = deps.now ?? (() => Date.now());

  const app = Fastify({
    logger: false,
    bodyLimit: config.bounds.requestBodyBytes,
  });

  // P-40: every bound is logged at startup, and no secret is (P-35).
  deps.onLog?.(`narok-server config ${describeConfig(config)}`);

  registerOriginGuard(app, config);
  await app.register(cookie);

  // Installed before any route. Fastify binds a route to the error handler in
  // force when the route is loaded, and an awaited plugin registration (the
  // socket's) loads every route declared so far — so a handler set after it
  // silently misses them all and they answer in Fastify's shape, not ours.
  app.setNotFoundHandler(async (_request, reply) => {
    const error = new AppError('NOT_FOUND', 'route');
    return reply.code(error.status).send(error.toEnvelope());
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof AppError) {
      if (error.retryAfter !== undefined) void reply.header('Retry-After', String(error.retryAfter));
      return reply.code(error.status).send(error.toEnvelope());
    }

    // A body that exceeded the configured bound is a refusal, not a 500.
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 413) {
      const bounded = new AppError('VALIDATION', 'body');
      return reply.code(bounded.status).send(bounded.toEnvelope());
    }
    if (statusCode === 400) {
      const malformed = new AppError('VALIDATION', 'body');
      return reply.code(malformed.status).send(malformed.toEnvelope());
    }

    deps.onLog?.(`unhandled ${request.method} ${request.url}`);
    const envelope = toEnvelope(error, 'request');
    return reply.code(500).send(envelope);
  });

  const ctx: RouteContext = {
    stores,
    config,
    hasher,
    now,
    hashToken,
    limiters: { auth: fixedWindow(config.rateLimits.auth), command: fixedWindow(config.rateLimits.command) },
    parse: makeParse(),
  };

  registerAuthRoutes(app, ctx);
  registerAccountRoutes(app, ctx, { huntsWired: deps.hunts !== undefined });
  if (deps.hunts !== undefined) {
    registerHuntRoutes(app, ctx, deps.hunts);
    registerReportRoutes(app, ctx, deps.hunts.lifecycle.db);
  }

  /**
   * The socket endpoint's *refusals* are decided here with everything else: a
   * foreign origin never reaches it, and a caller without a live session is
   * `UNAUTHENTICATED` rather than upgraded. Without a hunt feed there is no
   * protocol to speak, so a call that passes both checks is told plainly that
   * there is nothing to upgrade to.
   */
  if (deps.huntFeed === undefined) {
    app.get('/ws', async (request) => {
      await requireSession(request, stores, config, now());
      // Not a fault: the endpoint exists and is not serving. INTERNAL would
      // have put a known-absent feature into the fault metrics of P-41.
      throw new AppError('MAINTENANCE', 'ws');
    });
  } else {
    await registerSocket(app, ctx, deps.huntFeed);
  }


  await app.ready();
  return app;
}
