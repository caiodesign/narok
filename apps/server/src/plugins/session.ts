/**
 * Session resolution as a request decoration (P-07, P-11).
 *
 * `requireSession` is the only way a route learns who is calling. It reads the
 * cookie and nothing else: a token presented in a query string, a body, an
 * `Authorization` header or a socket subprotocol is not a session, and the
 * answer is the same `UNAUTHENTICATED` an absent one gets.
 *
 * Expiry and revocation are re-checked here on every request, so a session
 * that dies mid-flight stops working on the next call rather than at the next
 * reconnect (layer-1 §8.3: authentication at upgrade is not perpetual
 * authorization).
 */
import type { FastifyRequest } from 'fastify';
import { SESSION_COOKIE, resolveSession } from '../auth/sessions';
import { unauthenticated } from '../errors';
import type { ServerConfig } from '../config';
import type { AccountRow, SessionRow, Stores } from '../store/ports';

export interface Caller {
  readonly account: AccountRow;
  readonly session: SessionRow;
}

export function readSessionCookie(request: FastifyRequest): string | undefined {
  const cookies = (request as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies;
  return cookies?.[SESSION_COOKIE];
}

export function requireSession(
  request: FastifyRequest,
  stores: Stores,
  config: ServerConfig,
  now: number,
): Caller {
  const session = resolveSession(stores.sessions, readSessionCookie(request), config, now);
  if (session === undefined) throw unauthenticated();

  const account = stores.accounts.byId(session.accountId);
  if (account === undefined) throw unauthenticated();

  // A session issued before the current password is dead even if the store
  // missed a revocation: the password change is the authority (P-10).
  if (session.createdAt < account.passwordChangedAt) throw unauthenticated();

  return { account, session };
}
