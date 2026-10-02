/**
 * The engine-free client's smoke (milestone B Task 8, gate B-02).
 *
 * Chromium only, against the built-and-previewed `apps/client` (the `chromium`
 * project in `playwright.config.ts`). The client renders the Realm HUD and runs
 * no simulation: it starts no worker and offers no laboratory controls — those
 * live in `apps/lab` (`e2e/laboratory.spec.ts`). Every wait is condition-based.
 */
import { expect, test } from '@playwright/test';

test('the client renders the Realm HUD and starts no simulation worker', async ({ page }) => {
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));

  await page.goto('/');
  await expect(page.locator('.realm')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start experiment', exact: true })).toHaveCount(0);
  expect(workers).toEqual([]);
});

test('the hunt shell offers Start hunt and Stop, and never Pause or Resume (R166)', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Narok hunt');
  await expect(page.getByRole('button', { name: 'Start hunt', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /pause|resume/i })).toHaveCount(0);
});

test('the town screens open from the hunt and take their sheet away with them (R181)', async ({ page }) => {
  await page.goto('/');
  const sheet = (name: string) => page.locator(`style[data-route-sheet="${name}"]`);
  await expect(sheet('bag')).toHaveCount(0);

  await page.getByRole('button', { name: /Loot filter/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Bag and loot filter' })).toBeVisible();
  await expect(sheet('bag')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: /Materials/ })).toHaveCount(0);

  await page.locator('.statusbar .back').click();
  await expect(sheet('bag')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start hunt', exact: true })).toHaveCount(1);

  await page.getByRole('button', { name: /^Party/ }).click();
  await expect(sheet('character')).toHaveCount(1);
  await page.getByRole('navigation', { name: 'Town menu' }).getByRole('button', { name: /^Hunt/ }).click();
  await expect(sheet('character')).toHaveCount(0);
});
