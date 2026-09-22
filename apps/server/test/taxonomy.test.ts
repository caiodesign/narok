/**
 * P-39: no code outside the part 1 §7 table reaches a client, and simulation
 * error codes are mapped rather than forwarded — `WRONG_VERSION` becomes
 * `CONTENT_VERSION_MISMATCH` because it is the one distinction a client can act
 * on, and everything else becomes `INTERNAL` plus a fault capture (part 1 §9
 * #14, taken as the recommendation).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ERROR_CODES } from '@narok/protocol';
import { SimError } from '@narok/sim';
import { toEnvelope } from '../src/errors';
import { harness, ORIGIN, type Harness } from './helpers';

let h: Harness;

beforeEach(async () => {
  h = await harness();
});

afterEach(async () => {
  await h.app.close();
});

describe('simulation errors are mapped, never forwarded', () => {
  test('WRONG_VERSION is the one a client can act on', () => {
    const envelope = toEnvelope(new SimError('WRONG_VERSION', 'state.contentVersion', 'different content'));
    expect(envelope.code).toBe('CONTENT_VERSION_MISMATCH');
    expect(envelope.retryable).toBe(true);
  });

  test.each(['INVALID_STATE', 'UNSAFE_INTEGER', 'INVALID_CONTENT', 'LOOP_DETECTED', 'TIME_REWIND'] as const)(
    '%s becomes INTERNAL and leaks no detail',
    (code) => {
      const envelope = toEnvelope(new SimError(code, 'state.actors.0.hp', 'a message naming internals'));
      expect(envelope.code).toBe('INTERNAL');
      expect(JSON.stringify(envelope)).not.toContain('a message naming internals');
      expect(JSON.stringify(envelope)).not.toContain(code);
    },
  );

  test('an unclassified throw is INTERNAL with a bounded field, not a stack trace', () => {
    const envelope = toEnvelope(new Error('connect ECONNREFUSED 127.0.0.1:5432'), 'hunts.start');
    expect(envelope.code).toBe('INTERNAL');
    expect(envelope.field).toBe('hunts.start');
    expect(JSON.stringify(envelope)).not.toContain('ECONNREFUSED');
  });

  test('every mapping lands inside the taxonomy', () => {
    const codes = [
      toEnvelope(new SimError('WRONG_VERSION', '$', '')).code,
      toEnvelope(new SimError('INVALID_STATE', '$', '')).code,
      toEnvelope(new Error('x')).code,
    ];
    for (const code of codes) expect(ERROR_CODES).toContain(code);
  });
});

describe('P-39: the emitted set is a subset of the table', () => {
  test('across a run of the failure paths this app can reach', async () => {
    const emitted = new Set<string>();
    const collect = (response: { statusCode: number; body: string }) => {
      if (response.statusCode < 400) return;
      const body = JSON.parse(response.body) as { code?: string };
      if (body.code !== undefined) emitted.add(body.code);
    };

    collect(await h.app.inject({ method: 'GET', url: '/api/me' }));
    collect(await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'https://evil.example.com' } }));
    collect(await h.app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: ORIGIN }, payload: { email: 'not-an-email', password: 'x' } }));
    collect(await h.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: 'nobody@example.com', password: 'a-sufficiently-long-password' } }));
    collect(await h.app.inject({ method: 'GET', url: '/api/reports/99999999-9999-4999-8999-999999999999' }));

    const cookie = await h.signUp();
    collect(await h.app.inject({ method: 'GET', url: '/api/reports/99999999-9999-4999-8999-999999999999', headers: { cookie } }));
    collect(await h.app.inject({
      method: 'POST',
      url: '/api/shop/buy',
      headers: { origin: ORIGIN, cookie, 'idempotency-key': 's1' },
      payload: { definitionId: 'small-hp-potion', quantity: 1 },
    }));

    expect(emitted.size).toBeGreaterThan(3);
    for (const code of emitted) expect(ERROR_CODES, `emitted ${code}`).toContain(code);
  });

  test('the shop answers MAINTENANCE while prices are deferred (spec §4.0)', async () => {
    const cookie = await h.signUp();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/shop/buy',
      headers: { origin: ORIGIN, cookie, 'idempotency-key': 's2' },
      payload: { definitionId: 'small-hp-potion', quantity: 1 },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('MAINTENANCE');
  });
});

describe('the envelope never carries display text', () => {
  test('a validation failure names a field path and no sentence', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { origin: ORIGIN },
      payload: { email: 'not-an-email', password: 'a-sufficiently-long-password' },
    });
    const body = response.json();
    expect(body).toMatchObject({ code: 'VALIDATION', field: 'email' });
    expect(Object.keys(body).sort()).toEqual(['code', 'field', 'retryable']);
  });
});
