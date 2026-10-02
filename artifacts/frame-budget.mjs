/**
 * Task 11 — gate B-23: the HUD's per-frame cost under a live socket.
 *
 * Builds nothing; run `pnpm --filter @narok/client build` first. Starts a real
 * `apps/server` on a fresh harness database, serves the built client with
 * `vite preview` proxying `/api` and `/ws` to it (R197), onboards an account
 * through the real routes, starts a hunt from the shipped UI, and measures a
 * window of live play in headless Chromium.
 *
 * "The highest supported release rate": the server releases on one fixed
 * cadence (`RELEASE_TICK_MS`, 1,000 ms, `apps/server/src/compose.ts`) and the
 * client plays at 1x (part 4 §7, production playback speed is an open
 * decision), so there is exactly one supported rate and this measures it.
 *
 * Method. Milestone A's R109 figures (44.4 ms and 3.85 ms per frame) are
 * recorded in the port record without the method that produced them, so this
 * cannot claim to repeat it; it states its own:
 *   - per-frame main-thread cost = Δ CDP `Performance.getMetrics` TaskDuration
 *     over the window ÷ frames presented in it (a `requestAnimationFrame`
 *     counter in the page), with the Script/Layout/RecalcStyle shares;
 *   - the frame-interval distribution from the same rAF timestamps, and how
 *     many intervals missed a vsync (over 25 ms).
 * A level-1 party in the bundled content wipes within minutes, so whenever
 * the hunt stops during the window the script starts a new one from the
 * shipped control at once; the restarts are counted and reported, and the
 * socket stays live throughout.
 * Headless Chromium on this workstation: a workstation result, not a target
 * device result.
 *
 * Usage: node artifacts/frame-budget.mjs artifacts/b23-frames.json [windowSeconds]
 */
import { writeFileSync } from 'node:fs';
import { cpus, totalmem, platform, release } from 'node:os';
import { chromium } from '@playwright/test';
import { onboardPage, prepareDatabase, startPreview, startServer, summarize } from '../e2e/support/server.mjs';

const out = process.argv[2] ?? 'artifacts/b23-frames.json';
const windowSeconds = Number(process.argv[3] ?? 30);
const API_PORT = 8795;
const PREVIEW_PORT = 4175;
const origin = `http://127.0.0.1:${PREVIEW_PORT}`;

const url = await prepareDatabase('narok_frames');
const server = await startServer({ url, port: API_PORT, origin });
const preview = await startPreview({ port: PREVIEW_PORT, apiUrl: `http://127.0.0.1:${API_PORT}` });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const tag = crypto.randomUUID().slice(0, 4);
  await onboardPage(page, { url, origin, email: `frames-${tag}@example.com`, names: [`Aster${tag}`, `Brin${tag}`, `Coda${tag}`] });
  const socketFrames = { count: 0, events: 0 };
  page.on('websocket', (ws) => ws.on('framereceived', (frame) => {
    try {
      const message = JSON.parse(String(frame.payload));
      if (message.type === 'frame') {
        socketFrames.count += 1;
        socketFrames.events += message.events.length;
      }
    } catch {
      /* not JSON: ignored */
    }
  }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Start hunt', exact: true }).click();
  await page.getByTestId('orders-help').filter({ hasText: 'Stop returns the party to town' }).waitFor();
  // Let the buffer fill and the stream settle into steady state before measuring.
  await page.waitForFunction(() => {
    const label = document.querySelector('[aria-label^="Simulated elapsed: "]')?.getAttribute('aria-label') ?? '';
    return /\d/.test(label) && !/: —$/.test(label);
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));

  await page.evaluate(() => {
    const stamps = [];
    window.__frames = stamps;
    const loop = (now) => {
      stamps.push(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const before = await metrics();
  const framesBefore = await page.evaluate(() => window.__frames.length);
  let restarts = 0;
  const until = Date.now() + windowSeconds * 1000;
  const again = page.getByRole('button', { name: 'Start a new hunt', exact: true });
  while (Date.now() < until) {
    if (await again.isEnabled().catch(() => false)) {
      await again.click();
      restarts += 1;
      // One start per stop: wait for the server's running state before looking again.
      await page.getByTestId('orders-help').filter({ hasText: 'Stop returns the party to town' }).waitFor({ timeout: 15_000 }).catch(() => undefined);
    }
    await page.waitForTimeout(500);
  }
  const after = await metrics();
  const stamps = await page.evaluate(() => window.__frames.slice());
  const stillRunning = await page.getByTestId('orders-help').textContent();
  const presented = stamps.length - framesBefore;
  const intervals = [];
  for (let index = framesBefore + 1; index < stamps.length; index += 1) intervals.push(stamps[index] - stamps[index - 1]);

  const delta = (name) => (after[name] - before[name]) * 1000;
  const perFrame = (name) => delta(name) / presented;
  const result = {
    gate: 'B-23',
    ranAt: new Date().toISOString(),
    label: 'WORKSTATION RESULT (headless Chromium), not a target-device result',
    hardware: { platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemGiB: +(totalmem() / 2 ** 30).toFixed(1) },
    browser: browser.version(),
    viewport: '1440x900',
    releaseTickMs: 1000,
    playbackSpeed: 1,
    windowSeconds,
    framesPresented: presented,
    socketFramesReceived: socketFrames.count,
    socketEventsReceived: socketFrames.events,
    perFrameMs: {
      task: +perFrame('TaskDuration').toFixed(3),
      script: +perFrame('ScriptDuration').toFixed(3),
      layout: +perFrame('LayoutDuration').toFixed(3),
      recalcStyle: +perFrame('RecalcStyleDuration').toFixed(3),
    },
    frameIntervalMs: Object.fromEntries(Object.entries(summarize(intervals)).map(([key, value]) => [key, typeof value === 'number' ? +value.toFixed(2) : value])),
    // A presented interval of 16.7 ms is one vsync; one over 25 ms means a frame was missed.
    intervalsMissingAFrame: intervals.filter((interval) => interval > 25).length,
    huntRestartsDuringWindow: restarts,
    huntStillRunningAtEnd: (stillRunning ?? '').includes('Stop returns the party to town'),
    budgetMs: 16.7,
  };
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  await preview.kill();
  await server.kill();
}
