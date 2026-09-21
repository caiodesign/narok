/**
 * Screenshots of the ported Strategy editor at the three widths the UI spec
 * names, with a character selected so the board shows its drop targets.
 */
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const out = process.argv[3] ?? 'artifacts/setup';
const browser = await chromium.launch();

for (const [w, h] of [[1440, 900], [1280, 800], [1100, 800]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Select p0', exact: true }).click();
  await page.screenshot({ path: `${out}-${w}.png` });
  await page.close();
}
await browser.close();
