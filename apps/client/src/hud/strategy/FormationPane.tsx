/**
 * The Formation pane (`codex-examples/realm-refined/strategy.html:1026-1172`).
 *
 * The design's board is an isometric diamond with the party half shaded, the
 * neutral lane hatched, the enemy side dimmed, a legend, a live status line and
 * a foot that resets to the class default. All of that is ported. What is *not*
 * ported is the mockup's interaction: it is a drag-and-drop demo over an
 * `role="img"` SVG, which cannot be operated by keyboard and has no way to say
 * why a cell refuses a character.
 *
 * So the picture and the controls are separate layers (R112). The SVG is
 * scenery — `aria-hidden`, no hit target — and over it sits the same
 * `role="grid"` of buttons the laboratory has always had: five rows of five
 * cells in DOM order, roving tabindex, arrow keys clamped to party rows (R77),
 * `aria-disabled` and a spoken reason on every cell outside the party zone.
 * Each button is positioned and clipped to its own diamond, so the control the
 * pointer finds is exactly the cell the picture draws.
 */
import { useTranslation } from 'react-i18next';
import type { Content } from '@narok/data';
import type { ActorId, PositionId } from '@narok/sim';
import type { ValidationIssue } from '../../validation';
import { classGlyphId } from '../model';
import { boardOutline, boardViewBox, cellBox, cellCentre, cellDiamond, rowBand, toPath } from './board';

export interface FormationPaneProps {
  grid: Content['grid'];
  rosterIds: readonly ActorId[];
  classes: readonly string[];
  placement: Record<ActorId, PositionId>;
  cellId: (column: number, row: number) => PositionId;
  selectedActorId: ActorId | null;
  focusedCell: { column: number; row: number };
  registerCell: (id: PositionId, node: HTMLButtonElement | null) => void;
  onFocusCell: (column: number, row: number) => void;
  onPlace: (column: number, row: number) => void;
  onCellKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, column: number, row: number) => void;
  onResetPlacement: () => void;
  onSelectForPlacement: (actorId: ActorId) => void;
  selectionLabel: string;
  issues: ValidationIssue[];
}

/** The design's own defs, carried across verbatim so the board is the board. */
function FormationDefs(): React.JSX.Element {
  return (
    <defs>
      <linearGradient id="f-tile" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#4a392c" />
        <stop offset="1" stopColor="#2e231b" />
      </linearGradient>
      <linearGradient id="f-ally-half" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#8fb8dc" stopOpacity=".03" />
        <stop offset="1" stopColor="#8fb8dc" stopOpacity=".14" />
      </linearGradient>
      <pattern id="f-hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(-27)">
        <path d="M0 5h10" stroke="#0d0906" strokeWidth="3.2" strokeOpacity=".55" />
      </pattern>
      <linearGradient id="f-ally" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#6d8fae" />
        <stop offset=".55" stopColor="#34495e" />
        <stop offset="1" stopColor="#1a2430" />
      </linearGradient>
      <filter id="f-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="4" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <path id="f-plate-ally" d="M-17-20H17V0c0 12-8 18.5-17 22.5C-9 18.5-17 12-17 0Z" />
    </defs>
  );
}

export function FormationPane(props: FormationPaneProps): React.JSX.Element {
  const { grid, rosterIds, classes, placement, cellId, selectedActorId, focusedCell } = props;
  const { t } = useTranslation();

  const playerRows = [...grid.playerRows].sort((a, b) => a - b);
  const enemyRows = [...grid.enemyRows].sort((a, b) => a - b);
  const neutralRows = Array.from({ length: grid.height }, (_, row) => row).filter(
    (row) => !playerRows.includes(row) && !enemyRows.includes(row),
  );
  const outline = boardOutline(grid);
  const viewBox = boardViewBox(grid);

  const occupantOf = (id: PositionId): ActorId | null =>
    rosterIds.find((actorId) => placement[actorId] === id) ?? null;

  /** Cell id -> its column and row, built once so a plate can find its seat. */
  const seats = new Map<PositionId, { column: number; row: number }>();
  for (let row = 0; row < grid.height; row++) {
    for (let column = 0; column < grid.width; column++) seats.set(cellId(column, row), { column, row });
  }

  return (
    <section className="pane" aria-labelledby="formation-title">
      <h2 className="win-title" id="formation-title">
        {t('controls.formation')}
        <span className="pane-title-note">
          {t('controls.formationRows', { rows: playerRows.map((row) => row + 1).join(', ') })}
        </span>
      </h2>
      <div className="pane-body">
        <div className="board-wrap">
          <svg className="formation" viewBox={viewBox} aria-hidden="true" focusable="false">
            <FormationDefs />

            {/* The tile and the depth of its near edges. */}
            <path d={toPath(outline)} fill="url(#f-tile)" />
            {playerRows.length > 0 && <path d={toPath(rowBand(grid, playerRows[0], playerRows[playerRows.length - 1]))} fill="url(#f-ally-half)" />}
            {enemyRows.length > 0 && (
              <path d={toPath(rowBand(grid, enemyRows[0], enemyRows[enemyRows.length - 1]))} fill="#0c0908" fillOpacity=".72" />
            )}
            {neutralRows.map((row) => (
              <g key={`lane-${row}`}>
                <path d={toPath(rowBand(grid, row, row))} fill="#140e0a" fillOpacity=".7" />
                <path d={toPath(rowBand(grid, row, row))} fill="url(#f-hatch)" />
              </g>
            ))}

            {/* Cell edges, drawn along both diagonals the way the design does. */}
            <g stroke="#0c0806" strokeOpacity=".75" strokeWidth="2">
              {Array.from({ length: grid.height + 1 }, (_, index) => index - 0.5).map((row) => {
                const from = cellCentre(-0.5, row);
                const to = cellCentre(grid.width - 0.5, row);
                return <path key={`r${row}`} d={`M${from.x} ${from.y}L${to.x} ${to.y}`} />;
              })}
              {Array.from({ length: grid.width + 1 }, (_, index) => index - 0.5).map((column) => {
                const from = cellCentre(column, -0.5);
                const to = cellCentre(column, grid.height - 0.5);
                return <path key={`c${column}`} d={`M${from.x} ${from.y}L${to.x} ${to.y}`} />;
              })}
            </g>
            <path d={toPath(outline)} fill="none" stroke="#b8905a" strokeWidth="2" />

            {/*
             * One diamond per cell, in the four states the design's own legend
             * names: a drop target, an open party cell, a cell outside the party
             * zone and the enemy rows. The colours are the legend's
             * (`strategy.css:373-376`), so the key and the board agree.
             */}
            {Array.from({ length: grid.height }, (_, row) =>
              Array.from({ length: grid.width }, (_, column) => {
                const id = cellId(column, row);
                const isPartyCell = grid.playerRows.includes(row);
                const occupied = occupantOf(id) !== null;
                const isDropTarget = isPartyCell && selectedActorId !== null && !occupied;
                const isEnemyRow = enemyRows.includes(row);
                const paint = isEnemyRow
                  ? { fill: '#2a1c14', stroke: '#4a3722', width: 1.2 }
                  : !isPartyCell
                    ? { fill: 'rgba(216, 72, 58, .28)', stroke: '#ff6b57', width: 1.6 }
                    : isDropTarget
                      ? { fill: 'rgba(156, 192, 220, .42)', stroke: '#cfe6f7', width: 2.4 }
                      : { fill: 'rgba(156, 192, 220, .12)', stroke: 'rgba(156, 192, 220, .6)', width: 1.5 };
                return (
                  <path
                    key={id}
                    d={cellDiamond(column, row, isDropTarget ? 0.9 : 0.86)}
                    fill={paint.fill}
                    stroke={paint.stroke}
                    strokeWidth={paint.width}
                    strokeDasharray={isPartyCell && !isDropTarget ? '5 4' : undefined}
                    filter={isDropTarget ? 'url(#f-glow)' : undefined}
                  />
                );
              }),
            )}

            {/* One plate per placed character, as the design draws its party. */}
            {rosterIds.map((actorId, index) => {
              const seat = seats.get(placement[actorId] as PositionId);
              if (seat === undefined) return null;
              const centre = cellCentre(seat.column, seat.row);
              const selected = selectedActorId === actorId;
              return (
                <g key={actorId}>
                  <g transform={`translate(${centre.x} ${centre.y}) scale(1.12)`}>
                    <ellipse rx="22" ry="9" fill="#000" fillOpacity=".55" />
                    <ellipse
                      rx="20"
                      ry="8"
                      fill="none"
                      stroke={selected ? '#dcb67c' : '#9cc0dc'}
                      strokeOpacity={selected ? 1 : 0.8}
                      strokeWidth={selected ? 2 : 1.5}
                    />
                    <use
                      href="#f-plate-ally"
                      transform="translate(0 -23)"
                      fill="url(#f-ally)"
                      stroke={selected ? '#f1d49c' : '#dcb67c'}
                      strokeWidth={selected ? 2 : 1.6}
                    />
                    <use href={`#${classGlyphId(classes[index])}`} x="-11" y="-35" width="22" height="22" color="#eaf2f8" />
                  </g>
                  <text
                    className="tok-name"
                    x={centre.x + 26}
                    y={centre.y + 15}
                    style={selected ? { fill: '#f1d49c' } : undefined}
                  >
                    {actorId}
                  </text>
                </g>
              );
            })}
          </svg>

          <div role="grid" className="place-grid" aria-label={t('controls.placementGrid')}>
            {Array.from({ length: grid.height }, (_, row) => (
              <div role="row" key={row}>
                {Array.from({ length: grid.width }, (_, column) => {
                  const id = cellId(column, row);
                  const occupant = occupantOf(id);
                  const isPartyCell = grid.playerRows.includes(row);
                  const isFocused = focusedCell.column === column && focusedCell.row === row;
                  const isDropTarget = isPartyCell && selectedActorId !== null && occupant === null;
                  const state = !isPartyCell
                    ? 'bad'
                    : isDropTarget
                      ? 'drop'
                      : occupant !== null
                        ? 'held'
                        : 'open';
                  return (
                    <button
                      type="button"
                      role="gridcell"
                      key={id}
                      className={`cell cell--${state}`}
                      style={cellBox(grid, column, row)}
                      title={isPartyCell ? t('board.cell', { position: id }) : t('controls.invalidCell')}
                      ref={(node) => {
                        props.registerCell(id, node);
                      }}
                      tabIndex={isFocused ? 0 : -1}
                      aria-disabled={!isPartyCell}
                      onFocus={() => props.onFocusCell(column, row)}
                      onClick={() => props.onPlace(column, row)}
                      onKeyDown={(event) => props.onCellKeyDown(event, column, row)}
                    >
                      {/*
                       * The occupant's name is drawn on its plate in the board
                       * below, so here it is the cell's accessible text only —
                       * printing it twice put a label on top of a token. The
                       * mark on a cell outside the party zone stays visible: it
                       * is the signal that does not depend on colour (R64).
                       */}
                      {isPartyCell ? (
                        <span className="sr-only">{occupant ?? ''}</span>
                      ) : (
                        t('controls.invalidCellMark')
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <ul className="legend" aria-label={t('controls.legend')}>
          <li>
            <i className="lg-drop" aria-hidden="true" />
            {t('controls.legendDrop')}
          </li>
          <li>
            <i className="lg-open" aria-hidden="true" />
            {t('controls.legendOpen')}
          </li>
          <li>
            <i className="lg-bad" aria-hidden="true" />
            {t('controls.legendBad')}
          </li>
          <li>
            <i className="lg-foe" aria-hidden="true" />
            {t('controls.legendFoe')}
          </li>
        </ul>

        <div className="section">
          <p className="hint">{t('controls.placementHelp')}</p>
          <div className="run-actions">
            {rosterIds.map((actorId, index) => (
              <button
                key={actorId}
                type="button"
                className="btn btn--small"
                aria-pressed={selectedActorId === actorId}
                onClick={() => props.onSelectForPlacement(actorId)}
              >
                <span className={`medal medal--${classes[index]}`} aria-hidden="true">
                  <svg>
                    <use href={`#${classGlyphId(classes[index])}`} />
                  </svg>
                </span>
                {t('controls.selectCharacter', { actor: actorId })}
              </button>
            ))}
          </div>
        </div>

        <p className="drag-status" role="status">
          <span>{props.selectionLabel}</span>
        </p>

        {props.issues.map((issue, index) => (
          <p role="alert" className="alert" key={`${issue.field}-${index}`}>
            {t(issue.messageKey)}
          </p>
        ))}

        <div className="formation-foot">
          <p className="hint">{t('controls.formationHint')}</p>
          <button className="btn btn--small" type="button" onClick={props.onResetPlacement}>
            {t('controls.classDefault')}
          </button>
        </div>
      </div>
    </section>
  );
}
