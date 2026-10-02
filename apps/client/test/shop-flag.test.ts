/**
 * `VITE_FEATURE_SHOP` (milestone B Task 10; ruling R185): every sale control
 * sits behind it, and it defaults off. Prices are deferred, so the NPC shop
 * and potion purchase ship no route, no component and no price key at all;
 * the sale controls (`src/town/SaleControls.tsx`, marked `data-sale`) are the
 * only entry point the flag can open.
 *
 * The bundle is built twice into temporary directories: with the flag unset
 * no sale entry point may be in it, and with it on the marker must be — the
 * second build proves the first one's search could have found it.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { build } from 'vite';

const CLIENT = resolve(__dirname, '..');
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function bundle(flag: string | undefined): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), 'narok-client-'));
  dirs.push(outDir);
  const before = process.env.VITE_FEATURE_SHOP;
  if (flag === undefined) delete process.env.VITE_FEATURE_SHOP;
  else process.env.VITE_FEATURE_SHOP = flag;
  try {
    await build({
      root: CLIENT,
      configFile: join(CLIENT, 'vite.config.ts'),
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true, minify: true },
    });
  } finally {
    if (before === undefined) delete process.env.VITE_FEATURE_SHOP;
    else process.env.VITE_FEATURE_SHOP = before;
  }
  const assets = join(outDir, 'assets');
  return readdirSync(assets)
    .filter((file) => file.endsWith('.js'))
    .map((file) => readFileSync(join(assets, file), 'utf8'))
    .join('\n');
}

describe('R185: the sale controls are behind VITE_FEATURE_SHOP', () => {
  test('with the flag unset the built bundle carries no sale entry point', async () => {
    const js = await bundle(undefined);
    expect(js.length).toBeGreaterThan(0);
    expect(js).not.toContain('data-sale');
    expect(js).not.toContain('/api/shop/buy');
  }, 180_000);

  test('with the flag on the marker is there, so the search above can see it', async () => {
    const js = await bundle('true');
    expect(js).toContain('data-sale');
  }, 180_000);
});
