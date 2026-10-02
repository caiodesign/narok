/**
 * Final-review I3 — how long a returning player's 12-hour catch-up holds the
 * API event loop, measured on this workstation (ruling R202).
 *
 * Catch-up runs inline in B (`compose.ts`: `new SegmentPool(inlineExecutor(sim))`),
 * not in the worker the plan's Task 3 interface names. This measures what that
 * costs: the reconnect path a socket's `hello` takes after a full absence —
 * `LifecycleFeed.connect`, which settles the absence in summary mode with the
 * away-report digest folded (R192), stores the report, and builds the view —
 * against a real PostgreSQL harness database, through the composed server
 * dependencies exactly as `main.ts` builds them.
 *
 * The hunt is the gameplay fixture's party (guardian, cleric, ranger, mixed
 * recipe, default placement and strategy) as a laboratory hunt, because a
 * level-1 party with real progression wipes within minutes (results §4.3) and
 * would settle minutes, not twelve hours. Each hunt is started, then
 * backdated twelve hours (the offline cap), then reconnected.
 *
 * Two measurements, both on the main thread:
 *   - wall time of each `connect` (hrtime);
 *   - the event-loop block: the longest gap a 1 ms interval saw while the
 *     reconnects ran (`maxGapMs`), and `perf_hooks.monitorEventLoopDelay`'s max.
 * Run once one at a time (`sequential`), then sixteen returning at once
 * (`concurrent16`), which the inline executor serialises on the one thread.
 *
 * Usage: node --import tsx artifacts/catchup-12h.ts artifacts/catchup-12h.json
 * Uses only the harness database `narok_drill_catchup` (created fresh, dropped after).
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { cpus, totalmem } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { backdate, dropDatabase, prepareDatabase, readHuntRow, sqlFor, summarize } from '../e2e/support/server.mjs';
import { compose } from '../apps/server/src/compose';
import { startHunt, type HuntPlan } from '../apps/server/src/hunt/lifecycle';
import type { LifecycleFeed } from '../apps/server/src/hunt/feed';

const requireServer = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { defaultBag, defaultPlacement, defaultStrategy, starterLoot } = (await import(
  pathToFileURL(requireServer.resolve('@narok/sim')).href
)) as typeof import('@narok/sim');

const OUT = process.argv[2] ?? 'artifacts/catchup-12h.json';
const DATABASE = 'narok_drill_catchup';
const TWELVE_HOURS = 12 * 60 * 60 * 1000;
const SEQUENTIAL = 5;
const CONCURRENT = 16;
const classes = ['guardian', 'cleric', 'ranger'] as const;

function plan(): HuntPlan {
  return {
    mapId: 'prototype',
    input: {
      classes: [...classes],
      recipe: 'mixed',
      placement: defaultPlacement([...classes]),
      strategies: Object.fromEntries(classes.map((id, index) => [`p${index}`, defaultStrategy(id)])),
      rest: { hpStart: 50, mpStart: 30 },
    },
    activeStrategy: { presetId: crypto.randomUUID(), presetVersion: 1 },
    activeLoot: { presetId: crypto.randomUUID(), presetVersion: 1 },
    setup: { loot: starterLoot(), bag: defaultBag(), dropProtection: { epicPlus: 0, legendary: 0 } },
  };
}

/** The longest main-thread stall while `run` executes. */
async function blocking<T>(run: () => Promise<T>): Promise<{ result: T; wallMs: number; maxGapMs: number; histogramMaxMs: number }> {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  let last = performance.now();
  let maxGapMs = 0;
  const probe = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
  }, 1);
  const started = process.hrtime.bigint();
  const result = await run();
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  // One more turn, so a stall that ended with `run` is seen by the probe.
  await new Promise((resolve) => setTimeout(resolve, 5));
  clearInterval(probe);
  maxGapMs = Math.max(maxGapMs, performance.now() - last);
  histogram.disable();
  return { result, wallMs, maxGapMs, histogramMaxMs: histogram.max / 1e6 };
}

const url = await prepareDatabase(DATABASE);
const sql = sqlFor(url);
const composed = compose({ DATABASE_URL: url });
const lifecycle = composed.deps.hunts!.lifecycle;
const feed = composed.deps.huntFeed as LifecycleFeed;

async function awayHunt(): Promise<string> {
  const [account] = await sql`
    insert into accounts (email, password_hash, password_algorithm, password_changed_at, bag_capacity)
    values (${`catchup-${crypto.randomUUID()}@example.com`}, 'hash', 'test', ${Date.now()}, 100)
    returning id`;
  await startHunt(lifecycle, { accountId: account.id, expectedStateVersion: 0, plan: plan() });
  await backdate(sql, account.id, TWELVE_HOURS);
  return account.id;
}

async function settledSpan(accountId: string) {
  const { row, state } = await readHuntRow(sql, accountId);
  return { status: row.status, simNowMs: state.nowMs, stopReason: state.stopReason ?? null };
}

try {
  const sequential = [];
  for (let i = 0; i < SEQUENTIAL; i++) {
    const accountId = await awayHunt();
    const measured = await blocking(() => feed.connect(accountId));
    sequential.push({
      wallMs: measured.wallMs,
      maxGapMs: measured.maxGapMs,
      histogramMaxMs: measured.histogramMaxMs,
      reportId: measured.result?.reportId ?? null,
      ...(await settledSpan(accountId)),
    });
    console.log(`sequential ${i + 1}/${SEQUENTIAL}`, JSON.stringify(sequential.at(-1)));
  }

  const ids = [];
  for (let i = 0; i < CONCURRENT; i++) ids.push(await awayHunt());
  const together = await blocking(() => Promise.all(ids.map((id) => feed.connect(id))));
  const spans = await Promise.all(ids.map(settledSpan));
  const concurrent16 = {
    totalWallMs: together.wallMs,
    maxGapMs: together.maxGapMs,
    histogramMaxMs: together.histogramMaxMs,
    reports: together.result.filter((view) => view?.reportId !== undefined).length,
    simNowMs: summarize(spans.map((span) => span.simNowMs)),
    stopped: spans.filter((span) => span.status !== 'running').length,
  };
  console.log('concurrent16', JSON.stringify(concurrent16));

  const result = {
    metadata: {
      measuredAt: new Date().toISOString(),
      nodeVersion: process.version,
      platform: process.platform,
      cpuModel: cpus()[0]?.model.trim(),
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      executor: 'inline (compose.ts), the API process main thread',
      absenceMs: TWELVE_HOURS,
      path: 'LifecycleFeed.connect: summary settlement with digest (R192), away report, view',
      hunt: 'laboratory party guardian/cleric/ranger, mixed recipe, default placement and strategy',
    },
    sequential: {
      runs: sequential,
      wallMs: summarize(sequential.map((run) => run.wallMs)),
      maxGapMs: summarize(sequential.map((run) => run.maxGapMs)),
    },
    concurrent16,
  };
  writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`wrote ${OUT}`);
} finally {
  await composed.close();
  await sql.end({ timeout: 5 });
  await dropDatabase(DATABASE);
}
process.exit(0);
