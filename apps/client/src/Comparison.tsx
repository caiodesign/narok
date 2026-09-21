/**
 * The two retained comparison slots (ruling R63).
 *
 * Slot A is the earlier retained run, slot B the latest (R54). Every per-hour
 * figure divides by `state.nowMs` — the duration that was *actually* simulated,
 * never the horizon that was requested before an early stop — and a zero-length
 * window has no rate at all, so it renders the em dash. No NaN or Infinity can
 * reach the DOM.
 *
 * An absent slot renders an explicit empty state and, per ruling R81, carries
 * neither an `elapsed-time` nor a `kills-per-hour` test id, so those ids stay
 * unambiguous while no run has completed.
 *
 * The report states observed facts only — stop reason, wipes, elapsed, kills —
 * and never a diagnosis, projection or recommendation the data does not support.
 */
import { useTranslation } from 'react-i18next';
import type { LabInput, PublicState } from '@narok/sim';
import { formatMeasuredDuration, formatNumber, formatPerHour, type Translate } from './i18n';

export interface ComparisonRun {
  input: LabInput;
  state: PublicState;
}

export interface ComparisonProps {
  runs: readonly ComparisonRun[];
}

const SLOTS = ['a', 'b'] as const;
type Slot = (typeof SLOTS)[number];

function Figure({ id, label, value }: { id: string; label: string; value: string }): React.JSX.Element {
  return (
    <div className="figure">
      <dt>{label}</dt>
      <dd className="num" data-testid={id}>
        {value}
      </dd>
    </div>
  );
}

function SlotBody({ run }: { run: ComparisonRun }): React.JSX.Element {
  const { t: rawT, i18n } = useTranslation();
  const t = rawT as unknown as Translate;
  const language = i18n.language;
  const { input, state } = run;
  const elapsedMs = state.nowMs;
  const metrics = state.metrics;

  const roster = input.classes.map((classId) => t(`class.${classId}`, { defaultValue: classId })).join(', ');
  const recipe = t(`recipe.${input.recipe}`, { defaultValue: input.recipe });

  return (
    <>
      <p className="slot-setup">
        {t('comparison.roster')}: {roster} · {t('metrics.recipe')}: {recipe} · {t('metrics.seed')}:{' '}
        <span className="num">{formatNumber(input.seed, language)}</span>
      </p>
      <p className="slot-window">
        {elapsedMs > 0
          ? t('comparison.window', { duration: formatMeasuredDuration(elapsedMs, t, language) })
          : t('comparison.windowNone')}
      </p>
      <dl className="figures">
        <Figure id="elapsed-time" label={t('metrics.elapsed')} value={formatMeasuredDuration(elapsedMs, t, language)} />
        <Figure id="kills" label={t('metrics.kills')} value={formatNumber(metrics.kills, language)} />
        <Figure
          id="kills-per-hour"
          label={t('metrics.killsPerHour')}
          value={formatPerHour(metrics.kills, elapsedMs, t, language)}
        />
        <Figure id="wins" label={t('metrics.wins')} value={formatNumber(metrics.wins, language)} />
        <Figure id="wipes" label={t('metrics.wipes')} value={formatNumber(metrics.wipes, language)} />
        <Figure
          id="stop-reason"
          label={t('metrics.stopReason')}
          value={state.stopReason === null ? t('stopReason.none') : t(`stopReason.${state.stopReason}`)}
        />
        <Figure id="damage-dealt" label={t('metrics.damageDealt')} value={formatNumber(metrics.damageDealt, language)} />
        <Figure
          id="effective-healing"
          label={t('metrics.effectiveHealing')}
          value={formatNumber(metrics.effectiveHealing, language)}
        />
        <Figure
          id="raw-exp-per-hour"
          label={t('metrics.rawExpPerHour')}
          value={formatPerHour(metrics.rawExp, elapsedMs, t, language)}
        />
        <Figure
          id="raw-gold-per-hour"
          label={t('metrics.rawGoldPerHour')}
          value={formatPerHour(metrics.rawGold, elapsedMs, t, language)}
        />
        <Figure id="walk-time" label={t('metrics.walkMs')} value={formatMeasuredDuration(metrics.walkMs, t, language)} />
        <Figure id="fight-time" label={t('metrics.fightMs')} value={formatMeasuredDuration(metrics.fightMs, t, language)} />
        <Figure id="rest-time" label={t('metrics.restMs')} value={formatMeasuredDuration(metrics.restMs, t, language)} />
      </dl>
    </>
  );
}

export function Comparison({ runs }: ComparisonProps): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <section className="comparison" aria-label={t('comparison.heading')}>
      <h2 className="comparison-heading">{t('comparison.heading')}</h2>
      <div className="comparison-slots">
        {SLOTS.map((slot: Slot, index) => {
          const run = runs[index];
          return (
            <section key={slot} className="win panel" data-testid={`comparison-slot-${slot}`} aria-label={t(`comparison.slot${slot.toUpperCase()}`)}>
              <h3 className="win-title">{t(`comparison.slot${slot.toUpperCase()}`)}</h3>
              {run === undefined ? <p className="slot-empty">{t('comparison.empty')}</p> : <SlotBody run={run} />}
            </section>
          );
        })}
      </div>
    </section>
  );
}
