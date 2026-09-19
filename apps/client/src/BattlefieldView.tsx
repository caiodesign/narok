/**
 * The isometric board (ruling R58).
 *
 * It consumes `PublicState` and `GridConfig` only — never `SimState`, never the
 * queue, never the RNG, never a snapshot — and it is the single place outside the
 * grid adapter allowed to turn a `PositionId` into a cell, which it does by
 * calling `gridCoordinates` rather than parsing the id.
 *
 * PixiJS cannot render in jsdom, so the pure parts of the board (`projectCell`,
 * `compareDepth`, the manifest lookup and the centring maths) are named exports
 * tested directly; the component itself only gets a mount/unmount smoke test with
 * the Pixi `Application` stubbed.
 *
 * Nothing here animates, so `prefers-reduced-motion` removes no information: every
 * cue (casting mote, target chevron, zone tint, resource bars) is a static shape
 * that is always drawn.
 */
import { useEffect, useRef, useState } from 'react';
import { Application, Container, Graphics, Text } from 'pixi.js';
import { useTranslation } from 'react-i18next';
import type { GridConfig } from '@narok/data';
import type { PublicActor, PublicState } from '@narok/sim';
import { gridCoordinates } from '@narok/sim';
import { artManifest, palette, type ArtEntry } from './art-manifest';
import { formatNumber, type Translate } from './i18n';

export const TILE_WIDTH = 96;
export const TILE_HEIGHT = 48;

/**
 * The plan's binding projection: a cell's centre in isometric screen space.
 */
export function projectCell(column: number, row: number, tileWidth: number, tileHeight: number) {
  return { x: (column - row) * tileWidth / 2,
    y: (column + row) * tileHeight / 2 };
}

export interface DepthEntity {
  id: string;
  column: number;
  row: number;
}

/**
 * Painter's order: `row + column` ascending, ties broken by **ASCII** actor id.
 * `localeCompare` is deliberately not used — its collation is locale-dependent, so
 * two actors sharing a depth could swap draw order when the language changes.
 */
export function compareDepth(a: DepthEntity, b: DepthEntity): number {
  const depthA = a.row + a.column;
  const depthB = b.row + b.column;
  if (depthA !== depthB) return depthA - depthB;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Manifest lookup: an unknown key resolves to the declared placeholder, never a throw. */
export function artFor(key: string): ArtEntry {
  return (artManifest as Record<string, ArtEntry | undefined>)[key] ?? artManifest.unknown;
}

/**
 * The manifest key for one projected actor. Ruling R83: `PublicActor` carries no
 * statuses, so this never resolves to `marker.status` — no per-actor status badge
 * exists in milestone A.
 */
export function actorArtKey(actor: PublicActor): string {
  const key = actor.side === 'party' ? `class.${actor.definitionId}` : `monster.${actor.definitionId}`;
  return key in artManifest ? key : 'unknown';
}

export interface SceneBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
}

/** The projected extent of the whole grid, including the outer half-tiles. */
export function sceneBounds(grid: GridConfig, tileWidth: number, tileHeight: number): SceneBounds {
  const corners = [
    projectCell(0, 0, tileWidth, tileHeight),
    projectCell(grid.width - 1, 0, tileWidth, tileHeight),
    projectCell(0, grid.height - 1, tileWidth, tileHeight),
    projectCell(grid.width - 1, grid.height - 1, tileWidth, tileHeight),
  ];
  const minX = Math.min(...corners.map((corner) => corner.x)) - tileWidth / 2;
  const maxX = Math.max(...corners.map((corner) => corner.x)) + tileWidth / 2;
  const minY = Math.min(...corners.map((corner) => corner.y)) - tileHeight / 2;
  const maxY = Math.max(...corners.map((corner) => corner.y)) + tileHeight / 2;
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * The translation that puts the projected bounds' centre at the viewport centre.
 * The scene is centred from its measured bounds, never from hard-coded offsets.
 */
export function centreOffset(bounds: SceneBounds, viewWidth: number, viewHeight: number): { x: number; y: number } {
  return {
    x: viewWidth / 2 - (bounds.minX + bounds.maxX) / 2,
    y: viewHeight / 2 - (bounds.minY + bounds.maxY) / 2,
  };
}

function drawEntry(
  graphics: Graphics,
  entry: ArtEntry,
  originX: number,
  originY: number,
  tileWidth: number,
  tileHeight: number,
): void {
  const scaleX = entry.space === 'tile' ? tileWidth : 1;
  const scaleY = entry.space === 'tile' ? tileHeight : 1;
  for (const part of entry.shapes) {
    if (part.shape.kind === 'polygon') {
      const points: number[] = [];
      for (let index = 0; index < part.shape.points.length; index += 2) {
        points.push(originX + part.shape.points[index] * scaleX, originY + part.shape.points[index + 1] * scaleY);
      }
      graphics.poly(points);
    } else {
      graphics.circle(originX + part.shape.cx * scaleX, originY + part.shape.cy * scaleY, part.shape.radius);
    }
    if (part.fill !== undefined) graphics.fill({ color: part.fill, alpha: part.alpha ?? 1 });
    if (part.stroke !== undefined) {
      graphics.stroke({ color: part.stroke.color, width: part.stroke.width, alpha: part.stroke.alpha ?? 1 });
    }
  }
}

function bar(graphics: Graphics, x: number, y: number, width: number, ratio: number, colour: string): void {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  graphics.rect(x, y, width, 5).fill({ color: palette.iron0, alpha: 0.85 });
  if (clamped > 0) graphics.rect(x, y, width * clamped, 5).fill({ color: colour });
}

function label(text: string, size: number, colour: string): Text {
  const node = new Text({ text, style: { fontFamily: 'Alegreya Sans, Segoe UI, sans-serif', fontSize: size, fill: colour } });
  node.anchor.set(0.5, 1);
  return node;
}

function buildScene(
  root: Container,
  state: PublicState | null,
  grid: GridConfig,
  tileWidth: number,
  tileHeight: number,
  t: Translate,
): void {
  for (const child of root.removeChildren()) child.destroy({ children: true });

  const ground = new Graphics();
  for (let row = 0; row < grid.height; row++) {
    for (let column = 0; column < grid.width; column++) {
      const { x, y } = projectCell(column, row, tileWidth, tileHeight);
      const key = grid.playerRows.includes(row)
        ? 'tile.party-zone'
        : grid.enemyRows.includes(row)
          ? 'tile.enemy-zone'
          : 'tile.ground';
      drawEntry(ground, artFor(key), x, y, tileWidth, tileHeight);
    }
  }
  root.addChild(ground);

  // Spawn zones read as labelled bands, not as a hue alone.
  const zones = new Graphics();
  for (const row of grid.playerRows) {
    for (let column = 0; column < grid.width; column++) {
      const { x, y } = projectCell(column, row, tileWidth, tileHeight);
      drawEntry(zones, artFor('marker.spawn'), x, y, tileWidth, tileHeight);
    }
  }
  root.addChild(zones);

  const firstPartyRow = [...grid.playerRows].sort((a, b) => a - b)[0] ?? 0;
  const firstEnemyRow = [...grid.enemyRows].sort((a, b) => a - b)[0] ?? 0;
  const partyAnchor = projectCell(grid.width, firstPartyRow, tileWidth, tileHeight);
  const enemyAnchor = projectCell(grid.width, firstEnemyRow, tileWidth, tileHeight);
  const partyLabel = label(t('board.partyZone'), 13, palette.steel);
  partyLabel.position.set(partyAnchor.x, partyAnchor.y);
  root.addChild(partyLabel);
  const enemyLabel = label(t('board.enemyZone'), 13, palette.emberHot);
  enemyLabel.position.set(enemyAnchor.x, enemyAnchor.y);
  root.addChild(enemyLabel);

  if (state === null) return;

  const targeted = new Set(state.actors.map((actor) => actor.currentTarget).filter((id): id is string => id !== null));

  const entities = state.actors
    .map((actor) => {
      const cell = gridCoordinates(actor.position);
      return { id: actor.id, column: cell.column, row: cell.row, actor };
    })
    .sort(compareDepth);

  for (const entity of entities) {
    const { x, y } = projectCell(entity.column, entity.row, tileWidth, tileHeight);
    const token = new Graphics();
    drawEntry(token, artFor(actorArtKey(entity.actor)), x, y, tileWidth, tileHeight);

    if (targeted.has(entity.actor.id)) {
      drawEntry(token, artFor('marker.target'), x, y, tileWidth, tileHeight);
    }
    if (entity.actor.casting !== null) {
      drawEntry(token, artFor('marker.casting'), x, y, tileWidth, tileHeight);
    }

    const barWidth = tileWidth * 0.5;
    bar(token, x - barWidth / 2, y + 6, barWidth, entity.actor.hp / Math.max(1, entity.actor.maxHp), entity.actor.side === 'party' ? palette.hpAlly : palette.hpFoe);
    if (entity.actor.maxMp > 0) {
      bar(token, x - barWidth / 2, y + 13, barWidth, entity.actor.mp / entity.actor.maxMp, palette.mana);
    }
    root.addChild(token);

    const name = label(entity.actor.id, 12, palette.vellum);
    name.position.set(x, y - 44);
    root.addChild(name);
  }
}

export interface BattlefieldViewProps {
  state: PublicState | null;
  grid: GridConfig;
  tileWidth?: number;
  tileHeight?: number;
}

export function BattlefieldView({
  state,
  grid,
  tileWidth = TILE_WIDTH,
  tileHeight = TILE_HEIGHT,
}: BattlefieldViewProps): React.JSX.Element {
  const { t: rawT, i18n } = useTranslation();
  const t = rawT as unknown as Translate;
  const language = i18n.language;

  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<Container | null>(null);
  const recentreRef = useRef<() => void>(() => {});
  const layoutRef = useRef({ grid, tileWidth, tileHeight });
  layoutRef.current = { grid, tileWidth, tileHeight };
  const [ready, setReady] = useState(false);

  // Lifecycle: one Application, created once, destroyed with its children and
  // textures on unmount. A resize only touches the renderer and the centring
  // transform — it never recreates the application or any simulation state.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    let disposed = false;
    let initialised = false;
    const app = new Application();
    const root = new Container();

    const measure = (): { width: number; height: number } => ({
      width: Math.max(1, host.clientWidth || 720),
      height: Math.max(1, host.clientHeight || 420),
    });

    const recentre = (): void => {
      if (!initialised || disposed) return;
      const { width, height } = measure();
      app.renderer.resize(width, height);
      const layout = layoutRef.current;
      const offset = centreOffset(sceneBounds(layout.grid, layout.tileWidth, layout.tileHeight), width, height);
      root.position.set(offset.x, offset.y);
    };
    recentreRef.current = recentre;

    const size = measure();
    void app
      .init({
        width: size.width,
        height: size.height,
        background: palette.iron0,
        antialias: true,
        autoDensity: true,
        resolution: globalThis.devicePixelRatio ?? 1,
      })
      .then(() => {
        initialised = true;
        if (disposed) {
          app.destroy(true, { children: true, texture: true });
          return;
        }
        host.appendChild(app.canvas);
        app.stage.addChild(root);
        rootRef.current = root;
        recentre();
        setReady(true);
      });

    globalThis.addEventListener('resize', recentre);
    return () => {
      disposed = true;
      globalThis.removeEventListener('resize', recentre);
      rootRef.current = null;
      if (initialised) app.destroy(true, { children: true, texture: true });
    };
  }, []);

  // Redraw from the current projection. Rebuilding the scene graph never touches
  // the application, the renderer or anything the simulation owns.
  useEffect(() => {
    const root = rootRef.current;
    if (!ready || root === null) return;
    buildScene(root, state, grid, tileWidth, tileHeight, t);
    recentreRef.current();
  }, [ready, state, grid, tileWidth, tileHeight, t, language]);

  const actors = state?.actors ?? [];

  return (
    <section className="win panel board-panel" aria-label={t('app.board')}>
      <h2 className="win-title">{t('app.board')}</h2>
      <div className="board-host" ref={hostRef} aria-hidden="true" />
      {state === null && <p className="board-empty">{t('board.empty')}</p>}
      {/* The canvas is never the only carrier: the same frame is published as text. */}
      <ul className="sr-only" aria-label={t('board.summary')}>
        {actors.map((actor) => (
          <li key={actor.id}>
            {t('board.actor', {
              name: t(actor.side === 'party' ? `class.${actor.definitionId}` : `monster.${actor.definitionId}`, {
                defaultValue: actor.definitionId,
              }),
              id: actor.id,
              hp: formatNumber(actor.hp, language),
              maxHp: formatNumber(actor.maxHp, language),
              mp: formatNumber(actor.mp, language),
              maxMp: formatNumber(actor.maxMp, language),
              position: actor.position,
            })}
          </li>
        ))}
      </ul>
    </section>
  );
}
