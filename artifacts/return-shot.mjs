/**
 * The return journey after Stop (milestone B §4.3), shot over the shipped
 * client against a real server: start a hunt, stop it, and capture the Orders
 * window while the party travels home — Start a new hunt disabled and the
 * countdown under it — then again once the party is in town and Start is
 * enabled. Run `pnpm --filter @narok/client build` first.
 *
 * Usage: node artifacts/return-shot.mjs http://127.0.0.1:4173/ artifacts/town
 * (SHOTS_DATABASE and SHOTS_API_PORT name another harness database and API
 * port, as for `town-shots.mjs`.)
 */
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { onboardPage, prepareDatabase, sqlFor, startPreview, startServer } from '../e2e/support/server.mjs';

const target = new URL(process.argv[2] ?? 'http://127.0.0.1:4173/');
const outDir = process.argv[3] ?? 'artifacts/town';
mkdirSync(outDir, { recursive: true });
const API_PORT = Number(process.env.SHOTS_API_PORT ?? 8797);
const origin = `http://127.0.0.1:${target.port}`;

const url = await prepareDatabase(process.env.SHOTS_DATABASE ?? 'narok_shots');
const sql = sqlFor(url);
const server = await startServer({ url, port: API_PORT, origin });
const preview = await startPreview({ port: Number(target.port), apiUrl: `http://127.0.0.1:${API_PORT}` });
const browser = await chromium.launch();

const STRINGS = {
  en: { start: 'Start hunt', stop: 'Stop', newHunt: 'Start a new hunt' },
  'pt-BR': { start: 'Iniciar caçada', stop: 'Parar', newHunt: 'Iniciar nova caçada' },
};

try {
  for (const language of ['en', 'pt-BR']) {
    const s = STRINGS[language];
    const context = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 800 } });
    await context.addInitScript((value) => window.localStorage.setItem('narok.language', value), language);
    const page = await context.newPage();
    const tag = crypto.randomUUID().slice(0, 4);
    await onboardPage(page, {
      url,
      origin,
      email: `return-${language.toLowerCase()}-${tag}@example.com`,
      names: [`Guardiã${tag}`, `Clérigo${tag}`, `Patrulheira${tag}`],
      forwardedFor: `198.51.100.${language === 'en' ? 71 : 72}`,
    });
    await page.goto('/');
    await page.getByRole('button', { name: s.start, exact: true }).click();
    const stop = page.getByRole('button', { name: s.stop, exact: true });
    await stop.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.log li').length > 3);
    await stop.click();
    const again = page.getByRole('button', { name: s.newHunt, exact: true });
    await page.getByTestId('orders-travel').waitFor();
    const travelling = { disabled: await again.isDisabled(), note: await page.getByTestId('orders-travel').textContent() };
    await page.screenshot({ path: `${outDir}/${language}-returning-1280x800.png` });
    await again.waitFor({ state: 'visible' });
    await page.waitForFunction((name) => {
      const button = [...document.querySelectorAll('button')].find((each) => each.textContent?.trim().endsWith(name));
      return button !== undefined && !button.disabled;
    }, s.newHunt, { timeout: 30_000 });
    await page.screenshot({ path: `${outDir}/${language}-in-town-1280x800.png` });
    console.log(`${language}: while returning, Start a new hunt disabled=${travelling.disabled}, note "${travelling.note}"; in town, enabled=${await again.isEnabled()}`);
    await context.close();
  }
} finally {
  await browser.close();
  await preview.kill();
  await server.kill();
  await sql.end({ timeout: 5 });
}
