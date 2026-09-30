// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { content } from '@narok/data';
import type { DomainEvent, PublicActor, PublicState } from '@narok/sim';
import { emptyDropMetrics, gridPosition } from '@narok/sim';

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
  // The board registers one ticker callback for the animated cues; jsdom never
  // runs it, which is the point (R58) — the curves it drives are tested pure.
  ticker = { add: vi.fn(), remove: vi.fn() };
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
  FLOATER_LIFETIME_MS,
  FLOATER_RISE_PX,
  actorArtKey,
  artFor,
  centreOffset,
  compareDepth,
  floaterFrame,
  floatersFromEvents,
  intentArtKey,
  intentDashes,
  latestEventSeq,
  nameplateAlign,
  plateArtKey,
  projectCell,
  rebaseSeenSeq,
  ringPulse,
  sceneBounds,
  spaceScale,
  targetedIds,
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
      drops: emptyDropMetrics(),
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

// --- workstream B: the pure side of the new board art and combat feedback ----
// Everything below is a named export exercised directly (R58). None of it
// touches a canvas: the renderer only resolves keys and applies these curves.

function domainEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    seq: 1,
    at: 1_000,
    encounter: 0,
    kind: 'damage',
    actorId: 'p0',
    targetId: 'e0',
    amount: 42,
    reason: 'basic',
    position: null,
    ...overrides,
  };
}

describe('coordinate spaces', () => {
  const frame = { tileWidth: 96, tileHeight: 48, viewWidth: 800, viewHeight: 400 };

  test('each declared space resolves to its own multipliers', () => {
    expect(spaceScale('tile', frame)).toEqual({ x: 96, y: 48 });
    expect(spaceScale('pixel', frame)).toEqual({ x: 1, y: 1 });
    expect(spaceScale('view', frame)).toEqual({ x: 800, y: 400 });
  });

  test('every manifest entry declares one of the three spaces', () => {
    for (const entry of Object.values(artManifest)) {
      expect(['tile', 'pixel', 'view']).toContain(entry.space);
    }
  });

  test('a circle is only ever declared in pixel space', () => {
    // The tile and view projections scale x and y differently, so a circle drawn
    // in them would not be the ellipse the art intends; those are polygons.
    for (const [key, entry] of Object.entries(artManifest)) {
      if (entry.space === 'pixel') continue;
      for (const part of entry.shapes) {
        expect(`${key}:${part.shape.kind}`).toBe(`${key}:polygon`);
      }
    }
  });
});

describe('board art (workstream B1/B2)', () => {
  test('ground tiles are extruded: a top face plus two side faces', () => {
    for (const key of ['tile.ground', 'tile.party-zone', 'tile.enemy-zone', 'tile.invalid']) {
      const entry = artFor(key);
      expect(entry.space).toBe('tile');
      // A flat diamond plus its stroke was one shape; a slab needs more.
      expect(entry.shapes.length).toBeGreaterThan(2);
      const lowest = Math.max(
        ...entry.shapes.flatMap((part) =>
          part.shape.kind === 'polygon'
            ? part.shape.points.filter((_, index) => index % 2 === 1)
            : [part.shape.cy],
        ),
      );
      // The side faces hang below the tile's own diamond, which ends at y = 0.5.
      expect(lowest).toBeGreaterThan(0.5);
    }
  });

  test('a spawn lane is tinted with a fill, not only an outline', () => {
    for (const key of ['marker.spawn', 'marker.spawn-enemy']) {
      const entry = artFor(key);
      expect(entry.shapes.some((part) => part.fill !== undefined)).toBe(true);
    }
  });

  test('the neutral lane is hatched, so the band with no spawns says so', () => {
    const entry = artFor('marker.neutral-lane');
    expect(entry.shapes.length).toBeGreaterThan(1);
    expect(entry.shapes.every((part) => part.fill !== undefined)).toBe(true);
  });

  test('both token plates exist and neither falls back to the placeholder', () => {
    for (const side of ['party', 'enemy'] as const) {
      const entry = artFor(plateArtKey(side));
      expect(entry).not.toBe(artManifest.unknown);
      expect(entry.space).toBe('tile');
      // Shadow, rim, two side faces, three gradient bands, outline.
      expect(entry.shapes.length).toBeGreaterThanOrEqual(8);
    }
  });

  test('both intent dashes exist and neither falls back to the placeholder', () => {
    for (const side of ['party', 'enemy'] as const) {
      expect(artFor(intentArtKey(side))).not.toBe(artManifest.unknown);
    }
  });

  test('the vignette is declared in view space, so it never moves with the board', () => {
    expect(artFor('atmosphere.vignette').space).toBe('view');
  });

  /**
   * The canvas is transparent now: the environment behind the board is the DOM
   * world layer (WorldBackdrop.tsx), the way the approved reference composites
   * its battlefield over the world. An opaque canvas-space backdrop would hide
   * it, so the manifest must not grow one back by accident.
   */
  test('the manifest declares no canvas backdrop behind the board', () => {
    expect(Object.keys(artManifest)).not.toContain('atmosphere.backdrop');
  });

  test('the vignette leaves the middle of the canvas alone', () => {
    // Every band is an edge strip; none of them may cover the centre.
    for (const part of artFor('atmosphere.vignette').shapes) {
      if (part.shape.kind !== 'polygon') throw new Error('vignette bands are polygons');
      const xs = part.shape.points.filter((_, index) => index % 2 === 0);
      const ys = part.shape.points.filter((_, index) => index % 2 === 1);
      const coversCentre =
        Math.min(...xs) < 0.5 && Math.max(...xs) > 0.5 && Math.min(...ys) < 0.5 && Math.max(...ys) > 0.5;
      expect(coversCentre).toBe(false);
    }
  });
});

describe('nameplate placement', () => {
  test('a token on the right of the diamond hangs its plate to the left', () => {
    expect(nameplateAlign(4, 0)).toBe('left');
    expect(nameplateAlign(2, 2)).toBe('left');
    expect(nameplateAlign(0, 4)).toBe('right');
  });

  test('the side always points back toward the middle of the canvas', () => {
    for (let column = 0; column < 5; column++) {
      for (let row = 0; row < 5; row++) {
        const { x } = projectCell(column, row, 96, 48);
        expect(nameplateAlign(column, row)).toBe(x >= 0 ? 'left' : 'right');
      }
    }
  });
});

describe('floating numbers (workstream B4)', () => {
  test('only damage and heal with a real amount and target become numbers', () => {
    const events: DomainEvent[] = [
      domainEvent({ seq: 1, kind: 'damage', amount: 40 }),
      domainEvent({ seq: 2, kind: 'heal', amount: 15, targetId: 'p1' }),
      domainEvent({ seq: 3, kind: 'miss', amount: null }),
      domainEvent({ seq: 4, kind: 'damage', amount: 0 }),
      domainEvent({ seq: 5, kind: 'damage', amount: 12, targetId: null }),
      domainEvent({ seq: 6, kind: 'move', amount: null }),
    ];
    expect(floatersFromEvents(events, -1).map((spec) => spec.seq)).toEqual([1, 2]);
  });

  test('the critical suffix on reason is read, never inferred', () => {
    const specs = floatersFromEvents(
      [
        domainEvent({ seq: 1, reason: 'arrow-rain:critical' }),
        domainEvent({ seq: 2, reason: 'arrow-rain' }),
        domainEvent({ seq: 3, reason: null }),
      ],
      -1,
    );
    expect(specs.map((spec) => spec.critical)).toEqual([true, false, false]);
  });

  test('only events newer than the watermark pop', () => {
    const events = [1, 2, 3, 4].map((seq) => domainEvent({ seq }));
    expect(floatersFromEvents(events, 2).map((spec) => spec.seq)).toEqual([3, 4]);
    expect(floatersFromEvents(events, 4)).toEqual([]);
  });

  test('a catch-up frame is capped: the newest few pop, the log keeps the rest', () => {
    const events = Array.from({ length: 200 }, (_, index) => domainEvent({ seq: index + 1 }));
    const specs = floatersFromEvents(events, -1, 8);
    expect(specs).toHaveLength(8);
    expect(specs[specs.length - 1].seq).toBe(200);
  });

  test('the watermark rebases when a new run rewinds the history', () => {
    expect(latestEventSeq([])).toBe(-1);
    expect(latestEventSeq([domainEvent({ seq: 7 }), domainEvent({ seq: 3 })])).toBe(7);
    // A fresh run restarts seq at zero; without this every new event looks old.
    expect(rebaseSeenSeq(120, -1)).toBe(-1);
    expect(rebaseSeenSeq(120, 4)).toBe(-1);
    expect(rebaseSeenSeq(120, 121)).toBe(120);
  });

  test('the drift curve rises into place, holds, then fades out and retires', () => {
    expect(floaterFrame(0)).toEqual({ offsetY: 8, alpha: 0, done: false });
    const settled = floaterFrame(FLOATER_LIFETIME_MS * 0.12);
    expect(settled.offsetY).toBeCloseTo(0, 6);
    expect(settled.alpha).toBeCloseTo(1, 6);
    expect(floaterFrame(FLOATER_LIFETIME_MS * 0.5).alpha).toBe(1);
    expect(floaterFrame(FLOATER_LIFETIME_MS * 0.85).alpha).toBeCloseTo(0.5, 6);
    expect(floaterFrame(FLOATER_LIFETIME_MS)).toEqual({ offsetY: -FLOATER_RISE_PX, alpha: 0, done: true });
    expect(floaterFrame(FLOATER_LIFETIME_MS * 10).done).toBe(true);
  });

  test('the drift only ever rises once it has settled', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let age = FLOATER_LIFETIME_MS * 0.12; age <= FLOATER_LIFETIME_MS; age += 25) {
      const step = floaterFrame(age);
      expect(step.offsetY).toBeLessThanOrEqual(previous + 1e-9);
      expect(step.alpha).toBeGreaterThanOrEqual(0);
      expect(step.alpha).toBeLessThanOrEqual(1);
      previous = step.offsetY;
    }
  });
});

describe('target ring and intent line (workstream B4)', () => {
  test('the pulse stays in range and does not jump at the wrap-around', () => {
    for (let age = 0; age < 6_000; age += 37) {
      const pulse = ringPulse(age);
      expect(pulse.scale).toBeGreaterThanOrEqual(1);
      expect(pulse.scale).toBeLessThanOrEqual(1.14 + 1e-9);
      expect(pulse.alpha).toBeGreaterThanOrEqual(0.55 - 1e-9);
      expect(pulse.alpha).toBeLessThanOrEqual(1 + 1e-9);
    }
    const period = 1_800;
    expect(ringPulse(period).scale).toBeCloseTo(ringPulse(0).scale, 9);
    expect(ringPulse(period - 1).scale).toBeCloseTo(ringPulse(-1).scale, 9);
  });

  test('dashes run from attacker to target, clear of both plates', () => {
    const dashes = intentDashes({ x: 0, y: 0 }, { x: 200, y: 0 }, 17, 26);
    expect(dashes.length).toBeGreaterThan(0);
    for (const dash of dashes) {
      expect(dash.x).toBeGreaterThanOrEqual(26);
      expect(dash.x).toBeLessThanOrEqual(174);
      expect(dash.y).toBeCloseTo(0, 9);
      expect(dash.rotation).toBeCloseTo(0, 9);
    }
  });

  test('the dash rotation points at the target, so direction is a shape cue', () => {
    const [dash] = intentDashes({ x: 0, y: 0 }, { x: 0, y: 200 });
    expect(dash.rotation).toBeCloseTo(Math.PI / 2, 9);
    const [back] = intentDashes({ x: 0, y: 200 }, { x: 0, y: 0 });
    expect(back.rotation).toBeCloseTo(-Math.PI / 2, 9);
  });

  test('adjacent or coincident actors draw no line at all', () => {
    expect(intentDashes({ x: 0, y: 0 }, { x: 0, y: 0 })).toEqual([]);
    expect(intentDashes({ x: 0, y: 0 }, { x: 40, y: 0 })).toEqual([]);
  });

  test('only the ids something is pointed at get a ring', () => {
    const ids = targetedIds([
      actor({ id: 'p0', currentTarget: 'e0' }),
      actor({ id: 'p1', currentTarget: null }),
      actor({ id: 'e0', side: 'enemy', definitionId: 'briar-boar', currentTarget: 'p0' }),
    ]);
    expect([...ids].sort()).toEqual(['e0', 'p0']);
  });
});

describe('BattlefieldView with an event history', () => {
  test('accepts the published history and still mounts exactly one application', async () => {
    const view = render(
      <BattlefieldView
        state={publicState([
          actor(),
          actor({ id: 'e0', side: 'enemy', definitionId: 'briar-boar', position: gridPosition(2, 1) }),
        ])}
        grid={content.grid}
        events={[domainEvent({ seq: 1 }), domainEvent({ seq: 2, kind: 'heal', targetId: 'p0' })]}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(StubApplication.instances).toBe(1);
    // One ticker callback drives every animated cue; it is added once, at init.
    expect(applications[0].ticker.add).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
