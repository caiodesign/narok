/**
 * Task 11 — B-22's screenshots, B-22's overflow probe and B-21's automated
 * half, over the shipped client against a real server.
 *
 * The `hud-shots.mjs` pattern extended to the three routes milestone B added
 * (Bag, Character, Away) plus Hunt and Strategy, in EN and PT-BR, at
 * 1440×900 and 1280×800, with `clip-probe.mjs`'s overflow probe at 1100×800.
 * Run `pnpm --filter @narok/client build` first; the script starts its own
 * `apps/server` on a fresh harness database and serves the build with
 * `vite preview` on the URL's port, proxying `/api` and `/ws` (R197).
 *
 * The Away report is a real one: the hunt runs, the page closes, the hunt's
 * wall anchors are backdated two hours in the database (the drill's stand-in
 * for an absence), and the next page load reconnects and settles it.
 *
 * B-21's automated checks, recorded beside the screenshots:
 *   - focus visibility: on each screen, Tab through up to 40 stops and record,
 *     for each focused element, whether its outline, shadow, border or
 *     background differs from the same element blurred;
 *   - reduced motion: with `prefers-reduced-motion: reduce`, the hunt's log
 *     keeps receiving rows (information stays complete) and running
 *     animations are counted.
 * These are necessary, not sufficient: keyboard-only traversal is a human
 * observation, and so is looking at the pages (B-22). Neither closes R64.
 *
 * Usage: node artifacts/town-shots.mjs http://127.0.0.1:4173/ artifacts/town
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { backdate, onboardPage, prepareDatabase, sqlFor, startPreview, startServer } from '../e2e/support/server.mjs';

const target = new URL(process.argv[2] ?? 'http://127.0.0.1:4173/');
const outDir = process.argv[3] ?? 'artifacts/town';
mkdirSync(outDir, { recursive: true });
// A second run beside another (another worktree, another agent) names its own
// harness database and API port; the preview port is the URL's.
const API_PORT = Number(process.env.SHOTS_API_PORT ?? 8797);
const origin = `http://127.0.0.1:${target.port}`;

const url = await prepareDatabase(process.env.SHOTS_DATABASE ?? 'narok_shots');
const sql = sqlFor(url);
const server = await startServer({ url, port: API_PORT, origin });
const preview = await startPreview({ port: Number(target.port), apiUrl: `http://127.0.0.1:${API_PORT}` });
const browser = await chromium.launch();

const STRINGS = {
  en: { start: 'Start hunt', newHunt: 'Start a new hunt', running: 'Stop returns the party to town', away: 'While you were away', bag: 'Bag and loot filter', character: 'Character', strategy: 'Edit strategy', close: 'Close strategy editor', review: 'Review', party: 'Party', loot: 'Loot filter' },
  'pt-BR': { start: 'Iniciar caçada', newHunt: 'Iniciar nova caçada', running: 'Parar leva o grupo', away: 'Enquanto você esteve fora', bag: 'Bolsa e filtro de saque', character: 'Personagem', strategy: 'Editar estratégia', close: 'Fechar o editor de estratégia', review: 'Revisar', party: 'Grupo', loot: 'Filtro de saque' },
};

async function clipProbe(page) {
  return page.evaluate(() => {
    const found = [];
    for (const el of document.querySelectorAll('.realm *')) {
      const dy = el.scrollHeight - el.clientHeight;
      const dx = el.scrollWidth - el.clientWidth;
      if (dy <= 8 && dx <= 8) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const scrolls = /auto|scroll/.test(style.overflowY + style.overflowX);
      found.push({
        sel: el.className.toString().split(' ').slice(0, 3).join('.') || el.tagName,
        dx, dy, overflow: `${style.overflowX}/${style.overflowY}`, scrolls,
        text: (el.textContent ?? '').trim().slice(0, 48),
      });
    }
    return {
      documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      clipped: found.filter((entry) => !entry.scrolls),
      scrolling: found.filter((entry) => entry.scrolls).length,
    };
  });
}

async function focusWalk(page, stops = 40) {
  const walk = [];
  await page.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => undefined);
  for (let index = 0; index < stops; index += 1) {
    await page.keyboard.press('Tab');
    const entry = await page.evaluate(() => {
      const el = document.activeElement;
      if (el === null || el === document.body) return null;
      // A text input's indicator may be drawn on the label that frames it
      // (the Bag's search field): that frame is compared as well.
      const frame = el.matches('input') ? el.closest('label') : null;
      const lookOf = (node) => {
        const style = getComputedStyle(node);
        return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor} | ${style.boxShadow} | ${style.borderColor} | ${style.backgroundColor}`;
      };
      const look = () => (frame === null ? lookOf(el) : `${lookOf(el)} || ${lookOf(frame)}`);
      const focusVisible = el.matches(':focus-visible');
      const focused = look();
      // The same element unfocused, then focus restored, so Tab continues from it.
      el.blur();
      const unfocused = look();
      el.focus();
      const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/s+/g, ' ').slice(0, 50);
      return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), name, focusVisible, indicator: focused !== unfocused };
    });
    if (entry === null) continue;
    walk.push(entry);
  }
  return {
    stops: walk.length,
    withIndicator: walk.filter((entry) => entry.indicator).length,
    withoutIndicator: walk.filter((entry) => !entry.indicator).map((entry) => `${entry.tag}${entry.role ? `[${entry.role}]` : ''} "${entry.name}"`),
  };
}

const report = { ranAt: new Date().toISOString(), viewports: ['1440x900', '1280x800', '1100x800 (shot and probe)'], languages: {}, files: [] };
try {
  for (const language of ['en', 'pt-BR']) {
    const s = STRINGS[language];
    const context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 900 } });
    await context.addInitScript((value) => window.localStorage.setItem('narok.language', value), language);
    let page = await context.newPage();
    const tag = crypto.randomUUID().slice(0, 4);
    const email = `shots-${language.toLowerCase()}-${tag}@example.com`;
    // PT-BR-length names on purpose: long names must not hide controls (part 4 §5).
    await onboardPage(page, { url, origin, email, names: [`Guardiã${tag}`, `Clérigo${tag}`, `Patrulheira${tag}`], forwardedFor: `198.51.100.${language === 'en' ? 61 : 62}` });
    await page.goto('/');
    await page.getByRole('button', { name: s.start, exact: true }).click();
    await page.getByTestId('orders-help').filter({ hasText: s.running }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.log li').length > 3);
    const entry = { screens: {}, a11y: {} };
    const shoot = async (screen) => {
      // 1100×800 is shot as well as probed: the probe's overflows are judged on it.
      for (const [w, h] of [[1440, 900], [1280, 800], [1100, 800]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const file = `${outDir}/${language}-${screen}-${w}x${h}.png`;
        await page.screenshot({ path: file });
        report.files.push(file);
      }
      await page.setViewportSize({ width: 1100, height: 800 });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      entry.screens[screen] = { probe1100: await clipProbe(page) };
      await page.setViewportSize({ width: 1440, height: 900 });
      entry.a11y[screen] = await focusWalk(page);
    };

    await shoot('hunt');
    await page.getByRole('button', { name: new RegExp(s.strategy) }).click();
    await page.getByRole('button', { name: s.close, exact: true }).waitFor();
    await shoot('strategy');
    await page.getByRole('button', { name: s.close, exact: true }).click();

    // A real absence for Away: close the page, backdate, return.
    await page.close();
    const [{ id }] = await sql`select id from accounts where email = ${email}`;
    await backdate(sql, id, 2 * 60 * 60 * 1000);
    page = await context.newPage();
    await page.goto('/');
    await page.getByRole('heading', { level: 1, name: s.away }).waitFor({ timeout: 60_000 });
    await shoot('away');
    // At 1100×800 the timeline is below the report's fold: shot scrolled into view.
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.evaluate(() => {
      const body = document.querySelector('.report-body');
      if (body !== null) body.scrollTop = body.scrollHeight;
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: `${outDir}/${language}-away-timeline-1100x800.png` });
    report.files.push(`${outDir}/${language}-away-timeline-1100x800.png`);
    await page.setViewportSize({ width: 1440, height: 900 });
    // The absence ended the hunt (a level-1 party wipes within minutes), so the
    // report's actions are Start a new hunt and the loot filter's Review, which opens Bag.
    await page.getByRole('button', { name: new RegExp(`${s.review}$`) }).click();
    await page.getByRole('heading', { level: 1, name: s.bag }).waitFor();
    await shoot('bag');
    await page.locator('.statusbar .back').click();
    await page.getByRole('button', { name: new RegExp(`^${s.party}`) }).click();
    await page.getByRole('heading', { level: 1, name: s.character }).waitFor();
    await shoot('character');

    // Reduced motion: information stays complete on the live hunt.
    const reduced = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', storageState: await context.storageState() });
    await reduced.addInitScript((value) => window.localStorage.setItem('narok.language', value), language);
    const calm = await reduced.newPage();
    await calm.goto('/');
    // Whichever start the hunt shell offers: Start hunt, or Start a new hunt after a stop.
    for (const name of [s.start, s.newHunt]) {
      const control = calm.getByRole('button', { name, exact: true });
      if (await control.isEnabled().catch(() => false)) {
        await control.click();
        break;
      }
    }
    await calm.getByTestId('orders-help').filter({ hasText: s.running }).waitFor({ timeout: 30_000 }).catch(() => undefined);
    const rowsAt = async () => calm.locator('.log li').count();
    await calm.waitForFunction(() => document.querySelectorAll('.log li').length > 0, undefined, { timeout: 30_000 }).catch(() => undefined);
    const first = await rowsAt();
    await calm.waitForFunction((n) => document.querySelectorAll('.log li').length > n, first, { timeout: 30_000 }).catch(() => undefined);
    const second = await rowsAt();
    const running = await calm.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').length);
    entry.reducedMotion = { logRowsFirst: first, logRowsLater: second, newRowsArrived: second > first, runningAnimations: running };
    await reduced.close();
    await context.close();
    report.languages[language] = entry;
  }
} finally {
  writeFileSync(`${outDir}/probe.json`, `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  await preview.kill();
  await server.kill();
  await sql.end({ timeout: 5 });
}
for (const [language, entry] of Object.entries(report.languages)) {
  for (const [screen, result] of Object.entries(entry.screens)) {
    console.log(`${language} ${screen}: 1100px document overflow-x ${result.probe1100.documentOverflowX}, clipped ${result.probe1100.clipped.length}; focus ${entry.a11y[screen].withIndicator}/${entry.a11y[screen].stops} with indicator`);
  }
  console.log(`${language} reduced motion: ${JSON.stringify(entry.reducedMotion)}`);
}
