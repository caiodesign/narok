import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Start experiment', exact: true }).click();
await page.waitForTimeout(9000);
await page.locator('.chat').screenshot({ path: 'artifacts/log-after.png' });
await browser.close();
