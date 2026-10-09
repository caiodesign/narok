/**
 * The login path must do the same work whether or not the email exists
 * (layer-1 §8.3). A decoy hash is what makes that true — and a decoy computed
 * lazily on first use is a decoy that does not work, because the first unknown
 * email pays a hashing cost no later one pays, which is exactly the signal the
 * decoy exists to suppress.
 *
 * The limiter is here for a related reason: a bound that leaks memory is a
 * bound that fails on the long-running server it was written for.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { fixedWindow, sourceKey } from '../src/plugins/rate-limit';
import { harness, ORIGIN, type Harness } from './helpers';
import type { Hasher } from '../src/auth/password';

const PASSWORD = 'a-sufficiently-long-password';

/** Counts what the login path actually does, rather than timing it. */
function countingHasher(): Hasher & { hashes: number; verifies: number } {
  const counter = {
    hashes: 0,
    verifies: 0,
    async hash(password: string) {
      counter.hashes += 1;
      return { hash: `hash:${password}`, algorithm: 'test' };
    },
    async verify(stored: string, password: string) {
      counter.verifies += 1;
      return stored === `hash:${password}`;
    },
  };
  return counter;
}

let open: Harness | undefined;

afterEach(async () => {
  await open?.app.close();
  open = undefined;
});

describe('an unknown email and a wrong password do the same work', () => {
  test('both verify exactly once, and neither hashes during login', async () => {
    const hasher = countingHasher();
    open = await harness({}, { hasher });
    await open.app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: ORIGIN }, payload: { email: 'known@example.com', password: PASSWORD } });

    const login = (email: string, password: string) =>
      open!.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email, password } });

    // The decoy must already exist by the time the first login runs.
    const hashesAfterRegister = hasher.hashes;

    hasher.verifies = 0;
    const unknown = await login('nobody@example.com', PASSWORD);
    const unknownVerifies = hasher.verifies;
    const unknownHashes = hasher.hashes;

    hasher.verifies = 0;
    const wrong = await login('known@example.com', 'a-completely-wrong-password');
    const wrongVerifies = hasher.verifies;

    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknownVerifies, 'unknown email still verifies').toBe(1);
    expect(wrongVerifies, 'wrong password verifies').toBe(1);
    expect(unknownVerifies).toBe(wrongVerifies);
    expect(unknownHashes, 'login never hashes: the decoy is already built').toBe(hashesAfterRegister);
  });

  test('the decoy is per app, not shared module state across instances', async () => {
    const first = countingHasher();
    const a = await harness({}, { hasher: first });
    const before = first.hashes;
    await a.app.close();

    const second = countingHasher();
    const b = await harness({}, { hasher: second });
    try {
      // A second app builds its own decoy rather than inheriting the first's.
      expect(second.hashes).toBeGreaterThan(0);
      expect(before).toBeGreaterThan(0);
    } finally {
      await b.app.close();
    }
  });
});

describe('the fixed window does not grow without bound', () => {
  test('keys whose window has passed are dropped rather than retained forever', () => {
    const limiter = fixedWindow({ limit: 5, windowMs: 1_000 });

    for (let key = 0; key < 500; key++) limiter.check(`source-${key}`, 0);
    expect(limiter.size()).toBe(500);

    // Long after every window closed, one more call must not leave 501 behind.
    limiter.check('source-fresh', 60_000);
    expect(limiter.size(), 'expired windows are swept').toBeLessThan(10);
  });

  test('sweeping does not forget a window that is still open', () => {
    const limiter = fixedWindow({ limit: 2, windowMs: 10_000 });
    limiter.check('a', 0);
    limiter.check('a', 0);
    // A different key far in the future sweeps, but 'a' is still inside its window.
    limiter.check('b', 5_000);
    expect(() => limiter.check('a', 5_000)).toThrow();
  });
});

describe('D-02: the source a credential attempt is charged to', () => {
  const headers = { 'x-forwarded-for': '198.51.100.1, 203.0.113.9' };

  test('without a trusted proxy the header is ignored: any client could write it', () => {
    expect(sourceKey(headers, '192.0.2.4', false)).toBe('192.0.2.4');
  });

  test('behind a trusted proxy, the rightmost entry: the one the proxy appended', () => {
    expect(sourceKey(headers, '127.0.0.1', true)).toBe('203.0.113.9');
    expect(sourceKey({ 'x-forwarded-for': '203.0.113.9' }, '127.0.0.1', true)).toBe('203.0.113.9');
  });

  test('behind a trusted proxy with no header, the socket address', () => {
    expect(sourceKey({}, '127.0.0.1', true)).toBe('127.0.0.1');
  });
});
