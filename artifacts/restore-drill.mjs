/**
 * Task 11 — gate B-28: restore a backup into a clean database and application
 * environment, then settle a maintenance migration under pinned artifacts
 * (layer-1 §8.4, §4.7; part 2 §7; ruling R199).
 *
 *   1. A source database (`narok_drill_backup`) with two accounts: one hunt
 *      running, one stopped after an absence (so rewards and EXP exist).
 *   2. Backup: `pg_dump -Fc` of the source, taken with no server running.
 *   3. Restore into a clean database (`narok_restore`, dropped and created
 *      empty — no migration applied first), and start a fresh server process
 *      against it. Every table's row count and an md5 of its rows must equal
 *      the source's; both accounts sign in again and read the same characters,
 *      bag and hunt as before the backup.
 *   4. Maintenance, against the restored database, with no server running:
 *      `freeze` → `settle` (every running hunt settled to the cutoff under the
 *      artifacts this build carries) → `resume` (new anchors; downtime is a
 *      pause). The running hunt must sit at the cutoff before resume, keep its
 *      simulated time across the outage, and have `lastSeenAt` advanced by
 *      exactly the downtime; then a server starts and the hunt plays on.
 *
 * `pg_dump`/`pg_restore` run inside the PostgreSQL container when one is
 * named (`NAROK_PG_CONTAINER`, default `narok-postgres`, `docker exec`), else
 * from the PATH. The dump file is written under `artifacts/` and is not
 * committed (it is a raw dump).
 *
 * Usage: node artifacts/restore-drill.mjs artifacts/b28-restore.json
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  ADMIN_URL,
  apiClient,
  backdate,
  onboard,
  openSocket,
  prepareDatabase,
  provisionPresets,
  readHuntRow,
  ROOT,
  sleep,
  sqlFor,
  startHunt,
  startServer,
  transcript,
  postgres,
} from '../e2e/support/server.mjs';

const out = process.argv[2] ?? 'artifacts/b28-restore.json';
const container = process.env.NAROK_PG_CONTAINER ?? 'narok-postgres';
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = 'http://127.0.0.1:4173';
const t = transcript();
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  t.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

function pg(tool, args, input) {
  const admin = new URL(ADMIN_URL);
  if (container !== '') {
    return execFileSync('docker', ['exec', '-i', container, tool, '-U', decodeURIComponent(admin.username), ...args], { input, maxBuffer: 1 << 28 });
  }
  return execFileSync(tool, ['-h', admin.hostname, '-p', admin.port, '-U', decodeURIComponent(admin.username), ...args], {
    input,
    maxBuffer: 1 << 28,
    env: { ...process.env, PGPASSWORD: decodeURIComponent(admin.password) },
  });
}

async function fingerprint(url) {
  const sql = sqlFor(url);
  try {
    const tables = (await sql`select tablename from pg_tables where schemaname in ('public', 'drizzle') order by tablename`).map((row) => row.tablename);
    const result = {};
    for (const table of tables) {
      const schemaName = table === '__drizzle_migrations' ? 'drizzle' : 'public';
      const [row] = await sql.unsafe(`select count(*)::int as n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as h from ${schemaName}."${table}" t`);
      result[table] = { rows: row.n, md5: row.h };
    }
    return result;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function maintenance(url, command) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'apps/server/src/ops/maintenance.ts', command, 'B-28 drill'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
  });
  for (const line of result.stdout.trim().split(/\r?\n/).filter(Boolean)) t.log(`  ops/maintenance ${command}: ${line}`);
  if (result.status !== 0) throw new Error(`maintenance ${command} failed: ${result.stderr}`);
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

// -- 1. the source environment ----------------------------------------------------
const sourceUrl = await prepareDatabase('narok_drill_backup');
const source = sqlFor(sourceUrl);
let server = await startServer({ url: sourceUrl, port: PORT, origin: ORIGIN });
t.log(`source database narok_drill_backup; server pid ${server.pid}`);
const players = [];
for (const [index, label] of ['stopped', 'running'].entries()) {
  const api = apiClient(BASE, ORIGIN, { forwardedFor: `198.51.100.${80 + index}` });
  const email = `restore-${label}-${crypto.randomUUID().slice(0, 6)}@example.com`;
  await onboard(api, { email, names: [`Ra${index}${email.slice(-18, -13)}`, `Rb${index}${email.slice(-18, -13)}`, `Rc${index}${email.slice(-18, -13)}`] });
  players.push({ label, email, api });
}
provisionPresets(sourceUrl, players.map((player) => player.email));
for (const player of players) {
  const started = await startHunt(player.api);
  if (started.status !== 200) throw new Error(`start ${started.status}`);
  const [{ id }] = await source`select id from accounts where email = ${player.email}`;
  player.accountId = id;
}
// The first account's hunt ends inside a long absence (rewards, EXP, a report).
await backdate(source, players[0].accountId, 60 * 60 * 1000);
const back = openSocket(BASE, ORIGIN, players[0].api.cookie);
await back.opened;
back.send({ type: 'hello' });
await back.next((m) => m.type === 'snapshot', 60_000);
back.close();
await sleep(500);
const reads = async (base, api) => ({
  characters: (await api.get('/api/characters')).body,
  inventory: (await api.get('/api/inventory')).body,
  hunt: (await api.get('/api/hunts/current')).body,
});
const before = {};
for (const player of players) before[player.label] = await reads(BASE, player.api);
await server.kill();
await source.end({ timeout: 5 });
t.log('source populated: one hunt stopped after an absence, one running; server stopped');

// -- 2. backup ---------------------------------------------------------------------
const dumpPath = 'artifacts/b28-backup.dump';
const dump = pg('pg_dump', ['-Fc', '-d', 'narok_drill_backup']);
writeFileSync(dumpPath, dump);
t.log(`pg_dump -Fc narok_drill_backup -> ${dumpPath} (${dump.byteLength} bytes)`);
const sourcePrint = await fingerprint(sourceUrl);

// -- 3. restore into a clean environment -------------------------------------------
const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
await admin.unsafe('drop database if exists narok_restore with (force)');
await admin.unsafe('create database narok_restore');
await admin.end({ timeout: 5 });
const restoreUrl = new URL(ADMIN_URL);
restoreUrl.pathname = '/narok_restore';
t.log('clean database narok_restore created empty (no migration applied)');
pg('pg_restore', ['--no-owner', '-d', 'narok_restore'], dump);
t.log('pg_restore --no-owner -d narok_restore < dump');
const restoredPrint = await fingerprint(restoreUrl.toString());
const differing = Object.keys(sourcePrint).filter((table) => JSON.stringify(sourcePrint[table]) !== JSON.stringify(restoredPrint[table]));
check('every table restored with identical row count and row md5', differing.length === 0 && Object.keys(restoredPrint).length === Object.keys(sourcePrint).length, `${Object.keys(sourcePrint).length} tables${differing.length === 0 ? '' : `; differ: ${differing.join(', ')}`}`);

server = await startServer({ url: restoreUrl.toString(), port: PORT, origin: ORIGIN });
t.log(`fresh server process pid ${server.pid} against narok_restore`);
for (const player of players) {
  const api = apiClient(BASE, ORIGIN, { forwardedFor: `198.51.100.9${players.indexOf(player)}` });
  const login = await api.post('/api/auth/login', { email: player.email, password: 'correct horse battery staple' });
  check(`${player.label}: signs in against the restored database`, login.status === 204, String(login.status));
  const after = await reads(BASE, api);
  check(`${player.label}: characters and bag read back identical`, JSON.stringify(after.characters) === JSON.stringify(before[player.label].characters) && JSON.stringify(after.inventory) === JSON.stringify(before[player.label].inventory));
  check(`${player.label}: the hunt reads back identical`, JSON.stringify(after.hunt) === JSON.stringify(before[player.label].hunt), `status ${after.hunt?.state?.phase ?? after.hunt?.code}`);
  player.restoredApi = api;
}
await server.kill();
t.log('server stopped: the stopped process is the freeze (R199)');

// -- 4. maintenance settlement under pinned artifacts --------------------------------
const restored = sqlFor(restoreUrl.toString());
const running = players[1];
const beforeMaintenance = await readHuntRow(restored, running.accountId);
maintenance(restoreUrl.toString(), 'freeze');
const [frozen] = await restored`select frozen, cutoff_at from maintenance where id = 1`;
const cutoff = new Date(frozen.cutoff_at).getTime();
const settled = maintenance(restoreUrl.toString(), 'settle');
const atCutoff = await readHuntRow(restored, running.accountId);
check('settle: the running hunt is settled to the cutoff under its pinned artifacts', atCutoff.envelope.wallAnchorMs === cutoff && atCutoff.row.content_version === beforeMaintenance.row.content_version && settled.some((line) => line.accountId === running.accountId && line.outcome === 'settled'), `wallAnchor ${atCutoff.envelope.wallAnchorMs} = cutoff ${cutoff}; sim ${atCutoff.envelope.simAnchorMs} ms`);
check('settle: the stopped hunt is not touched', !settled.some((line) => line.accountId === players[0].accountId));
const DOWNTIME_MS = 3_000;
await sleep(DOWNTIME_MS);
const resumedLines = maintenance(restoreUrl.toString(), 'resume');
const resumed = await readHuntRow(restored, running.accountId);
const downtime = resumed.envelope.wallAnchorMs - cutoff;
check('resume: nothing simulated across the outage', resumed.envelope.simAnchorMs === atCutoff.envelope.simAnchorMs);
check('resume: lastSeenAt advanced by exactly the downtime (not billed to the allowance)', resumed.envelope.lastSeenAt === atCutoff.envelope.lastSeenAt + downtime && downtime >= DOWNTIME_MS, `downtime ${downtime} ms`);
check('resume: the freeze is lifted', (await restored`select frozen from maintenance where id = 1`)[0].frozen === false && resumedLines.some((line) => line.outcome === 'resumed'));
await restored.end({ timeout: 5 });

server = await startServer({ url: restoreUrl.toString(), port: PORT, origin: ORIGIN });
const socket = openSocket(BASE, ORIGIN, running.restoredApi.cookie);
await socket.opened;
socket.send({ type: 'hello' });
const snapshot = await socket.next((m) => m.type === 'snapshot', 60_000);
const frame = await socket.next((m) => m.type === 'frame' && m.state.nowMs > snapshot.state.nowMs, 15_000).catch(() => null);
socket.close();
check('after resume the hunt plays on from the cutoff state', snapshot.state.nowMs >= atCutoff.envelope.simAnchorMs && snapshot.state.nowMs < atCutoff.envelope.simAnchorMs + 60_000 && (frame !== null || snapshot.state.stopReason !== null), `snapshot at sim ${snapshot.state.nowMs} ms`);
await server.kill();

const failed = checks.filter((entry) => !entry.ok);
writeFileSync(out, `${JSON.stringify({ gate: 'B-28', ranAt: new Date().toISOString(), dumpBytes: dump.byteLength, tables: restoredPrint, cutoffWall: cutoff, downtimeMs: downtime, checks, passed: failed.length === 0 }, null, 2)}\n`);
writeFileSync(out.replace(/\.json$/, '.txt'), `${t.lines.join('\n')}\n`);
t.log(`${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
