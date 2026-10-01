// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ArtEntry } from '../src/art-manifest';

// PixiJS cannot initialise a renderer in jsdom (R58). The board's own lifecycle
// is covered in battlefield.test.tsx; here the Application is stubbed so the
// shell around it can be asserted.
class StubDisplay {
  children: StubDisplay[] = [];
  position = { set: vi.fn() };
  scale = { set: vi.fn() };
  anchor = { set: vi.fn() };
  addChild<T extends StubDisplay>(child: T): T {
    this.children.push(child);
    return child;
  }
  removeChildren(): StubDisplay[] {
    const removed = this.children;
    this.children = [];
    return removed;
  }
  destroy = vi.fn();
}

class StubGraphics extends StubDisplay {
  poly = vi.fn(() => this);
  circle = vi.fn(() => this);
  rect = vi.fn(() => this);
  fill = vi.fn(() => this);
  stroke = vi.fn(() => this);
  clear = vi.fn(() => this);
}

class StubText extends StubDisplay {
  text: string;
  constructor(options: { text?: string } = {}) {
    super();
    this.text = options.text ?? '';
  }
}

class StubApplication {
  stage = new StubDisplay();
  canvas = globalThis.document.createElement('canvas');
  renderer = { resize: vi.fn() };
  // The board registers one ticker callback for the animated cues; jsdom never
  // runs it, which is the point (R58) — the curves it drives are tested pure.
  ticker = { add: vi.fn(), remove: vi.fn() };
  destroy = vi.fn();
  init(): Promise<void> {
    return Promise.resolve();
  }
}

vi.mock('pixi.js', () => ({
  Application: StubApplication,
  Container: StubDisplay,
  Graphics: StubGraphics,
  Text: StubText,
}));

const { LabApp: App } = await import('../src/LabApp');
const { entryViewBox } = await import('../src/art-manifest');
const { default: i18n, LANGUAGE_STORAGE_KEY, resources } = await import('@narok/client/src/i18n');
const { artManifest } = await import('../src/art-manifest');

/**
 * The hook builds a real `Worker` on start, which jsdom has no implementation
 * for. Only the constructor needs to exist: `start` transitions to `running` the
 * moment it posts, and pause/resume are pure playback-clock operations that never
 * touch the worker at all (contract §7). Nothing here answers a frame, so no
 * simulation data is faked.
 */
class StubWorker {
  postMessage = vi.fn();
  terminate = vi.fn();
  onmessage: unknown = null;
  onerror: unknown = null;
}

/** Fills the default guardian/cleric/ranger roster's placement so Start enables. */
function placeWholeRoster(): void {
  const grid = screen.getByRole('grid', { name: /battlefield placement grid/i });
  const rows = within(grid).getAllByRole('row');
  fireEvent.click(screen.getByRole('button', { name: 'Select p0' }));
  fireEvent.click(within(rows[3]).getAllByRole('gridcell')[2]); // (2,3)
  fireEvent.click(screen.getByRole('button', { name: 'Select p1' }));
  fireEvent.click(within(rows[4]).getAllByRole('gridcell')[1]); // (1,4)
  fireEvent.click(screen.getByRole('button', { name: 'Select p2' }));
  fireEvent.click(within(rows[4]).getAllByRole('gridcell')[3]); // (3,4)
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await act(async () => {
    await i18n.changeLanguage('en');
  });
  globalThis.localStorage.clear();
});

describe('laboratory shell', () => {
  test('R81: the run controls carry the accessible names the smoke test drives', () => {
    render(<App />);
    expect(screen.getByRole('button', { name: 'Start experiment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop experiment' })).toBeInTheDocument();
  });

  test('R81: exactly one element carries data-testid="elapsed-time" while no run has completed', () => {
    render(<App />);
    const elapsed = screen.getAllByTestId('elapsed-time');
    expect(elapsed).toHaveLength(1);
    // The live playback readout, through the shared duration helper.
    expect(elapsed[0]).toHaveTextContent('0 s');
  });

  test('R81: the playback status readout is translated and renders exactly "Paused" in EN once paused', () => {
    vi.stubGlobal('Worker', StubWorker);
    render(<App />);
    const readout = screen.getByTestId('playback-status');
    expect(readout).toHaveTextContent('Idle');

    placeWholeRoster();
    fireEvent.click(screen.getByRole('button', { name: 'Start experiment' }));
    expect(readout).toHaveTextContent('Running');

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    // Task 11's smoke asserts toHaveText('Paused'), which is an exact match on
    // the element's whole text -- so assert the rendered string, not a substring.
    expect(readout.textContent).toBe('Paused');
    expect(readout.textContent).toBe(resources.en.translation.status.paused);

    // Resuming must leave the paused state again, not stick.
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(readout.textContent).toBe(resources.en.translation.status.running);
  });

  test('the playback pause is explicitly labelled as a laboratory pause, not an offline cap', () => {
    render(<App />);
    const note = screen.getByTestId('playback-note');
    expect(note.textContent).toMatch(/laboratory/i);
    expect(note.textContent).toMatch(/not an offline/i);
  });

  test('both comparison slots are present from the first render', () => {
    render(<App />);
    expect(screen.getByTestId('comparison-slot-a')).toBeInTheDocument();
    expect(screen.getByTestId('comparison-slot-b')).toBeInTheDocument();
  });

  test('switching to PT-BR retranslates the interface and stores only the language', async () => {
    render(<App />);
    expect(screen.getByRole('button', { name: 'Start experiment' })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Português (Brasil)' }));
    });

    expect(screen.queryByRole('button', { name: 'Start experiment' })).toBeNull();
    expect(screen.getByRole('button', { name: resources['pt-BR'].translation.controls.start })).toBeInTheDocument();
    expect(globalThis.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('pt-BR');
    expect(Object.keys(globalThis.localStorage)).toEqual([LANGUAGE_STORAGE_KEY]);
  });
});

describe('entryViewBox', () => {
  function box(entry: ArtEntry, pad?: number): number[] {
    const value = entryViewBox(entry, pad);
    expect(value).not.toBeNull();
    return (value as string).split(' ').map(Number);
  }

  function entry(shapes: ArtEntry['shapes']): ArtEntry {
    return { space: 'pixel', accent: '#000000', shapes };
  }

  test('a polygon-only entry is bounded by its own points', () => {
    expect(
      entryViewBox(entry([{ shape: { kind: 'polygon', points: [0, 0, 10, 0, 10, 20] } }]), 0),
    ).toBe('0 0 10 20');
  });

  /** The radius has to push the box out on all four sides, not just two. */
  test('a circle-only entry is bounded by centre plus radius in every direction', () => {
    expect(entryViewBox(entry([{ shape: { kind: 'circle', cx: 5, cy: -5, radius: 4 } }]), 0)).toBe('1 -9 8 8');
  });

  test('a mixed entry is bounded by the union of both kinds', () => {
    const [x, y, width, height] = box(
      entry([
        { shape: { kind: 'polygon', points: [-7, 0, 7, 0, 5, -22] } },
        { shape: { kind: 'circle', cx: 14, cy: -30, radius: 5 } },
      ]),
      0,
    );
    expect([x, y, width, height]).toEqual([-7, -35, 26, 35]);
  });

  test('padding grows the box by that much on every side', () => {
    const shapes: ArtEntry['shapes'] = [{ shape: { kind: 'polygon', points: [0, 0, 10, 20] } }];
    expect(entryViewBox(entry(shapes), 3)).toBe('-3 -3 16 26');
    expect(entryViewBox(entry(shapes))).toBe('-3 -3 16 26');
  });

  test('an entry with nothing drawable has no box at all', () => {
    expect(entryViewBox(entry([]))).toBeNull();
    expect(entryViewBox(entry([{ shape: { kind: 'polygon', points: [] } }]))).toBeNull();
  });

  /**
   * The medal measures the manifest instead of hard-coding a box precisely so
   * that art changes cannot silently crop or off-centre the portrait — the
   * humanoid's shadow ellipse was removed once already. This asserts that
   * coupling directly: for every class the board can draw, every declared point
   * must fall inside the returned box.
   */
  test('every class entry in the manifest is fully contained by its measured box', () => {
    const classKeys = Object.keys(artManifest).filter((key) => key.startsWith('class.'));
    expect(classKeys.length).toBeGreaterThan(0);

    for (const key of classKeys) {
      const art = (artManifest as Record<string, ArtEntry>)[key];
      const [x, y, width, height] = box(art);
      for (const part of art.shapes) {
        if (part.shape.kind === 'circle') {
          const { cx, cy, radius } = part.shape;
          expect(cx - radius, key).toBeGreaterThanOrEqual(x);
          expect(cx + radius, key).toBeLessThanOrEqual(x + width);
          expect(cy - radius, key).toBeGreaterThanOrEqual(y);
          expect(cy + radius, key).toBeLessThanOrEqual(y + height);
          continue;
        }
        const points = part.shape.points;
        for (let index = 0; index + 1 < points.length; index += 2) {
          expect(points[index], key).toBeGreaterThanOrEqual(x);
          expect(points[index], key).toBeLessThanOrEqual(x + width);
          expect(points[index + 1], key).toBeGreaterThanOrEqual(y);
          expect(points[index + 1], key).toBeLessThanOrEqual(y + height);
        }
      }
    }
  });
});
