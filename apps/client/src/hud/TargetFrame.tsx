/**
 * The focused foe's frame (`hunt.html:1184-1193`).
 *
 * The reference frame carries five figures. Three are measured and are ported
 * verbatim — the foe's emblem and level medal, its name, and its health bar.
 * Two are not published by milestone A and are dropped rather than filled:
 *
 * - `.target-kind` ("Elite") — no `PublicActor` or monster definition carries an
 *   elite flag, so there is no rank to print.
 * - `.target-group` ("Group 3") — encounters are not grouped in milestone A.
 * - `.threat-meter` — `Actor.threat` is simulation-internal and is not
 *   projected, so there is no threat share to fill eight pips with.
 *
 * What the projection *does* publish is `currentTarget`, so the reference's
 * threat line keeps its real half: who this foe is attacking, named from the
 * same projection and resolved through `actorLabel` so three identical party
 * members stay distinguishable.
 */
import { useTranslation } from 'react-i18next';
import type { PublicState } from '@narok/sim';
import { actorLabel, formatNumber, type Translate } from '../i18n';
import { actorLevel, displayName, focusedEnemy, glyphId, meterVar, percent } from './model';

export interface TargetFrameProps {
  state: PublicState | null;
}

export function TargetFrame(props: TargetFrameProps): React.JSX.Element | null {
  const { state } = props;
  const { t: rawT, i18n } = useTranslation();
  const t = rawT as unknown as Translate;
  const language = i18n.resolvedLanguage ?? 'en';

  const enemy = focusedEnemy(state);
  if (enemy === null) return null;

  const actors = state?.actors ?? [];
  const level = actorLevel(enemy);
  // One source of truth for the bar: `--v`, the printed percentage and
  // `aria-valuenow` are all this ratio. The reference hardcodes all three.
  const share = percent(enemy.hp, enemy.maxHp);
  const attackedId = enemy.currentTarget;
  const attacked = attackedId === null ? null : actors.find((actor) => actor.id === attackedId) ?? null;

  return (
    <section className="target win" aria-label={t('unit.target')} data-testid="target-frame">
      <div className="medal">
        <svg aria-hidden="true">
          <use href={`#${glyphId(enemy)}`} />
        </svg>
        {level === null ? null : <span className="lvl num">{formatNumber(level, language)}</span>}
      </div>
      <header className="target-head">
        <h2 className="target-name">{displayName(t, enemy)}</h2>
      </header>
      <div
        className="bar bar--foe"
        role="meter"
        aria-label={t('unit.hp')}
        aria-valuenow={share}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <i style={{ '--v': meterVar(enemy.hp, enemy.maxHp) } as React.CSSProperties} />
        <span>{t('unit.percent', { value: formatNumber(share, language) })}</span>
      </div>
      <p className="threat" data-testid="target-threat">
        {attackedId === null ? (
          <span>{t('unit.noTarget')}</span>
        ) : (
          <>
            {attacked === null ? null : (
              <svg aria-hidden="true">
                <use href={`#${glyphId(attacked)}`} />
              </svg>
            )}
            <span>
              {t('unit.attacking')} <b>{actorLabel(t, attackedId, actors)}</b>
            </span>
          </>
        )}
      </p>
    </section>
  );
}
