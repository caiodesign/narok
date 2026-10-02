/**
 * Task 11 — gate B-27's harness: concurrent returning accounts against one
 * server process, extending `artifacts/batch-100.mjs`'s shape from bounded
 * worker jobs to authenticated accounts.
 *
 * B-27 is a **target-VPS** gate. Run anywhere else, this produces
 * workstation numbers, labelled as such, and the gate stays open: A's results
 * file refuses to claim §6.5 from a workstation and B must not either.
 *
 * Phases, all against a real `apps/server` and a fresh harness database:
 *   1. Onboard N accounts through the real routes (each charged to its own
 *      TEST-NET source address, as distinct players behind the proxy would be),
 *      seed their presets (R197), start N hunts.
 *   2. Returning accounts: stop the server, backdate every hunt one hour (an
 *      absence), restart it, and reconnect all N sockets at once. Each
 *      reconnect settles its absence before its snapshot (step 2 of the
 *      lifecycle), so time-to-snapshot is the catch-up latency under load.
 *   3. Hold: all N sockets stream for the requested hours, acking frames and
 *      heartbeating on the client's 30 s interval; frame inter-arrival and the
 *      latency of a hunt read issued with each heartbeat are recorded.
 *   4. Bounds: one extra account opens one more socket than
 *      `socketsPerAccount` allows, and the refusal is recorded.
 * The server's resident set size is sampled once a second throughout.
 *
 * Usage: node artifacts/load-accounts.mjs <concurrent-accounts> <hours> artifacts/b27-load.json
 * `<hours>` may be fractional (0.05 = three minutes).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import {
  apiClient,
  backdate,
  onboard,
  openSocket,
  prepareDatabase,
  provisionPresets,
  sleep,
  sqlFor,
  startHunt,
  startServer,
  summarize,
  transcript,
} from '../e2e/support/server.mjs';

const accounts = Number(process.argv[2] ?? 50);
const hours = Number(process.argv[3] ?? 0.05);
const out = process.argv[4] ?? 'artifacts/b27-load.json';
const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = 'http://127.0.0.1:4173';
const t = transcript();

function rssBytes(pid) {
  try {
    if (platform() === 'linux') {
      const line = readFileSync(`/proc/${pid}/status`, 'utf8').split('\n').find((entry) => entry.startsWith('VmRSS:'));
      return line === undefined ? null : Number(line.split(/\s+/)[1]) * 1024;
    }
    if (platform() === 'win32') {
      const csv = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
      const memory = csv.split('","').at(-1)?.replace(/[^\d]/g, '');
      return memory === undefined || memory === '' ? null : Number(memory) * 1024;
    }
    const kb = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return Number(kb) * 1024;
  } catch {
    return null;
  }
}

function sampleRss(pid, into) {
  let live = true;
  const loop = (async () => {
    while (live) {
      const bytes = rssBytes(pid);
      if (bytes !== null) into.push({ at: Date.now(), bytes });
      await sleep(1000);
    }
  })();
  return async () => {
    live = false;
    await loop;
  };
}

const url = await prepareDatabase('narok_load');
const sql = sqlFor(url);
let server = await startServer({ url, port: PORT, origin: ORIGIN });
const rss = [];
let stopSampling = sampleRss(server.pid, rss);
t.log(`server pid ${server.pid}; ${accounts} accounts; hold ${hours} h`);

// -- 1. onboarding --------------------------------------------------------------
const players = [];
const onboardMs = [];
const startMs = [];
for (let batch = 0; batch < accounts; batch += 10) {
  await Promise.all(
    Array.from({ length: Math.min(10, accounts - batch) }, async (_, offset) => {
      const index = batch + offset;
      const api = apiClient(BASE, ORIGIN, { forwardedFor: `198.51.${100 + Math.floor(index / 250)}.${1 + (index % 250)}` });
      const email = `load-${index}-${crypto.randomUUID().slice(0, 6)}@example.com`;
      const began = performance.now();
      await onboard(api, { email, names: [`L${index}a${email.slice(-18, -12)}`, `L${index}b${email.slice(-18, -12)}`, `L${index}c${email.slice(-18, -12)}`] });
      onboardMs.push(performance.now() - began);
      players.push({ index, email, api });
    }),
  );
}
provisionPresets(url, players.map((player) => player.email));
for (const player of players) {
  const started = await startHunt(player.api);
  if (started.status !== 200) throw new Error(`start ${player.index}: ${started.status} ${JSON.stringify(started.body)}`);
  startMs.push(started.ms);
}
t.log(`onboarded and started ${players.length} hunts`);

// -- 2. returning accounts --------------------------------------------------------
await stopSampling();
await server.kill();
const ABSENCE_MS = 60 * 60 * 1000;
const ids = await sql`select id from accounts`;
for (const { id } of ids) await backdate(sql, id, ABSENCE_MS);
t.log(`INJECT backdated all ${ids.length} hunts by ${ABSENCE_MS} ms`);
server = await startServer({ url, port: PORT, origin: ORIGIN });
stopSampling = sampleRss(server.pid, rss);
const reconnectMs = [];
const sockets = await Promise.all(
  players.map(async (player) => {
    const socket = openSocket(BASE, ORIGIN, player.api.cookie);
    await socket.opened;
    const began = performance.now();
    socket.send({ type: 'hello' });
    await socket.next((m) => m.type === 'snapshot', 300_000);
    reconnectMs.push(performance.now() - began);
    return { player, socket };
  }),
);
t.log(`all ${sockets.length} returning accounts reconnected; time-to-snapshot p50 ${summarize(reconnectMs).p50?.toFixed(0)} ms`);

// Hunts that stopped during the absence start again, so the hold streams N live hunts.
let restarted = 0;
for (const { player } of sockets) {
  const current = await player.api.get('/api/hunts/current');
  if (current.body?.state?.stopReason !== null && current.body?.state?.stopReason !== undefined) {
    const again = await startHunt(player.api);
    if (again.status === 200) restarted += 1;
  }
}
t.log(`${restarted} hunts had stopped during the absence and were started again`);

// -- 3. hold -------------------------------------------------------------------------
const interArrival = [];
const readMs = [];
let holdRestarts = 0;
const readFailures = [];
const lastFrame = new Map();
for (const { player, socket } of sockets) {
  socket.socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'frame') return;
    const now = performance.now();
    const previous = lastFrame.get(player.index);
    if (previous !== undefined) interArrival.push(now - previous);
    lastFrame.set(player.index, now);
    socket.send({ type: 'ack', generation: message.generation, seq: message.lastSeq });
  });
}
const holdUntil = Date.now() + hours * 60 * 60 * 1000;
while (Date.now() < holdUntil) {
  // Each client's 30 s heartbeat (a settlement), and a timed read of its hunt
  // under the same load: the read's latency is what a player waits for.
  await Promise.all(
    sockets.map(async ({ player, socket }) => {
      socket.send({ type: 'heartbeat' });
      const read = await player.api.get('/api/hunts/current');
      readMs.push(read.ms);
      if (read.status !== 200) readFailures.push(read.status);
      // A hunt that ended (a level-1 party wipes within minutes) is started
      // again, as a returning player would, so the hold keeps N live streams.
      if (read.status === 200 && read.body.state.stopReason !== null) {
        const again = await startHunt(player.api);
        if (again.status === 200) holdRestarts += 1;
      }
    }),
  );
  await sleep(Math.min(30_000, Math.max(0, holdUntil - Date.now())));
}
const framesReceived = sockets.reduce((sum, { socket }) => sum + socket.messages.filter((m) => m.type === 'frame').length, 0);
t.log(`hold finished: ${framesReceived} frames received across ${sockets.length} sockets`);

// -- 4. the socket bound ------------------------------------------------------------
const probe = players[0];
const extra = [];
const limit = 4;
for (let index = 0; index < limit + 1; index += 1) {
  const socket = openSocket(BASE, ORIGIN, probe.api.cookie);
  extra.push(socket);
}
const outcomes = await Promise.all(
  extra.map((socket) => Promise.race([socket.opened.then(() => 'open', () => 'refused'), sleep(5000).then(() => 'timeout')])),
);
await sleep(1000);
const closes = await Promise.all(extra.map((socket) => Promise.race([socket.closed, sleep(500).then(() => null)])));
t.log(`socket bound probe (account 0 already holds 1): opens ${JSON.stringify(outcomes)}; closes ${JSON.stringify(closes)}`);
for (const socket of extra) socket.close();
for (const { socket } of sockets) socket.close();

await stopSampling();
await server.kill();
await sql.end({ timeout: 5 });

const ms = (values) => Object.fromEntries(Object.entries(summarize(values)).map(([key, value]) => [key, typeof value === 'number' && key !== 'n' ? +value.toFixed(1) : value]));
const result = {
  gate: 'B-27',
  label: 'WORKSTATION RESULT — not the target VPS; B-27 and milestone A §6.5 stay open',
  ranAt: new Date().toISOString(),
  hardware: { platform: platform(), release: release(), cpu: cpus()[0]?.model?.trim(), logicalCpus: cpus().length, totalMemGiB: +(totalmem() / 2 ** 30).toFixed(1) },
  node: process.version,
  accounts,
  hours,
  absenceMs: ABSENCE_MS,
  onboardMs: ms(onboardMs),
  startHuntMs: ms(startMs),
  reconnectTimeToSnapshotMs: ms(reconnectMs),
  restartedAfterAbsence: restarted,
  huntReadUnderLoadMs: ms(readMs),
  huntReadFailures: readFailures,
  huntRestartsDuringHold: holdRestarts,
  frameInterArrivalMs: ms(interArrival),
  framesReceived,
  peakRssMiB: rss.length === 0 ? null : +(Math.max(...rss.map((sample) => sample.bytes)) / 2 ** 20).toFixed(1),
  rssSamples: rss.length,
  socketBoundProbe: { opens: outcomes, closes },
  note: 'Each account is charged to its own TEST-NET-2/3 X-Forwarded-For source; the credential limiter keys on that header (plugins/rate-limit.ts).',
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ ...result }, null, 2));
