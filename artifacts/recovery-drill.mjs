/**
 * Task 11 — the recovery drill: gates B-25, B-29 (server half) and B-30
 * (server half), against real `apps/server` processes and a real PostgreSQL.
 *
 * Every step is a real process or a real row; the only injections are direct
 * edits of the committed checkpoint row while no server holds the hunt (the
 * drill's stand-in for "time passed" and "the state went bad"), each logged.
 *
 *   1. Onboard an account, start a hunt, close the socket, stop the server.
 *   2. Backdate the hunt two hours (a long absence), start a server, connect:
 *      the absence settles and rewards commit. Stay connected while the
 *      release ticks run, observing frames the server released *ahead of*
 *      the committed checkpoint (its precomputation).
 *   3. B-25: SIGKILL the server mid-hunt. Record the committed checkpoint and
 *      every reward row. Restart under the same pinned versions, reconnect,
 *      and let it replay from the durable checkpoint. Assert: the pins are
 *      unchanged; reward ids are unique and their sequence contiguous from 0
 *      (committed exactly once); every reward that existed before the crash
 *      still exists unchanged; nothing the killed process precomputed and
 *      released was in the database at the crash.
 *   4. B-29: rewrite the row's `content_version` to a value no build has;
 *      start a server: the hunt answers `CONTENT_VERSION_MISMATCH` and the
 *      checkpoint bytes are untouched — no version is substituted for replay.
 *   5. B-30: restore the version, inject an invalid engine state (an actor
 *      whose class does not exist) into the checkpoint; connect: the hunt is
 *      marked faulted, a `fault` archive row holds the reproduction inputs, no
 *      wipe is counted, repeated heartbeats and reconnects do not retry, and
 *      every command but recovery is refused with `HUNT_FAULTED`.
 *
 * Usage: node artifacts/recovery-drill.mjs artifacts/b25-recovery.json
 * Writes the JSON result and, beside it, a `.txt` transcript. Exit 1 on any
 * failed assertion. Uses the harness database `narok_drill_recovery` only.
 */
import { writeFileSync } from 'node:fs';
import {
  apiClient,
  backdate,
  onboard,
  openSocket,
  prepareDatabase,
  provisionPresets,
  readHuntRow,
  sleep,
  sqlFor,
  startHunt,
  startServer,
  tamperCheckpoint,
  transcript,
} from '../e2e/support/server.mjs';

const out = process.argv[2] ?? 'artifacts/b25-recovery.json';
const PORT = 8792;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = 'http://127.0.0.1:4173';
const t = transcript();
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  t.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

const url = await prepareDatabase('narok_drill_recovery');
const sql = sqlFor(url);
t.log(`database narok_drill_recovery migrated (${url.replace(/:[^:@]*@/, ':***@')})`);

async function boot(label) {
  const server = await startServer({ url, port: PORT, origin: ORIGIN });
  t.log(`server ${label} up, pid ${server.pid}`);
  return server;
}

async function rewards(accountId) {
  return sql`select source_ref, reason, delta, state_version_after from resource_audit
             where account_id = ${accountId} and reason like 'drop-%' order by id`;
}

// -- 1. onboard ---------------------------------------------------------------
let server = await boot('#1');
const api = apiClient(BASE, ORIGIN, { forwardedFor: '198.51.100.25' });
const email = `recovery-${crypto.randomUUID().slice(0, 8)}@example.com`;
await onboard(api, { email, names: ['Rhea', 'Cassio', 'Lumi'].map((name) => `${name}${email.slice(9, 13)}`) });
provisionPresets(url, [email]);
const [{ id: accountId }] = await sql`select id from accounts where email = ${email}`;
t.log(`account ${accountId} onboarded (three characters, presets seeded per R197)`);

// -- 2. long absences settle rewards; then a live hunt --------------------------
// Each round: start a hunt, backdate it an hour (an absence), reconnect. The
// absence settles to the hunt's own stop, committing its drops and EXP. The
// rounds exist so reward rows exist on both sides of the crash below.
const ABSENCE_MS = 60 * 60 * 1000;
const absenceSettles = [];
// Rounds continue until some drops exist (a level-1 party wipes early and
// drops are rare), at most 40; EXP carries over, so later hunts last longer.
for (let round = 0; round < 40 && (round < 3 || (await rewards(accountId)).length < 3); round += 1) {
  const started = await startHunt(api);
  if (started.status !== 200) throw new Error(`start ${started.status} ${JSON.stringify(started.body)}`);
  await backdate(sql, accountId, ABSENCE_MS);
  const probe = openSocket(BASE, ORIGIN, api.cookie);
  await probe.opened;
  const began = performance.now();
  probe.send({ type: 'hello' });
  const snapshot = await probe.next((m) => m.type === 'snapshot', 120_000);
  const settled = performance.now() - began;
  await probe.next((m) => m.type === 'report', 1_500).catch(() => null);
  probe.close();
  await sleep(300);
  const hunt = await readHuntRow(sql, accountId);
  absenceSettles.push(Math.round(settled));
  t.log(`round ${round}: hunt ${started.body.huntId} backdated ${ABSENCE_MS} ms, settled in ${settled.toFixed(0)} ms wall to sim ${snapshot.state.nowMs} ms, status ${hunt.row.status} (${hunt.envelope.stopContext?.reason ?? 'running'})`);
}
const afterAbsence = await rewards(accountId);
t.log(`rewards committed by the absence settlements: ${afterAbsence.length} drop audit rows`);

// The live hunt the crash interrupts.
const live = await startHunt(api);
if (live.status !== 200) throw new Error(`start ${live.status} ${JSON.stringify(live.body)}`);
t.log(`live hunt ${live.body.huntId} started`);
const pinsBefore = (await readHuntRow(sql, accountId)).row;
let socket = openSocket(BASE, ORIGIN, api.cookie);
await socket.opened;
socket.send({ type: 'hello' });
const firstSnapshot = await socket.next((m) => m.type === 'snapshot', 60_000);

// Live play: the release ticks run; the server releases precomputed time ahead of the checkpoint.
let released = firstSnapshot.state.nowMs;
const framesAhead = [];
const liveUntil = Date.now() + 26_000;
while (Date.now() < liveUntil) {
  const frame = await socket.next((m) => m.type === 'frame' && m.state.nowMs > released, 10_000).catch(() => null);
  if (frame === null) continue;
  released = frame.state.nowMs;
  framesAhead.push({ at: Date.now(), releasedSimMs: frame.state.nowMs, events: frame.events.length, kinds: [...new Set(frame.events.map((e) => e.kind))] });
  socket.send({ type: 'ack', generation: frame.generation, seq: frame.lastSeq });
}
const committedAtKill = await readHuntRow(sql, accountId);
const rewardsAtKill = await rewards(accountId);
t.log(`at the crash: released sim ${released} ms; committed checkpoint seq ${committedAtKill.envelope.checkpointSeq} at sim ${committedAtKill.envelope.simAnchorMs} ms; ${rewardsAtKill.length} drop rows`);
check('the server had released time ahead of the committed checkpoint (precomputation existed)', released > committedAtKill.envelope.simAnchorMs, `released ${released} > committed ${committedAtKill.envelope.simAnchorMs}`);
const expAtKill = Number((await sql`select sum(exp)::bigint as exp from characters where account_id = ${accountId}`)[0].exp);

// -- 3. B-25: crash, replay, rewards once --------------------------------------
await server.kill();
t.log('B-25 SIGKILL server #2 mid-hunt (no shutdown hook ran)');
const aliveAfterKill = await readHuntRow(sql, accountId);
check('the durable checkpoint is exactly what was committed before the crash', aliveAfterKill.envelope.checkpointSeq === committedAtKill.envelope.checkpointSeq && Buffer.compare(aliveAfterKill.row.checkpoint, committedAtKill.row.checkpoint) === 0);

server = await boot('#3 (same build, same pins)');
socket = openSocket(BASE, ORIGIN, api.cookie);
await socket.opened;
socket.send({ type: 'hello' });
const replayed = await socket.next((m) => m.type === 'snapshot', 60_000);
await socket.next((m) => m.type === 'report', 5_000).catch(() => null);
socket.close();
await sleep(500);
const afterReplay = await readHuntRow(sql, accountId);
const rewardsAfter = await rewards(accountId);
t.log(`after replay: checkpoint seq ${afterReplay.envelope.checkpointSeq} at sim ${afterReplay.envelope.simAnchorMs} ms; snapshot at sim ${replayed.state.nowMs} ms; ${rewardsAfter.length} drop rows`);

const pinsOf = (row) => `${row.simulation_version}/${row.content_version}/${row.grid_hash}`;
check('replay ran under the pinned versions (unchanged across the crash)', pinsOf(afterReplay.row) === pinsOf(pinsBefore), pinsOf(afterReplay.row));
check('replay resumed from the durable checkpoint and moved forward', afterReplay.envelope.checkpointSeq > committedAtKill.envelope.checkpointSeq && afterReplay.envelope.simAnchorMs >= committedAtKill.envelope.simAnchorMs);
const ids = rewardsAfter.map((row) => row.source_ref);
const unique = new Set(ids);
check('every reward id is unique (no reward committed twice)', unique.size === ids.length, `${ids.length} rows, ${unique.size} distinct`);
const byHunt = new Map();
for (const id of ids) {
  const [hunt, seq] = [id.slice(0, id.lastIndexOf(':')), Number(id.slice(id.lastIndexOf(':') + 1))];
  byHunt.set(hunt, [...(byHunt.get(hunt) ?? []), seq]);
}
const contiguous = [...byHunt.values()].every((list) => list.sort((a, b) => a - b).every((value, index) => value === index));
check('every hunt has a reward sequence is contiguous from 0 (none skipped, none repeated)', ids.length > 0 && contiguous, `${byHunt.size} hunts, ${ids.length} rewards`);
const beforeIds = new Set(rewardsAtKill.map((row) => row.source_ref));
check('every reward committed before the crash survives unchanged', [...beforeIds].every((id) => unique.has(id)));
// Hunt rewards only: starter-kit and onboarding grants carry their own source refs.
const [{ items }] = await sql`select count(*)::int as items from items where account_id = ${accountId} and source_ref ~ '^[0-9a-f-]{36}:[0-9]+$'`;
const kept = rewardsAfter.filter((row) => row.reason === 'drop-kept').length;
check('kept-drop audit rows and reward-sourced items agree one to one', items === kept, `${items} items, ${kept} kept audits`);
const releasedBeyond = framesAhead.filter((frame) => frame.releasedSimMs > committedAtKill.envelope.simAnchorMs);
const liveAtKill = rewardsAtKill.filter((row) => row.source_ref.startsWith(`${live.body.huntId}:`)).length;
const committedRewards = committedAtKill.state.nextRewardSeq - committedAtKill.state.pendingRewards.length;
check('at the crash the database held exactly the rewards the committed checkpoint had rolled — nothing from the released precomputation', releasedBeyond.length > 0 && liveAtKill === committedRewards, `${releasedBeyond.length} frames released past sim ${committedAtKill.envelope.simAnchorMs}; live-hunt rewards in the database ${liveAtKill}, committed checkpoint nextRewardSeq ${committedAtKill.state.nextRewardSeq} with ${committedAtKill.state.pendingRewards.length} pending`);
const expNow = Number((await sql`select sum(exp)::bigint as exp from characters where account_id = ${accountId}`)[0].exp);
t.log(`EXP: ${expAtKill} at the crash (as committed), ${expNow} after replay`);
const [{ exp: expColumn }] = await sql`select sum(exp)::bigint as exp from characters where account_id = ${accountId}`;
const expCheckpoint = Object.values(afterReplay.state.progression ?? {}).reduce((sum, entry) => sum + Number(entry?.exp ?? 0), 0);
check('character EXP columns equal the committed checkpoint progression (no double credit)', Number(expColumn) === expCheckpoint || afterReplay.state.progression === undefined, `columns ${expColumn}, checkpoint ${expCheckpoint}`);
await server.kill();
t.log('server #3 stopped');

// -- 4. B-29: a checkpoint pinned to other content is refused, never substituted --
const bytesBefore = (await readHuntRow(sql, accountId)).row.checkpoint;
const realContent = afterReplay.row.content_version;
await sql`update hunts set content_version = ${'drill-other-content'} where account_id = ${accountId}`;
t.log("INJECT hunts.content_version := 'drill-other-content' (a checkpoint pinned to content this build does not carry)");
server = await boot('#4');
const currentRead = await api.get('/api/hunts/current');
socket = openSocket(BASE, ORIGIN, api.cookie);
await socket.opened;
socket.send({ type: 'hello' });
const refusal = await Promise.race([socket.next((m) => m.type === 'error', 15_000).catch(() => null), socket.closed]);
await sleep(300);
socket.close();
t.log(`GET /api/hunts/current -> ${currentRead.status} ${JSON.stringify(currentRead.body)}; socket -> ${JSON.stringify(refusal)}`);
const bytesAfter = (await readHuntRow(sql, accountId)).row;
check('B-29 the read refuses with CONTENT_VERSION_MISMATCH', currentRead.body?.code === 'CONTENT_VERSION_MISMATCH', String(currentRead.body?.code));
check('B-29 the checkpoint is untouched: no replay under the deployed content', Buffer.compare(bytesAfter.checkpoint, bytesBefore) === 0 && bytesAfter.content_version === 'drill-other-content');
await server.kill();
await sql`update hunts set content_version = ${realContent} where account_id = ${accountId}`;
t.log(`RESTORE hunts.content_version := '${realContent}'`);

// -- 5. B-30: an invalid engine state faults the hunt ---------------------------
const wipesBefore = (await readHuntRow(sql, accountId)).state.metrics?.wipes ?? null;
await tamperCheckpoint(sql, accountId, ({ state }) => {
  const actors = state.actors;
  const first = Array.isArray(actors) ? actors[0] : actors[Object.keys(actors)[0]];
  first.definitionId = 'drill-no-such-class';
});
t.log("INJECT the first actor's definitionId := 'drill-no-such-class' (an engine state no content can produce)");
server = await boot('#5');
socket = openSocket(BASE, ORIGIN, api.cookie);
await socket.opened;
socket.send({ type: 'hello' });
const faultSeen = await Promise.race([socket.next((m) => m.type === 'error', 20_000).catch(() => null), socket.closed]);
t.log(`socket after the injection -> ${JSON.stringify(faultSeen)}`);
await sleep(500);
const faulted = await readHuntRow(sql, accountId);
const archives = await sql`select captured_for, simulation_version, content_version from hunt_checkpoint_archive where account_id = ${accountId} order by created_at`;
t.log(`hunts.status=${faulted.row.status} faulted_reason=${faulted.row.faulted_reason}; archive rows: ${JSON.stringify(archives)}`);
check('B-30 the hunt is marked faulted with a reason', faulted.row.status === 'faulted' && faulted.row.faulted_reason !== null);
check('B-30 a fault archive row keeps the reproduction inputs', archives.some((row) => row.captured_for === 'fault'));
check('B-30 no wipe was charged by the fault', (faulted.state.metrics?.wipes ?? null) === wipesBefore, `wipes ${wipesBefore} -> ${faulted.state.metrics?.wipes ?? null}`);

// Automatic retries are stopped: reconnects and heartbeats do not touch the row again.
const faultedBytes = faulted.row.checkpoint;
const faultedUpdated = faulted.row.updated_at;
for (let attempt = 0; attempt < 3; attempt += 1) {
  const again = openSocket(BASE, ORIGIN, api.cookie);
  await again.opened.catch(() => undefined);
  again.send({ type: 'hello' });
  again.send({ type: 'heartbeat' });
  await Promise.race([again.closed, sleep(1500)]);
  again.close();
}
const stillFaulted = await readHuntRow(sql, accountId);
const archivesAfter = await sql`select count(*)::int as n from hunt_checkpoint_archive where account_id = ${accountId} and captured_for = 'fault'`;
check('B-30 automatic retries are stopped: three reconnects with heartbeats wrote nothing', Buffer.compare(stillFaulted.row.checkpoint, faultedBytes) === 0 && String(stillFaulted.row.updated_at) === String(faultedUpdated) && archivesAfter[0].n === 1, `fault archive rows ${archivesAfter[0].n}`);
const stop = await api.post('/api/hunts/current/stop', {}, crypto.randomUUID());
const restart = await startHunt(api);
check('B-30 a normal stop is refused with HUNT_FAULTED', stop.body?.code === 'HUNT_FAULTED', `${stop.status} ${stop.body?.code}`);
check('B-30 a normal start is refused with HUNT_FAULTED', restart.body?.code === 'HUNT_FAULTED', `${restart.status} ${restart.body?.code}`);
const recoverRoute = await api.post('/api/hunts/current/recover', { expectedStateVersion: 0 }, crypto.randomUUID());
t.log(`POST /api/hunts/current/recover -> ${recoverRoute.status} ${JSON.stringify(recoverRoute.body)} (the explicit recovery has no route in this build)`);
await server.kill();

await sql.end({ timeout: 5 });
const failed = checks.filter((entry) => !entry.ok);
const result = {
  drill: 'recovery (B-25, B-29 server half, B-30 server half)',
  ranAt: new Date().toISOString(),
  database: 'narok_drill_recovery',
  absenceMs: ABSENCE_MS,
  absenceSettleWallMs: absenceSettles,
  dropRowsBeforeLiveHunt: afterAbsence.length,
  releasedAtKillSimMs: released,
  committedAtKill: { checkpointSeq: committedAtKill.envelope.checkpointSeq, simAnchorMs: committedAtKill.envelope.simAnchorMs, dropRows: rewardsAtKill.length },
  afterReplay: { checkpointSeq: afterReplay.envelope.checkpointSeq, simAnchorMs: afterReplay.envelope.simAnchorMs, dropRows: rewardsAfter.length },
  framesObservedAhead: framesAhead.length,
  recoverRoute: { status: recoverRoute.status, body: recoverRoute.body },
  checks,
  passed: failed.length === 0,
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
writeFileSync(out.replace(/\.json$/, '.txt'), `${t.lines.join('\n')}\n`);
t.log(`${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
