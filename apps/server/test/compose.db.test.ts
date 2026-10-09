/**
 * What the environment selects (compose.ts). The in-memory default is kept
 * exactly; `DATABASE_URL` switches accounts and sessions to PostgreSQL and
 * serves `/ws` from real hunts instead of MAINTENANCE.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createApp } from '../src/app';
import { compose, configFromEnvironment } from '../src/compose';
import { LifecycleFeed } from '../src/hunt/feed';
import { sessionCookie } from './helpers';
import { connect, DATABASE_URL, databaseReachable, disconnect, truncateAll, type Db } from './db-helpers';

let db: Db;

beforeAll(async () => {
  expect(await databaseReachable(), 'PostgreSQL must be running: pnpm db:up').toBe(true);
  db = await connect();
});

afterAll(async () => {
  await disconnect();
});

beforeEach(async () => {
  await truncateAll(db);
});

describe('compose', () => {
  test('without a database it is the in-memory server, with no hunt feed', async () => {
    const composed = compose({});
    expect(composed.deps.huntFeed).toBeUndefined();
    expect(composed.deps.stores).toBeUndefined();
    await composed.close();
  });

  test('with a database the socket is served by the lifecycle', async () => {
    const composed = compose({ DATABASE_URL });
    try {
      expect(composed.deps.huntFeed).toBeInstanceOf(LifecycleFeed);
      expect(composed.deps.stores).toBeDefined();
    } finally {
      await composed.close();
    }
  });

  test('the database-backed app registers and authenticates for real', async () => {
    const composed = compose({ DATABASE_URL, NAROK_INSECURE_COOKIES: '1' });
    const app = await createApp(composed.deps);
    try {
      const origin = composed.deps.config!.allowedOrigins[0];
      const registered = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: { origin },
        payload: { email: 'compose@example.com', password: 'a-sufficiently-long-password' },
      });
      expect(registered.statusCode).toBeLessThan(300);

      // Without a session the upgrade is refused before the feed is reached.
      const refused = await app.inject({ method: 'GET', url: '/ws', headers: { origin } });
      expect(refused.statusCode).toBe(401);

      // With one, a plain GET reaches the real socket route, which asks for an
      // upgrade — where the unwired server would have answered MAINTENANCE.
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin },
        payload: { email: 'compose@example.com', password: 'a-sufficiently-long-password' },
      });
      const cookie = sessionCookie(login.headers['set-cookie']);
      const plain = await app.inject({ method: 'GET', url: '/ws', headers: { origin, cookie } });
      // The whole envelope, not just the code: a regression once left every
      // route answering in Fastify's own error shape once the socket was wired.
      expect(plain.json()).toEqual({ code: 'VALIDATION', field: expect.any(String), retryable: false });
    } finally {
      await app.close();
      await composed.close();
    }
  });

  test('environment parsing is unchanged from the old main.ts', () => {
    const config = configFromEnvironment({ NAROK_ALLOWED_ORIGINS: 'https://a.example, https://b.example' });
    expect(config.allowedOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(config.secureCookies).toBe(true);
    expect(configFromEnvironment({ NAROK_INSECURE_COOKIES: '1' }).secureCookies).toBe(false);
    expect(config.trustProxy, 'X-Forwarded-For is ignored unless a proxy is declared (D-02)').toBe(false);
    expect(configFromEnvironment({ NAROK_TRUST_PROXY: '1' }).trustProxy).toBe(true);
  });
});
