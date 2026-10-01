/**
 * Original board artwork declared as data (ruling R59).
 *
 * Every tile, class, monster, zone, marker and atmosphere layer the board can
 * draw resolves through a stable key in {@link artManifest}, so replacing the art
 * later is a data change and never a renderer change. Geometry is limited to
 * polygons (flat point lists) and circles; there is no external artwork, no image
 * file, no generated image and nothing fetched from a CDN. Gradients are declared
 * the same way — as stacked bands of flat fills — because a Pixi `Graphics` fill
 * is flat and a real gradient would mean a generated texture.
 *
 * Three coordinate spaces exist, declared per entry so the renderer never guesses:
 *  - `'tile'`: points are fractions of one projected tile (x * tileWidth,
 *    y * tileHeight), so ground art follows the isometric projection exactly.
 *    A circle declared here is *not* flattened by the projection, so every ground
 *    ellipse is declared as a polygon via {@link ellipsePoints} instead.
 *  - `'pixel'`: points are pixels in the actor's own frame, origin at the token's
 *    feet on the tile centre, negative `y` upward.
 *  - `'view'`: points are fractions of the viewport (x * viewWidth,
 *    y * viewHeight) with the origin at its top-left corner. Only the atmosphere
 *    layers use it: they are drawn outside the scene's centring transform, so
 *    they stay glued to the canvas rather than to the board.
 *
 * Shapes are listed back to front and the renderer paints them in that order, so
 * an extruded tile declares its two side faces before its top face and the top
 * face of the neighbour in front covers whichever side face it should hide.
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
  readonly space: 'tile' | 'pixel' | 'view';
  /** Accent colour for the DOM side (unit frames, log highlights, skill slots). */
  readonly accent: string;
}

// --- colour derivation ----------------------------------------------------
// Side faces, gradient bands and bevels are *derived* from the palette rather
// than added to it: `palette` mirrors the custom properties in `styles.css`, and
// a shade that has no CSS counterpart does not belong there.

function channel(hex: string, index: number): number {
  return Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
}

/** Linear hex mix; `ratio` 0 returns `from`, 1 returns `to`. */
export function mix(from: string, to: string, ratio: number): string {
  const t = Math.max(0, Math.min(1, ratio));
  let out = '#';
  for (let index = 0; index < 3; index++) {
    const value = Math.round(channel(from, index) + (channel(to, index) - channel(from, index)) * t);
    out += value.toString(16).padStart(2, '0');
  }
  return out;
}

const shade = (hex: string, amount: number): string => mix(hex, palette.iron0, amount);
const lighten = (hex: string, amount: number): string => mix(hex, palette.vellum, amount);

// --- geometry helpers -----------------------------------------------------

/**
 * A closed ellipse as a polygon. Ground art is declared this way so the tile
 * projection (which scales x and y differently) flattens it correctly.
 */
export function ellipsePoints(rx: number, ry: number, segments = 24, cx = 0, cy = 0): number[] {
  const points: number[] = [];
  for (let index = 0; index < segments; index++) {
    const angle = (index / segments) * Math.PI * 2;
    points.push(cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry);
  }
  return points;
}

/** A diamond with the given half-extents, in the same winding as {@link unitDiamond}. */
function diamond(halfWidth: number, halfHeight: number): PolygonShape {
  return { kind: 'polygon', points: [0, -halfHeight, halfWidth, 0, 0, halfHeight, -halfWidth, 0] };
}

/** One projected tile as a unit diamond; scaled by the renderer's tile size. */
const unitDiamond: PolygonShape = diamond(0.5, 0.5);

/**
 * A ring of dashes on an ellipse. The dash count is the shape cue: the ring reads
 * as a ring with the colour removed, which `prefers-reduced-motion` and greyscale
 * both require.
 */
function dashedRing(
  rx: number,
  ry: number,
  thickness: number,
  dashes: number,
  duty: number,
  fill: string,
  alpha = 1,
): ArtPart[] {
  const parts: ArtPart[] = [];
  const step = (Math.PI * 2) / dashes;
  for (let index = 0; index < dashes; index++) {
    const start = index * step;
    const end = start + step * duty;
    const points: number[] = [];
    const arc = 4;
    for (let k = 0; k <= arc; k++) {
      const angle = start + ((end - start) * k) / arc;
      points.push(Math.cos(angle) * (rx + thickness), Math.sin(angle) * (ry + thickness));
    }
    for (let k = arc; k >= 0; k--) {
      const angle = start + ((end - start) * k) / arc;
      points.push(Math.cos(angle) * (rx - thickness), Math.sin(angle) * (ry - thickness));
    }
    parts.push({ shape: { kind: 'polygon', points }, fill, alpha });
  }
  return parts;
}

// --- tiles ----------------------------------------------------------------

/** Extrusion of the board plate, as a fraction of one tile height. */
export const TILE_ELEVATION = 0.24;

/**
 * One ground tile, extruded. The two side faces are only ever visible on the
 * board's two front edges — every interior tile has its faces covered by the top
 * face of the neighbour drawn after it — so the whole plate reads as a single
 * slab with thickness rather than as a field of blocks.
 */
function tile(fill: string, stroke: string, alpha = 1): ArtEntry {
  const depth = TILE_ELEVATION;
  return {
    space: 'tile',
    accent: fill,
    shapes: [
      // Left front face: away from the light, so the darker of the two.
      {
        shape: { kind: 'polygon', points: [-0.5, 0, 0, 0.5, 0, 0.5 + depth, -0.5, depth] },
        fill: shade(fill, 0.68),
        alpha,
      },
      // Right front face.
      {
        shape: { kind: 'polygon', points: [0, 0.5, 0.5, 0, 0.5, depth, 0, 0.5 + depth] },
        fill: shade(fill, 0.42),
        alpha,
      },
      // Top face.
      { shape: unitDiamond, fill, alpha, stroke: { color: stroke, width: 1, alpha: 0.9 } },
      // Lit upper-right bevel: the geometric cue that the top face is a top face.
      {
        shape: { kind: 'polygon', points: [0, -0.5, 0.5, 0, 0.43, 0.015, 0, -0.44] },
        fill: lighten(fill, 0.26),
        alpha: 0.4 * alpha,
      },
    ],
  };
}

/**
 * A spawn lane, tinted as a **fill** across the whole cell with an inset outline
 * for the shape cue. The previous stroke-only outline read as a grid, not a lane.
 */
function lane(colour: string, alpha: number): ArtEntry {
  return {
    space: 'tile',
    accent: colour,
    shapes: [
      { shape: unitDiamond, fill: colour, alpha },
      { shape: diamond(0.43, 0.43), stroke: { color: colour, width: 1, alpha: 0.5 } },
    ],
  };
}

/**
 * The neutral lane, hatched rather than tinted: it is the one band with no
 * spawns, and hatching says so without spending a hue on it.
 */
function hatchedLane(): ArtEntry {
  const parts: ArtPart[] = [];
  for (const centre of [0.28, 0.5, 0.72]) {
    const half = 0.055;
    const low = centre - half;
    const high = centre + half;
    // `a(u)` walks the upper-left edge, `b(u)` the lower-right one, so the chord
    // between them is always parallel to the tile's other axis.
    const a = (u: number): [number, number] => [-0.5 + 0.5 * u, -0.5 * u];
    const b = (u: number): [number, number] => [0.5 * u, 0.5 - 0.5 * u];
    parts.push({
      shape: { kind: 'polygon', points: [...a(low), ...a(high), ...b(high), ...b(low)] },
      fill: palette.iron0,
      alpha: 0.45,
    });
  }
  return { space: 'tile', accent: palette.vellumDim, shapes: parts };
}

// --- tokens ---------------------------------------------------------------

/**
 * The plate a token stands on: a drop shadow, a contact rim in the side's colour,
 * an extruded diamond and a three-band gradient standing in for the reference's
 * linear gradient. Ally and foe differ in hue *and* in rim weight, so the two are
 * still distinguishable with colour removed.
 */
function plate(base: string, rim: string, outline: string): ArtEntry {
  const halfWidth = 0.27;
  const halfHeight = 0.27;
  const depth = 0.08;
  const waist = halfWidth / 3;
  const midY = halfHeight / 3;
  const light = mix(base, palette.steel, 0.38);
  const dark = shade(base, 0.62);
  return {
    space: 'tile',
    accent: base,
    shapes: [
      { shape: { kind: 'polygon', points: ellipsePoints(halfWidth * 1.22, halfHeight * 1.22) }, fill: palette.iron0, alpha: 0.55 },
      {
        shape: { kind: 'polygon', points: ellipsePoints(halfWidth * 1.1, halfHeight * 1.1) },
        stroke: { color: rim, width: 1.5, alpha: 0.75 },
      },
      // Side faces, matching the ground's light direction.
      {
        shape: {
          kind: 'polygon',
          points: [-halfWidth, 0, 0, halfHeight, 0, halfHeight + depth, -halfWidth, depth],
        },
        fill: shade(base, 0.74),
      },
      {
        shape: {
          kind: 'polygon',
          points: [0, halfHeight, halfWidth, 0, halfWidth, depth, 0, halfHeight + depth],
        },
        fill: shade(base, 0.5),
      },
      // Gradient bands, back to front: light top, base waist, dark front.
      { shape: { kind: 'polygon', points: [0, -halfHeight, waist * 2, -midY, -waist * 2, -midY] }, fill: light },
      {
        shape: {
          kind: 'polygon',
          points: [waist * 2, -midY, halfWidth, 0, waist * 2, midY, -waist * 2, midY, -halfWidth, 0, -waist * 2, -midY],
        },
        fill: base,
      },
      { shape: { kind: 'polygon', points: [waist * 2, midY, 0, halfHeight, -waist * 2, midY] }, fill: dark },
      { shape: diamond(halfWidth, halfHeight), stroke: { color: outline, width: 1.6, alpha: 0.9 } },
    ],
  };
}

/** A humanoid token: boots, body, head, plus one class-specific silhouette cue. */
function humanoid(body: string, accent: string, cue: ArtPart): ArtEntry {
  return {
    space: 'pixel',
    accent,
    shapes: [
      {
        shape: { kind: 'polygon', points: [-7, 0, 7, 0, 5, -22, -5, -22] },
        fill: body,
        stroke: { color: palette.iron0, width: 1, alpha: 0.55 },
      },
      { shape: { kind: 'polygon', points: [-5, -22, 5, -22, 3, -30, -3, -30] }, fill: accent },
      {
        shape: { kind: 'circle', cx: 0, cy: -36, radius: 6 },
        fill: palette.vellum,
        stroke: { color: palette.iron0, width: 1, alpha: 0.55 },
      },
      cue,
    ],
  };
}

// --- atmosphere -----------------------------------------------------------

/**
 * One vignette band: the region of the viewport outside `inset`. Bands stack, so
 * the corners take two passes and darken faster than the edges — which is what a
 * radial vignette does, without a generated texture.
 */
function vignetteBand(inset: number, alpha: number): ArtPart[] {
  const colour = palette.iron0;
  return [
    { shape: { kind: 'polygon', points: [0, 0, 1, 0, 1, inset, 0, inset] }, fill: colour, alpha },
    { shape: { kind: 'polygon', points: [0, 1 - inset, 1, 1 - inset, 1, 1, 0, 1] }, fill: colour, alpha },
    { shape: { kind: 'polygon', points: [0, 0, inset, 0, inset, 1, 0, 1] }, fill: colour, alpha },
    { shape: { kind: 'polygon', points: [1 - inset, 0, 1, 0, 1, 1, 1 - inset, 1] }, fill: colour, alpha },
  ];
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
      {
        shape: { kind: 'polygon', points: [-16, 0, 16, 0, 13, -16, -13, -16] },
        fill: palette.boarBrown,
        stroke: { color: palette.iron0, width: 1, alpha: 0.55 },
      },
      { shape: { kind: 'polygon', points: [-13, -16, -4, -16, -7, -26, -11, -26] }, fill: '#4b3324' },
      { shape: { kind: 'polygon', points: [13, -16, 19, -22, 15, -8] }, fill: '#4b3324' },
      { shape: { kind: 'polygon', points: [-9, -26, -2, -30, -6, -22] }, fill: palette.vellumDim },
    ],
  },
  'monster.reed-slinger': {
    space: 'pixel',
    accent: palette.reedGold,
    shapes: [
      {
        shape: { kind: 'polygon', points: [-6, 0, 6, 0, 3, -30, -3, -30] },
        fill: palette.reedGold,
        stroke: { color: palette.iron0, width: 1, alpha: 0.55 },
      },
      { shape: { kind: 'polygon', points: [-3, -30, 3, -30, 10, -40, -10, -40] }, fill: '#a8a25a' },
      { shape: { kind: 'circle', cx: 0, cy: -34, radius: 4 }, fill: palette.vellumDim },
    ],
  },
  'monster.mossling': {
    space: 'pixel',
    accent: palette.mossGreen,
    shapes: [
      {
        shape: { kind: 'circle', cx: 0, cy: -11, radius: 11 },
        fill: palette.mossGreen,
        stroke: { color: palette.iron0, width: 1, alpha: 0.55 },
      },
      { shape: { kind: 'polygon', points: [-11, -11, 11, -11, 8, 0, -8, 0] }, fill: '#405630' },
      { shape: { kind: 'circle', cx: -4, cy: -14, radius: 2 }, fill: palette.vellum },
      { shape: { kind: 'circle', cx: 4, cy: -14, radius: 2 }, fill: palette.vellum },
    ],
  },

  // --- token plates -------------------------------------------------------
  /** The ground plate every party token stands on. */
  'token.plate-party': plate(palette.schoolGuardian, palette.steel, palette.bronzeLit),
  /** The ground plate every enemy token stands on. */
  'token.plate-enemy': plate(palette.emberDeep, palette.ember, palette.emberHot),

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
      { shape: { kind: 'polygon', points: [-7, -66, 7, -66, 0, -58] }, fill: palette.warn },
    ],
  },
  /**
   * Ground ring around the actor another actor is currently pointed at. The
   * renderer pulses it; with motion disabled it is still drawn, static, so the
   * information survives (spec §3).
   */
  'marker.target-ring': {
    space: 'tile',
    accent: palette.emberHot,
    shapes: dashedRing(0.4, 0.4, 0.022, 12, 0.55, palette.emberHot, 0.85),
  },
  /** Ember mote over an actor with a cast in flight (shape cue, not hue alone). */
  'marker.casting': {
    space: 'pixel',
    accent: palette.ember,
    shapes: [
      { shape: { kind: 'polygon', points: [-18, -48, -12, -40, -18, -32, -24, -40] }, fill: palette.emberHot },
    ],
  },
  /**
   * One dash of an attacker → target intent line, drawn pointing along +x; the
   * renderer repeats and rotates it along the line. The arrowhead is the
   * direction cue, so who-is-hitting-whom does not depend on hue.
   */
  'marker.intent-party': {
    space: 'pixel',
    accent: palette.steel,
    shapes: [
      { shape: { kind: 'polygon', points: [-4, -3, 4, 0, -4, 3, -1.5, 0] }, fill: palette.steel, alpha: 0.75 },
    ],
  },
  'marker.intent-enemy': {
    space: 'pixel',
    accent: palette.ember,
    shapes: [
      { shape: { kind: 'polygon', points: [-4, -3, 4, 0, -4, 3, -1.5, 0] }, fill: palette.ember, alpha: 0.75 },
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
  /** Party spawn lane, tinted as a fill across the cell. */
  'marker.spawn': lane(palette.steel, 0.13),
  /** Enemy spawn lane. */
  'marker.spawn-enemy': lane(palette.ember, 0.11),
  /** The band that belongs to neither side. */
  'marker.neutral-lane': hatchedLane(),

  // --- atmosphere ---------------------------------------------------------
  /**
   * In front of the board: the vignette that keeps the eye on the action.
   *
   * There is no canvas backdrop entry. The environment behind the board is the
   * painted world layer in the DOM (WorldBackdrop.tsx), which is where the
   * approved reference puts it (hunt.html:823-998); the canvas itself is
   * transparent, so an opaque wash here would simply hide it.
   */
  'atmosphere.vignette': {
    space: 'view',
    accent: palette.iron0,
    shapes: [
      ...vignetteBand(0.24, 0.04),
      ...vignetteBand(0.19, 0.05),
      ...vignetteBand(0.145, 0.06),
      ...vignetteBand(0.105, 0.07),
      ...vignetteBand(0.07, 0.08),
      ...vignetteBand(0.04, 0.09),
      ...vignetteBand(0.015, 0.11),
    ],
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

/**
 * The drawn extent of one entry, as an SVG `viewBox`. Measured from the manifest
 * rather than hard-coded so that changing a silhouette here cannot silently crop
 * or off-centre whatever renders it. Returns `null` for an entry with nothing
 * drawable in it, so a caller renders no box instead of a degenerate one.
 */
export function entryViewBox(entry: ArtEntry, pad = 3): string | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const part of entry.shapes) {
    if (part.shape.kind === 'circle') {
      const { cx, cy, radius } = part.shape;
      minX = Math.min(minX, cx - radius);
      maxX = Math.max(maxX, cx + radius);
      minY = Math.min(minY, cy - radius);
      maxY = Math.max(maxY, cy + radius);
      continue;
    }
    const { points } = part.shape;
    for (let index = 0; index + 1 < points.length; index += 2) {
      minX = Math.min(minX, points[index]);
      maxX = Math.max(maxX, points[index]);
      minY = Math.min(minY, points[index + 1]);
      maxY = Math.max(maxY, points[index + 1]);
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`;
}
