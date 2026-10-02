// @vitest-environment jsdom
/**
 * Gate B-01 over all five ported sheets (milestone B Task 10), and the loading
 * rule that keeps the three town sheets from restyling Hunt.
 *
 * The five invariants are the `diff` commands in the port records
 * (`docs/realm-hunt-port.md`, `docs/realm-strategy-port.md`,
 * `docs/realm-town-port.md`), run here so CI covers them without a hand-run
 * command:
 *
 *   diff <(sed -n 'A,Bp' codex-examples/realm-refined/<screen>.html) <(sed -n '1,Np' apps/client/src/<sheet>.css)
 *
 * They are evaluated in Node rather than shelled to `bash`, which a Windows
 * runner may not have (or may resolve to WSL): the same line ranges are cut
 * from both files and compared byte for byte — no line ending is normalised
 * here. Line endings are normalised in one place only, `.gitattributes`,
 * which checks the mockups and the sheets out with LF on every platform
 * (Task 10 fix round 1, Minor 9); a CR in either file fails. After each town
 * sheet's frozen range comes its labelled Additions block and nothing else.
 *
 * Ruling R181 (route-scoped loading; `docs/realm-town-port.md`): the three town
 * sheets share selectors with `styles.css:1-754` and some of those rule bodies
 * differ — `:root` among them — so a sheet left mounted would restyle Hunt.
 * The collision is measured below, and the Hunt route's computed `:root` tokens
 * and `.realm` box are asserted identical before a screen mounts its sheet and
 * after it unmounts.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { useRouteSheet } from '../src/town/sheets';

// `import.meta.url` is not a file URL under jsdom; the module's own directory is.
const ROOT = resolve(__dirname, '../../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** `sed -n 'from,top'` over `text`, one entry per line, exactly as stored. */
function lines(text: string, from: number, to: number): string[] {
  return text.split('\n').slice(from - 1, to);
}

interface Port {
  readonly mockup: string;
  readonly from: number;
  readonly to: number;
  readonly sheet: string;
  readonly length: number;
}

/** The confirmed ranges, recorded in the port records. */
const PORTS: readonly Port[] = [
  { mockup: 'hunt.html', from: 11, to: 764, sheet: 'styles.css', length: 754 },
  { mockup: 'strategy.html', from: 98, to: 750, sheet: 'strategy.css', length: 653 },
  { mockup: 'bag.html', from: 11, to: 761, sheet: 'bag.css', length: 751 },
  { mockup: 'character.html', from: 11, to: 822, sheet: 'character.css', length: 812 },
  { mockup: 'away.html', from: 11, to: 713, sheet: 'away.css', length: 703 },
];

function differences(port: Port): string[] {
  const reference = lines(read(`codex-examples/realm-refined/${port.mockup}`), port.from, port.to);
  const ported = lines(read(`apps/client/src/${port.sheet}`), 1, port.length);
  const out: string[] = [];
  const count = Math.max(reference.length, ported.length);
  for (let index = 0; index < count; index++) {
    if (reference[index] !== ported[index]) {
      out.push(`${port.sheet}:${index + 1}: < ${reference[index] ?? '(eof)'} > ${ported[index] ?? '(eof)'}`);
    }
  }
  return out;
}

describe('B-01: the five ported sheets are byte-identical to their references', () => {
  for (const port of PORTS) {
    test(`diff ${port.mockup}:${port.from}-${port.to} ${port.sheet}:1-${port.length} prints nothing`, () => {
      expect(differences(port)).toEqual([]);
    });
  }

  test('no line ending is normalised away: neither a reference nor a sheet holds a CR', () => {
    for (const port of PORTS) {
      expect(read(`codex-examples/realm-refined/${port.mockup}`).includes('\r'), port.mockup).toBe(false);
      expect(read(`apps/client/src/${port.sheet}`).includes('\r'), port.sheet).toBe(false);
    }
  });

  test('the frozen range is the sheet’s exact leading bytes', () => {
    for (const port of PORTS) {
      const reference = lines(read(`codex-examples/realm-refined/${port.mockup}`), port.from, port.to).join('\n') + '\n';
      expect(read(`apps/client/src/${port.sheet}`).startsWith(reference), port.sheet).toBe(true);
    }
  });

  test('after each town sheet’s frozen range comes its labelled Additions block, and nothing before it', () => {
    for (const port of PORTS.slice(2)) {
      const rest = read(`apps/client/src/${port.sheet}`).split('\n').slice(port.length).join('\n');
      const label = `/* ---- Additions (product-side, Task 10). Everything above this line is the\n   frozen port of codex-examples/realm-refined/${port.mockup}'s first <style> block`;
      expect(rest.trimStart().startsWith(label), port.sheet).toBe(true);
      // Only blank lines between the frozen range and the label.
      expect(rest.slice(0, rest.indexOf('/* ---- Additions')).trim(), port.sheet).toBe('');
      expect(rest.split('/* ---- Additions').length - 1, port.sheet).toBe(1);
    }
  });

  test('each town range is exactly the mockup’s first <style> block', () => {
    for (const port of PORTS.slice(2)) {
      const all = read(`codex-examples/realm-refined/${port.mockup}`).split('\n');
      expect(all[port.from - 2]).toBe('<style>');
      expect(all[port.to]).toBe('</style>');
      expect(all.slice(0, port.from - 2).some((line) => line.includes('<style'))).toBe(false);
    }
  });
});

// -- the collision, measured ---------------------------------------------------

/** Top-level rules (and rules inside at-blocks, keyed with the at-rule) of a sheet: selector → body. */
function rules(css: string): Map<string, string> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Map<string, string>();
  const walk = (source: string, prefix: string) => {
    let index = 0;
    while (index < source.length) {
      const open = source.indexOf('{', index);
      if (open < 0) break;
      const selector = source.slice(index, open).replace(/\s+/g, ' ').trim();
      let depth = 1;
      let cursor = open + 1;
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === '{') depth++;
        else if (source[cursor] === '}') depth--;
        cursor++;
      }
      const body = source.slice(open + 1, cursor - 1);
      if (selector.startsWith('@media') || selector.startsWith('@supports')) walk(body, `${prefix}${selector} `);
      else if (!selector.startsWith('@keyframes')) out.set(`${prefix}${selector}`, body.replace(/\s+/g, ' ').trim());
      index = cursor;
    }
  };
  walk(text, '');
  return out;
}

function collision(sheet: string): { shared: number; differing: string[] } {
  const hunt = rules(lines(read('apps/client/src/styles.css'), 1, 754).join('\n'));
  const town = rules(read(`apps/client/src/${sheet}`));
  const shared = [...town.keys()].filter((selector) => hunt.has(selector));
  return { shared: shared.length, differing: shared.filter((selector) => hunt.get(selector) !== town.get(selector)) };
}

describe('R181: the town sheets collide with Hunt, so they are route-scoped', () => {
  test('each sheet shares selectors with styles.css:1-754; Character and Away redefine :root', () => {
    // Measured whole-rule (selector text and body, whitespace-normalised):
    // bag 81 shared / 0 differing, character 69 / 4, away 77 / 2 — recorded
    // in docs/realm-town-port.md. Even an identical body re-declared later in
    // the cascade re-wins over styles.css's own additions block, so the
    // loading rule binds all three sheets alike.
    for (const sheet of ['bag.css', 'character.css', 'away.css']) {
      expect(collision(sheet).shared).toBeGreaterThan(0);
    }
    expect(collision('character.css').differing).toEqual(expect.arrayContaining([':root', '.realm']));
    expect(collision('away.css').differing).toContain(':root');
  });

  test('no entry point imports a town sheet; each screen imports its own, raw', () => {
    const main = read('apps/client/src/main.tsx');
    expect(main).not.toMatch(/(bag|character|away)\.css/);
    expect(read('apps/client/src/town/BagScreen.tsx')).toMatch(/from '\.\.\/bag\.css\?raw'/);
    expect(read('apps/client/src/town/CharacterScreen.tsx')).toMatch(/from '\.\.\/character\.css\?raw'/);
    expect(read('apps/client/src/town/AwayReport.tsx')).toMatch(/from '\.\.\/away\.css\?raw'/);
  });
});

afterEach(() => {
  cleanup();
  document.head.querySelectorAll('style').forEach((node) => node.remove());
  document.body.innerHTML = '';
});

/** The tokens `styles.css`'s `:root` declares, and the `.realm` box properties. */
const HUNT_SHEET = lines(read('apps/client/src/styles.css'), 1, 754).join('\n');
const TOKENS = [...(rules(HUNT_SHEET).get(':root') ?? '').matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]!);
const BOX = ['position', 'inset', 'min-width', 'top', 'left', 'right', 'bottom', 'width', 'height', 'overflow', 'background', 'color', 'font-family'];

function huntSnapshot(): Record<string, string> {
  const realm = document.querySelector('.realm')!;
  const root = getComputedStyle(document.documentElement);
  const box = getComputedStyle(realm);
  const out: Record<string, string> = {};
  for (const token of TOKENS) out[token] = root.getPropertyValue(token);
  for (const property of BOX) out[`.realm ${property}`] = box.getPropertyValue(property);
  return out;
}

function Screen({ name, css }: { name: 'bag' | 'character' | 'away'; css: string }): null {
  useRouteSheet(name, css);
  return null;
}

describe('R181: the Hunt route is unchanged with and without each town sheet mounted', () => {
  for (const sheet of ['bag', 'character', 'away'] as const) {
    test(`${sheet}.css mounts with its screen and leaves with it`, () => {
      const hunt = document.createElement('style');
      hunt.textContent = HUNT_SHEET;
      document.head.append(hunt);
      const realm = document.createElement('div');
      realm.className = 'realm';
      document.body.append(realm);
      expect(TOKENS.length).toBeGreaterThan(10);

      const before = huntSnapshot();
      const css = read(`apps/client/src/${sheet}.css`);
      const view = render(createElement(Screen, { name: sheet, css }));
      expect(document.head.querySelector(`style[data-route-sheet="${sheet}"]`)?.textContent).toBe(css);
      act(() => view.unmount());
      expect(document.head.querySelector(`style[data-route-sheet="${sheet}"]`)).toBeNull();
      expect(huntSnapshot()).toEqual(before);
    });
  }

  test('the collision is real: a sheet left mounted would change a Hunt :root token', () => {
    const hunt = document.createElement('style');
    hunt.textContent = HUNT_SHEET;
    document.head.append(hunt);
    const realm = document.createElement('div');
    realm.className = 'realm';
    document.body.append(realm);
    const before = huntSnapshot();
    render(createElement(Screen, { name: 'character', css: read('apps/client/src/character.css') }));
    expect(huntSnapshot()).not.toEqual(before);
  });
});
