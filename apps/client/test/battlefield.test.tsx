// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { content } from '@narok/data';
import type { PublicActor, PublicState } from '@narok/sim';
import { gridPosition } from '@narok/sim';

// PixiJS cannot render in jsdom (R58): the Application is stubbed so the board's
// React lifecycle can be smoke-tested without chasing WebGL coverage.
const applications: StubApplication[] = [];

class StubDisplay {
  children: StubDisplay[] = [];
  position = { set: vi.fn() };
  scale = { set: vi.fn() };
  anchor = { set: vi.fn() };
  label = '';
  eventMode = 'none';
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
  moveTo = vi.fn(() => this);
  lineTo = vi.fn(() => this);
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
  static instances = 0;
  initCalls: { width?: number; height?: number }[] = [];
  stage = new StubDisplay();
  canvas = globalThis.document.createElement('canvas');
  renderer = { resize: vi.fn() };
  destroy = vi.fn();
  constructor() {
    StubApplication.instances += 1;
    applications.push(this);
  }
  init(options: { width?: number; height?: number }): Promise<void> {
    this.initCalls.push(options);
    return Promise.resolve();
  }
}

vi.mock('pixi.js', () => ({
  Application: StubApplication,
  Container: StubDisplay,
  Graphics: StubGraphics,
  Text: StubText,
}));

const {
  BattlefieldView,
  actorArtKey,
  artFor,
  centreOffset,
  compareDepth,
  projectCell,
  sceneBounds,
} = await import('../src/BattlefieldView');
const { artManifest } = await import('../src/art-manifest');
await import('../src/i18n');

function actor(overrides: Partial<PublicActor> = {}): PublicActor {
  return {
    id: 'p0',
    definitionId: 'guardian',
    side: 'party',
    position: gridPosition(2, 3),
    hp: 120,
    mp: 30,
    maxHp: 250,
    maxMp: 60,
    currentTarget: 'e0',
    casting: null,
    targetReason: 'priority',
    cooldowns: {},
    ...overrides,
  };
}

function publicState(actors: PublicActor[]): PublicState {
  return {
    nowMs: 2_000,
    phase: 'fighting',
    stopReason: null,
    actors,
    metrics: {
      kills: 0,
      wins: 0,
      wipes: 0,
      rawExp: 0,
      rawGold: 0,
      damageDealt: 0,
      effectiveHealing: 0,
      walkMs: 0,
      fightMs: 0,
      restMs: 0,
      respawnMs: 0,
      actors: {},
    },
  };
}

beforeEach(() => {
  StubApplication.instances = 0;
  applications.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('projectCell (binding formula)', () => {
  test('maps grid coordinates to the isometric diamond', () => {
    expect(projectCell(0, 0, 64, 32)).toEqual({ x: 0, y: 0 });
    expect(projectCell(1, 0, 64, 32)).toEqual({ x: 32, y: 16 });
    expect(projectCell(0, 1, 64, 32)).toEqual({ x: -32, y: 16 });
    expect(projectCell(2, 3, 64, 32)).toEqual({ x: -32, y: 80 });
  });
});

describe('depth ordering', () => {
  test('sorts by row + column ascending', () => {
    const order = [
      { id: 'a', column: 4, row: 4 },
      { id: 'b', column: 0, row: 0 },
      { id: 'c', column: 1, row: 2 },
    ]
      .sort(compareDepth)
      .map((entity) => entity.id);
    expect(order).toEqual(['b', 'c', 'a']);
  });

  test('breaks ties by ASCII actor id, never by localeCompare', () => {
    const tied = [
      { id: 'e0', column: 1, row: 1 },
      { id: 'E0', column: 2, row: 0 },
    ];
    // ASCII puts 'E' (69) before 'e' (101); ICU collation does the opposite.
    expect([...tied].sort(compareDepth).map((entity) => entity.id)).toEqual(['E0', 'e0']);
    expect([...tied].reverse().sort(compareDepth).map((entity) => entity.id)).toEqual(['E0', 'e0']);
    expect('e0'.localeCompare('E0')).toBeLessThan(0); // the behaviour we are NOT using
  });

  test('is a total, stable order for equal depths', () => {
    const entities = [
      { id: 'e2', column: 2, row: 1 },
      { id: 'e10', column: 1, row: 2 },
      { id: 'p1', column: 3, row: 0 },
    ];
    const first = [...entities].sort(compareDepth).map((entity) => entity.id);
    const second = [...entities].reverse().sort(compareDepth).map((entity) => entity.id);
    expect(first).toEqual(second);
    expect(first).toEqual(['e10', 'e2', 'p1']);
  });
});

describe('scene centring', () => {
  test('bounds cover the whole projected grid, not a hard-coded offset', () => {
    const bounds = sceneBounds(content.grid, 64, 32);
    expect(bounds.minX).toBe(-160);
    expect(bounds.maxX).toBe(160);
    expect(bounds.width).toBe(320);
    expect(bounds.height).toBe(160);
  });

  test('centring translates the projected bounds into the viewport centre', () => {
    const bounds = sceneBounds(content.grid, 64, 32);
    const offset = centreOffset(bounds, 800, 400);
    expect(offset.x + (bounds.minX + bounds.maxX) / 2).toBe(400);
    expect(offset.y + (bounds.minY + bounds.maxY) / 2).toBe(200);
  });
});

describe('art manifest lookup', () => {
  test('resolves every class and monster in the bound content', () => {
    for (const id of Object.keys(content.classes)) {
      expect(artFor(`class.${id}`).shapes.length).toBeGreaterThan(0);
    }
    for (const id of Object.keys(content.monsters)) {
      expect(artFor(`monster.${id}`).shapes.length).toBeGreaterThan(0);
    }
  });

  test('an unknown key falls back to the declared placeholder instead of throwing', () => {
    expect(() => artFor('class.necromancer')).not.toThrow();
    expect(artFor('class.necromancer')).toBe(artManifest.unknown);
  });

  test('R83: a status marker key is reserved, but no actor ever resolves to it', () => {
    expect(artManifest['marker.status']).toBeDefined();
    const keys = [
      actorArtKey(actor()),
      actorArtKey(actor({ side: 'enemy', definitionId: 'briar-boar' })),
      actorArtKey(actor({ definitionId: 'unheard-of' })),
    ];
    expect(keys).not.toContain('marker.status');
    expect(keys).toEqual(['class.guardian', 'monster.briar-boar', 'unknown']);
  });
});

describe('BattlefieldView lifecycle', () => {
  test('creates one Pixi application and destroys its resources on unmount', async () => {
    const view = render(<BattlefieldView state={publicState([actor()])} grid={content.grid} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(StubApplication.instances).toBe(1);
    const app = applications[0];
    expect(app.destroy).not.toHaveBeenCalled();

    view.unmount();
    expect(app.destroy).toHaveBeenCalledWith(true, { children: true, texture: true });
  });

  test('a resize adjusts the renderer without recreating the application', async () => {
    render(<BattlefieldView state={publicState([actor()])} grid={content.grid} />);
    await act(async () => {
      await Promise.resolve();
    });
    const app = applications[0];

    await act(async () => {
      globalThis.dispatchEvent(new Event('resize'));
      await Promise.resolve();
    });

    expect(StubApplication.instances).toBe(1);
    expect(app.renderer.resize).toHaveBeenCalled();
    expect(app.destroy).not.toHaveBeenCalled();
  });

  test('publishes the board as accessible text, so the canvas is not the only carrier', async () => {
    render(
      <BattlefieldView
        state={publicState([
          actor(),
          actor({ id: 'e0', side: 'enemy', definitionId: 'briar-boar', position: gridPosition(2, 1) }),
        ])}
        grid={content.grid}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    const list = screen.getByRole('list', { name: /battlefield/i });
    expect(list.textContent).toContain('Guardian');
    expect(list.textContent).toContain('Briar Boar');
    expect(list.textContent).toContain('120');
  });
});
