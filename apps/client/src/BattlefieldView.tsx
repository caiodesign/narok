/**
 * The isometric board (ruling R58).
 *
 * It consumes `PublicState`, `GridConfig` and the published `DomainEvent`
 * history only — never `SimState`, never the queue, never the RNG, never a
 * snapshot — and it is the single place outside the grid adapter allowed to turn
 * a `PositionId` into a cell, which it does by calling `gridCoordinates` rather
 * than parsing the id.
 *
 * PixiJS cannot render in jsdom, so the pure parts of the board (`projectCell`,
 * `compareDepth`, the manifest lookup, the centring maths, and every animation
 * curve) are named exports tested directly; the component itself only gets a
 * mount/unmount smoke test with the Pixi `Application` stubbed.
 *
 * **Art is data.** No shape is written here. The renderer resolves a manifest key
 * and paints the declared parts in the declared coordinate space; anything new to
 * draw is a new key in `art-manifest.ts` (ruling R59).
 *
 * **Reduced motion.** Three things move: the floating damage/heal numbers, the
 * pulse on the current-target ring, and nothing else. Under
 * `prefers-reduced-motion: reduce` the ticker does nothing, no floater is ever
 * created, and the ring is drawn in its static pose — so no information is lost:
 * the ring, the target chevron, the casting mote, the intent line and the HP bar
 * are all static shapes that are always drawn, and every damage and heal figure
 * that a floater would show is already a row in the event log.
 */
import { useEffect, useRef, useState } from 'react';
import { Application, Container, Graphics, Text } from 'pixi.js';
import { useTranslation } from 'react-i18next';
import type { GridConfig } from '@narok/data';
import type { DomainEvent, PublicActor, PublicState } from '@narok/sim';
import { gridCoordinates } from '@narok/sim';
import { artManifest, mix, palette, type ArtEntry } from './art-manifest';
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

/** The manifest key for the ground plate a token of this side stands on. */
export function plateArtKey(side: PublicActor['side']): string {
  return side === 'party' ? 'token.plate-party' : 'token.plate-enemy';
}

/** The manifest key for one dash of this side's attacker → target intent line. */
export function intentArtKey(side: PublicActor['side']): string {
  return side === 'party' ? 'marker.intent-party' : 'marker.intent-enemy';
}

/** The frame a manifest entry is measured against; see the manifest's doc comment. */
export interface DrawFrame {
  tileWidth: number;
  tileHeight: number;
  viewWidth: number;
  viewHeight: number;
}

/**
 * The multipliers one declared coordinate space is drawn with. `'tile'` follows
 * the isometric projection, `'view'` the canvas, `'pixel'` nothing.
 */
export function spaceScale(space: ArtEntry['space'], frame: DrawFrame): { x: number; y: number } {
  if (space === 'tile') return { x: frame.tileWidth, y: frame.tileHeight };
  if (space === 'view') return { x: frame.viewWidth, y: frame.viewHeight };
  return { x: 1, y: 1 };
}

export interface SceneBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
}

/**
 * The projected extent of the whole grid, including the outer half-tiles.
 *
 * The tiles' extrusion (`TILE_ELEVATION`) hangs below this box by design: the
 * board is centred on its *top* faces, which is where the tokens stand, so the
 * slab's thickness does not drag the action off centre.
 */
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

/**
 * Which side of a token its nameplate sits on. Screen x runs with
 * `column - row`, so a token on the right half of the diamond hangs its plate to
 * the left and never runs off the canvas edge.
 */
export function nameplateAlign(column: number, row: number): 'left' | 'right' {
  return column - row >= 0 ? 'left' : 'right';
}

// --- combat feedback, all of it derived from already-published data ---------

/** How long one floating number lives, and how far it rises in that time. */
export const FLOATER_LIFETIME_MS = 1_500;
export const FLOATER_RISE_PX = 34;
/** A long catch-up frame can deliver hundreds of events; only the newest few pop. */
export const FLOATER_BURST_LIMIT = 8;
/** One full breath of the current-target ring. */
export const RING_PULSE_MS = 1_800;

export interface FloaterSpec {
  seq: number;
  targetId: string;
  amount: number;
  kind: 'damage' | 'heal';
  critical: boolean;
}

/** The highest `seq` in a history slice, or `-1` when it is empty. */
export function latestEventSeq(events: readonly DomainEvent[]): number {
  let highest = -1;
  for (const event of events) {
    if (event.seq > highest) highest = event.seq;
  }
  return highest;
}

/**
 * A new run restarts `seq` at zero, so a watermark left over from the previous
 * run would swallow every event of the new one. A history that went backwards is
 * a rewind, not a gap.
 */
export function rebaseSeenSeq(previous: number, highest: number): number {
  return highest < previous ? -1 : previous;
}

/**
 * The floating numbers owed for the events that arrived since `sinceSeq`.
 *
 * Nothing here is inferred: `kind`, `amount`, `targetId` and the `:critical`
 * suffix on `reason` are exactly the fields `EventLog` renders as sentences.
 */
export function floatersFromEvents(
  events: readonly DomainEvent[],
  sinceSeq: number,
  limit = FLOATER_BURST_LIMIT,
): FloaterSpec[] {
  const picked: FloaterSpec[] = [];
  for (const event of events) {
    if (event.seq <= sinceSeq) continue;
    if (event.kind !== 'damage' && event.kind !== 'heal') continue;
    if (event.targetId === null) continue;
    const amount = event.amount;
    if (amount === null || !Number.isFinite(amount) || amount <= 0) continue;
    picked.push({
      seq: event.seq,
      targetId: event.targetId,
      amount,
      kind: event.kind,
      critical: (event.reason ?? '').endsWith(':critical'),
    });
  }
  return picked.length > limit ? picked.slice(picked.length - limit) : picked;
}

/**
 * The reference's `pop-drift`: a short rise into place, a hold, then a fade out
 * while it keeps rising. Pure, so the curve is tested rather than eyeballed.
 */
export function floaterFrame(
  ageMs: number,
  lifetimeMs = FLOATER_LIFETIME_MS,
): { offsetY: number; alpha: number; done: boolean } {
  if (ageMs <= 0) return { offsetY: 8, alpha: 0, done: false };
  if (ageMs >= lifetimeMs) return { offsetY: -FLOATER_RISE_PX, alpha: 0, done: true };
  const progress = ageMs / lifetimeMs;
  const offsetY = progress < 0.12
    ? 8 - (8 * progress) / 0.12
    : -(FLOATER_RISE_PX * (progress - 0.12)) / 0.88;
  const alpha = progress < 0.12
    ? progress / 0.12
    : progress < 0.7
      ? 1
      : 1 - (progress - 0.7) / 0.3;
  return { offsetY, alpha, done: false };
}

/** The current-target ring's breath: a cosine, so it never jumps at wrap-around. */
export function ringPulse(ageMs: number, periodMs = RING_PULSE_MS): { scale: number; alpha: number } {
  const safe = Number.isFinite(ageMs) ? ageMs : 0;
  const phase = (((safe % periodMs) + periodMs) % periodMs) / periodMs;
  const wave = (1 - Math.cos(phase * Math.PI * 2)) / 2;
  return { scale: 1 + wave * 0.14, alpha: 0.55 + wave * 0.45 };
}

export interface IntentDash {
  x: number;
  y: number;
  rotation: number;
}

/**
 * Where the dashes of one attacker → target line go. Both ends are cleared by
 * `clearance` so no dash disappears under a token plate, and the run is centred
 * in what is left so the line reads as deliberate at any distance.
 */
export function intentDashes(
  from: { x: number; y: number },
  to: { x: number; y: number },
  spacing = 17,
  clearance = 26,
): IntentDash[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length === 0) return [];
  const usable = length - clearance * 2;
  if (usable < spacing) return [];
  const rotation = Math.atan2(dy, dx);
  const count = Math.floor(usable / spacing) + 1;
  const start = clearance + (usable - (count - 1) * spacing) / 2;
  const dashes: IntentDash[] = [];
  for (let index = 0; index < count; index++) {
    const distance = start + index * spacing;
    dashes.push({ x: from.x + (dx / length) * distance, y: from.y + (dy / length) * distance, rotation });
  }
  return dashes;
}

// --- renderer ---------------------------------------------------------------

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function motionQuery(): MediaQueryList | null {
  const host = globalThis as { matchMedia?: (query: string) => MediaQueryList };
  return typeof host.matchMedia === 'function' ? host.matchMedia(REDUCED_MOTION_QUERY) : null;
}

/** `false` wherever `matchMedia` is unavailable, which is the motion-allowed default. */
export function prefersReducedMotion(): boolean {
  return motionQuery()?.matches === true;
}

interface PlaceOptions {
  /** Radians, applied about the entry's own origin. Only meaningful in `'pixel'` space. */
  rotation?: number;
  scale?: number;
  alpha?: number;
}

function drawEntry(
  graphics: Graphics,
  entry: ArtEntry,
  originX: number,
  originY: number,
  frame: DrawFrame,
  options: PlaceOptions = {},
): void {
  const scale = spaceScale(entry.space, frame);
  const rotation = options.rotation ?? 0;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const size = options.scale ?? 1;
  const alphaScale = options.alpha ?? 1;
  for (const part of entry.shapes) {
    if (part.shape.kind === 'polygon') {
      const points: number[] = [];
      for (let index = 0; index < part.shape.points.length; index += 2) {
        const localX = part.shape.points[index] * size;
        const localY = part.shape.points[index + 1] * size;
        points.push(
          originX + (localX * cos - localY * sin) * scale.x,
          originY + (localX * sin + localY * cos) * scale.y,
        );
      }
      graphics.poly(points);
    } else {
      const localX = part.shape.cx * size;
      const localY = part.shape.cy * size;
      graphics.circle(
        originX + (localX * cos - localY * sin) * scale.x,
        originY + (localX * sin + localY * cos) * scale.y,
        part.shape.radius * size * scale.x,
      );
    }
    if (part.fill !== undefined) graphics.fill({ color: part.fill, alpha: (part.alpha ?? 1) * alphaScale });
    if (part.stroke !== undefined) {
      graphics.stroke({
        color: part.stroke.color,
        width: part.stroke.width,
        alpha: (part.stroke.alpha ?? 1) * alphaScale,
      });
    }
  }
}

/** Resolve a manifest key and paint it; the renderer never authors a shape. */
function paint(
  graphics: Graphics,
  key: string,
  originX: number,
  originY: number,
  frame: DrawFrame,
  options: PlaceOptions = {},
): void {
  drawEntry(graphics, artFor(key), originX, originY, frame, options);
}

function bar(graphics: Graphics, x: number, y: number, width: number, ratio: number, colour: string): void {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  graphics.rect(x - 1, y - 1, width + 2, 7).fill({ color: palette.iron0, alpha: 0.92 });
  graphics.rect(x, y, width, 5).fill({ color: mix(colour, palette.iron0, 0.72) });
  if (clamped > 0) {
    graphics.rect(x, y, width * clamped, 5).fill({ color: colour });
    // Gloss, matching the reference's bar highlight — a shape cue, not a hue.
    graphics.rect(x, y, width * clamped, 2).fill({ color: mix(colour, palette.vellum, 0.45), alpha: 0.5 });
  }
}

const BOARD_FONT = 'Alegreya Sans, Segoe UI, sans-serif';

/** Every board label is stroked: the canvas behind it is busy and unpredictable. */
function label(text: string, size: number, colour: string, strokeWidth = 3): Text {
  const node = new Text({
    text,
    style: {
      fontFamily: BOARD_FONT,
      fontSize: size,
      fontWeight: '700',
      fill: colour,
      stroke: { color: palette.iron0, width: strokeWidth, join: 'round' },
    },
  });
  node.anchor.set(0.5, 1);
  return node;
}

function floaterText(spec: FloaterSpec, language: string): Text {
  // The sign is the cue that survives greyscale; size is the cue for a critical.
  const magnitude = formatNumber(spec.amount, language);
  const colour = spec.kind === 'heal'
    ? palette.hpAlly
    : spec.critical
      ? palette.emberHot
      : palette.vellum;
  const node = new Text({
    text: spec.kind === 'heal' ? `+${magnitude}` : `−${magnitude}`,
    style: {
      fontFamily: BOARD_FONT,
      fontSize: spec.critical ? 24 : 17,
      fontWeight: '800',
      fill: colour,
      stroke: { color: palette.iron0, width: spec.critical ? 5 : 4, join: 'round' },
    },
  });
  node.anchor.set(0.5, 1);
  return node;
}

interface PlacedActor {
  id: string;
  column: number;
  row: number;
  actor: PublicActor;
  x: number;
  y: number;
}

/**
 * A ring the ticker breathes. Every ring shares one phase — driven by the
 * clock, not by when the ring was built — so a state update that rebuilds the
 * scene does not restart the animation.
 */
interface PulsedRing {
  container: Container;
}

function paintGround(root: Container, grid: GridConfig, frame: DrawFrame): void {
  // Row-major is already painter's order for the extrusion: both neighbours that
  // cover a tile's side faces — (column + 1, row) and (column, row + 1) — are
  // drawn after it, so only the board's two front edges show their thickness.
  const ground = new Graphics();
  const lanes = new Graphics();
  for (let row = 0; row < grid.height; row++) {
    for (let column = 0; column < grid.width; column++) {
      const { x, y } = projectCell(column, row, frame.tileWidth, frame.tileHeight);
      const party = grid.playerRows.includes(row);
      const enemy = grid.enemyRows.includes(row);
      paint(ground, party ? 'tile.party-zone' : enemy ? 'tile.enemy-zone' : 'tile.ground', x, y, frame);
      paint(lanes, party ? 'marker.spawn' : enemy ? 'marker.spawn-enemy' : 'marker.neutral-lane', x, y, frame);
    }
  }
  root.addChild(ground);
  root.addChild(lanes);
}

function paintZoneLabels(root: Container, grid: GridConfig, frame: DrawFrame, t: Translate): void {
  const firstPartyRow = [...grid.playerRows].sort((a, b) => a - b)[0] ?? 0;
  const firstEnemyRow = [...grid.enemyRows].sort((a, b) => a - b)[0] ?? 0;
  const partyAnchor = projectCell(grid.width, firstPartyRow, frame.tileWidth, frame.tileHeight);
  const enemyAnchor = projectCell(grid.width, firstEnemyRow, frame.tileWidth, frame.tileHeight);
  const partyLabel = label(t('board.partyZone'), 13, palette.steel);
  partyLabel.position.set(partyAnchor.x, partyAnchor.y);
  root.addChild(partyLabel);
  const enemyLabel = label(t('board.enemyZone'), 13, palette.emberHot);
  enemyLabel.position.set(enemyAnchor.x, enemyAnchor.y);
  root.addChild(enemyLabel);
}

/** Chest height, so an intent line floats over the plates instead of through them. */
const INTENT_HEIGHT = 18;

/**
 * Where the HP bar sits, in the token's own pixel frame. It shares that frame
 * with `marker.target` (the caret, just above it) and `marker.casting` (beside
 * the head), so the three cues are laid out against each other here and in the
 * manifest rather than colliding by accident.
 */
const HP_BAR_Y = -52;

function paintIntentLines(root: Container, placed: readonly PlacedActor[], frame: DrawFrame): void {
  const byId = new Map(placed.map((entity) => [entity.id, entity]));
  const links = new Graphics();
  for (const entity of placed) {
    const targetId = entity.actor.currentTarget;
    if (targetId === null || targetId === entity.id) continue;
    const target = byId.get(targetId);
    if (target === undefined) continue;
    const key = intentArtKey(entity.actor.side);
    const from = { x: entity.x, y: entity.y - INTENT_HEIGHT };
    const to = { x: target.x, y: target.y - INTENT_HEIGHT };
    for (const dash of intentDashes(from, to)) {
      paint(links, key, dash.x, dash.y, frame, { rotation: dash.rotation });
    }
  }
  root.addChild(links);
}

/** The ids something on the board is currently pointed at. */
export function targetedIds(actors: readonly PublicActor[]): Set<string> {
  return new Set(actors.map((actor) => actor.currentTarget).filter((id): id is string => id !== null));
}

function paintTargetRings(
  root: Container,
  placed: readonly PlacedActor[],
  targeted: ReadonlySet<string>,
  frame: DrawFrame,
): PulsedRing[] {
  const rings: PulsedRing[] = [];
  for (const entity of placed) {
    if (!targeted.has(entity.id)) continue;
    const container = new Container();
    const graphics = new Graphics();
    paint(graphics, 'marker.target-ring', 0, 0, frame);
    container.addChild(graphics);
    container.position.set(entity.x, entity.y);
    root.addChild(container);
    rings.push({ container });
  }
  return rings;
}

function paintTokens(
  root: Container,
  placed: readonly PlacedActor[],
  targeted: ReadonlySet<string>,
  frame: DrawFrame,
): void {
  for (const entity of placed) {
    const { x, y, actor } = entity;
    const token = new Graphics();
    paint(token, plateArtKey(actor.side), x, y, frame);
    paint(token, actorArtKey(actor), x, y, frame);
    if (targeted.has(actor.id)) paint(token, 'marker.target', x, y, frame);
    if (actor.casting !== null) paint(token, 'marker.casting', x, y, frame);

    // HP only, above the token as the reference has it. MP lives on the party
    // card; two bars per token was noise.
    const barWidth = frame.tileWidth * 0.5;
    bar(
      token,
      x - barWidth / 2,
      y + HP_BAR_Y,
      barWidth,
      actor.hp / Math.max(1, actor.maxHp),
      actor.side === 'party' ? palette.hpAlly : palette.hpFoe,
    );
    root.addChild(token);

    const name = label(actor.id, 12, actor.side === 'party' ? palette.vellum : palette.emberHot);
    const align = nameplateAlign(entity.column, entity.row);
    name.anchor.set(align === 'left' ? 1 : 0, 0.5);
    name.position.set(x + (align === 'left' ? -30 : 30), y - 26);
    root.addChild(name);
  }
}

function buildScene(
  root: Container,
  state: PublicState | null,
  grid: GridConfig,
  frame: DrawFrame,
  t: Translate,
): PulsedRing[] {
  for (const child of root.removeChildren()) child.destroy({ children: true });

  paintGround(root, grid, frame);
  paintZoneLabels(root, grid, frame, t);
  if (state === null) return [];

  const placed = state.actors
    .map((actor) => {
      const cell = gridCoordinates(actor.position);
      const { x, y } = projectCell(cell.column, cell.row, frame.tileWidth, frame.tileHeight);
      return { id: actor.id, column: cell.column, row: cell.row, actor, x, y };
    })
    .sort(compareDepth);

  const targeted = targetedIds(state.actors);
  paintIntentLines(root, placed, frame);
  const rings = paintTargetRings(root, placed, targeted, frame);
  paintTokens(root, placed, targeted, frame);
  return rings;
}

export interface BattlefieldViewProps {
  state: PublicState | null;
  grid: GridConfig;
  /**
   * The same bounded history `EventLog` renders. Optional so the board still
   * mounts before a run exists; damage and heal rows become floating numbers.
   */
  events?: readonly DomainEvent[];
  tileWidth?: number;
  tileHeight?: number;
}

const NO_EVENTS: readonly DomainEvent[] = [];

export function BattlefieldView({
  state,
  grid,
  events = NO_EVENTS,
  tileWidth = TILE_WIDTH,
  tileHeight = TILE_HEIGHT,
}: BattlefieldViewProps): React.JSX.Element {
  const { t: rawT, i18n } = useTranslation();
  const t = rawT as unknown as Translate;
  const language = i18n.language;

  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Container | null>(null);
  const floaterRef = useRef<Container | null>(null);
  const ringsRef = useRef<PulsedRing[]>([]);
  const activeRef = useRef<{ node: Text; baseY: number; bornAt: number }[]>([]);
  const seenSeqRef = useRef<number>(-1);
  const primedRef = useRef(false);
  const recentreRef = useRef<() => void>(() => {});
  const frameRef = useRef<DrawFrame>({ tileWidth, tileHeight, viewWidth: 1, viewHeight: 1 });
  frameRef.current = { ...frameRef.current, tileWidth, tileHeight };
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const [ready, setReady] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);

  // The board must answer a mid-session change of the preference, not only the
  // preference it was mounted with.
  useEffect(() => {
    const query = motionQuery();
    if (query === null || typeof query.addEventListener !== 'function') return;
    const update = (): void => setReducedMotion(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  // Lifecycle: one Application, created once, destroyed with its children and
  // textures on unmount. A resize only touches the renderer, the centring
  // transform and the view-space atmosphere — it never recreates the application
  // or any simulation state.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    let disposed = false;
    let initialised = false;
    const app = new Application();
    const root = new Container();
    const scene = new Container();
    const floaters = new Container();
    const vignette = new Graphics();
    root.addChild(scene);
    root.addChild(floaters);

    const measure = (): { width: number; height: number } => ({
      width: Math.max(1, host.clientWidth || 720),
      height: Math.max(1, host.clientHeight || 420),
    });

    const recentre = (): void => {
      if (!initialised || disposed) return;
      const { width, height } = measure();
      app.renderer.resize(width, height);
      const frame = { ...frameRef.current, viewWidth: width, viewHeight: height };
      frameRef.current = frame;
      const offset = centreOffset(sceneBounds(gridRef.current, frame.tileWidth, frame.tileHeight), width, height);
      root.position.set(offset.x, offset.y);
      // The vignette is view space: it is glued to the canvas, not to the
      // board, so it is repainted on resize and never moved by the centring
      // transform. There is no canvas backdrop any more — the environment is
      // the DOM world layer behind this canvas (WorldBackdrop.tsx), which is
      // what the approved reference does (hunt.html:823-998).
      vignette.clear();
      paint(vignette, 'atmosphere.vignette', 0, 0, frame);
    };
    recentreRef.current = recentre;

    const tick = (): void => {
      if (disposed || prefersReducedMotion()) return;
      const now = performance.now();
      for (const ring of ringsRef.current) {
        const pulse = ringPulse(now);
        ring.container.scale.set(pulse.scale);
        ring.container.alpha = pulse.alpha;
      }
      const survivors: typeof activeRef.current = [];
      for (const floater of activeRef.current) {
        const step = floaterFrame(now - floater.bornAt);
        if (step.done) {
          floater.node.destroy();
          continue;
        }
        floater.node.y = floater.baseY + step.offsetY;
        floater.node.alpha = step.alpha;
        survivors.push(floater);
      }
      activeRef.current = survivors;
    };

    const size = measure();
    void app
      .init({
        width: size.width,
        height: size.height,
        // Transparent: the painted world shows through everywhere the board
        // itself does not cover, exactly as the reference composites its
        // battlefield SVG over the world (hunt.html:999).
        backgroundAlpha: 0,
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
        app.stage.addChild(vignette);
        sceneRef.current = scene;
        floaterRef.current = floaters;
        app.ticker.add(tick);
        recentre();
        setReady(true);
      });

    globalThis.addEventListener('resize', recentre);
    return () => {
      disposed = true;
      globalThis.removeEventListener('resize', recentre);
      sceneRef.current = null;
      floaterRef.current = null;
      ringsRef.current = [];
      activeRef.current = [];
      if (initialised) app.destroy(true, { children: true, texture: true });
    };
  }, []);

  // Redraw from the current projection. Rebuilding the scene graph never touches
  // the application, the renderer or anything the simulation owns.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!ready || scene === null) return;
    recentreRef.current();
    ringsRef.current = buildScene(scene, state, grid, frameRef.current, t);
    if (reducedMotion) {
      // Static pose: the ring is still there, it simply does not breathe.
      for (const ring of ringsRef.current) {
        ring.container.scale.set(1);
        ring.container.alpha = 1;
      }
    }
  }, [ready, state, grid, tileWidth, tileHeight, t, language, reducedMotion]);

  // Floating damage and heal numbers, from the very rows the log renders.
  useEffect(() => {
    const layer = floaterRef.current;
    if (!ready || layer === null) return;

    const highest = latestEventSeq(events);
    seenSeqRef.current = rebaseSeenSeq(seenSeqRef.current, highest);

    const clear = (): void => {
      for (const floater of activeRef.current) floater.node.destroy();
      activeRef.current = [];
      for (const child of layer.removeChildren()) child.destroy({ children: true });
    };

    // A board that mounts onto an existing history must not replay it, and with
    // motion disabled no floater is ever created — the log still has every row.
    if (!primedRef.current || reducedMotion) {
      primedRef.current = true;
      seenSeqRef.current = Math.max(seenSeqRef.current, highest);
      if (reducedMotion) clear();
      return;
    }

    const specs = floatersFromEvents(events, seenSeqRef.current);
    seenSeqRef.current = Math.max(seenSeqRef.current, highest);
    if (specs.length === 0) return;

    const cells = new Map(
      (state?.actors ?? []).map((actor) => {
        const cell = gridCoordinates(actor.position);
        return [actor.id, projectCell(cell.column, cell.row, tileWidth, tileHeight)] as const;
      }),
    );
    const bornAt = performance.now();
    for (const spec of specs) {
      const cell = cells.get(spec.targetId);
      if (cell === undefined) continue;
      const node = floaterText(spec, language);
      // Above the caret and the HP bar, so a number never lands on a cue.
      const baseY = cell.y - 58;
      node.position.set(cell.x, baseY);
      node.alpha = 0;
      layer.addChild(node);
      activeRef.current.push({ node, baseY, bornAt });
    }
  }, [ready, events, state, reducedMotion, language, tileWidth, tileHeight]);

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
