/**
 * Gate B-02, source half (milestone B Task 8, rulings R163/R164): `apps/client`
 * ships no simulation engine. The laboratory that does run one lives in
 * `apps/lab`, which may import `@narok/client` — never the other way round.
 *
 * Every `import`/`export … from` statement is read whole (multi-line ones
 * included), so a `type`-only statement spread over several lines is not
 * mistaken for a value import, and a value import spread the same way is not
 * missed. The bundle half of B-02 (a grep over `apps/client/dist`) is Task 11's.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CLIENT = join(ROOT, 'apps', 'client');
const LAB = join(ROOT, 'apps', 'lab');

interface Statement {
  file: string;
  text: string;
  typeOnly: boolean;
  specifier: string;
}

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(join(dir, 'src'), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(ts|tsx|js|jsx|mjs)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** Every static import/export-from, side-effect import and dynamic import in `file`. */
async function statements(file: string): Promise<Statement[]> {
  const text = await readFile(file, 'utf8');
  const name = relative(ROOT, file).split(sep).join('/');
  const found: Statement[] = [];
  const fromClause = /\b(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(fromClause)) {
    found.push({
      file: name,
      text: match[0].replace(/\s+/g, ' '),
      typeOnly: match[2] !== undefined,
      specifier: match[4],
    });
  }
  for (const match of text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) {
    found.push({ file: name, text: match[0], typeOnly: false, specifier: match[1] });
  }
  for (const match of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    found.push({ file: name, text: match[0], typeOnly: false, specifier: match[1] });
  }
  return found;
}

async function allStatements(dir: string): Promise<Statement[]> {
  const found: Statement[] = [];
  for (const file of await sources(dir)) found.push(...(await statements(file)));
  return found;
}

const isEngine = (specifier: string): boolean => specifier === '@narok/sim' || specifier.startsWith('@narok/sim/');
const isPixi = (specifier: string): boolean => specifier === 'pixi.js' || specifier.startsWith('pixi.js/');
const isLab = (specifier: string): boolean =>
  specifier === '@narok/lab' || specifier.startsWith('@narok/lab/') || /(^|\/)apps\/lab(\/|$)/.test(specifier)
  || /^(\.\.\/)+lab(\/|$)/.test(specifier);

const show = (statement: Statement): string => `${statement.file}: ${statement.text}`;

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function manifest(dir: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Manifest;
}

describe('apps/client is engine-free (B-02)', () => {
  test('apps/client imports @narok/sim type-only', async () => {
    const offenders = (await allStatements(CLIENT))
      .filter((statement) => isEngine(statement.specifier) && !statement.typeOnly)
      .map(show);
    expect(offenders).toEqual([]);
  });

  test('apps/client never imports pixi.js', async () => {
    const offenders = (await allStatements(CLIENT)).filter((statement) => isPixi(statement.specifier)).map(show);
    expect(offenders).toEqual([]);
  });

  test('apps/client never imports apps/lab (R164)', async () => {
    const offenders = (await allStatements(CLIENT)).filter((statement) => isLab(statement.specifier)).map(show);
    expect(offenders).toEqual([]);
  });

  test('apps/client lists @narok/sim only under devDependencies, and pixi.js nowhere', async () => {
    const pkg = await manifest(CLIENT);
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('@narok/sim');
    expect(Object.keys(pkg.devDependencies ?? {})).toContain('@narok/sim');
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('pixi.js');
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain('pixi.js');
  });
});

/**
 * The reverse direction: the engine is allowed in `apps/lab`, and is actually
 * there. Asserting presence keeps the scanner above honest — a pattern that
 * matched nothing would pass the client checks vacuously.
 */
describe('apps/lab carries the engine', () => {
  test('apps/lab imports @narok/sim by value and draws with pixi.js', async () => {
    const found = await allStatements(LAB);
    expect(found.filter((statement) => isEngine(statement.specifier) && !statement.typeOnly).length).toBeGreaterThan(0);
    expect(found.filter((statement) => isPixi(statement.specifier)).length).toBeGreaterThan(0);
  });

  test('apps/lab depends on @narok/sim, pixi.js and @narok/client at runtime', async () => {
    const deps = Object.keys((await manifest(LAB)).dependencies ?? {});
    expect(deps).toEqual(expect.arrayContaining(['@narok/sim', 'pixi.js', '@narok/client']));
  });
});
