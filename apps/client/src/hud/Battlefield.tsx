/**
 * The Realm battlefield (`codex-examples/realm-refined/hunt.html:1000-1182`).
 *
 * The approved mockup hand-places seven token groups and fuses the isometric
 * floor into four literal paths. Nothing here is hand-placed: the floor is drawn
 * as `grid.width` × `grid.height` diamonds, every token is one actor of
 * `PublicState.actors` projected through the board's own isometric transform,
 * every bar width is `hp / maxHp` times the bar's pixel width, and the `<title>`
 * and per-token `aria-label`s are sentences generated from the frame in hand.
 * The mockup's class names, gradients, plates and colours are reproduced exactly
 * — `styles.css` carries the mockup's rules verbatim and is never edited here.
 *
 * **Nothing is invented.** Where the mockup shows a figure milestone A does not
 * publish, the element is dropped rather than faked:
 *
 * - the Arrow Rain AoE telegraph (`hunt.html:1073-1094`) — `PublicActor.casting`
 *   is a skill id with no target area and no cast-remaining time, so neither the
 *   footprint diamond nor "lands in 0.8s" has a source;
 * - the threat / engagement link curves (`hunt.html:1070-1071`) — milestone A
 *   publishes no threat table, and `currentTarget` is already drawn as the
 *   target ring and caret;
 * - the cast bar's fill is a presence cue, not a progress read: no cast start
 *   stamp is published, so the bar is full under `prefers-reduced-motion` and
 *   sweeps under the CSS `cast-fill` animation otherwise. It never claims a
 *   percentage.
 *
 * **Reduced motion.** Everything that moves — `target-ring`, `pop`, `cast-fill`,
 * `foe-low` — moves under a CSS animation that `styles.css:751` and
 * `styles.css:777` suppress wholesale. There is no JS-driven animation here, so
 * the suppressed pose is the static pose and no information is lost: the ring,
 * caret, HP bar and cast bar are all still drawn.
 *
 * **Glyphs.** The `#g-*` symbols and the `#b-plate-*` paths are resolved by
 * reference; the plates are defined below, the glyph sprite sheet is the
 * document-level sheet the rest of the HUD shares (`hunt.html:779-784`).
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { content } from '@narok/data';
import type { GridConfig, SkillDefinition } from '@narok/data';
import type { DomainEvent, PublicActor, PublicState } from '@narok/sim';
import { gridCoordinates } from '@narok/sim';
import { formatNumber, type Translate } from '../i18n';
import {
  classNames,
  displayName,
  glyphId,
  isLowHp,
  percent,
  recentFloaters,
  skillActivity,
  splitSides,
  type Floater,
} from './model';

// --- projection -------------------------------------------------------------
//
// `projectCell`, `compareDepth`, `sceneBounds`, `centreOffset` and
// `nameplateAlign` are copied verbatim from `BattlefieldView.tsx` (ruling R58's
// binding projection, already unit-tested there). They are duplicated rather
// than imported so this component does not drag PixiJS into the HUD's module
// graph and does not break when the canvas board retires.

/** The plan's binding projection: a cell's centre in isometric screen space. */
export function projectCell(
  column: number,
  row: number,
  tileWidth: number,
  tileHeight: number,
): { x: number; y: number } {
  return { x: ((column - row) * tileWidth) / 2, y: ((column + row) * tileHeight) / 2 };
}

export interface DepthEntity {
  id: string;
  column: number;
  row: number;
}

/**
 * Painter's order: `row + column` ascending, ties broken by **ASCII** actor id,
 * so nearer tokens overlap farther ones and the order never depends on locale.
 */
export function compareDepth(a: DepthEntity, b: DepthEntity): number {
  const depthA = a.row + a.column;
  const depthB = b.row + b.column;
  if (depthA !== depthB) return depthA - depthB;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
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

/** The translation that puts the projected bounds' centre at a viewport centre. */
export function centreOffset(
  bounds: SceneBounds,
  viewWidth: number,
  viewHeight: number,
): { x: number; y: number } {
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

// --- the mockup's board, measured ------------------------------------------
//
// Every figure below is read off `hunt.html`'s own diamond
// (`M380 95 690 250 380 405 70 250Z`) inside its `viewBox="0 0 760 460"`. For
// milestone A's 5×5 grid these reproduce the mockup's lattice exactly: a
// 124×62 tile with cell (0,0) centred on (380, 126).

export const VIEW_WIDTH = 760;
export const VIEW_HEIGHT = 460;
const BOARD_CENTRE_X = 380;
const BOARD_CENTRE_Y = 250;
const BOARD_HALF_WIDTH = 310;
const BOARD_HALF_HEIGHT = 155;
/** The slab the board sits on (`hunt.html:1044-1046`). */
const SLAB_DEPTH = 25;
/** The inner hairline rule, `M380 101 678 250 380 399 82 250Z` ÷ the outline. */
const INNER_RULE_SCALE = 0.9613;
/** Where the neutral lane's caption hangs off the board's right edge. */
const LANE_LABEL_DROP = 40;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface BoardGeometry {
  readonly tileWidth: number;
  readonly tileHeight: number;
  /** Screen position of cell (0,0)'s centre. */
  readonly originX: number;
  readonly originY: number;
}

/**
 * The board fills the mockup's diamond whatever the grid's shape: the tile is
 * the diamond divided by the grid, and the projected bounds are centred on the
 * diamond's centre by the same `centreOffset` the canvas board uses.
 */
export function boardGeometry(grid: GridConfig): BoardGeometry {
  const tileWidth = (BOARD_HALF_WIDTH * 2) / Math.max(1, grid.width);
  const tileHeight = (BOARD_HALF_HEIGHT * 2) / Math.max(1, grid.height);
  const offset = centreOffset(
    sceneBounds(grid, tileWidth, tileHeight),
    BOARD_CENTRE_X * 2,
    BOARD_CENTRE_Y * 2,
  );
  return { tileWidth, tileHeight, originX: offset.x, originY: offset.y };
}

/** A cell's centre in the mockup's viewBox. */
export function cellCentre(
  geometry: BoardGeometry,
  column: number,
  row: number,
): { x: number; y: number } {
  const point = projectCell(column, row, geometry.tileWidth, geometry.tileHeight);
  return { x: point.x + geometry.originX, y: point.y + geometry.originY };
}

/**
 * A lattice corner: the point where cell columns `i` and rows `j` meet, so
 * `boardVertex(0, 0)` is the board's top corner and `boardVertex(w, h)` its
 * bottom one. Grid lines, the outline, the slab and the lane markers are all
 * drawn between these.
 */
export function boardVertex(
  geometry: BoardGeometry,
  i: number,
  j: number,
): { x: number; y: number } {
  return {
    x: geometry.originX + ((i - j) * geometry.tileWidth) / 2,
    y: geometry.originY + ((i + j) * geometry.tileHeight) / 2 - geometry.tileHeight / 2,
  };
}

/** One tile's diamond, as an SVG path. */
export function diamondPath(
  centre: { x: number; y: number },
  tileWidth: number,
  tileHeight: number,
): string {
  const halfWidth = tileWidth / 2;
  const halfHeight = tileHeight / 2;
  return [
    `M${round(centre.x)} ${round(centre.y - halfHeight)}`,
    `L${round(centre.x + halfWidth)} ${round(centre.y)}`,
    `L${round(centre.x)} ${round(centre.y + halfHeight)}`,
    `L${round(centre.x - halfWidth)} ${round(centre.y)}`,
    'Z',
  ].join('');
}

export type Lane = 'foe' | 'ally' | 'neutral';

/** A row's lane, straight from the grid's declared spawn zones. */
export function laneForRow(grid: GridConfig, row: number): Lane {
  if (grid.enemyRows.includes(row)) return 'foe';
  if (grid.playerRows.includes(row)) return 'ally';
  return 'neutral';
}

export function laneRows(grid: GridConfig, lane: Lane): number[] {
  const rows: number[] = [];
  for (let row = 0; row < grid.height; row += 1) {
    if (laneForRow(grid, row) === lane) rows.push(row);
  }
  return rows;
}

/**
 * The vertical span a lane's wash covers, so the mockup's gradients can be
 * declared in user space and stay continuous across the lane's tiles instead of
 * restarting inside every diamond.
 */
export function laneBand(
  geometry: BoardGeometry,
  grid: GridConfig,
  lane: Lane,
): { top: number; bottom: number } | null {
  const rows = laneRows(grid, lane);
  if (rows.length === 0) return null;
  const first = Math.min(...rows);
  const last = Math.max(...rows);
  return {
    top: boardVertex(geometry, 0, first).y,
    bottom: boardVertex(geometry, grid.width, last + 1).y,
  };
}

/** The filled part of an HP bar, in pixels — never wider than the bar. */
export function hpBarWidth(actor: PublicActor, barWidth: number): number {
  if (!Number.isFinite(actor.hp) || !Number.isFinite(actor.maxHp) || actor.maxHp <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, actor.hp / actor.maxHp));
  return round(ratio * barWidth);
}

// --- token metrics ----------------------------------------------------------
//
// One metric set per side, taken from the mockup's unscaled tokens (Sigrun for
// the party, the Quarry Revenant for the foes). The mockup scales individual
// tokens by eye; milestone A publishes no size, rank or "elite" flag, so every
// token of a side is drawn at that side's one size.

interface TokenMetrics {
  readonly shadowRx: number;
  readonly shadowRy: number;
  readonly ringRx: number;
  readonly ringRy: number;
  readonly ringStroke: string;
  readonly ringOpacity: number;
  readonly plateHref: string;
  readonly plateFill: string;
  readonly plateStroke: string;
  readonly plateStrokeWidth: number;
  readonly plateDy: number;
  readonly glyphSize: number;
  readonly glyphDy: number;
  readonly barWidth: number;
  readonly barHeight: number;
  readonly barDy: number;
  readonly trackFill: string;
  readonly hpFill: string;
}

const ALLY_TOKEN: TokenMetrics = {
  shadowRx: 22,
  shadowRy: 9,
  ringRx: 20,
  ringRy: 8,
  ringStroke: '#9cc0dc',
  ringOpacity: 0.8,
  plateHref: '#b-plate-ally',
  plateFill: 'url(#b-ally)',
  plateStroke: '#dcb67c',
  plateStrokeWidth: 1.6,
  plateDy: -23,
  glyphSize: 20,
  glyphDy: -34,
  barWidth: 42,
  barHeight: 5,
  barDy: -55,
  trackFill: '#050708',
  hpFill: '#62c26f',
};

const FOE_TOKEN: TokenMetrics = {
  shadowRx: 21,
  shadowRy: 9,
  ringRx: 19,
  ringRy: 8,
  ringStroke: '#e0673a',
  ringOpacity: 0.75,
  plateHref: '#b-plate-foe',
  plateFill: 'url(#b-foe)',
  plateStroke: '#e8804a',
  plateStrokeWidth: 1.8,
  plateDy: -25,
  glyphSize: 20,
  glyphDy: -35,
  barWidth: 42,
  barHeight: 5,
  barDy: -60,
  trackFill: '#0a0605',
  hpFill: '#d8483a',
};

/** The mockup's per-glyph tint (`hunt.html:1100-1162`), by sheet symbol. */
const GLYPH_TINT: Record<string, string> = {
  'g-guardian': '#eaf2f8',
  'g-cleric': '#fff4d6',
  'g-ranger': '#e6fff0',
  'g-slagjaw': '#ffe2cf',
};

function glyphTint(actor: PublicActor): string {
  return GLYPH_TINT[glyphId(actor)] ?? (actor.side === 'party' ? '#eaf2f8' : '#ffd9c4');
}

function metricsFor(actor: PublicActor): TokenMetrics {
  return actor.side === 'party' ? ALLY_TOKEN : FOE_TOKEN;
}

/** The nameplate's offset from the token's centre. */
const NAME_DX = 28;
const NAME_DY = -22;
/** Half a projected step, so a cell clears the names of the cells beside it. */
const NAME_ROW_STAGGER = 16;
/** The target caret sits just above the HP bar. */
const CARET_DY = -8;
/** The target ring, `hunt.html:1116` reduced to the unscaled token. */
const TARGET_RING_RX = 24;
const TARGET_RING_RY = 11;
/** The cast bar under a token (`hunt.html:1165-1166`). */
const CAST_BAR_WIDTH = 56;
const CAST_BAR_HEIGHT = 6;
const CAST_BAR_DY = 13;
/** Floating numbers clear the HP bar, and stack when several land at once. */
const FLOATER_DY = -64;
const FLOATER_STACK = 18;

// --- derived state ----------------------------------------------------------

/**
 * The skill an actor is casting with a bar worth drawing. `skillActivity` is the
 * model's own rule: a `baseCastMs === 0` skill is `active`, not `casting`, so it
 * never gets a bar (ruling R87), and a basic attack never does either.
 */
function castingSkill(actor: PublicActor, nowMs: number): SkillDefinition | null {
  if (actor.casting === null || actor.casting === 'basic') return null;
  const skill = content.skills[actor.casting as keyof typeof content.skills];
  if (skill === undefined) return null;
  return skillActivity(actor, skill, nowMs) === 'casting' ? skill : null;
}

/** Every actor id a party member is currently pointed at. */
function partyTargets(party: readonly PublicActor[]): Set<string> {
  return new Set(
    party
      .map((actor) => actor.currentTarget)
      .filter((id): id is string => id !== null),
  );
}

interface PlacedActor extends DepthEntity {
  readonly actor: PublicActor;
  readonly x: number;
  readonly y: number;
}

function placeActors(state: PublicState | null, geometry: BoardGeometry): PlacedActor[] {
  if (state === null) return [];
  return state.actors
    .map((actor) => {
      const cell = gridCoordinates(actor.position);
      const centre = cellCentre(geometry, cell.column, cell.row);
      return { id: actor.id, column: cell.column, row: cell.row, actor, x: centre.x, y: centre.y };
    })
    .sort(compareDepth);
}

// --- generated prose --------------------------------------------------------

function boardTitle(
  t: Translate,
  language: string,
  state: PublicState | null,
  focus: PublicActor | null,
): string {
  if (state === null) return t('board.empty');
  const { party, enemies } = splitSides(state);
  const sentence = t('battlefield.title', {
    defaultValue: 'Battlefield: {{party}} party members against {{enemies}} enemies, {{phase}}.',
    party: formatNumber(party.length, language),
    enemies: formatNumber(enemies.length, language),
    phase: t(`phase.${state.phase}`, { defaultValue: state.phase }),
  });
  if (focus === null) return sentence;
  return t('battlefield.titleFocus', {
    defaultValue: '{{sentence}} Current target: {{name}} at {{percent}} percent health.',
    sentence,
    name: displayName(t, focus),
    percent: formatNumber(percent(focus.hp, focus.maxHp), language),
  });
}

function tokenLabel(
  t: Translate,
  language: string,
  actor: PublicActor,
  targeted: boolean,
  casting: SkillDefinition | null,
): string {
  let label = t('battlefield.token', {
    defaultValue: '{{name}} {{id}}, {{percent}} percent health',
    name: displayName(t, actor),
    id: actor.id,
    percent: formatNumber(percent(actor.hp, actor.maxHp), language),
  });
  if (targeted) {
    label = t('battlefield.tokenTarget', { defaultValue: '{{label}}, current target', label });
  }
  if (casting !== null) {
    label = t('battlefield.tokenCasting', {
      defaultValue: '{{label}}, casting {{skill}}',
      label,
      skill: t(`skill.${casting.id}`, { defaultValue: casting.id }),
    });
  }
  return label;
}

// --- the floor --------------------------------------------------------------

function renderDefs(geometry: BoardGeometry, grid: GridConfig): React.JSX.Element {
  const top = boardVertex(geometry, 0, 0).y;
  const bottom = boardVertex(geometry, grid.width, grid.height).y;
  const foe = laneBand(geometry, grid, 'foe');
  const ally = laneBand(geometry, grid, 'ally');
  return (
    <defs>
      {/* The mockup's gradients, in user space so one wash spans a whole lane
          instead of repeating inside every tile. */}
      <linearGradient id="b-tile" x1="0" y1={round(top)} x2="0" y2={round(bottom)} gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#4a392c" />
        <stop offset="1" stopColor="#2e231b" />
      </linearGradient>
      <linearGradient
        id="b-foe-half"
        x1="0"
        y1={round(foe?.top ?? top)}
        x2="0"
        y2={round(foe?.bottom ?? bottom)}
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0" stopColor="#ff6a2a" stopOpacity=".12" />
        <stop offset="1" stopColor="#ff6a2a" stopOpacity=".02" />
      </linearGradient>
      <linearGradient
        id="b-ally-half"
        x1="0"
        y1={round(ally?.top ?? top)}
        x2="0"
        y2={round(ally?.bottom ?? bottom)}
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0" stopColor="#8fb8dc" stopOpacity=".03" />
        <stop offset="1" stopColor="#8fb8dc" stopOpacity=".14" />
      </linearGradient>
      <pattern
        id="b-hatch"
        width="10"
        height="10"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(-27)"
      >
        <path d="M0 5h10" stroke="#0d0906" strokeWidth="3.2" strokeOpacity=".55" />
      </pattern>
      <linearGradient id="b-ally" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#6d8fae" />
        <stop offset=".55" stopColor="#34495e" />
        <stop offset="1" stopColor="#1a2430" />
      </linearGradient>
      <linearGradient id="b-foe" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#9a3a1c" />
        <stop offset=".6" stopColor="#4a170a" />
        <stop offset="1" stopColor="#230a04" />
      </linearGradient>
      <filter id="b-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="4" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <path id="b-plate-ally" d="M-17-20H17V0c0 12-8 18.5-17 22.5C-9 18.5-17 12-17 0Z" />
      <path id="b-plate-foe" d="M0-23 18-9 13 13 0 23-13 13-18-9Z" />
    </defs>
  );
}

/** The slab the board stands on, extruded from its two lower edges. */
function renderSlab(geometry: BoardGeometry, grid: GridConfig): React.JSX.Element {
  const left = boardVertex(geometry, 0, grid.height);
  const bottom = boardVertex(geometry, grid.width, grid.height);
  const right = boardVertex(geometry, grid.width, 0);
  const point = (value: { x: number; y: number }, drop = 0): string =>
    `${round(value.x)} ${round(value.y + drop)}`;
  return (
    <g>
      <path
        d={`M${point(left)}L${point(bottom)}L${point(bottom, SLAB_DEPTH)}L${point(left, SLAB_DEPTH)}Z`}
        fill="#1d140e"
      />
      <path
        d={`M${point(bottom)}L${point(right)}L${point(right, SLAB_DEPTH)}L${point(bottom, SLAB_DEPTH)}Z`}
        fill="#3a261a"
      />
      <path
        d={`M${point(left, SLAB_DEPTH)}L${point(bottom, SLAB_DEPTH)}L${point(right, SLAB_DEPTH)}`}
        fill="none"
        stroke="#000"
        strokeOpacity=".5"
        strokeWidth="3"
      />
    </g>
  );
}

/** Real per-cell diamonds, tinted by the lane their row belongs to. */
function renderTiles(geometry: BoardGeometry, grid: GridConfig): React.JSX.Element {
  const tiles: React.JSX.Element[] = [];
  for (let row = 0; row < grid.height; row += 1) {
    const lane = laneForRow(grid, row);
    for (let column = 0; column < grid.width; column += 1) {
      const path = diamondPath(
        cellCentre(geometry, column, row),
        geometry.tileWidth,
        geometry.tileHeight,
      );
      const key = `${column}-${row}`;
      if (lane === 'neutral') {
        // The mockup's no-spawn lane: a darkened band under the hatch.
        tiles.push(<path key={`${key}-wash`} d={path} fill="#140e0a" fillOpacity=".7" />);
        tiles.push(<path key={`${key}-hatch`} d={path} fill="url(#b-hatch)" />);
        continue;
      }
      tiles.push(
        <path key={key} d={path} fill={lane === 'foe' ? 'url(#b-foe-half)' : 'url(#b-ally-half)'} />,
      );
    }
  }
  return <g>{tiles}</g>;
}

/** The bevel: a dark rule on every internal cell boundary, lit one pixel below. */
function renderGridLines(geometry: BoardGeometry, grid: GridConfig): React.JSX.Element {
  const line = (a: { x: number; y: number }, b: { x: number; y: number }, drop: number): string =>
    `M${round(a.x)} ${round(a.y + drop)}L${round(b.x)} ${round(b.y + drop)}`;
  const paths = (drop: number): string[] => {
    const out: string[] = [];
    for (let i = 1; i < grid.width; i += 1) {
      out.push(line(boardVertex(geometry, i, 0), boardVertex(geometry, i, grid.height), drop));
    }
    for (let j = 1; j < grid.height; j += 1) {
      out.push(line(boardVertex(geometry, 0, j), boardVertex(geometry, grid.width, j), drop));
    }
    return out;
  };
  return (
    <g>
      <g stroke="#0c0806" strokeOpacity=".75" strokeWidth="2">
        <path d={paths(0).join('')} fill="none" />
      </g>
      <g stroke="#e8c79a" strokeOpacity=".1" strokeWidth="1">
        <path d={paths(1).join('')} fill="none" />
      </g>
    </g>
  );
}

/** The board's four corners, clockwise from the top one. */
function boardCorners(geometry: BoardGeometry, grid: GridConfig): { x: number; y: number }[] {
  return [
    boardVertex(geometry, 0, 0),
    boardVertex(geometry, grid.width, 0),
    boardVertex(geometry, grid.width, grid.height),
    boardVertex(geometry, 0, grid.height),
  ];
}

function polygonPath(points: readonly { x: number; y: number }[]): string {
  return `${points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${round(point.x)} ${round(point.y)}`)
    .join('')}Z`;
}

/** The board's outline and its inner hairline rule. */
function renderOutline(geometry: BoardGeometry, grid: GridConfig): React.JSX.Element {
  const corners = boardCorners(geometry, grid);
  const centreY = (corners[0].y + corners[2].y) / 2;
  const inner = corners.map((corner) => ({
    x: BOARD_CENTRE_X + (corner.x - BOARD_CENTRE_X) * INNER_RULE_SCALE,
    y: centreY + (corner.y - centreY) * INNER_RULE_SCALE,
  }));
  return (
    <g fill="none">
      <path d={polygonPath(corners)} stroke="#b8905a" strokeWidth="2" />
      <path d={polygonPath(inner)} stroke="#b8905a" strokeOpacity=".25" strokeWidth="1" />
    </g>
  );
}

/**
 * The dashed rule on each boundary the neutral lane shares with a spawn lane or
 * the board edge (`hunt.html:1051`). Drawn with the floor, under the bevel, as
 * the mockup draws it.
 */
function renderNeutralBoundaries(
  geometry: BoardGeometry,
  grid: GridConfig,
): React.JSX.Element | null {
  const rows = laneRows(grid, 'neutral');
  if (rows.length === 0) return null;
  const boundaries = new Set<number>();
  for (const row of rows) {
    if (row === 0 || laneForRow(grid, row - 1) !== 'neutral') boundaries.add(row);
    if (row === grid.height - 1 || laneForRow(grid, row + 1) !== 'neutral') boundaries.add(row + 1);
  }
  const dashes = [...boundaries]
    .sort((a, b) => a - b)
    .map((j) => {
      const a = boardVertex(geometry, 0, j);
      const b = boardVertex(geometry, grid.width, j);
      return `M${round(a.x)} ${round(a.y)}L${round(b.x)} ${round(b.y)}`;
    })
    .join('');
  return (
    <path
      d={dashes}
      fill="none"
      stroke="#c9a46a"
      strokeOpacity=".5"
      strokeWidth="1.2"
      strokeDasharray="6 5"
    />
  );
}

/**
 * The neutral lane's markers: a pip on each board edge beside it and the caption
 * the mockup writes off its right edge. Rendered only when the grid actually has
 * a row in neither spawn zone — for milestone A's 5×5 that is row 2, and "no
 * spawns" is then literally true.
 */
function renderNeutralLane(
  geometry: BoardGeometry,
  grid: GridConfig,
  label: string,
): React.JSX.Element | null {
  const rows = laneRows(grid, 'neutral');
  if (rows.length === 0) return null;

  const pip = (point: { x: number; y: number }): string =>
    `M${round(point.x)} ${round(point.y - 6)}l7 6-7 6-7-6Z`;
  const pips = rows.map((row) => {
    const leftEdge = {
      x: (boardVertex(geometry, 0, row).x + boardVertex(geometry, 0, row + 1).x) / 2,
      y: (boardVertex(geometry, 0, row).y + boardVertex(geometry, 0, row + 1).y) / 2,
    };
    const rightEdge = {
      x:
        (boardVertex(geometry, grid.width, row).x + boardVertex(geometry, grid.width, row + 1).x) / 2,
      y:
        (boardVertex(geometry, grid.width, row).y + boardVertex(geometry, grid.width, row + 1).y) / 2,
    };
    return (
      <g key={`pip-${row}`}>
        <path d={pip(leftEdge)} />
        <path d={pip(rightEdge)} />
      </g>
    );
  });

  const anchor = boardVertex(geometry, grid.width, Math.min(...rows));
  return (
    <g>
      <g fill="#d9b47a">{pips}</g>
      <text
        className="lane-label"
        x={round(anchor.x)}
        y={round(anchor.y + LANE_LABEL_DROP)}
        textAnchor="start"
      >
        {label}
      </text>
    </g>
  );
}

// --- tokens -----------------------------------------------------------------

/**
 * Which tokens get a drawn nameplate.
 *
 * The mockup names all seven of its tokens because it hand-placed them far
 * apart. A real board packs actors into neighbouring cells, which project barely
 * half a tile apart, and the plates then overprint each other into an unreadable
 * stack. So a plate is drawn only where it clears the plates already placed,
 * walking in depth order so the result is stable frame to frame. The token
 * itself, its health bar and its `aria-label` are unaffected — only the drawn
 * text is dropped, and the target frame names the focused enemy regardless.
 */
const NAME_CLEAR_X = 76;
const NAME_CLEAR_Y = 17;

/**
 * Who keeps their plate when two collide: the party first, then whatever the
 * party is aimed at, then the rest of the field. A crowd of identical foes is
 * the case that overflows, and losing one of those names costs far less than
 * losing the name of a character the operator is actually reading.
 */
function namePriority(entry: PlacedActor, targeted: ReadonlySet<string>): number {
  if (entry.actor.side === 'party') return 0;
  return targeted.has(entry.id) ? 1 : 2;
}

export function nameplateVisibility(
  placed: readonly PlacedActor[],
  targeted: ReadonlySet<string>,
): ReadonlySet<string> {
  const shown = new Set<string>();
  const taken: { x: number; y: number }[] = [];
  // Depth order breaks ties, so the kept set stays stable between frames.
  const byPriority = [...placed].sort(
    (a, b) => namePriority(a, targeted) - namePriority(b, targeted),
  );
  for (const entry of byPriority) {
    const align = nameplateAlign(entry.column, entry.row);
    const x = align === 'left' ? entry.x - NAME_DX : entry.x + NAME_DX;
    const y = entry.y + NAME_DY - ((entry.column + entry.row) % 2 === 0 ? 0 : NAME_ROW_STAGGER);
    const collides = taken.some(
      (other) => Math.abs(other.x - x) < NAME_CLEAR_X && Math.abs(other.y - y) < NAME_CLEAR_Y,
    );
    if (collides) continue;
    taken.push({ x, y });
    shown.add(entry.id);
  }
  return shown;
}

function renderToken(
  placed: PlacedActor,
  targeted: boolean,
  casting: SkillDefinition | null,
  label: string,
  name: string,
  showName: boolean,
): React.JSX.Element {
  const { actor, x, y } = placed;
  const metrics = metricsFor(actor);
  const barX = x - metrics.barWidth / 2;
  const barY = y + metrics.barDy;
  const fillWidth = hpBarWidth(actor, metrics.barWidth - 2);
  const align = nameplateAlign(placed.column, placed.row);
  const low = actor.side === 'enemy' && isLowHp(actor);

  return (
    <g key={actor.id} aria-label={label}>
      <ellipse
        cx={round(x)}
        cy={round(y)}
        rx={metrics.shadowRx}
        ry={metrics.shadowRy}
        fill="#000"
        fillOpacity=".55"
      />
      {targeted ? (
        <ellipse
          className="target-ring"
          cx={round(x)}
          cy={round(y)}
          rx={TARGET_RING_RX}
          ry={TARGET_RING_RY}
          fill="none"
          stroke="#ffd690"
          strokeWidth="2"
          strokeDasharray="7 5"
        />
      ) : casting !== null ? (
        <ellipse
          cx={round(x)}
          cy={round(y)}
          rx={metrics.ringRx}
          ry={metrics.ringRy}
          fill="none"
          stroke="#ffb66a"
          strokeWidth="1.8"
          filter="url(#b-glow)"
        />
      ) : (
        <ellipse
          cx={round(x)}
          cy={round(y)}
          rx={metrics.ringRx}
          ry={metrics.ringRy}
          fill="none"
          stroke={metrics.ringStroke}
          strokeOpacity={metrics.ringOpacity}
          strokeWidth="1.5"
        />
      )}
      <use
        href={metrics.plateHref}
        transform={`translate(${round(x)} ${round(y + metrics.plateDy)})`}
        fill={metrics.plateFill}
        stroke={metrics.plateStroke}
        strokeWidth={metrics.plateStrokeWidth}
      />
      <use
        href={`#${glyphId(actor)}`}
        x={round(x - metrics.glyphSize / 2)}
        y={round(y + metrics.glyphDy)}
        width={metrics.glyphSize}
        height={metrics.glyphSize}
        color={glyphTint(actor)}
      />
      {targeted && (
        <path
          d={`M${round(x - 6)} ${round(barY + CARET_DY)}h12l-6 7Z`}
          fill="#ffd690"
        />
      )}
      <rect
        x={round(barX)}
        y={round(barY)}
        width={metrics.barWidth}
        height={metrics.barHeight}
        rx="1"
        fill={metrics.trackFill}
        stroke="#000"
      />
      <rect
        className={classNames(low && 'foe-low')}
        x={round(barX + 1)}
        y={round(barY + 1)}
        width={fillWidth}
        height={metrics.barHeight - 2}
        fill={low ? '#ff5a3a' : metrics.hpFill}
      />
      {showName ? (
      <text
        className={classNames('tok-name', actor.side === 'enemy' && 'tok-name-foe')}
        x={round(align === 'left' ? x - NAME_DX : x + NAME_DX)}
        // Neighbouring cells project only half a tile apart vertically — in both
        // axes, since `projectCell` moves y by `(column + row)` — which is less
        // than a nameplate is tall, so neighbours would overprint each other.
        // Alternating by that same depth index is what actually separates them.
        y={round(y + NAME_DY - ((placed.column + placed.row) % 2 === 0 ? 0 : NAME_ROW_STAGGER))}
        textAnchor={align === 'left' ? 'end' : 'start'}
      >
        {name}
      </text>
      ) : null}
      {casting !== null && (
        <>
          <rect
            x={round(x - CAST_BAR_WIDTH / 2)}
            y={round(y + CAST_BAR_DY)}
            width={CAST_BAR_WIDTH}
            height={CAST_BAR_HEIGHT}
            rx="1"
            fill="#120a05"
            stroke="#000"
          />
          {/* No cast-start stamp is published, so the static pose is a full bar:
              the element says "a cast is in flight", never how far along it is.
              The CSS `cast-fill` sweep carries the motion when motion is on. */}
          <rect
            className="cast-fill"
            x={round(x - CAST_BAR_WIDTH / 2 + 1)}
            y={round(y + CAST_BAR_DY + 1)}
            width={CAST_BAR_WIDTH - 2}
            height={CAST_BAR_HEIGHT - 2}
            fill="#ff9a45"
            style={
              {
                transformBox: 'fill-box',
                transformOrigin: 'left center',
                transform: 'scaleX(1)',
              } as React.CSSProperties
            }
          />
        </>
      )}
    </g>
  );
}

// --- floating combat numbers ------------------------------------------------

const POP_MODIFIERS = ['', 'pop-b', 'pop-c'] as const;

function renderFloaters(
  floaters: readonly Floater[],
  placed: readonly PlacedActor[],
  t: Translate,
  language: string,
): React.JSX.Element | null {
  if (floaters.length === 0) return null;
  const centres = new Map(placed.map((entry) => [entry.id, { x: entry.x, y: entry.y }] as const));
  const groups: React.JSX.Element[] = [];

  floaters.forEach((floater, index) => {
    const centre = centres.get(floater.targetId);
    if (centre === undefined) return;
    const y = centre.y + FLOATER_DY - index * FLOATER_STACK;
    const amount = formatNumber(Math.abs(floater.amount), language);
    const text = floater.kind === 'heal' ? `+${amount}` : amount;
    const fill = floater.kind === 'heal' ? '#8ff0a0' : floater.critical ? '#ffc15a' : '#fff6e8';
    const stroke = floater.kind === 'heal' ? '#06200c' : floater.critical ? '#3a0f02' : '#1a0c06';
    groups.push(
      <g
        key={floater.seq}
        className={classNames('pop', POP_MODIFIERS[Math.min(index, POP_MODIFIERS.length - 1)])}
      >
        <text
          x={round(centre.x)}
          y={round(y)}
          fontSize={floater.critical ? 30 : 19}
          fill={fill}
          stroke={stroke}
          strokeWidth={floater.critical ? 5 : 4}
          textAnchor="middle"
        >
          {text}
        </text>
        {floater.critical && (
          <text
            x={round(centre.x)}
            y={round(y - 24)}
            fontSize={12}
            fontStyle="italic"
            fill="#ffe6c2"
            stroke="#3a0f02"
            strokeWidth={3}
            textAnchor="middle"
          >
            {t('battlefield.critical', { defaultValue: 'Critical' })}
          </text>
        )}
      </g>,
    );
  });

  if (groups.length === 0) return null;
  return (
    <g
      fontFamily="Alegreya Sans, sans-serif"
      fontWeight="800"
      paintOrder="stroke"
      strokeLinejoin="round"
    >
      {groups}
    </g>
  );
}

// --- component --------------------------------------------------------------

export interface BattlefieldProps {
  state: PublicState | null;
  grid: GridConfig;
  events: readonly DomainEvent[];
}

export function Battlefield({ state, grid, events }: BattlefieldProps): React.JSX.Element {
  const { t: rawT, i18n } = useTranslation();
  const t = rawT as unknown as Translate;
  const language = i18n.language;

  const nowMs = state?.nowMs ?? 0;
  const laneLabel = t('battlefield.laneNeutral', { defaultValue: 'Neutral lane, no spawns' });

  // The board itself is a function of the grid alone, and the grid is a content
  // constant. Rebuilding the gradients, the slab, every tile diamond, the grid
  // lines and the outline on each published frame cost more than the handful of
  // tokens that actually move over them.
  const geometry = useMemo(() => boardGeometry(grid), [grid]);
  const chrome = useMemo(
    () => (
      <>
        {renderDefs(geometry, grid)}
        {renderSlab(geometry, grid)}
        {/* The ground the tiles are washed over, so no antialiasing seam between
            two diamonds can show the page through the board. */}
        <path d={polygonPath(boardCorners(geometry, grid))} fill="url(#b-tile)" />
        {renderTiles(geometry, grid)}
        {renderNeutralBoundaries(geometry, grid)}
        {renderGridLines(geometry, grid)}
        {renderOutline(geometry, grid)}
        {renderNeutralLane(geometry, grid, laneLabel)}
      </>
    ),
    [geometry, grid, laneLabel],
  );

  const placed = placeActors(state, geometry);
  const { party, enemies } = splitSides(state);
  const targeted = partyTargets(party);
  const nameplates = nameplateVisibility(placed, targeted);
  const focus = enemies.find((enemy) => targeted.has(enemy.id)) ?? null;

  return (
    <svg className="battlefield" viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} role="img" aria-labelledby="bf-title">
      <title id="bf-title">{boardTitle(t, language, state, focus)}</title>
      {chrome}
      {/* Computed once per frame so the kept set is stable. */}
      {placed.map((entry) => {
        const named = nameplates.has(entry.id);
        const isTargeted = entry.actor.side === 'enemy' && targeted.has(entry.id);
        const casting = castingSkill(entry.actor, nowMs);
        return renderToken(
          entry,
          isTargeted,
          casting,
          tokenLabel(t, language, entry.actor, isTargeted, casting),
          displayName(t, entry.actor),
          named,
        );
      })}
      {renderFloaters(recentFloaters(events, state?.nowMs ?? 0), placed, t, language)}
    </svg>
  );
}
