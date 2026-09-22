/**
 * Registration, login and the rules layer-1 §8.3 fixes around them: argon2id
 * hashes that never leak, a login that rotates the session, an
 * indistinguishable credential failure, and rate limits that refuse rather
 * than degrade (P-06, P-09, P-13).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { harness, ORIGIN, sessionCookie, type Harness } from './helpers';

let h: Harness;
const PASSWORD = 'a-sufficiently-long-password';

beforeEach(async () => {
  h = await harness();
});

afterEach(async () => {
  await h.app.close();
});

async function register(email = 'player@example.com', password = PASSWORD) {
  return h.app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: ORIGIN }, payload: { email, password } });
}

async function login(email = 'player@example.com', password = PASSWORD) {
  return h.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email, password } });
}

describe('registration', () => {
  test('creates an account and returns its summary, never its hash', async () => {
    const response = await register();
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.email).toBe('player@example.com');
    expect(JSON.stringify(body)).not.toContain(PASSWORD);
    expect(JSON.stringify(body)).not.toMatch(/\$argon2/);
  });

  test('a second registration of the same email is EMAIL_TAKEN, case-insensitively', async () => {
    await register();
    const again = await register('PLAYER@example.com');
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('EMAIL_TAKEN');
  });

  test('a short password is a validation failure naming the field', async () => {
    const response = await register('new@example.com', 'short');
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION', field: 'password' });
  });
});

describe('login', () => {
  test('answers 204 and sets the session cookie', async () => {
    await register();
    const response = await login();
    expect(response.statusCode).toBe(204);
    expect(sessionCookie(response.headers['set-cookie'])).toMatch(/^narok_session=.+/);
  });

  test('P-09: login rotates the session and invalidates the credential presented with it', async () => {
    await register();
    const first = sessionCookie((await login()).headers['set-cookie']);

    const second = sessionCookie((await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN, cookie: first },
      payload: { email: 'player@example.com', password: PASSWORD },
    })).headers['set-cookie']);

    expect(second).not.toBe(first);
    const withOld = await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: first } });
    expect(withOld.statusCode).toBe(401);
    const withNew = await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: second } });
    expect(withNew.statusCode).toBe(200);
  });

  test('INVALID_CREDENTIALS never distinguishes an unknown email from a wrong password', async () => {
    await register();
    const unknownEmail = await login('nobody@example.com', PASSWORD);
    const wrongPassword = await login('player@example.com', 'the-wrong-password-entirely');

    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.json()).toEqual(wrongPassword.json());
  });
});

describe('P-06: no password and no hash is ever written out', () => {
  test('neither appears in any log line or audit row across register, login and reset', async () => {
    const lines: string[] = [];
    const logged = await harness({}, { onLog: (line) => lines.push(line) });
    try {
      await logged.app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: ORIGIN }, payload: { email: 'p@example.com', password: PASSWORD } });
      await logged.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: 'p@example.com', password: PASSWORD } });

      const account = logged.stores.accounts.byEmail('p@example.com');
      expect(account).not.toBeUndefined();
      await logged.stores.accounts.resetPassword(account!.id, 'another-long-password-here');

      const captured = [...lines, ...logged.stores.audit.rows().map((row) => JSON.stringify(row))].join('\n');
      expect(captured).not.toContain(PASSWORD);
      expect(captured).not.toContain('another-long-password-here');
      expect(captured).not.toMatch(/\$argon2/);
      expect(captured).not.toContain(account!.passwordHash);
    } finally {
      await logged.app.close();
    }
  });
});

describe('P-13: rate limits refuse rather than degrade', () => {
  test('login attempts past the configured limit answer RATE_LIMITED with Retry-After', async () => {
    const limited = await harness({ rateLimits: { auth: { limit: 3, windowMs: 60_000 }, command: { limit: 100, windowMs: 60_000 } } });
    try {
      await limited.app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: ORIGIN }, payload: { email: 'p@example.com', password: PASSWORD } });

      const codes: number[] = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await limited.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.7' },
          payload: { email: 'p@example.com', password: 'wrong-password-here-ok' },
        });
        codes.push(response.statusCode);
        if (response.statusCode === 429) {
          expect(response.json().code).toBe('RATE_LIMITED');
          expect(response.headers['retry-after']).toBeDefined();
        }
      }
      expect(codes).toContain(429);
    } finally {
      await limited.app.close();
    }
  });
});
