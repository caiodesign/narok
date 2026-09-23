/**
 * Sessions (layer-1 §8.3, P-07, P-09, P-10, P-11).
 *
 * The credential is an opaque 256-bit random token, stored only as a SHA-256
 * hash, carried only in an `httpOnly; Secure; SameSite=Lax` cookie. Part 1 §9
 * #1 weighs this against a JWT and lands here because §8.3 requires revocation
 * to take effect immediately, and a self-describing token cannot be revoked
 * without the lookup a JWT exists to avoid.
 *
 * Two lifetimes, both checked on every request rather than only at upgrade:
 * an absolute one a session cannot outlive however active it is, and an idle
 * one a request or a heartbeat refreshes.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { ServerConfig } from '../config';
import type { SessionRow, SessionStore } from '../store/ports';

export const SESSION_COOKIE = 'narok_session';

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionIssue {
  readonly token: string;
  readonly row: SessionRow;
}

export function issueSession(
  sessions: SessionStore,
  accountId: string,
  config: ServerConfig,
  now: number,
): SessionIssue {
  const token = newSessionToken();
  const expiresAt = now + Math.min(config.session.absoluteMs, config.session.idleMs);
  return { token, row: sessions.create(accountId, hashToken(token), now, expiresAt) };
}

/**
 * Resolves a presented token to a live session, refreshing its idle window.
 *
 * Returns `undefined` for absent, unknown, revoked and expired alike: a caller
 * answering `UNAUTHENTICATED` must not be able to tell those apart, or the
 * response becomes an oracle for which tokens once existed.
 */
export function resolveSession(
  sessions: SessionStore,
  token: string | undefined,
  config: ServerConfig,
  now: number,
): SessionRow | undefined {
  if (token === undefined || token === '') return undefined;

  const row = sessions.byTokenHash(hashToken(token));
  if (row === undefined) return undefined;
  if (row.revokedAt !== null) return undefined;
  if (row.expiresAt <= now) return undefined;
  // The absolute lifetime is not refreshable; the idle one is (P-11).
  if (now - row.createdAt >= config.session.absoluteMs) return undefined;

  const idleExpiry = now + config.session.idleMs;
  const absoluteExpiry = row.createdAt + config.session.absoluteMs;
  sessions.touch(row.id, now, Math.min(idleExpiry, absoluteExpiry));
  return row;
}

export function cookieOptions(config: ServerConfig, now: number) {
  return {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax' as const,
    path: '/',
    expires: new Date(now + Math.min(config.session.absoluteMs, config.session.idleMs)),
  };
}
