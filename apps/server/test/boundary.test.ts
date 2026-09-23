/**
 * P-01: one simulation implementation. The server runs progression only
 * through `@narok/sim`, the protocol package touches the engine at type level
 * only, and no second RNG or advance loop exists anywhere.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  await walk(path.join(ROOT, dir));
  return out;
}

const SIMULATION_SHAPED = ['seedrandom', 'random-js', 'chance', 'pure-rand', 'xorshift'];

describe('dependency boundaries', () => {
  test('apps/server declares no simulation-shaped dependency other than @narok/sim and @narok/data', async () => {
    const manifest = JSON.parse(await readFile(path.join(ROOT, 'apps/server/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const names = Object.keys(manifest.dependencies ?? {});
    for (const forbidden of SIMULATION_SHAPED) expect(names).not.toContain(forbidden);
    expect(names).toContain('@narok/sim');
  });

  test('packages/protocol declares neither @narok/sim nor @narok/data as a runtime dependency', async () => {
    const manifest = JSON.parse(await readFile(path.join(ROOT, 'packages/protocol/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const names = Object.keys(manifest.dependencies ?? {});
    expect(names).not.toContain('@narok/sim');
    expect(names).not.toContain('@narok/data');
  });

  test('packages/protocol imports @narok/sim at type level only, so no engine reaches the wire', async () => {
    const offenders: string[] = [];
    for (const file of await sources('packages/protocol/src')) {
      const text = await readFile(file, 'utf8');
      for (const line of text.split('\n')) {
        if (!/from '@narok\/(sim|data)'/.test(line)) continue;
        if (!/^\s*(import|export)\s+type\b/.test(line)) offenders.push(`${path.relative(ROOT, file)}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Files allowed to call `Math.random`, each for a reason that is not
 * progression. The rule exists so no second RNG reaches gameplay: retry jitter
 * and rate-limit spreading decide *when* to try again, never what happens.
 */
const NON_GAMEPLAY_RANDOM = ['apps/server/src/db/tx.ts'];

describe('one RNG, one advance loop', () => {
  test('no xorshift implementation outside packages/sim', async () => {
    const offenders: string[] = [];
    for (const dir of ['apps/server/src', 'packages/protocol/src']) {
      for (const file of await sources(dir)) {
        const text = await readFile(file, 'utf8');
        const relative = path.relative(ROOT, file).split(path.sep).join('/');
        // The shifts xorshift32 is made of; `rng.ts` is the only place they belong.
        if (/<<\s*13|>>>\s*17|<<\s*5/.test(text)) offenders.push(relative);
        if (/Math\.random\s*\(/.test(text) && !NON_GAMEPLAY_RANDOM.includes(relative)) {
          offenders.push(`${relative} (Math.random)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the allowlisted files use randomness only for backoff, never for an outcome', async () => {
    for (const relative of NON_GAMEPLAY_RANDOM) {
      const text = await readFile(path.join(ROOT, relative), 'utf8');
      const lines = text.split('\n');
      for (const [index, line] of lines.entries()) {
        if (!/Math\.random\s*\(/.test(line)) continue;
        // The justification may sit on the line, in the enclosing function's
        // name, or in the comment above it — so read a small window, not one line.
        const window = lines.slice(Math.max(0, index - 4), index + 1).join('\n');
        expect(window, `${relative}:${index + 1} ${line.trim()}`).toMatch(/backoff|jitter|delay|sleep/i);
      }
    }
  });

  test('the server never declares its own advance loop', async () => {
    const offenders: string[] = [];
    for (const file of await sources('apps/server/src')) {
      const text = await readFile(file, 'utf8');
      if (/function\s+advance\b/.test(text)) offenders.push(path.relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
  });
});
