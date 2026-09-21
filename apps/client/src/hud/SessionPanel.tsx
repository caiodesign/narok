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
 */
import { useTranslation } from 'react-i18next';
import type { PublicState } from '@narok/sim';
import { formatNumber } from '../i18n';
import { sessionRates } from './model';

export interface SessionPanelProps {
  state: PublicState | null;
}

export function SessionPanel(props: SessionPanelProps): React.JSX.Element {
  const { state } = props;
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? 'en';

  const rates = sessionRates(state?.metrics ?? null, state?.nowMs ?? 0);
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
    </section>
  );
}
