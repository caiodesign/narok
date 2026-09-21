/**
 * The session window (`hunt.html:1249-1257`).
 *
 * Three of the reference's four entries are per-hour rates the laboratory
 * actually measures, so they are ported as they stand and a fourth, damage per
 * hour, joins them from the same `Metrics` record.
 *
 * The reference's `.metric--estimate` row ("Time until death, est.") is dropped:
 * the handoff forbids a survival forecast, and nothing in `PublicState` measures
 * one. Every rate divides by the duration that was *actually* simulated (R63);
 * a window of zero length has no rate at all and prints the em dash rather than
 * a fabricated figure.
 *
 * The window itself is stated here rather than borrowed from the playback panel
 * across the screen (UI spec §4): an hourly figure divided out of 2.6 seconds
 * is honest arithmetic and misleading on its own, so the divisor travels with
 * the rates. The copy is `comparison.window`, the same sentence a retained run
 * carries, because it is the same claim about the same kind of number.
 */
import { useTranslation } from 'react-i18next';
import type { PublicState } from '@narok/sim';
import { formatMeasuredDuration, formatNumber, type Translate } from '../i18n';
import { sessionRates } from './model';

export interface SessionPanelProps {
  state: PublicState | null;
}

export function SessionPanel(props: SessionPanelProps): React.JSX.Element {
  const { state } = props;
  const { t: rawT, i18n } = useTranslation();
  const t = rawT as unknown as Translate;
  const language = i18n.resolvedLanguage ?? 'en';

  const elapsedMs = state?.nowMs ?? 0;
  const rates = sessionRates(state?.metrics ?? null, elapsedMs);
  const show = (rate: number | null): string =>
    rate === null ? t('value.none') : formatNumber(rate, language, 1);

  return (
    <section className="session win" aria-labelledby="session-title" data-testid="session-panel">
      <h2 className="win-title" id="session-title">
        {t('session.title')}
      </h2>
      <dl className="session-list">
        <div className="metric">
          <dt>{t('metrics.killsPerHour')}</dt>
          <dd className="num" data-testid="session-kills-per-hour">
            {show(rates.kills)}
          </dd>
        </div>
        <div className="metric">
          <dt>{t('metrics.rawExpPerHour')}</dt>
          <dd className="num" data-testid="session-exp-per-hour">
            {show(rates.exp)}
          </dd>
        </div>
        <div className="metric">
          <dt>{t('metrics.rawGoldPerHour')}</dt>
          <dd className="num" data-testid="session-gold-per-hour">
            {show(rates.gold)}
          </dd>
        </div>
        <div className="metric">
          <dt>{t('metrics.damagePerHour')}</dt>
          <dd className="num" data-testid="session-damage-per-hour">
            {show(rates.damage)}
          </dd>
        </div>
      </dl>
      <p className="session-window" data-testid="session-window">
        {elapsedMs > 0
          ? t('comparison.window', { duration: formatMeasuredDuration(elapsedMs, t, language) })
          : t('comparison.windowNone')}
      </p>
    </section>
  );
}
