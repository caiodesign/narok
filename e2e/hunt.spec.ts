/**
 * Gate B-24, the end-to-end smoke, in both languages (B-20's PT-BR run).
 *
 * Chromium against the built-and-previewed `apps/client`, whose preview
 * proxies `/api` and `/ws` to a real `apps/server` on a freshly migrated
 * PostgreSQL database (`playwright.config.ts`, ruling R197). Nothing here is a
 * fake: the hunt is the server's, the events are what it released, and the
 * away report is the one its settlement wrote.
 *
 * Ruling R197 shapes the first step. Milestone B ships no sign-in screen, no
 * party-creation screen and no route that creates a preset (onboarding is
 * Phase C), so "register or log in, configure party" goes through the
 * server's real REST routes — `page.request` shares the page's cookie jar, so
 * the session it obtains is the one the bundle then uses — and the account's
 * first strategy and loot presets are seeded by
 * `apps/server/test/harness/provision-presets.ts`. Everything after that is the
 * shipped UI: the Strategy screen (one edit, saved through the real
 * `PUT /api/presets/:id`), Start hunt, the live log, the reconnect,
 * Away, Stop, and the three town routes.
 *
 * Accessible names are read from the committed locale files at run time (the
 * `e2e/laboratory.spec.ts` pattern), and every wait is a condition — there is
 * no `waitForTimeout` in this file. The socket is routed through
 * `page.routeWebSocket` only to observe what the server released and to drop
 * the connection on demand; every message is forwarded unchanged.
 *
 * The negative assertions ride inline: the shown elapsed time never passes
 * what the server has released (no future event is rendered), no Pause or
 * Resume control exists, and the offline cap on the away report is the
 * server's own figure, never a literal.
 */
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { escape, LAB, LOCALES, onboard, s, seconds, useLanguage } from './support/flow';

interface Released {
  /** The newest released simulation instant, from frames and snapshots. */
  maxSimMs: number;
  frames: number;
  events: number;
}

/** Routes `/ws` transparently, recording what was released and keeping the live route for a drop. */
async function observeSocket(page: Page) {
  const released: Released = { maxSimMs: 0, frames: 0, events: 0 };
  const routes: WebSocketRoute[] = [];
  await page.routeWebSocket(
    (url) => url.pathname === '/ws',
    (ws) => {
      const server = ws.connectToServer();
      routes.push(ws);
      ws.onMessage((message) => server.send(message));
      server.onMessage((message) => {
        const parsed = JSON.parse(String(message)) as { type: string; state?: { nowMs: number }; events?: unknown[] };
        if ((parsed.type === 'frame' || parsed.type === 'snapshot') && parsed.state !== undefined) {
          released.maxSimMs = Math.max(released.maxSimMs, parsed.state.nowMs);
          released.frames += 1;
          released.events += parsed.events?.length ?? 0;
        }
        ws.send(message);
      });
      ws.onClose(() => server.close());
      server.onClose(() => ws.close());
    },
  );
  return {
    released,
    get connections() {
      return routes.length;
    },
    /** Drops the live connection from the network's side, as a lost link would. */
    async drop() {
      const live = routes.at(-1);
      if (live === undefined) throw new Error('no socket to drop');
      await live.close({ code: 4000, reason: 'network drop' });
    },
  };
}

for (const language of ['en', 'pt-BR'] as const) {
  test(`B-24: sign in, configure, hunt, reconnect, away report, stop, town — ${language}`, async ({ page }) => {
    test.setTimeout(180_000);
    const t = LOCALES[language];
    await useLanguage(page, language);
    await onboard(page, `b24-${language.toLowerCase()}`);
    const socket = await observeSocket(page);

    await page.goto('/');
    await expect(page.locator('html')).toBeVisible();

    // No Pause or Resume control, in either language (R166).
    const labControls = LAB.flatMap((lab) => [s(lab, 'controls.pause'), s(lab, 'controls.resume')]);
    const noLabControls = async () => {
      for (const name of labControls) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    };
    await noLabControls();

    // Configure: the Strategy screen shows the account's saved preset; one
    // edit marks it unsaved, and Save is a real `PUT /api/presets/:id` whose
    // acknowledgement — not the click — clears the marker (part 4 §3.2).
    const orders = page.getByRole('region', { name: s(t, 'hunt.orders') });
    await expect(orders.getByRole('button', { name: new RegExp(escape(s(t, 'hunt.openStrategy'))) })).toContainText('Main');
    await orders.getByRole('button', { name: new RegExp(escape(s(t, 'hunt.openStrategy'))) }).click();
    const strategy = page.getByTestId('strategy-screen');
    const dirtyNote = strategy.getByTestId('dirty-note');
    await expect(dirtyNote).toHaveText(s(t, 'strategy.saved').replace('{{version}}', '1'));
    const restHp = strategy.getByLabel(s(t, 'controls.restHp'), { exact: true });
    await expect(restHp).toHaveValue('50');
    await restHp.fill('61');
    await expect(dirtyNote).toHaveText(s(t, 'strategy.unsavedDraft'));
    await expect(strategy.getByRole('img', { name: s(t, 'strategy.unsaved'), exact: true })).toHaveCount(1);
    const saved = page.waitForResponse(
      (response) => /\/api\/presets\/[^/]+$/.test(new URL(response.url()).pathname) && response.request().method() === 'PUT',
    );
    await strategy.getByRole('button', { name: s(t, 'strategy.save'), exact: true }).click();
    const saveResponse = await saved;
    expect(saveResponse.status()).toBe(200);
    expect(saveResponse.request().postDataJSON()).toMatchObject({ payload: { rest: { hpStart: 61 } } });
    await expect(dirtyNote).toHaveText(s(t, 'strategy.saved').replace('{{version}}', '2'));
    await expect(strategy.getByRole('img', { name: s(t, 'strategy.unsaved'), exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: s(t, 'strategy.close'), exact: true }).click();
    await expect(page.getByRole('button', { name: s(t, 'strategy.save'), exact: true })).toHaveCount(0);

    // Start hunt.
    const start = page.getByRole('button', { name: s(t, 'hunt.start'), exact: true });
    await expect(start).toBeEnabled();
    await start.click();
    await expect(page.getByTestId('orders-help')).toHaveText(s(t, 'hunt.runningHelp'));

    // Elapsed released events: the readout leaves zero and the log fills.
    const elapsedLabel = s(t, 'metrics.elapsed');
    const elapsed = page.locator(`[aria-label^="${elapsedLabel}: "]`);
    await expect.poll(async () => seconds((await elapsed.getAttribute('aria-label')) ?? ''), { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
    const rows = page.getByRole('list', { name: s(t, 'log.rows') }).locator('li');
    await expect.poll(() => rows.count(), { timeout: 30_000 }).toBeGreaterThan(0);

    // No future event is rendered: what is shown never passes what was released.
    for (let sample = 0; sample < 5; sample += 1) {
      const shown = seconds((await elapsed.getAttribute('aria-label')) ?? '');
      expect(shown * 1000).toBeLessThanOrEqual(socket.released.maxSimMs);
      await expect.poll(async () => seconds((await elapsed.getAttribute('aria-label')) ?? '')).toBeGreaterThan(shown);
    }
    expect(socket.released.events).toBeGreaterThan(0);

    // Drop and reconnect: the server settles the absence and announces its report; Away opens.
    const reportRead = page.waitForResponse((response) => /\/api\/reports\//.test(response.url()) && response.status() === 200);
    const before = socket.connections;
    await socket.drop();
    await expect.poll(() => socket.connections, { timeout: 30_000 }).toBeGreaterThan(before);
    const report = (await (await reportRead).json()) as { capCutoffWall: number; awayFromWall: number; simulatedMs: number };
    await expect(page.getByRole('heading', { level: 1, name: s(t, 'away.title') })).toBeVisible();

    // Time away and simulated duration are reported separately (B-18), and the
    // cap is the server's figure, never a literal (part 4 §4).
    // The frozen Away sheet shows time away in the herald (it hides the
    // duplicate `.fact--away`); the simulated share of the cap is its own fact.
    const template = (key: string) => new RegExp(escape(s(t, key)).replace(/\\\{\\\{\w+\\\}\\\}/g, '.+'));
    await expect(page.locator('.herald-sub')).toContainText(s(t, 'away.credited'));
    await expect(page.locator('.herald-sub b')).toHaveText(/\d/);
    await expect(page.getByText(template('away.fact.simulated'))).toBeVisible();
    const meter = page.getByRole('meter', { name: s(t, 'away.capMeter') });
    await expect(meter).toHaveAttribute('aria-valuemax', String(report.capCutoffWall - report.awayFromWall));
    await expect(page.locator('body')).not.toContainText(/17\s*h\s*42/);
    await expect(page.getByText(s(t, 'away.credited'))).toBeVisible();

    // Return to hunt: still running, the log resumes.
    await page.getByRole('button', { name: s(t, 'away.action.view-hunt'), exact: true }).click();
    await expect(page.getByTestId('orders-help')).toHaveText(s(t, 'hunt.runningHelp'));
    await noLabControls();

    // Stop: the party returns to town; the second control starts a *new* hunt.
    await page.getByRole('button', { name: s(t, 'hunt.stop'), exact: true }).click();
    await expect(page.getByTestId('orders-help')).toHaveText(s(t, 'hunt.stoppedHelp.operator'), { timeout: 30_000 });
    await expect(page.getByRole('button', { name: s(t, 'hunt.newHunt'), exact: true })).toBeEnabled();
    await noLabControls();

    // Town: Bag, then Character, then back to Hunt.
    await orders.getByRole('button', { name: new RegExp(escape(s(t, 'hunt.lootFilter'))) }).click();
    await expect(page.getByRole('heading', { level: 1, name: s(t, 'bag.screen') })).toBeVisible();
    // The back control names the place, then the state: "<zone> In town, return to hunt".
    await page.getByRole('button', { name: new RegExp(`${escape(s(t, 'town.back.inTown'))}$`) }).click();
    await orders.getByRole('button', { name: new RegExp(`^${escape(s(t, 'hunt.party'))}`) }).click();
    await expect(page.getByRole('heading', { level: 1, name: s(t, 'character.title') })).toBeVisible();
    await page
      .getByRole('navigation', { name: s(t, 'town.nav.label') })
      .getByRole('button', { name: new RegExp(`^${escape(s(t, 'town.nav.hunt'))}`) })
      .click();
    await expect(page.getByRole('button', { name: s(t, 'hunt.newHunt'), exact: true })).toBeVisible();

    // A new hunt from town reaches the socket that watched the stopped one
    // (R198). The server refuses a start while the party is still travelling
    // to town (ten seconds of content), so the start is retried until it is
    // accepted — a condition, not a sleep.
    const framesBefore = socket.released.frames;
    await expect(async () => {
      const again = page.getByRole('button', { name: s(t, 'hunt.newHunt'), exact: true });
      if (await again.isEnabled()) await again.click();
      await expect(page.getByTestId('orders-help')).toHaveText(s(t, 'hunt.runningHelp'), { timeout: 2_000 });
    }).toPass({ timeout: 45_000 });
    await expect.poll(() => socket.released.frames, { timeout: 30_000 }).toBeGreaterThan(framesBefore + 2);
    await expect.poll(async () => seconds((await elapsed.getAttribute('aria-label')) ?? ''), { timeout: 30_000 }).toBeGreaterThan(0);
  });
}
