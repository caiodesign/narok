/**
 * The party column (`hunt.html:1196-1247`).
 *
 * Each member keeps the reference's frame: the school-tinted medal with its
 * class emblem and level badge, the name head, and the health and mana bars.
 * Two parts of the reference unit are dropped rather than rendered empty:
 *
 * - `.xp` — milestone A has no leveling mechanic at all, so there is no
 *   progress towards a next level to fill the sliver with.
 * - `.buffs` — `Actor.statuses` is simulation-internal and is not projected, so
 *   there is no buff list to draw. An empty shell would imply "no buffs", which
 *   is a claim the projection cannot support either.
 *
 * The reference has no per-character names (`displayName` returns the class),
 * so the head prints the class as the name and the stable actor id where the
 * reference prints the class — the id is what distinguishes two Guardians.
 *
 * Selecting: the whole frame is clickable like the reference's, and the name is
 * a real button so the choice is reachable by keyboard and announced as a
 * pressed state. The frame stays an `<article>` so its heading and both meters
 * keep their own semantics.
 */
import { useTranslation } from 'react-i18next';
import type { PublicState } from '@narok/sim';
import { formatNumber, type Translate } from '../i18n';
import {
  actorLevel,
  classNames,
  displayName,
  glyphId,
  isLowMp,
  meterVar,
  medalModifier,
  splitSides,
} from './model';

export interface PartyPanelProps {
  state: PublicState | null;
  selectedId: string | null;
  onSelect: (actorId: string) => void;
}

export function PartyPanel(props: PartyPanelProps): React.JSX.Element {
  const { state, selectedId, onSelect } = props;
  const { t: rawT, i18n } = useTranslation();
  const t = rawT as unknown as Translate;
  const language = i18n.resolvedLanguage ?? 'en';
  const { party } = splitSides(state);

  return (
    <section className="party" aria-label={t('unit.party')} data-testid="party-panel">
      {party.length === 0 ? (
        <p className="unit-empty">{t('unit.empty')}</p>
      ) : (
        party.map((actor) => {
          const selected = actor.id === selectedId;
          const level = actorLevel(actor);
          const lowMp = isLowMp(actor);

          return (
            <article
              key={actor.id}
              className={classNames('unit', 'win', selected && 'is-selected')}
              data-testid={`unit-${actor.id}`}
              onClick={() => onSelect(actor.id)}
            >
              <div className={classNames('medal', medalModifier(actor.definitionId))}>
                <svg aria-hidden="true">
                  <use href={`#${glyphId(actor)}`} />
                </svg>
                {level === null ? null : <span className="lvl num">{formatNumber(level, language)}</span>}
              </div>
              <div>
                <header className="unit-head">
                  <h2 className="unit-name">
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelect(actor.id);
                      }}
                    >
                      {displayName(t, actor)}
                    </button>
                  </h2>
                  <span className="unit-class num">{actor.id}</span>
                </header>
                {/* Both meters: `--v`, the printed pair and `aria-valuenow` all
                    come from the same two numbers, never from a second literal. */}
                <div
                  className="bar bar--hp"
                  role="meter"
                  aria-label={t('unit.hp')}
                  aria-valuenow={actor.hp}
                  aria-valuemin={0}
                  aria-valuemax={actor.maxHp}
                >
                  <i style={{ '--v': meterVar(actor.hp, actor.maxHp) } as React.CSSProperties} />
                  <span>
                    {formatNumber(actor.hp, language)} / {formatNumber(actor.maxHp, language)}
                  </span>
                </div>
                <div
                  className={classNames('bar', 'bar--mp', lowMp && 'bar--mp-low')}
                  role="meter"
                  aria-label={lowMp ? `${t('unit.mp')}, ${t('unit.mpLow')}` : t('unit.mp')}
                  aria-valuenow={actor.mp}
                  aria-valuemin={0}
                  aria-valuemax={actor.maxMp}
                >
                  <i style={{ '--v': meterVar(actor.mp, actor.maxMp) } as React.CSSProperties} />
                  <span>
                    {formatNumber(actor.mp, language)} / {formatNumber(actor.maxMp, language)}
                  </span>
                  {lowMp ? <em className="mp-warn">{t('unit.mpLow')}</em> : null}
                </div>
              </div>
            </article>
          );
        })
      )}
    </section>
  );
}
