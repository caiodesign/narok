/**
 * Milestone A browser smoke (plan task 11, ruling R69).
 *
 * Chromium only, against the built-and-previewed laboratory (`apps/lab`, the
 * `lab` project in `playwright.config.ts`). The laboratory left `apps/client`
 * in milestone B Task 8; these cases pass unchanged against it, which is the
 * proof the split lost no behaviour. Locators use accessible names and the `data-testid`
 * hooks Task 10 shipped. Every wait is condition-based — `toHaveText`,
 * `not.toHaveText`, `toBeVisible`, `toHaveCount` — and there is no
 * `waitForTimeout` or other fixed sleep anywhere in this file.
 *
 * Strict-mode note (ruling R81): an *empty* comparison slot carries no
 * `elapsed-time` test id, so a page-level `getByTestId('elapsed-time')` is
 * unambiguous only while no run has completed. Once the first run is retained
 * the document holds two, and after the second three, so every later elapsed
 * assertion is scoped to the playback group.
 *
 * The Portuguese strings below are read from the committed `pt-BR.json` files at run
 * time rather than typed here, so the smoke can never drift from the shipped
 * translation (ruling R69).
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

interface Locale {
  app: { title: string };
  board: { cell: string };
  comparison: { slotA: string };
  controls: { start: string; pause: string; resume: string; stop: string; selectCharacter: string; placementGrid: string };
  language: { 'pt-BR': string };
  status: { label: string; running: string; paused: string; stopped: string };
  stopReason: { operator: string };
}

/**
 * The client's strings with the laboratory's own layered on top, exactly as
 * `apps/lab/src/i18n.ts` merges them at run time: Pause and Resume are the
 * laboratory's alone since milestone B Task 9 (ruling R166).
 */
function locale(file: 'en.json' | 'pt-BR.json'): Locale {
  const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Record<string, Record<string, unknown>>;
  const client = read(`../apps/client/src/locales/${file}`);
  const lab = read(`../apps/lab/src/locales/${file}`);
  const merged: Record<string, Record<string, unknown>> = { ...client };
  for (const [section, values] of Object.entries(lab)) merged[section] = { ...client[section], ...values };
  return merged as unknown as Locale;
}

const en = locale('en.json');
const pt = locale('pt-BR.json');

/** `{{actor}}`/`{{position}}` interpolation, matching what i18next renders. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
}

/** The live playback readouts, scoped so `elapsed-time` stays unambiguous (R81). */
function playback(page: Page, strings: Locale) {
  return page.getByRole('group', { name: strings.status.label });
}

/**
 * A placement cell. An *occupied* cell's accessible name is its occupant's id
 * (`p0`), not its `title`, so occupancy would change the locator underneath us;
 * the title is the one stable, localized handle on a specific cell.
 */
function cell(page: Page, strings: Locale, position: string) {
  return page
    .getByRole('grid', { name: strings.controls.placementGrid })
    .getByTitle(fill(strings.board.cell, { position }), { exact: true });
}

/** Starts the configured setup, waits for the clock to move, then stops it. */
async function runAndStop(page: Page, strings: Locale): Promise<void> {
  await page.getByRole('button', { name: strings.controls.start, exact: true }).click();
  await expect(playback(page, strings).getByTestId('elapsed-time')).not.toHaveText('0 s');
  await page.getByRole('button', { name: strings.controls.stop, exact: true }).click();
  await expect(page.getByTestId('playback-status')).toHaveText(strings.status.stopped);
}

test('a player can run, pause, resume and inspect an experiment', async ({ page }) => {
  await page.goto('/');

  // Before any run completes there is exactly one `elapsed-time` in the document
  // (asserted at unit level in apps/lab/test/app.test.tsx), so the plan's
  // unscoped locator is legal here and reads the live playback clock.
  await expect(page.getByTestId('elapsed-time')).toHaveText('0 s');

  await page.getByRole('button', { name: 'Start experiment', exact: true }).click();
  await expect(page.getByTestId('elapsed-time')).not.toHaveText('0 s');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByTestId('playback-status')).toHaveText('Paused');

  // A paused clock is frozen, so this reading stays valid until Resume.
  const pausedAt = await page.getByTestId('elapsed-time').textContent();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByTestId('playback-status')).toHaveText('Running');
  await expect(page.getByTestId('elapsed-time')).not.toHaveText(pausedAt ?? '');

  await page.getByRole('button', { name: 'Stop experiment', exact: true }).click();
  await expect(page.getByTestId('comparison-slot-a')).toBeVisible();

  // The stopped run is actually retained, not merely a visible empty slot.
  const slotA = page.getByTestId('comparison-slot-a');
  await expect(slotA.getByTestId('kills')).toBeVisible();
  await expect(slotA.getByTestId('stop-reason')).toHaveText(en.stopReason.operator);
  await expect(page.getByTestId('playback-status')).toHaveText('Stopped');
  await expect(page.getByTestId('elapsed-time')).toHaveCount(2);
});

test('a second run from a changed placement fills comparison B', async ({ page }) => {
  await page.goto('/');
  await runAndStop(page, en);
  await expect(page.getByTestId('comparison-slot-a').getByTestId('kills')).toBeVisible();

  // Move p0 off its default (2,3) seat onto the empty party cell (0,3).
  const origin = cell(page, en, '2,3');
  const destination = cell(page, en, '0,3');
  await expect(origin).toHaveText('p0');
  await page.getByRole('button', { name: fill(en.controls.selectCharacter, { actor: 'p0' }), exact: true }).click();
  await destination.click();
  await expect(destination).toHaveText('p0');
  await expect(origin).toHaveText('');

  await runAndStop(page, en);

  const slotB = page.getByTestId('comparison-slot-b');
  await expect(slotB).toBeVisible();
  await expect(slotB.getByTestId('kills')).toBeVisible();
  await expect(slotB.getByTestId('walk-time')).toBeVisible();
  // Live readout plus two filled slots (R81).
  await expect(page.getByTestId('elapsed-time')).toHaveCount(3);
});

test('the same run works in Portuguese with the shipped pt-BR strings', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: pt.language['pt-BR'], exact: true }).click();
  await expect(page.getByRole('heading', { name: pt.app.title, level: 1 })).toBeVisible();

  await page.getByRole('button', { name: pt.controls.start, exact: true }).click();
  await expect(page.getByTestId('elapsed-time')).not.toHaveText('0 s');
  await page.getByRole('button', { name: pt.controls.pause, exact: true }).click();
  await expect(page.getByTestId('playback-status')).toHaveText(pt.status.paused);
  await page.getByRole('button', { name: pt.controls.resume, exact: true }).click();
  await expect(page.getByTestId('playback-status')).toHaveText(pt.status.running);
  await page.getByRole('button', { name: pt.controls.stop, exact: true }).click();
  await expect(page.getByTestId('playback-status')).toHaveText(pt.status.stopped);

  const slotA = page.getByTestId('comparison-slot-a');
  await expect(slotA).toHaveAttribute('aria-label', pt.comparison.slotA);
  await expect(slotA.getByTestId('kills')).toBeVisible();
});

/**
 * R64 left the rendered-composition check open for this task. An agent cannot
 * judge whether a layout *looks* right, so this measures only what is
 * measurable: at each width the UI spec names, the document must not scroll
 * horizontally. A human still has to look at the page; that gate stays open in
 * `artifacts/milestone-a-results.md`.
 */
for (const { width, height } of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1100, height: 800 },
]) {
  test(`the laboratory does not scroll horizontally at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await expect(page.getByTestId('playback-note')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

/**
 * The reference's chat holds a handful of lines. The laboratory's holds up to
 * five hundred (`EVENT_HISTORY_LIMIT`), and `.log` is a flex column whose rows
 * carry `overflow: hidden` — which resolves their automatic minimum height to
 * zero, so past a certain count the rows shrank instead of scrolling and the
 * log rendered as a field of clipped glyph fragments. The rows must keep their
 * line height and the list must scroll instead.
 */
test('the event log scrolls instead of squashing its rows once the history is long', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start experiment', exact: true }).click();
  const log = page.getByRole('list', { name: en.log.rows });
  await expect
    .poll(async () => log.locator('li').count(), { timeout: 20_000 })
    .toBeGreaterThan(40);

  const rows = await log.locator('li').evaluateAll((items) =>
    items.map((item) => (item as HTMLElement).getBoundingClientRect().height),
  );
  const shortest = Math.min(...rows);
  expect(shortest, `shortest of ${rows.length} rows`).toBeGreaterThanOrEqual(14);

  const scrolls = await log.evaluate((element) => element.scrollHeight > element.clientHeight + 1);
  expect(scrolls, 'the log scrolls its overflow').toBe(true);
});
