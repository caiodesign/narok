/**
 * The Formation board's isometric projection (R111).
 *
 * `codex-examples/realm-refined/strategy.html` draws its board by hand: a
 * diamond `#f-cell` of `M0-31 62 0 0 31-62 0Z` placed at literal translates, a
 * tile quad, a shaded ally half and a hatched neutral lane. Those numbers are
 * the design, but they are also a 5x5 grid with party rows 3 and 4 — exactly
 * the grid `content.grid` publishes — so this derives them instead of copying
 * them. `apps/client/test/formation-board.test.ts` pins every formula to the
 * mockup's own figures; a grid of another shape then draws a correct board
 * rather than a mislabelled copy of this one.
 *
 * This is the Hunt board's projection with the Strategy screen's dimensions,
 * not a second coordinate system: `PositionId` stays opaque here too, and only
 * a board renderer may call `gridCoordinates` (R106).
 */

/** Half the width and height of `#f-cell`, the design's own diamond. */
export const HALF_WIDTH = 62;
export const HALF_HEIGHT = 31;

/** The mockup's board is centred on x=380 with its top corner at y=95. */
const ORIGIN_X = 380;
const ORIGIN_Y = 126;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface BoardGrid {
  readonly width: number;
  readonly height: number;
  readonly playerRows: readonly number[];
}

/**
 * Projects a point in *cell space*, where whole numbers are cell centres and
 * halves are cell corners: `(-0.5, 2.5)` is the left corner of the boundary
 * between rows 2 and 3.
 */
export function project(column: number, row: number): Point {
  return {
    x: ORIGIN_X + HALF_WIDTH * (column - row),
    y: ORIGIN_Y + HALF_HEIGHT * (column + row),
  };
}

export function cellCentre(column: number, row: number): Point {
  return project(column, row);
}

/** The four corners of the whole board, clockwise from the far corner. */
export function boardOutline(grid: BoardGrid): Point[] {
  const right = grid.width - 0.5;
  const bottom = grid.height - 0.5;
  return [project(-0.5, -0.5), project(right, -0.5), project(right, bottom), project(-0.5, bottom)];
}

/** The quad covering rows `from`..`to` inclusive, clockwise from its far-left corner. */
export function rowBand(grid: BoardGrid, from: number, to: number): Point[] {
  const right = grid.width - 0.5;
  return [
    project(-0.5, from - 0.5),
    project(right, from - 0.5),
    project(right, to + 0.5),
    project(-0.5, to + 0.5),
  ];
}

/** One cell's diamond, inset the way the design insets its highlighted cells. */
export function cellDiamond(column: number, row: number, scale = 0.88): string {
  const centre = cellCentre(column, row);
  const halfWidth = HALF_WIDTH * scale;
  const halfHeight = HALF_HEIGHT * scale;
  return toPath([
    { x: centre.x, y: centre.y - halfHeight },
    { x: centre.x + halfWidth, y: centre.y },
    { x: centre.x, y: centre.y + halfHeight },
    { x: centre.x - halfWidth, y: centre.y },
  ]);
}

export function toPath(points: readonly Point[]): string {
  return `${points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join('')}Z`;
}

/**
 * The viewBox that contains the whole board plus the room the design leaves for
 * a token's plate and name above its cell.
 *
 * The mockup's own viewBox (`60 138 530 294`) crops the far corner and fades
 * what is left behind `#f-mask`, because on that screen the enemy side is
 * scenery. Here every cell in the grid is a cell the operator is told about —
 * the party rows are placeable and the rest are explained as not placeable — so
 * cropping or fading one would hide a control's target (R108's rule about
 * frames applies to cells too). The projection, the diamond and the shading are
 * the design's; only the window onto them is widened.
 */
export function boardViewBox(grid: BoardGrid): string {
  const outline = boardOutline(grid);
  const xs = outline.map((point) => point.x);
  const ys = outline.map((point) => point.y);
  const left = Math.min(...xs) - 10;
  // The design writes a token's name to the right of its plate, so the far
  // column needs room for one.
  const right = Math.max(...xs) + 46;
  // Headroom for the ally plate (`#f-plate-ally` stands 20px above its cell,
  // scaled 1.12) and the `.tok-name` label above that.
  const top = Math.min(...ys) - 44;
  const bottom = Math.max(...ys) + 26;
  return `${left} ${top} ${right - left} ${bottom - top}`;
}

/** Where a cell sits inside `boardViewBox`, as percentages, for an overlaid control. */
export function cellBox(
  grid: BoardGrid,
  column: number,
  row: number,
): { left: string; top: string; width: string; height: string } {
  const [left, top, width, height] = boardViewBox(grid).split(' ').map(Number);
  const centre = cellCentre(column, row);
  return {
    left: `${((centre.x - left) / width) * 100}%`,
    top: `${((centre.y - top) / height) * 100}%`,
    width: `${((HALF_WIDTH * 2) / width) * 100}%`,
    height: `${((HALF_HEIGHT * 2) / height) * 100}%`,
  };
}
