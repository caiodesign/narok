/**
 * The rail's compass window — `codex-examples/realm-refined/hunt.html:1262-1331`.
 *
 * The frame, the bronze ring, the eight rune marks and the painted ground are
 * ported verbatim: they are decoration and claim nothing. Everything that reads
 * as a *fact* is redrawn from the live projection instead:
 *
 *  - the markers are one dot per `state.actors` entry, placed from that actor's
 *    own grid cell (`gridCoordinates`), so no coordinate on this map is
 *    hand-authored;
 *  - the state pill prints the run's `phase`, or the playback `status` when
 *    there is no run to have a phase;
 *  - the reference's "Ember Quarry / Levels 24-34" is dropped outright —
 *    milestone A has no zone, no level band and no level curve — and the block
 *    names the recipe the run was actually started with plus the real grid
 *    geometry;
 *  - the ledger keeps four measured entries. The reference's "Premium offline"
 *    entry is dropped: premium wording is forbidden outright (realm-ui-spec §9,
 *    milestone spec §11).
 *
 * Milestone B binds what R108 left out, now that the server publishes it (part
 * 4 §3.1): given `zone`, the block names the map the hunt runs on; given
 * `wallet`, the ledger gains the reference's Gold and Bag entries, read from
 * the account (`GET /api/inventory`) — never filled in when absent. And given
 * `playback`, the state pill says when the client is buffering, resynchronising
 * or reconnecting, rather than presenting a held frame as live.
 *
 * Nothing here invents a number. An unmeasurable figure renders `value.none`.
 */
import { useTranslation } from 'react-i18next';
import { gridCoordinates } from '@narok/data';
import type { GridConfig } from '@narok/data';
import type { PositionId, PublicState } from '@narok/sim';
import { classNames, splitSides } from './model';
import { formatMeasuredDuration, formatNumber, type Translate } from '../i18n';
import type { PlaybackStatus } from '../playback';
import type { ExperimentStatus } from '../status';

/** The account's wallet and bag occupancy, as the server reports them. */
export interface CompassWallet {
  gold: number;
  usedSlots: number;
  capacity: number;
}

export interface CompassProps {
  state: PublicState | null;
  grid: GridConfig;
  status: ExperimentStatus;
  recipeId: string | null;
  /** The map the hunt runs on (`GET /api/hunts/current`); takes the recipe's place. */
  zone?: string | null;
  wallet?: CompassWallet | null;
  playback?: PlaybackStatus;
}

/** Playback states worth naming over the phase: the frame on screen is not live. */
const HELD: ReadonlySet<PlaybackStatus> = new Set(['buffering', 'resyncing', 'disconnected', 'faulted', 'error']);

/**
 * The reference's minimap is a 200x200 viewBox clipped to a circle of radius 80
 * centred on (100,100). The board is inscribed in the largest axis-aligned
 * square that stays inside that circle with a margin: a corner of this box sits
 * 79.2 units from the centre, so every cell centre is comfortably clipped in.
 */
const MAP_ORIGIN = 44;
const MAP_SPAN = 112;

interface Marker {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly side: 'party' | 'enemy';
}

/**
 * Projects a cell onto the minimap. `gridCoordinates` throws on a malformed id;
 * a projection never produces one, but the HUD refuses to take the whole rail
 * down over a single marker, so an undecodable position simply is not drawn.
 */
function cellCentre(position: PositionId, grid: GridConfig): { x: number; y: number } | null {
  if (grid.width <= 0 || grid.height <= 0) return null;
  let cell: { column: number; row: number };
  try {
    cell = gridCoordinates(position);
  } catch {
    return null;
  }
  return {
    x: MAP_ORIGIN + ((cell.column + 0.5) * MAP_SPAN) / grid.width,
    y: MAP_ORIGIN + ((cell.row + 0.5) * MAP_SPAN) / grid.height,
  };
}

/** A ledger entry: the reference's icon + value + caption triplet. */
function LedgerItem({
  glyph,
  modifier,
  glyphColor,
  caption,
  label,
  children,
}: {
  glyph: string;
  modifier?: string;
  glyphColor?: string;
  caption: string;
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={classNames('ledger-item', modifier)} aria-label={label}>
      <svg aria-hidden="true" style={glyphColor === undefined ? undefined : { color: glyphColor }}>
        <use href={`#${glyph}`} />
      </svg>
      <div>
        {children}
        <small>{caption}</small>
      </div>
    </div>
  );
}

export function Compass({ state, grid, status, recipeId, zone = null, wallet = null, playback }: CompassProps): React.JSX.Element {
  const { t: rawT, i18n } = useTranslation();
  const t = rawT as unknown as Translate;
  const language = i18n.language;

  const { party, enemies } = splitSides(state);

  // Foes are drawn first so an ally sharing a lane stays legible on top of them.
  // Deliberately not memoised: `party` and `enemies` are rebuilt by `splitSides`
  // on every render, so a memo keyed on them could never hit — it would only add
  // a closure and a deps array to each frame. The loop is a handful of actors.
  const markers: Marker[] = [];
  for (const actor of [...enemies, ...party]) {
    const centre = cellCentre(actor.position, grid);
    if (centre === null) continue;
    markers.push({ id: actor.id, x: centre.x, y: centre.y, side: actor.side });
  }

  const metrics = state?.metrics ?? null;

  const huntState =
    playback !== undefined && HELD.has(playback) && status === 'running'
      ? t(`playbackState.${playback}`)
      : state === null
        ? t(`status.${status}`)
        : t(`phase.${state.phase}`);
  const walletGold = wallet === null ? null : formatNumber(wallet.gold, language);
  const bag =
    wallet === null
      ? null
      : t('compass.bagValue', { used: formatNumber(wallet.usedSlots, language), capacity: formatNumber(wallet.capacity, language) });
  const zoneName = zone !== null ? t(`map.${zone}`, { defaultValue: zone }) : null;
  const gold = metrics === null ? t('value.none') : formatNumber(metrics.rawGold, language);
  const kills = metrics === null ? t('value.none') : formatNumber(metrics.kills, language);
  const elapsed = formatMeasuredDuration(state?.nowMs ?? null, t, language);
  // A wipe ends the hunt (owner decision 2026-09-30): a count, with no limit to measure it against.
  const wipes = metrics === null ? t('value.none') : formatNumber(metrics.wipes, language);

  return (
    <section className="compass win" aria-label={t('compass.label')}>
      <div className="minimap-wrap">
        <svg className="minimap" viewBox="0 0 200 200" role="img" aria-label={t('compass.minimap')}>
          <defs>
            <clipPath id="mm-clip">
              <circle cx="100" cy="100" r="80" />
            </clipPath>
            <radialGradient id="mm-slag" cx=".5" cy=".5" r=".5">
              <stop offset="0" stopColor="#ffd27a" />
              <stop offset=".5" stopColor="#ff6a1a" />
              <stop offset="1" stopColor="#ff6a1a" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="mm-shade" cx=".5" cy=".5" r=".5">
              <stop offset=".6" stopColor="#000" stopOpacity="0" />
              <stop offset="1" stopColor="#000" stopOpacity=".7" />
            </radialGradient>
          </defs>
          <circle cx="100" cy="100" r="94" fill="#1a130b" />
          <circle cx="100" cy="100" r="92" fill="none" stroke="#9a7747" strokeWidth="3" />
          <circle cx="100" cy="100" r="85" fill="none" stroke="#3a2a18" strokeWidth="7" />
          <g color="#c9a46a">
            <use href="#rune-a" x="96" y="13" width="8" height="10" />
            <use href="#rune-b" x="96" y="13" width="8" height="10" transform="rotate(45 100 100)" />
            <use href="#rune-c" x="96" y="13" width="8" height="10" transform="rotate(90 100 100)" />
            <use href="#rune-a" x="96" y="13" width="8" height="10" transform="rotate(135 100 100)" />
            <use href="#rune-b" x="96" y="13" width="8" height="10" transform="rotate(180 100 100)" />
            <use href="#rune-c" x="96" y="13" width="8" height="10" transform="rotate(225 100 100)" />
            <use href="#rune-a" x="96" y="13" width="8" height="10" transform="rotate(270 100 100)" />
            <use href="#rune-b" x="96" y="13" width="8" height="10" transform="rotate(315 100 100)" />
          </g>
          <g clipPath="url(#mm-clip)">
            <rect width="200" height="200" fill="#3a2b20" />
            <path d="M0 0H200V56L170 50 140 64 110 52 80 66 50 50 20 62 0 54Z" fill="#150f0b" />
            <path d="M20 70 70 70 90 96 40 122 20 110Z" fill="#4b392b" stroke="#6b5038" strokeWidth="1" />
            <path d="M200 72H150L128 96 170 124 200 110Z" fill="#4b392b" stroke="#6b5038" strokeWidth="1" />
            <path d="M120 200 160 150 200 170V200Z" fill="#1a110b" />
            <circle cx="160" cy="178" r="20" fill="url(#mm-slag)" />
            <circle cx="48" cy="96" r="10" fill="url(#mm-slag)" />
            <path d="M40 150l14-4 8 6 14-2M130 132l-10 6-4 8" fill="none" stroke="#ff8a3a" strokeWidth="1.2" />
            <path
              d="M40 180C60 160 70 140 86 126S96 112 100 108"
              fill="none"
              stroke="#dcb67c"
              strokeWidth="1.4"
              strokeDasharray="2 3"
              strokeOpacity=".8"
            />
            {/*
             * The reference's eight hand-placed dots (and its hand-drawn party
             * diamond) are replaced by the run's actual occupancy: one marker per
             * projected actor, at that actor's own cell.
             */}
            {markers.map((marker) => (
              <circle
                key={marker.id}
                cx={marker.x}
                cy={marker.y}
                r={marker.side === 'party' ? 3.2 : 2.4}
                stroke="#0b0d10"
                strokeWidth=".8"
                style={{ fill: marker.side === 'party' ? 'var(--hp-ally)' : 'var(--hp-foe)' }}
              />
            ))}
            <rect width="200" height="200" fill="url(#mm-shade)" />
          </g>
          <path d="M100 2 106 14H94Z" fill="#dcb67c" stroke="#1a130b" />
        </svg>
        <p className="hunt-state">
          <i>
            <svg aria-hidden="true">
              <use href="#i-swords" />
            </svg>
          </i>
          <span>{huntState}</span>
        </p>
      </div>

      {/*
       * Milestone A has no zone and no level band, so the reference's "Ember
       * Quarry / Levels 24-34" would be pure invention. The block names the
       * recipe this run was actually started with and the real board geometry.
       */}
      <div className="zone">
        <h2 className="zone-name">
          {zoneName ?? (recipeId === null ? t('compass.noRun') : t(`recipe.${recipeId}`, { defaultValue: recipeId }))}
        </h2>
        <span className="zone-range">
          {zoneName === null && recipeId === null
            ? t('compass.noRunRange')
            : t('compass.gridRange', {
                width: formatNumber(grid.width, language),
                height: formatNumber(grid.height, language),
              })}
        </span>
      </div>

      <div className="ledger">
        {walletGold !== null && bag !== null && (
          <>
            <LedgerItem
              glyph="i-coin"
              modifier="ledger-gold"
              caption={t('compass.wallet')}
              label={`${t('compass.wallet')}: ${walletGold}`}
            >
              <span className="num">{walletGold}</span>
            </LedgerItem>
            <LedgerItem
              glyph="i-bag"
              modifier="ledger-bag"
              glyphColor="#c9a46a"
              caption={t('compass.bag')}
              label={`${t('compass.bag')}: ${bag}`}
            >
              <span className="num">{bag}</span>
            </LedgerItem>
          </>
        )}
        <LedgerItem
          glyph="i-coin"
          modifier={wallet === null ? 'ledger-gold' : undefined}
          caption={t('metrics.rawGold')}
          label={`${t('metrics.rawGold')}: ${gold}`}
        >
          <span className="num">{gold}</span>
        </LedgerItem>
        <LedgerItem glyph="i-swords" caption={t('metrics.kills')} label={`${t('metrics.kills')}: ${kills}`}>
          <span className="num">{kills}</span>
        </LedgerItem>
        <LedgerItem
          glyph="i-hourglass"
          caption={t('metrics.elapsed')}
          label={`${t('metrics.elapsed')}: ${elapsed}`}
        >
          <span className="num">{elapsed}</span>
        </LedgerItem>
        <LedgerItem
          glyph="i-skull"
          glyphColor="#c9b9a2"
          caption={t('metrics.wipes')}
          label={`${t('metrics.wipes')}: ${wipes}`}
        >
          <span className="num">{wipes}</span>
        </LedgerItem>
      </div>
    </section>
  );
}
