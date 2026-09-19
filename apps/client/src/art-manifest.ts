/**
 * Original board artwork declared as data (ruling R59).
 *
 * Every tile, class, monster, zone and marker the board can draw resolves through
 * a stable key in {@link artManifest}, so replacing the art later is a data change
 * and never a renderer change. Geometry is limited to polygons (flat point lists)
 * and circles; there is no external artwork, no image file, no generated image and
 * nothing fetched from a CDN.
 *
 * Two coordinate spaces exist, declared per entry so the renderer never guesses:
 *  - `'tile'`: points are fractions of one projected tile (x * tileWidth,
 *    y * tileHeight), so ground art follows the isometric projection exactly.
 *  - `'pixel'`: points are pixels in the actor's own frame, origin at the token's
 *    feet on the tile centre, negative `y` upward.
 */

/** Colour tokens, shared with `styles.css`'s custom properties (realm-refined identity). */
export const palette = {
  iron0: '#0b0d10',
  iron1: '#171a1f',
  iron2: '#242930',
  iron3: '#343a43',
  steel: '#9cc0dc',
  steelDim: '#5d7a93',
  bronzeDark: '#4a3722',
  bronze: '#8d6b41',
  bronzeLit: '#dcb67c',
  ember: '#ff8a3d',
  emberHot: '#ffc46b',
  emberDeep: '#b5401a',
  vellum: '#eee5d2',
  vellumDim: '#b9ae98',
  hpAlly: '#62c26f',
  hpFoe: '#d8483a',
  mana: '#4f92e6',
  warn: '#ff6b57',
  schoolGuardian: '#3f5d78',
  schoolCleric: '#8a7433',
  schoolRanger: '#3d6b4c',
  schoolArcanist: '#6a4a7a',
  mossGreen: '#4f6b3a',
  reedGold: '#8d8a45',
  boarBrown: '#6b4b34',
  ground: '#2b3129',
  groundLit: '#39402f',
} as const;

export interface PolygonShape {
  readonly kind: 'polygon';
  /** Flat `[x0, y0, x1, y1, ...]` point list. */
  readonly points: readonly number[];
}

export interface CircleShape {
  readonly kind: 'circle';
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
}

export type ArtShape = PolygonShape | CircleShape;

export interface ArtPart {
  readonly shape: ArtShape;
  /** Omitted for outline-only parts (a selection ring, a zone edge). */
  readonly fill?: string;
  readonly alpha?: number;
  readonly stroke?: { readonly color: string; readonly width: number; readonly alpha?: number };
}

export interface ArtEntry {
  /** Declared drawing order, back to front. */
  readonly shapes: readonly ArtPart[];
  readonly space: 'tile' | 'pixel';
  /** Accent colour for the DOM side (unit frames, log highlights, skill slots). */
  readonly accent: string;
}

/** One projected tile as a unit diamond; scaled by the renderer's tile size. */
const unitDiamond: PolygonShape = {
  kind: 'polygon',
  points: [0, -0.5, 0.5, 0, 0, 0.5, -0.5, 0],
};

function tile(fill: string, stroke: string, alpha = 1): ArtEntry {
  return {
    space: 'tile',
    accent: fill,
    shapes: [{ shape: unitDiamond, fill, alpha, stroke: { color: stroke, width: 1, alpha: 0.9 } }],
  };
}

/** A humanoid token: boots, body, head, plus one class-specific silhouette cue. */
function humanoid(body: string, accent: string, cue: ArtPart): ArtEntry {
  return {
    space: 'pixel',
    accent,
    shapes: [
      { shape: { kind: 'circle', cx: 0, cy: -2, radius: 11 }, fill: palette.iron0, alpha: 0.45 },
      { shape: { kind: 'polygon', points: [-7, 0, 7, 0, 5, -22, -5, -22] }, fill: body },
      { shape: { kind: 'polygon', points: [-5, -22, 5, -22, 3, -30, -3, -30] }, fill: accent },
      { shape: { kind: 'circle', cx: 0, cy: -36, radius: 6 }, fill: palette.vellum },
      cue,
    ],
  };
}

export const artManifest = {
  // --- ground and zones ---------------------------------------------------
  'tile.ground': tile(palette.ground, palette.iron0),
  'tile.party-zone': tile(palette.groundLit, palette.steelDim),
  'tile.enemy-zone': tile('#3a2b26', palette.emberDeep),
  'tile.invalid': tile(palette.iron1, palette.iron3, 0.7),

  // --- party classes ------------------------------------------------------
  'class.guardian': humanoid(palette.schoolGuardian, palette.bronzeLit, {
    // Tower shield, read as a silhouette rather than by colour alone.
    shape: { kind: 'polygon', points: [8, -26, 18, -22, 18, -8, 8, -2] },
    fill: palette.bronze,
    stroke: { color: palette.bronzeLit, width: 1 },
  }),
  'class.cleric': humanoid(palette.schoolCleric, palette.vellum, {
    // Staff with a crossbar.
    shape: { kind: 'polygon', points: [10, -40, 13, -40, 13, 0, 10, 0] },
    fill: palette.bronzeLit,
  }),
  'class.ranger': humanoid(palette.schoolRanger, palette.hpAlly, {
    // Bow arc drawn as a thin chevron.
    shape: { kind: 'polygon', points: [11, -34, 17, -22, 11, -10, 13, -22] },
    fill: palette.bronzeLit,
  }),
  'class.arcanist': humanoid(palette.schoolArcanist, palette.mana, {
    // Floating focus orb.
    shape: { kind: 'circle', cx: 14, cy: -30, radius: 5 },
    fill: palette.mana,
    stroke: { color: palette.steel, width: 1 },
  }),

  // --- monsters -----------------------------------------------------------
  'monster.briar-boar': {
    space: 'pixel',
    accent: palette.boarBrown,
    shapes: [
      { shape: { kind: 'circle', cx: 0, cy: -2, radius: 13 }, fill: palette.iron0, alpha: 0.45 },
      { shape: { kind: 'polygon', points: [-16, 0, 16, 0, 13, -16, -13, -16] }, fill: palette.boarBrown },
      { shape: { kind: 'polygon', points: [-13, -16, -4, -16, -7, -26, -11, -26] }, fill: '#4b3324' },
      { shape: { kind: 'polygon', points: [13, -16, 19, -22, 15, -8] }, fill: '#4b3324' },
      { shape: { kind: 'polygon', points: [-9, -26, -2, -30, -6, -22] }, fill: palette.vellumDim },
    ],
  },
  'monster.reed-slinger': {
    space: 'pixel',
    accent: palette.reedGold,
    shapes: [
      { shape: { kind: 'circle', cx: 0, cy: -2, radius: 10 }, fill: palette.iron0, alpha: 0.45 },
      { shape: { kind: 'polygon', points: [-6, 0, 6, 0, 3, -30, -3, -30] }, fill: palette.reedGold },
      { shape: { kind: 'polygon', points: [-3, -30, 3, -30, 10, -40, -10, -40] }, fill: '#a8a25a' },
      { shape: { kind: 'circle', cx: 0, cy: -34, radius: 4 }, fill: palette.vellumDim },
    ],
  },
  'monster.mossling': {
    space: 'pixel',
    accent: palette.mossGreen,
    shapes: [
      { shape: { kind: 'circle', cx: 0, cy: -2, radius: 9 }, fill: palette.iron0, alpha: 0.45 },
      { shape: { kind: 'circle', cx: 0, cy: -11, radius: 11 }, fill: palette.mossGreen },
      { shape: { kind: 'polygon', points: [-11, -11, 11, -11, 8, 0, -8, 0] }, fill: '#405630' },
      { shape: { kind: 'circle', cx: -4, cy: -14, radius: 2 }, fill: palette.vellum },
      { shape: { kind: 'circle', cx: 4, cy: -14, radius: 2 }, fill: palette.vellum },
    ],
  },

  // --- markers ------------------------------------------------------------
  /** Outline ring under the actor the viewer is inspecting. */
  'marker.selection': {
    space: 'tile',
    accent: palette.bronzeLit,
    shapes: [{ shape: unitDiamond, stroke: { color: palette.bronzeLit, width: 3 } }],
  },
  /** Chevron over the actor another actor is currently pointed at. */
  'marker.target': {
    space: 'pixel',
    accent: palette.warn,
    shapes: [
      { shape: { kind: 'polygon', points: [-7, -50, 7, -50, 0, -42] }, fill: palette.warn },
    ],
  },
  /** Ember mote over an actor with a cast in flight (shape cue, not hue alone). */
  'marker.casting': {
    space: 'pixel',
    accent: palette.ember,
    shapes: [
      { shape: { kind: 'polygon', points: [0, -56, 6, -48, 0, -40, -6, -48] }, fill: palette.emberHot },
    ],
  },
  /**
   * Reserved (ruling R83). `PublicActor` carries no status list, so nothing in
   * milestone A may draw a per-actor status badge; the key exists so adding one
   * later stays a data change.
   */
  'marker.status': {
    space: 'pixel',
    accent: palette.steel,
    shapes: [{ shape: { kind: 'circle', cx: 0, cy: -46, radius: 4 }, fill: palette.steel }],
  },
  /** Spawn-zone edge drawn along a side's rows during setup. */
  'marker.spawn': {
    space: 'tile',
    accent: palette.steel,
    shapes: [{ shape: unitDiamond, stroke: { color: palette.steel, width: 2, alpha: 0.7 } }],
  },

  /** Declared placeholder for any key the manifest does not define yet. */
  unknown: {
    space: 'pixel',
    accent: palette.vellumDim,
    shapes: [
      { shape: { kind: 'circle', cx: 0, cy: -2, radius: 9 }, fill: palette.iron0, alpha: 0.45 },
      { shape: { kind: 'polygon', points: [-9, 0, 9, 0, 9, -26, -9, -26] }, stroke: { color: palette.vellumDim, width: 2 } },
    ],
  },
} as const satisfies Record<string, ArtEntry>;

export type ArtKey = keyof typeof artManifest;
