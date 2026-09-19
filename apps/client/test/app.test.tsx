// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

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

const { App } = await import('../src/App');
const { default: i18n, LANGUAGE_STORAGE_KEY, resources } = await import('../src/i18n');

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
