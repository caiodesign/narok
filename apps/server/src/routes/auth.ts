/**
 * Registration, login and logout (layer-1 §8.3, P-06, P-09, P-13).
 *
 * The two rules worth stating in code rather than only in a test:
 *
 * - **Login rotates.** A successful login always issues a new session and
 *   revokes the one presented with the request, so a credential that was ever
 *   observed in flight stops working the moment its owner logs in again.
 * - **Failure is indistinguishable.** An unknown email and a wrong password
 *   take the same path, do the same work and produce the same body. The verify
 *   call runs against a decoy hash for an unknown email so the timing does not
 *   answer the question the response refuses to.
 */
import type { FastifyInstance } from 'fastify';
import { loginRequestSchema, registerRequestSchema } from '@narok/protocol';
import { AppError } from '../errors';
import { cookieOptions, issueSession, SESSION_COOKIE } from '../auth/sessions';
import { requireSession } from '../plugins/session';
import { sourceKey } from '../plugins/rate-limit';
import type { RouteContext } from './context';

/** A real argon2id hash of a value no one holds, for the unknown-email path. */
let decoyHash: string | undefined;

export function registerAuthRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { stores, config, hasher, now, limiters, parse } = ctx;

  app.post('/api/auth/register', async (request, reply) => {
    limiters.auth.check(sourceKey(request.headers, request.ip), now());
    const body = parse(registerRequestSchema, request.body);

    if (stores.accounts.byEmail(body.email) !== undefined) {
      throw new AppError('EMAIL_TAKEN', 'email');
    }

    const hashed = await hasher.hash(body.password);
    const account = stores.accounts.create(body.email, hashed.hash, hashed.algorithm);

    return reply.code(200).send({
      id: account.id,
      email: account.email,
      stateVersion: account.stateVersion,
      createdAt: account.createdAt,
    });
  });

  app.post('/api/auth/login', async (request, reply) => {
    limiters.auth.check(sourceKey(request.headers, request.ip), now());
    const body = parse(loginRequestSchema, request.body);

    const account = stores.accounts.byEmail(body.email);
    if (decoyHash === undefined) decoyHash = (await hasher.hash('decoy-password-never-used')).hash;

    const ok = await hasher.verify(account?.passwordHash ?? decoyHash, body.password);
    if (!ok || account === undefined) throw new AppError('INVALID_CREDENTIALS', 'credentials');

    // P-09: rotate. The credential presented with this request dies here.
    const presented = (request as typeof request & { cookies?: Record<string, string | undefined> }).cookies?.[SESSION_COOKIE];
    if (presented !== undefined) {
      const existing = stores.sessions.byTokenHash(ctx.hashToken(presented));
      if (existing !== undefined) stores.sessions.revoke(existing.id, now());
    }

    const issued = issueSession(stores.sessions, account.id, config, now());
    return reply
      .setCookie(SESSION_COOKIE, issued.token, cookieOptions(config, now()))
      .code(204)
      .send();
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const caller = requireSession(request, stores, config, now());
    stores.sessions.revoke(caller.session.id, now());
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204).send();
  });
}
