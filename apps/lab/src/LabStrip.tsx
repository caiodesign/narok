/**
 * The laboratory's own readouts, in the Realm HUD's vocabulary.
 *
 * `hunt.html` is a game screen and has no header: no title, no playback clock, no
 * language switch, no export. Milestone A is a combat laboratory and needs all
 * four, so they live here in a compact window built from the reference's own
 * `.win` / `.session-list` / `.metric` / `.auto-inspection` components — no new
 * CSS is introduced for them.
 *
 * This strip is always mounted. The playback clock and status are the laboratory's
 * primary evidence and several tests locate them unscoped, so they must not be
 * hidden behind the setup overlay.
 */
import { useTranslation } from 'react-i18next';
import type { PublicState } from '@narok/sim';
import {
  formatDuration,
  setLanguage,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from '@narok/client/src/i18n';
import type { ExperimentStatus } from './useExperiment';

export interface LabStripProps {
  state: PublicState | null;
  status: ExperimentStatus;
  canExport: boolean;
  onExport: () => void;
}

export function LabStrip(props: LabStripProps): React.JSX.Element {
  const { state, status, canExport, onExport } = props;
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? 'en';

  return (
    <section className="session win" aria-label={t('app.title')}>
      <h1 className="sr-only">{t('app.title')}</h1>
      <h2 className="win-title">{t('status.label')}</h2>

      {/* The playback readouts are scoped inside one named group: once a run is
          retained the document holds several `elapsed-time` hooks, and the
          browser smoke resolves the live one through this group (R81). */}
      <div role="group" aria-label={t('status.label')}>
        <dl className="session-list">
          <div className="metric">
            <dt>{t('status.label')}</dt>
            <dd data-testid="playback-status">{t(`status.${status}`)}</dd>
          </div>
          <div className="metric">
            <dt>{t('playback.elapsed')}</dt>
            {/* The playback clock, not a measurement window: before a run it
                genuinely reads zero, so it prints `0 s` rather than the em dash
                `formatMeasuredDuration` gives an unmeasurable figure. */}
            <dd className="num" data-testid="elapsed-time">
              {formatDuration(state?.nowMs ?? 0, t, language)}
            </dd>
          </div>
          <div className="metric">
            <dt>{t('playback.phase')}</dt>
            <dd>{state === null ? t('value.none') : t(`phase.${state.phase}`)}</dd>
          </div>
          <div className="metric">
            <dt>{t('export.label')}</dt>
            <dd>
              <button
                type="button"
                className="preset-edit"
                data-testid="export-session"
                disabled={!canExport}
                onClick={onExport}
              >
                <svg aria-hidden="true">
                  <use href="#i-quill" />
                </svg>
                {t('export.button')}
              </button>
            </dd>
          </div>
        </dl>
      </div>

      <div className="auto-inspection" data-testid="playback-note">
        {t('playback.note')}
      </div>

      <div className="tabs" role="group" aria-label={t('language.label')}>
        {SUPPORTED_LANGUAGES.map((code) => (
          <button
            key={code}
            type="button"
            className="tab"
            aria-pressed={language === code}
            onClick={() => {
              void setLanguage(code as SupportedLanguage);
            }}
          >
            {t(`language.${code}`)}
          </button>
        ))}
      </div>
    </section>
  );
}
