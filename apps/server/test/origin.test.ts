/**
 * P-08: every mutating request and every socket upgrade is rejected unless its
 * `Origin` is on the allowlist, and the rejection happens *before* any session
 * lookup — a cross-site request must not even be able to measure whether a
 * session exists.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { harness, ORIGIN, type Harness } from './helpers';

let h: Harness;
let cookie: string;

beforeEach(async () => {
  h = await harness();
  cookie = await h.signUp();
});

afterEach(async () => {
  await h.app.close();
});

const FOREIGN = 'https://evil.example.com';

describe('mutations', () => {
  test('an allowed origin passes', async () => {
    const response = await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: ORIGIN, cookie } });
    expect(response.statusCode).toBe(204);
  });

  test('a foreign origin is FORBIDDEN_ORIGIN', async () => {
    const response = await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: FOREIGN, cookie } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN_ORIGIN' });
  });

  test('an absent origin on a mutation is FORBIDDEN_ORIGIN', async () => {
    const response = await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('FORBIDDEN_ORIGIN');
  });

  test('the check runs before the session lookup, so it cannot be used as an oracle', async () => {
    const withSession = await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: FOREIGN, cookie } });
    const withoutSession = await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: FOREIGN } });
    const withGarbage = await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: FOREIGN, cookie: 'narok_session=not-a-real-session' } });

    expect(withSession.statusCode).toBe(403);
    expect(withSession.json()).toEqual(withoutSession.json());
    expect(withSession.json()).toEqual(withGarbage.json());
  });

  test('a foreign origin cannot register or log in either', async () => {
    for (const url of ['/api/auth/register', '/api/auth/login']) {
      const response = await h.app.inject({ method: 'POST', url, headers: { origin: FOREIGN }, payload: { email: 'x@example.com', password: 'a-sufficiently-long-password' } });
      expect(response.statusCode, url).toBe(403);
    }
  });
});

describe('reads', () => {
  test('a read needs no origin: it mutates nothing and the cookie is SameSite=Lax', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(response.statusCode).toBe(200);
  });
});

describe('the socket upgrade', () => {
  const upgrade = (headers: Record<string, string>) =>
    h.app.inject({
      method: 'GET',
      url: '/ws',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers,
      },
    });

  test('is refused from a foreign origin before any session lookup', async () => {
    const response = await upgrade({ origin: FOREIGN, cookie });
    expect(response.statusCode).toBe(403);
  });

  test('is refused with no origin at all', async () => {
    const response = await upgrade({ cookie });
    expect(response.statusCode).toBe(403);
  });
});
