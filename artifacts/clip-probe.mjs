import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const browser = await chromium.launch();

for (const [w, h] of [[1440, 900], [1280, 800], [1100, 800]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Start experiment', exact: true }).click();
  await page.waitForTimeout(2500);

  const clipped = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('.realm *')) {
      const dy = el.scrollHeight - el.clientHeight;
      const dx = el.scrollWidth - el.clientWidth;
      if (dy <= 8 && dx <= 8) continue;
      const style = getComputedStyle(el);
      const scrolls = /auto|scroll/.test(style.overflowY + style.overflowX);
      out.push({
        sel: el.className.toString().split(' ').slice(0, 3).join('.') || el.tagName,
        dx, dy, overflow: `${style.overflowX}/${style.overflowY}`, scrolls,
        text: (el.textContent ?? '').trim().slice(0, 48),
      });
    }
    return out;
  });
  console.log(`\n=== ${w}x${h} ===`);
  for (const c of clipped) console.log(`${c.scrolls ? 'scrolls ' : 'CLIPPED '} ${c.sel}  dx=${c.dx} dy=${c.dy} (${c.overflow})  "${c.text}"`);
  await page.close();
}
await browser.close();
