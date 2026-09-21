import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://localhost:4173/';
const out = process.argv[3] ?? 'artifacts/hud';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: 'networkidle' });
await page.screenshot({ path: `${out}-idle-1440.png` });

await page.getByRole('button', { name: 'Start experiment', exact: true }).click();
await page.waitForFunction(
  () => (document.querySelector('[data-testid="elapsed-time"]')?.textContent ?? '0 s') !== '0 s',
);
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}-running-1440.png` });

await page.setViewportSize({ width: 1100, height: 800 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}-running-1100.png` });

const overflow = await page.evaluate(() => ({
  x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
}));
console.log('overflow at 1100x800:', JSON.stringify(overflow));

await browser.close();
