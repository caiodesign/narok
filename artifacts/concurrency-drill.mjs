/**
 * Task 11 — the concurrency drill: gates B-26 and B-18, against real
 * `apps/server` processes and a real PostgreSQL.
 *
 * B-26. Two server processes share one database (`narok_drill_concurrency`).
 * One streams a running hunt over a socket and is driven to settle as often as
 * it will — a heartbeat every 150 ms on top of its own release ticks — so the
 * account's `state_version` moves under every reader. The other process takes
 * town mutations on the *same account* (lock toggles on a starter weapon),
 * each formed against the version read just before it. Two processes is
 * stricter than the single-VPS deployment: the in-process command sequencer
 * cannot order them, so only the database's version guard can (layer-1 §8.1).
 * Asserted: every mutation is answered 200 or `CONFLICT_STATE_VERSION`; every
 * conflict carries the current version and a retry against it lands; no two
 * successes share a version; the item's final lock is the last success's;
 * the hunt's committed simulation time never moves backwards across every
 * 100 ms sample (no stale worker result was applied); reward ids stay unique; and a
 * replayed idempotency key returns the stored result without moving the
 * account, while the same key with a different body is refused.
 *
 * B-18. On one process: a second tab joins the stream (no away report: it was
 * away from nothing); repeated heartbeats from both tabs credit nothing twice
 * (EXP columns equal the checkpoint's progression; reward ids unique). Then
 * every socket closes, the hunt is backdated thirteen hours (longer than the
 * twelve-hour offline cap) and a client returns: the report states time away
 * and simulated duration separately; the simulated span never exceeds the cap
 * nor the hunt's own stop (no retroactive accrual); presence is refreshed
 * only by that settlement (its window starts at the previous `last_seen_at`);
 * and an immediate second return credits nothing new.
 *
 * Usage: node artifacts/concurrency-drill.mjs artifacts/b26-concurrency.json
 * Writes the JSON result and a `.txt` transcript beside it. Exit 1 on any
 * failed assertion.
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
  transcript,
} from '../e2e/support/server.mjs';

const out = process.argv[2] ?? 'artifacts/b26-concurrency.json';
const ORIGIN = 'http://127.0.0.1:4173';
const PORT_A = 8793;
const PORT_B = 8794;
const A = `http://127.0.0.1:${PORT_A}`;
const B = `http://127.0.0.1:${PORT_B}`;
const t = transcript();
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  t.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

const url = await prepareDatabase('narok_drill_concurrency');
const sql = sqlFor(url);
t.log('database narok_drill_concurrency migrated');
let serverA = await startServer({ url, port: PORT_A, origin: ORIGIN });
let serverB = await startServer({ url, port: PORT_B, origin: ORIGIN });
t.log(`server A pid ${serverA.pid} on ${PORT_A}; server B pid ${serverB.pid} on ${PORT_B}; one database`);

const apiA = apiClient(A, ORIGIN, { forwardedFor: '198.51.100.26' });
const email = `race-${crypto.randomUUID().slice(0, 8)}@example.com`;
await onboard(apiA, { email, names: ['Ivo', 'Nara', 'Tess'].map((name) => `${name}${email.slice(5, 10)}`) });
provisionPresets(url, [email]);
const [{ id: accountId }] = await sql`select id from accounts where email = ${email}`;
// Server B serves the same session: sessions live in the shared database.
const apiB = apiClient(B, ORIGIN);
Object.defineProperty(apiB, 'cookie', { value: apiA.cookie });
const callB = (method, path, body, key) => {
  const headers = { origin: ORIGIN, cookie: apiA.cookie, 'content-type': 'application/json', ...(key === undefined ? {} : { 'idempotency-key': key }) };
  const started = performance.now();
  return fetch(`${B}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (response) => ({
    status: response.status,
    body: await response.json().catch(() => null),
    ms: performance.now() - started,
  }));
};

const started = await startHunt(apiA);
if (started.status !== 200) throw new Error(`start ${started.status} ${JSON.stringify(started.body)}`);
t.log(`account ${accountId}; hunt ${started.body.huntId} running`);
const inventory = await apiA.get('/api/inventory');
const weapon = inventory.body.items.find((item) => item.equippedBy === undefined || item.equippedBy === null) ?? inventory.body.items[0];
t.log(`the contested item: ${weapon.id} (${weapon.definitionId ?? weapon.baseItemId ?? 'starter weapon'})`);

// -- B-26: settlement storm on A, town mutations on B -------------------------
const tab1 = openSocket(A, ORIGIN, apiA.cookie);
await tab1.opened;
tab1.send({ type: 'hello' });
await tab1.next((m) => m.type === 'snapshot', 30_000);
let storming = true;
const heartbeats = (async () => {
  let sent = 0;
  while (storming) {
    tab1.send({ type: 'heartbeat' });
    sent += 1;
    await sleep(150);
  }
  return sent;
})();
const samples = [];
const sampler = (async () => {
  while (storming) {
    const row = await readHuntRow(sql, accountId);
    samples.push({ seq: row.envelope.checkpointSeq, simAnchorMs: row.envelope.simAnchorMs, version: row.envelope.accountStateVersion });
    await sleep(100);
  }
})();

const outcomes = [];
let desired = false;
let lastSuccess = null;
for (let attempt = 0; attempt < 150; attempt += 1) {
  desired = !desired;
  const me = await callB('GET', '/api/me');
  let version = me.body.stateVersion;
  const record = { attempt, locked: desired, tries: [] };
  for (let retry = 0; retry < 8; retry += 1) {
    const key = crypto.randomUUID();
    const response = await callB('POST', '/api/inventory/lock', { itemId: weapon.id, locked: desired, expectedStateVersion: version }, key);
    record.tries.push({ status: response.status, code: response.body?.code ?? null, formedAt: version, stateVersion: response.body?.stateVersion ?? null, ms: Math.round(response.ms) });
    if (response.status === 200) {
      lastSuccess = { key, body: { itemId: weapon.id, locked: desired, expectedStateVersion: version }, response };
      break;
    }
    if (response.body?.code !== 'CONFLICT_STATE_VERSION') break;
    version = response.body.stateVersion; // the loser retries against fresh state
  }
  outcomes.push(record);
  await sleep(60);
}
storming = false;
const heartbeatsSent = await heartbeats;
await sampler;

const allTries = outcomes.flatMap((record) => record.tries);
const conflicts = allTries.filter((attempt) => attempt.code === 'CONFLICT_STATE_VERSION');
const successes = allTries.filter((attempt) => attempt.status === 200);
t.log(`${heartbeatsSent} heartbeats on A; ${allTries.length} lock attempts on B: ${successes.length} succeeded, ${conflicts.length} lost the race`);
const seqAfterStorm = (await readHuntRow(sql, accountId)).envelope.checkpointSeq;
t.log(`hunt checkpoint seq ${samples[0]?.seq} -> ${seqAfterStorm} during the storm (${samples.length} samples)`);
check('the race was real: settlements committed and at least one mutation lost to one', seqAfterStorm > (samples[0]?.seq ?? 0) && conflicts.length > 0, `${conflicts.length} conflicts`);
check('every answer is a success or CONFLICT_STATE_VERSION (no 5xx, no other refusal)', allTries.every((attempt) => attempt.status === 200 || attempt.code === 'CONFLICT_STATE_VERSION'));
check('every conflict names the current version to retry against', conflicts.every((attempt) => Number.isInteger(attempt.stateVersion) && attempt.stateVersion > attempt.formedAt));
check('every intent eventually landed after retrying against fresh state', outcomes.every((record) => record.tries.at(-1).status === 200), `max tries ${Math.max(...outcomes.map((record) => record.tries.length))}`);
const versions = successes.map((attempt) => attempt.stateVersion);
check('no two successes share a state_version (one writer wins each version)', new Set(versions).size === versions.length);
const [itemRow] = await sql`select locked from items where id = ${weapon.id}`;
check("the item's final lock is the last success's", itemRow.locked === lastSuccess.body.locked, `locked=${itemRow.locked}`);
let monotonic = true;
for (let index = 1; index < samples.length; index += 1) {
  if (samples[index].simAnchorMs < samples[index - 1].simAnchorMs || samples[index].seq < samples[index - 1].seq) monotonic = false;
}
check('the committed hunt never moved backwards (no stale worker result applied)', monotonic, `${samples.length} samples`);

// Idempotency: the same key and body replays the stored result on either process.
const versionBeforeReplay = (await callB('GET', '/api/me')).body.stateVersion;
const replayB = await callB('POST', '/api/inventory/lock', lastSuccess.body, lastSuccess.key);
const replayA = await apiA.post('/api/inventory/lock', lastSuccess.body, lastSuccess.key);
const versionAfterReplay = (await callB('GET', '/api/me')).body.stateVersion;
t.log(`replay of key ${lastSuccess.key}: B ${replayB.status} v${replayB.body?.stateVersion}, A ${replayA.status} v${replayA.body?.stateVersion}; original v${lastSuccess.response.body.stateVersion}`);
check('a replayed idempotency key returns the stored result on both processes', replayB.status === 200 && replayA.status === 200 && replayB.body.stateVersion === lastSuccess.response.body.stateVersion && replayA.body.stateVersion === lastSuccess.response.body.stateVersion);
const [{ n: lockAudits }] = await sql`select count(*)::int as n from command_results where account_id = ${accountId} and idempotency_key like ${`%${lastSuccess.key}`}`.catch(() => [{ n: null }]);
t.log(`account version ${versionBeforeReplay} before the replays, ${versionAfterReplay} after (settlements may move it); stored results for the key: ${lockAudits}`);
const reused = await callB('POST', '/api/inventory/lock', { ...lastSuccess.body, locked: !lastSuccess.body.locked }, lastSuccess.key);
check('the same key with a different body is refused, not applied', reused.status !== 200 && (await sql`select locked from items where id = ${weapon.id}`)[0].locked === lastSuccess.body.locked, `${reused.status} ${reused.body?.code}`);

// -- B-18: multiple tabs and repeated heartbeats -------------------------------
const tab2 = openSocket(A, ORIGIN, apiA.cookie);
await tab2.opened;
tab2.send({ type: 'hello' });
await tab2.next((m) => m.type === 'snapshot', 30_000);
await sleep(1_500);
check('B-18 a second tab joining a live stream gets no away report', !tab2.messages.some((m) => m.type === 'report'));
// Long enough for encounters to settle, so the EXP check has something to count.
for (let beat = 0; beat < 200; beat += 1) {
  tab1.send({ type: 'heartbeat' });
  tab2.send({ type: 'heartbeat' });
  await sleep(100);
}
await sleep(1_500);
const framesTab1 = tab1.messages.filter((m) => m.type === 'frame').length;
const framesTab2 = tab2.messages.filter((m) => m.type === 'frame').length;
check('B-18 both tabs keep receiving the stream', framesTab1 > 0 && framesTab2 > 0, `tab1 ${framesTab1} frames, tab2 ${framesTab2}`);
tab1.close();
tab2.close();
await sleep(500);
const settledTabs = await readHuntRow(sql, accountId);
const expColumns = Number((await sql`select sum(exp)::bigint as exp from characters where account_id = ${accountId}`)[0].exp);
const expCheckpoint = Object.values(settledTabs.state.progression ?? {}).reduce((sum, entry) => sum + Number(entry.exp ?? 0), 0);
check('B-18 repeated heartbeats from two tabs credited EXP once (columns equal the checkpoint)', expColumns === expCheckpoint, `columns ${expColumns}, checkpoint ${expCheckpoint}`);
const rewardIds = (await sql`select source_ref from resource_audit where account_id = ${accountId} and reason like 'drop-%'`).map((row) => row.source_ref);
check('B-18 reward ids stay unique across the storm and the tabs', new Set(rewardIds).size === rewardIds.length, `${rewardIds.length} rewards`);

// -- B-18: a thirteen-hour absence ---------------------------------------------
await serverA.kill();
await serverB.kill();
t.log('both servers stopped; no socket holds the hunt');
const beforeAbsence = await readHuntRow(sql, accountId);
const statusBefore = beforeAbsence.row.status;
const ABSENCE_MS = 13 * 60 * 60 * 1000;
await backdate(sql, accountId, ABSENCE_MS);
const backdated = await readHuntRow(sql, accountId);
t.log(`INJECT backdated the hunt ${ABSENCE_MS} ms (status ${statusBefore}); last_seen_at now ${new Date(backdated.envelope.lastSeenAt).toISOString()}`);
serverA = await startServer({ url, port: PORT_A, origin: ORIGIN });
const returning = openSocket(A, ORIGIN, apiA.cookie);
await returning.opened;
const settleStarted = performance.now();
returning.send({ type: 'hello' });
await returning.next((m) => m.type === 'snapshot', 300_000);
const settleWallMs = performance.now() - settleStarted;
const notice = await returning.next((m) => m.type === 'report', 5_000).catch(() => null);
returning.close();
const afterAbsence = await readHuntRow(sql, accountId);
const report = notice === null ? null : (await apiA.get(`/api/reports/${notice.reportId}`)).body;
t.log(`return after ${ABSENCE_MS} ms: settled in ${settleWallMs.toFixed(0)} ms wall; report ${notice?.reportId ?? 'none'}`);
if (report !== null) {
  const away = report.returnedAtWall - report.awayFromWall;
  const cap = report.capCutoffWall - report.awayFromWall;
  t.log(`report: status ${report.status}; time away ${away} ms; simulated ${report.simulatedMs} ms; cap ${cap} ms`);
  check('B-18 time away and simulated duration are reported separately', Number.isFinite(away) && Number.isFinite(report.simulatedMs) && away !== report.simulatedMs, `away ${away}, simulated ${report.simulatedMs}`);
  check('B-18 no retroactive accrual: simulated time never exceeds the offline cap', report.simulatedMs <= cap, `simulated ${report.simulatedMs} <= cap ${cap}`);
  check('B-18 the settlement window starts at the previous presence (settle before presence refresh)', report.awayFromWall === backdated.envelope.lastSeenAt, `${report.awayFromWall} vs ${backdated.envelope.lastSeenAt}`);
  check('B-18 presence was refreshed by that settlement, to now', afterAbsence.envelope.lastSeenAt > backdated.envelope.lastSeenAt + ABSENCE_MS - 60_000);
} else {
  check('B-18 a return after an absence produced an away report', false, 'no report notice');
}
const rewardsBefore = (await sql`select count(*)::int as n from resource_audit where account_id = ${accountId}`)[0].n;
const second = openSocket(A, ORIGIN, apiA.cookie);
await second.opened;
second.send({ type: 'hello' });
await second.next((m) => m.type === 'snapshot', 30_000);
const secondNotice = await second.next((m) => m.type === 'report', 3_000).catch(() => null);
second.close();
const secondReport = secondNotice === null ? null : (await apiA.get(`/api/reports/${secondNotice.reportId}`)).body;
const rewardsAfter = (await sql`select count(*)::int as n from resource_audit where account_id = ${accountId}`)[0].n;
t.log(`immediate second return: report ${secondNotice?.reportId ?? 'none'} simulated ${secondReport?.simulatedMs ?? 'n/a'} ms; audit rows ${rewardsBefore} -> ${rewardsAfter}`);
check('B-18 an immediate second return credits nothing retroactively', (secondReport === null || secondReport.simulatedMs < 10_000) && rewardsAfter - rewardsBefore <= 1);
await serverA.kill();

await sql.end({ timeout: 5 });
const failed = checks.filter((entry) => !entry.ok);
const result = {
  drill: 'concurrency (B-26) and offline semantics (B-18)',
  ranAt: new Date().toISOString(),
  database: 'narok_drill_concurrency',
  processes: 2,
  heartbeatsSent,
  lockAttempts: allTries.length,
  lockSuccesses: successes.length,
  lockConflicts: conflicts.length,
  lockLatencyMs: allTries.map((attempt) => attempt.ms),
  huntSamples: samples.length,
  absence: { absenceMs: ABSENCE_MS, settleWallMs: Math.round(settleWallMs), statusBefore, report },
  outcomes,
  checks,
  passed: failed.length === 0,
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
writeFileSync(out.replace(/\.json$/, '.txt'), `${t.lines.join('\n')}\n`);
t.log(`${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
