/**
 * One app per test, over in-memory stores. Task 2 substitutes the Drizzle
 * adapter behind the same ports without touching a line of these tests, which
 * is the whole reason `createApp` takes its stores rather than importing them.
 */
import { createApp, type AppDeps } from '../src/app';
import { defaultConfig, type ServerConfig } from '../src/config';
import { memoryStores } from '../src/store/memory';

export const ORIGIN = 'http://localhost:4173';

/** argon2id is deliberately expensive; a test run does not need that cost. */
const FAST_HASHING: Pick<ServerConfig, 'argon2'> = {
  argon2: { memoryCost: 8, timeCost: 1, parallelism: 1 },
};

export interface Harness {
  app: Awaited<ReturnType<typeof createApp>>;
  config: ServerConfig;
  stores: ReturnType<typeof memoryStores>;
  /** Registers an account and returns the session cookie for it. */
  signUp(email?: string, password?: string): Promise<string>;
}

export async function harness(overrides: Partial<ServerConfig> = {}, deps: Partial<AppDeps> = {}): Promise<Harness> {
  const config: ServerConfig = {
    ...defaultConfig(),
    ...FAST_HASHING,
    allowedOrigins: [ORIGIN],
    ...overrides,
  };
  const now = deps.now ?? (() => Date.now());
  const stores = deps.stores ?? memoryStores({ now });
  const app = await createApp({ config, stores, ...deps, now });

  return {
    app,
    config,
    stores,
    async signUp(email = 'player@example.com', password = 'a-sufficiently-long-password') {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: { origin: ORIGIN },
        payload: { email, password },
      });
      if (response.statusCode !== 200) throw new Error(`register failed: ${response.statusCode} ${response.body}`);
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: ORIGIN },
        payload: { email, password },
      });
      if (login.statusCode !== 204) throw new Error(`login failed: ${login.statusCode} ${login.body}`);
      return sessionCookie(login.headers['set-cookie']);
    },
  };
}

/** The `name=value` pair a subsequent request sends back. */
export function sessionCookie(header: string | string[] | undefined): string {
  const values = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const session = values.find((value) => value.startsWith('narok_session='));
  if (session === undefined) throw new Error(`no session cookie in ${JSON.stringify(values)}`);
  return session.split(';')[0];
}

export function cookieAttributes(header: string | string[] | undefined): string {
  const values = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const session = values.find((value) => value.startsWith('narok_session='));
  if (session === undefined) throw new Error('no session cookie');
  return session;
}
