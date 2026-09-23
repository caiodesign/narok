/**
 * Registration, login and logout (layer-1 §8.3, P-06, P-09, P-13).
 *
 * The two rules worth stating in code rather than only in a test:
 *
 * - **Login rotates.** A successful login always issues a new session and
 *   revokes the one presented with the request, so a credential that was ever
 *   observed in flight stops working the moment its owner logs in again.
 * - **Failure is indistinguishable.** An unknown email and a wrong password
 *   take the same path, do the same work and produce the same body. An unknown
 *   email is verified against a decoy hash so the timing does not answer the
 *   question the response refuses to.
 *
 * The decoy is built once when the routes are registered. Building it lazily
 * inside the handler defeated the point: the first unknown email paid a hashing
 * cost no later one paid, which is precisely the signal the decoy exists to
 * suppress. It is per app rather than module-level for the same reason — one
 * instance must not answer faster because another already warmed it.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loginRequestSchema, registerRequestSchema } from '@narok/protocol';
import { AppError } from '../errors';
import { cookieOptions, issueSession, SESSION_COOKIE } from '../auth/sessions';
import { requireSession } from '../plugins/session';
import { sourceKey } from '../plugins/rate-limit';
import type { RouteContext } from './context';

export function registerAuthRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { stores, config, hasher, now, limiters, parse } = ctx;

  /**
   * A hash of a value nobody holds, computed now so every login verifies
   * exactly once against a real hash whether or not the account exists.
   */
  const decoy = hasher.hash(randomBytes(32).toString('base64url')).then((hashed) => hashed.hash);

  app.post('/api/auth/register', async (request, reply) => {
    limiters.auth.check(sourceKey(request.headers, request.ip), now());
    const body = parse(registerRequestSchema, request.body);

    if ((await stores.accounts.byEmail(body.email)) !== undefined) {
      throw new AppError('EMAIL_TAKEN', 'email');
    }

    const hashed = await hasher.hash(body.password);
    const account = await stores.accounts.create(body.email, hashed.hash, hashed.algorithm);

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

    const account = await stores.accounts.byEmail(body.email);
    const ok = await hasher.verify(account?.passwordHash ?? (await decoy), body.password);
    if (!ok || account === undefined) throw new AppError('INVALID_CREDENTIALS', 'credentials');

    // P-09: rotate. The credential presented with this request dies here.
    const presented = (request as typeof request & { cookies?: Record<string, string | undefined> }).cookies?.[SESSION_COOKIE];
    if (presented !== undefined) {
      const existing = await stores.sessions.byTokenHash(ctx.hashToken(presented));
      if (existing !== undefined) await stores.sessions.revoke(existing.id, now());
    }

    const issued = await issueSession(stores.sessions, account.id, config, now());
    return reply
      .setCookie(SESSION_COOKIE, issued.token, cookieOptions(config, now()))
      .code(204)
      .send();
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const caller = await requireSession(request, stores, config, now());
    await stores.sessions.revoke(caller.session.id, now());
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204).send();
  });
}
