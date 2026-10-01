/**
 * The rail's orders window — `codex-examples/realm-refined/hunt.html:1370-1384`,
 * repurposed.
 *
 * "Orders" in the reference is what the hunt has been told to do, and in this
 * build that is the run itself: how fast the playback clock runs, where the
 * setup is edited, and whether the experiment is running at all. The reference's
 * two orders — Strategy and Loot filter — do not survive: strategy already has
 * its own panel in the setup form, and there is no loot to filter.
 *
 * The four run actions keep the exact accessible names ruling R81 fixed
 * (`controls.start` / `controls.pause` / `controls.resume` / `controls.stop`),
 * because the unit suite and the Playwright smoke locate them by name. All four
 * are always in the document and each is enabled exactly while its action is
 * legal — a button that vanished when illegal would take its name out of reach
 * of `getByRole`, which `apps/client/test/app.test.tsx` asserts at idle.
 */
import { useTranslation } from 'react-i18next';
import { formatNumber, type Translate } from '../i18n';
import type { ExperimentStatus } from '../status';

/** The only speeds `useExperiment.setSpeed` accepts; anything else is ignored there. */
const SPEEDS = [1, 4, 16] as const;

export interface OrdersPanelProps {
  status: ExperimentStatus;
  speed: number;
  canStart: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onSpeedChange: (speed: number) => void;
  onOpenSetup: () => void;
}

function RunButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button className="stop" type="button" disabled={disabled} onClick={onClick}>
      <span className="stop-seal" aria-hidden="true">
        <i />
      </span>
      {label}
    </button>
  );
}

export function OrdersPanel({
  status,
  speed,
  canStart,
  onStart,
  onPause,
  onResume,
  onStop,
  onSpeedChange,
  onOpenSetup,
}: OrdersPanelProps): React.JSX.Element {
  const { t: rawT, i18n } = useTranslation();
  const t = rawT as unknown as Translate;
  const language = i18n.language;

  const index = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
  const current = index === -1 ? SPEEDS[0] : SPEEDS[index];
  const next = SPEEDS[(index === -1 ? 0 : index + 1) % SPEEDS.length];

  const idle = status === 'idle' || status === 'stopped' || status === 'error';

  /**
   * The reference seals exactly one action into this window, so only the run
   * action that is actually next takes the seal. The other three stay as compact
   * controls: every name has to remain reachable by `getByRole` even while its
   * action is illegal (R81), so none of them is ever unmounted.
   */
  const primary = status === 'running' ? 'pause' : status === 'paused' ? 'resume' : 'start';

  const secondary: readonly { key: string; label: string; disabled: boolean; onClick: () => void }[] = [
    { key: 'start', label: t('controls.start'), disabled: !canStart || !idle, onClick: onStart },
    { key: 'pause', label: t('controls.pause'), disabled: status !== 'running', onClick: onPause },
    { key: 'resume', label: t('controls.resume'), disabled: status !== 'paused', onClick: onResume },
    { key: 'stop', label: t('controls.stop'), disabled: idle, onClick: onStop },
  ].filter((action) => action.key !== primary);

  const sealed = {
    start: { label: t('controls.start'), disabled: !canStart || !idle, onClick: onStart },
    pause: { label: t('controls.pause'), disabled: status !== 'running', onClick: onPause },
    resume: { label: t('controls.resume'), disabled: status !== 'paused', onClick: onResume },
  }[primary];

  return (
    <section className="orders win" aria-label={t('controls.orders')}>
      <button className="preset" type="button" onClick={() => onSpeedChange(next)}>
        <span className="preset-kind">{t('playback.speed')}</span>
        <span className="preset-value">{t('playback.speedOption', { value: formatNumber(current, language) })}</span>
      </button>

      <button className="preset" type="button" onClick={onOpenSetup}>
        <span className="preset-kind">{t('controls.section')}</span>
        <span className="preset-value">{t('controls.openSetup')}</span>
        <span className="preset-edit">
          <svg aria-hidden="true">
            <use href="#i-quill" />
          </svg>
          {t('controls.edit')}
        </span>
      </button>

      <RunButton label={sealed.label} disabled={sealed.disabled} onClick={sealed.onClick} />

      <div className="run-actions">
        {secondary.map((action) => (
          <button
            key={action.key}
            className="preset-edit"
            type="button"
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ))}
      </div>
    </section>
  );
}
