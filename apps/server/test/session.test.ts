/**
 * The session is a cookie and only a cookie (P-07), it carries the three
 * attributes layer-1 §8.3 fixes, it is re-checked on every request rather than
 * only at upgrade (P-11), and a password change revokes every one of them
 * (P-10).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cookieAttributes, harness, ORIGIN, sessionCookie, type Harness } from './helpers';

let h: Harness;
let cookie: string;

beforeEach(async () => {
  h = await harness();
  cookie = await h.signUp();
});

afterEach(async () => {
  await h.app.close();
});

describe('P-07: the credential travels in the cookie and nowhere else', () => {
  const value = () => cookie.slice('narok_session='.length);

  test('a session in a query string is not a session', async () => {
    const response = await h.app.inject({ method: 'GET', url: `/api/me?session=${value()}` });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('UNAUTHENTICATED');
  });

  test('a session in a body is not a session', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { origin: ORIGIN },
      payload: { session: value() },
    });
    expect(response.statusCode).toBe(401);
  });

  test('a session in an Authorization header is not a session', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${value()}` } });
    expect(response.statusCode).toBe(401);
  });

  test('a session in a WebSocket subprotocol is not a session', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: '/ws',
      headers: {
        origin: ORIGIN,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-protocol': `narok, ${value()}`,
      },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('the cookie attributes layer-1 §8.3 fixes', () => {
  test('httpOnly, Secure and SameSite=Lax', async () => {
    const attributes = cookieAttributes(
      (await h.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: 'player@example.com', password: 'a-sufficiently-long-password' } })).headers['set-cookie'],
    );
    expect(attributes).toMatch(/HttpOnly/i);
    expect(attributes).toMatch(/Secure/i);
    expect(attributes).toMatch(/SameSite=Lax/i);
  });
});

describe('P-11: authentication at upgrade is not perpetual authorization', () => {
  test('a revoked session stops working on the very next request', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);

    const account = h.stores.accounts.byEmail('player@example.com');
    h.stores.sessions.revokeAllFor(account!.id);

    const after = await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
    expect(after.json().code).toBe('UNAUTHENTICATED');
  });

  test('an expired session is refused even though it was valid when issued', async () => {
    const clock = { now: Date.now() };
    const expiring = await harness({ session: { absoluteMs: 1_000, idleMs: 1_000 } }, { now: () => clock.now });
    try {
      const live = sessionCookie((await (async () => {
        await expiring.app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: ORIGIN }, payload: { email: 'p@example.com', password: 'a-sufficiently-long-password' } });
        return expiring.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: 'p@example.com', password: 'a-sufficiently-long-password' } });
      })()).headers['set-cookie']);

      expect((await expiring.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: live } })).statusCode).toBe(200);
      clock.now += 5_000;
      expect((await expiring.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: live } })).statusCode).toBe(401);
    } finally {
      await expiring.app.close();
    }
  });
});

describe('P-10: a password change revokes every session', () => {
  test('all of them, not just the one that changed it', async () => {
    const second = await h.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: 'player@example.com', password: 'a-sufficiently-long-password' } });
    const other = sessionCookie(second.headers['set-cookie']);

    const account = h.stores.accounts.byEmail('player@example.com');
    await h.stores.accounts.resetPassword(account!.id, 'a-brand-new-long-password');

    for (const value of [cookie, other]) {
      const response = await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: value } });
      expect(response.statusCode).toBe(401);
    }
  });
});

describe('logout', () => {
  test('revokes only the session that presented it', async () => {
    const other = sessionCookie((await h.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: 'player@example.com', password: 'a-sufficiently-long-password' } })).headers['set-cookie']);

    expect((await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: ORIGIN, cookie: other } })).statusCode).toBe(204);
    expect((await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: other } })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
  });
});
