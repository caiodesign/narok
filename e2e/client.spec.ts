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
