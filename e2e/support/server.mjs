/**
 * The real-server harness shared by the milestone B end-to-end specs and the
 * Task 11 drills (gates B-24, B-25, B-26, B-18, B-29, B-30, B-27, B-28).
 *
 * Everything here talks to a real PostgreSQL and a real `apps/server` process
 * started exactly as production starts it (`tsx src/main.ts`), never to an
 * in-process `createApp`: a drill that kills the server must kill a process.
 *
 * Databases are always *separate* databases inside the one PostgreSQL the
 * developer runs (`compose.dev.yml`) or CI's service container — `narok_e2e`,
 * `narok_drill`, `narok_restore`, `narok_load`. The development database
 * `narok` is never dropped or truncated by anything in this file.
 *
 * `postgres` and `drizzle-orm` are the server's own dependencies, resolved from
 * `apps/server` (pnpm does not hoist them to the root).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SERVER_DIR = fileURLToPath(new URL('../../apps/server/', import.meta.url));
const requireServer = createRequire(new URL('../../apps/server/package.json', import.meta.url));

export const postgres = requireServer('postgres');
const { drizzle } = requireServer('drizzle-orm/postgres-js');
const { migrate } = requireServer('drizzle-orm/postgres-js/migrator');

/** The admin connection: the developer's database, used only to CREATE/DROP the harness's own. */
export const ADMIN_URL = process.env.NAROK_ADMIN_DATABASE_URL ?? 'postgres://narok:narok@127.0.0.1:5433/narok';

export function databaseUrl(name) {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

const HARNESS_DATABASE = /^narok_(e2e|drill|restore|load|frames|shots)[a-z0-9_]*$/;

function assertHarnessDatabase(name) {
  // A guard, not a convenience: nothing here may ever touch `narok` itself.
  if (!HARNESS_DATABASE.test(name)) throw new Error(`refusing to manage database ${name}: not a harness database`);
}

/** Drops (if asked) and creates a harness database, then applies every committed migration. */
export async function prepareDatabase(name, { fresh = true } = {}) {
  assertHarnessDatabase(name);
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    if (fresh) await admin.unsafe(`drop database if exists ${name} with (force)`);
    const [exists] = await admin`select 1 from pg_database where datname = ${name}`;
    if (exists === undefined) await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = databaseUrl(name);
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: `${SERVER_DIR}drizzle` });
  } finally {
    await client.end({ timeout: 5 });
  }
  return url;
}

export async function dropDatabase(name) {
  assertHarnessDatabase(name);
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** A query connection to a harness database, for the drills' assertions. */
export function sqlFor(url) {
  return postgres(url, { max: 4, onnotice: () => {} });
}

/**
 * Starts `apps/server` as its own process. `NAROK_INSECURE_COOKIES=1` because
 * every harness speaks plain HTTP on loopback; `extraEnv` carries a drill's
 * test-only seams (each refused by the server outside `NODE_ENV=test`).
 */
export async function startServer({ url, port, origin, extraEnv = {}, log = () => {} }) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      DATABASE_URL: url,
      PORT: String(port),
      NAROK_ALLOWED_ORIGINS: origin,
      NAROK_INSECURE_COOKIES: '1',
      // The harnesses charge each test account to its own TEST-NET address.
      NAROK_TRUST_PROXY: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  const onData = (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line === '') continue;
      lines.push(line);
      log(line);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${lines.join('\n')}`);
    if (lines.some((line) => line.includes(`listening on ${port}`))) break;
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`server did not listen within 60 s:\n${lines.join('\n')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    child,
    lines,
    pid: child.pid,
    exited,
    /** SIGKILL: no shutdown hook runs, which is the crash a recovery drill needs. */
    async kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      return exited;
    },
  };
}

/**
 * A cookie-carrying HTTP client speaking the server's REST surface, sending the
 * allowlisted `Origin` on every mutation as a browser would (P-08).
 */
export function apiClient(base, origin, { forwardedFor } = {}) {
  let cookie = '';
  const headers = (extra = {}) => ({
    origin,
    ...(cookie === '' ? {} : { cookie }),
    ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }),
    ...extra,
  });
  async function call(method, path, body, extra = {}) {
    const init = { method, headers: headers(extra) };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['content-type'] = 'application/json';
    }
    const started = performance.now();
    const response = await fetch(`${base}${path}`, init);
    const ms = performance.now() - started;
    const setCookie = response.headers.get('set-cookie');
    if (setCookie !== null) {
      const pair = setCookie.split(';')[0];
      if (pair.endsWith('=')) cookie = '';
      else cookie = pair;
    }
    const text = await response.text();
    let json = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: response.status, body: json, ms };
  }
  return {
    call,
    get cookie() {
      return cookie;
    },
    get: (path) => call('GET', path),
    post: (path, body, key) => call('POST', path, body, key === undefined ? {} : { 'idempotency-key': key }),
    put: (path, body, key) => call('PUT', path, body, key === undefined ? {} : { 'idempotency-key': key }),
  };
}

/** Registers, logs in and creates a three-member party; returns what a start needs. */
export async function onboard(api, { email, password = 'correct horse battery staple', names, classes = ['guardian', 'cleric', 'ranger'] }) {
  const registered = await api.post('/api/auth/register', { email, password });
  if (registered.status !== 200) throw new Error(`register ${registered.status} ${JSON.stringify(registered.body)}`);
  const login = await api.post('/api/auth/login', { email, password });
  if (login.status !== 204) throw new Error(`login ${login.status} ${JSON.stringify(login.body)}`);
  let version = registered.body.stateVersion;
  const characters = [];
  for (let slot = 0; slot < classes.length; slot += 1) {
    const created = await api.post(
      '/api/characters',
      { slot, name: names[slot], classId: classes[slot], expectedStateVersion: version },
      crypto.randomUUID(),
    );
    if (created.status !== 200) throw new Error(`create character ${created.status} ${JSON.stringify(created.body)}`);
    version = created.body.stateVersion;
    characters.push(created.body.character);
  }
  return { characters, stateVersion: version };
}

/** Starts a hunt with the account's first strategy and loot presets. */
export async function startHunt(api, { mapId = 'prototype' } = {}) {
  const [presets, characters] = await Promise.all([api.get('/api/presets'), api.get('/api/characters')]);
  if (presets.status !== 200) throw new Error(`presets ${presets.status} ${JSON.stringify(presets.body)}`);
  const started = await api.post(
    '/api/hunts',
    {
      characterIds: characters.body.characters.map((character) => character.id),
      mapId,
      strategyPresetId: presets.body.strategy[0].id,
      lootPresetId: presets.body.loot[0].id,
      expectedStateVersion: characters.body.stateVersion,
    },
    crypto.randomUUID(),
  );
  return started;
}

/**
 * A raw `/ws` client authenticated by the session cookie, as the browser's
 * upgrade carries it (P-07). Node's global `WebSocket` cannot set `Cookie` or
 * `Origin`, so the server's own `ws` dependency is used.
 */
export function openSocket(base, origin, cookie) {
  const WebSocket = createRequire(requireServer.resolve('@fastify/websocket'))('ws');
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, { headers: { origin, cookie } });
  const messages = [];
  const waiters = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  const opened = new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const closed = new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  return {
    socket,
    messages,
    opened,
    closed,
    send: (message) => socket.send(JSON.stringify(message)),
    next(predicate, timeoutMs = 30_000) {
      const found = messages.find(predicate);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
            reject(new Error(`socket: no matching message within ${timeoutMs} ms`));
          }
        }, timeoutMs).unref();
      });
    },
    close: () => socket.close(),
  };
}

export { ROOT, SERVER_DIR };

/**
 * Seeds the account's presets through `apps/server/test/harness/provision-presets.ts`
 * (ruling R197: B has no preset-creation route). Runs under tsx from the repo root.
 */
export function provisionPresets(url, emails) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'apps/server/test/harness/provision-presets.ts', ...emails],
    { cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`provision-presets failed (${result.status}):\n${result.stderr}${result.stdout}`);
  return result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

/** The account's hunt row with its envelope decoded (the checkpoint is UTF-8 JSON in `bytea`). */
export async function readHuntRow(sql, accountId) {
  const [row] = await sql`select * from hunts where account_id = ${accountId}`;
  if (row === undefined) return undefined;
  const envelope = JSON.parse(Buffer.from(row.checkpoint).toString('utf8'));
  return { row, envelope, state: JSON.parse(envelope.state) };
}

/**
 * Rewrites the committed checkpoint in place — the drills' only injection
 * point. `edit` receives `{ envelope, state, columns }` and mutates them; the
 * envelope is re-encoded with its state, and the named columns are updated in
 * the same statement. Run only while no server process holds the hunt.
 */
export async function tamperCheckpoint(sql, accountId, edit) {
  const current = await readHuntRow(sql, accountId);
  if (current === undefined) throw new Error(`no hunt for ${accountId}`);
  const columns = {};
  edit({ envelope: current.envelope, state: current.state, columns });
  current.envelope.state = JSON.stringify(current.state);
  const bytes = Buffer.from(JSON.stringify(current.envelope), 'utf8');
  await sql`update hunts set checkpoint = ${bytes} where account_id = ${accountId}`;
  for (const [column, value] of Object.entries(columns)) {
    await sql`update hunts set ${sql(column)} = ${value} where account_id = ${accountId}`;
  }
}

/** Shifts a hunt's wall anchors back by `ms`, as if the player had been away that long. */
export async function backdate(sql, accountId, ms) {
  const current = await readHuntRow(sql, accountId);
  await tamperCheckpoint(sql, accountId, ({ envelope, columns }) => {
    envelope.wallAnchorMs -= ms;
    envelope.lastSeenAt -= ms;
    columns.wall_anchor_at = new Date(new Date(current.row.wall_anchor_at).getTime() - ms);
    columns.last_seen_at = new Date(new Date(current.row.last_seen_at).getTime() - ms);
  });
}

/** Summary statistics in the `batch-100.mjs` shape. */
export function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (fraction) => {
    if (sorted.length === 0) return null;
    const rank = Math.ceil(fraction * sorted.length);
    return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
  };
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    max: sorted.at(-1) ?? null,
  };
}

/** A transcript: every line timestamped, kept in order, printed as it happens. */
export function transcript() {
  const started = Date.now();
  const lines = [];
  return {
    lines,
    log(line) {
      const stamped = `[+${((Date.now() - started) / 1000).toFixed(1).padStart(6)} s] ${line}`;
      lines.push(stamped);
      console.log(stamped);
    },
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serves the built client (`apps/client/dist`) with `vite preview`, proxying
 * `/api` and `/ws` to `apiUrl` (R197). Run `pnpm --filter @narok/client build` first.
 */
export async function startPreview({ port, apiUrl }) {
  const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: fileURLToPath(new URL('../../apps/client/', import.meta.url)),
    env: { ...process.env, NAROK_API_PROXY: apiUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`vite preview exited early (${child.exitCode})`);
    const ok = await fetch(`${base}/`).then((response) => response.ok, () => false);
    if (ok) break;
    if (Date.now() > deadline) throw new Error('vite preview did not answer within 60 s');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return {
    base,
    async kill() {
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

/** Onboards a browser page's account through the real routes (R197) and seeds its presets. */
export async function onboardPage(page, { url, origin, email, names, forwardedFor = '198.51.100.200' }) {
  const post = (path, data, key) =>
    page.request.post(path, { data, headers: { origin, 'x-forwarded-for': forwardedFor, ...(key === undefined ? {} : { 'idempotency-key': key }) } });
  const password = 'correct horse battery staple';
  const registered = await post('/api/auth/register', { email, password });
  if (registered.status() !== 200) throw new Error(`register ${registered.status()} ${await registered.text()}`);
  let version = (await registered.json()).stateVersion;
  const login = await post('/api/auth/login', { email, password });
  if (login.status() !== 204) throw new Error(`login ${login.status()}`);
  const classes = ['guardian', 'cleric', 'ranger'];
  for (let slot = 0; slot < 3; slot += 1) {
    const created = await post('/api/characters', { slot, name: names[slot], classId: classes[slot], expectedStateVersion: version }, crypto.randomUUID());
    if (created.status() !== 200) throw new Error(`character ${created.status()} ${await created.text()}`);
    version = (await created.json()).stateVersion;
  }
  provisionPresets(url, [email]);
}
