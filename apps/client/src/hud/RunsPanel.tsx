/**
 * The rail's second window — `codex-examples/realm-refined/hunt.html:1333-1368`,
 * repurposed.
 *
 * The reference fills this window with loot. Milestone A has no loot system, no
 * items, no rarities and no bag (milestone spec §11), so reproducing it would
 * mean inventing every row. What the laboratory actually accumulates over a
 * session is *retained runs* (ruling R54/R63), so the window keeps the loot
 * vocabulary — `.loot`, `.loot-list`, `.drop`, `.drop-icon`, `.drop-name`,
 * `.drop-note`, `.drop-age`, `.older` — and each row is one retained comparison
 * slot. The rarity modifiers are not repurposed: a run has no rarity, so every
 * row is the neutral `drop--plain`.
 *
 * Ordering follows the reference's newest-first list: slot B (the latest run)
 * heads the list and slot A (the earlier run) sits under the `.older` divider,
 * which is drawn only when there really are two runs to divide.
 *
 * Contract preserved from `Comparison.tsx` (ruling R81): both slots always
 * exist and carry `comparison-slot-a` / `comparison-slot-b`; a *filled* slot
 * carries all thirteen figure test ids; an *empty* slot carries none of them, so
 * those ids stay unambiguous while no run has completed.
 */
import { useTranslation } from 'react-i18next';
import type { ComparisonRun } from '../Comparison';
import { formatMeasuredDuration, formatNumber, formatPerHour, type Translate } from '../i18n';

export interface RunsPanelProps {
  runs: readonly ComparisonRun[];
}

/** Slot A is the earlier retained run, slot B the latest (R54/R63). */
type Slot = 'a' | 'b';

function Metric({ id, label, value }: { id: string; label: string; value: string }): React.JSX.Element {
  return (
    <div className="metric">
      <dt>{label}</dt>
      <dd className="num" data-testid={id}>
        {value}
      </dd>
    </div>
  );
}

/**
 * The measured figures for a filled slot. The reference has no equivalent — its
 * rows are single items — so this reuses the design's own figure vocabulary from
 * the session window (`hunt.html:1249-1257`): `.session-list` / `.metric`.
 */
function RunFigures({ run }: { run: ComparisonRun }): React.JSX.Element {
  const { t: rawT, i18n } = useTranslation();
  const t = rawT as unknown as Translate;
  const language = i18n.language;
  const elapsedMs = run.state.nowMs;
  const metrics = run.state.metrics;

  return (
    <dl className="session-list" style={{ gridColumn: '1 / span 3' }}>
      <Metric id="kills" label={t('metrics.kills')} value={formatNumber(metrics.kills, language)} />
      <Metric
        id="kills-per-hour"
        label={t('metrics.killsPerHour')}
        value={formatPerHour(metrics.kills, elapsedMs, t, language)}
      />
      <Metric id="wins" label={t('metrics.wins')} value={formatNumber(metrics.wins, language)} />
      <Metric id="wipes" label={t('metrics.wipes')} value={formatNumber(metrics.wipes, language)} />
      <Metric
        id="stop-reason"
        label={t('metrics.stopReason')}
        value={run.state.stopReason === null ? t('stopReason.none') : t(`stopReason.${run.state.stopReason}`)}
      />
      <Metric id="damage-dealt" label={t('metrics.damageDealt')} value={formatNumber(metrics.damageDealt, language)} />
      <Metric
        id="effective-healing"
        label={t('metrics.effectiveHealing')}
        value={formatNumber(metrics.effectiveHealing, language)}
      />
      <Metric
        id="raw-exp-per-hour"
        label={t('metrics.rawExpPerHour')}
        value={formatPerHour(metrics.rawExp, elapsedMs, t, language)}
      />
      <Metric
        id="raw-gold-per-hour"
        label={t('metrics.rawGoldPerHour')}
        value={formatPerHour(metrics.rawGold, elapsedMs, t, language)}
      />
      <Metric id="walk-time" label={t('metrics.walkMs')} value={formatMeasuredDuration(metrics.walkMs, t, language)} />
      <Metric id="fight-time" label={t('metrics.fightMs')} value={formatMeasuredDuration(metrics.fightMs, t, language)} />
      <Metric id="rest-time" label={t('metrics.restMs')} value={formatMeasuredDuration(metrics.restMs, t, language)} />
    </dl>
  );
}

function RunRow({ slot, run }: { slot: Slot; run: ComparisonRun | undefined }): React.JSX.Element {
  const { t: rawT, i18n } = useTranslation();
  const t = rawT as unknown as Translate;
  const language = i18n.language;
  const upper = slot.toUpperCase();

  const note =
    run === undefined ? (
      t('comparison.empty')
    ) : (
      <>
        {t('comparison.roster')}:{' '}
        {run.input.classes.map((classId) => t(`class.${classId}`, { defaultValue: classId })).join(', ')} ·{' '}
        {t('metrics.recipe')}: {t(`recipe.${run.input.recipe}`, { defaultValue: run.input.recipe })} ·{' '}
        {t('metrics.seed')}: <span className="num">{formatNumber(run.input.seed, language)}</span>
      </>
    );

  return (
    <li
      className="drop drop--plain"
      data-testid={`comparison-slot-${slot}`}
      aria-label={t(`comparison.slot${upper}`)}
    >
      <span className="drop-icon">
        <svg aria-hidden="true">
          <use href="#i-hourglass" />
        </svg>
      </span>
      <span className="drop-name">{t(`comparison.name${upper}`)}</span>
      {run !== undefined && (
        <span className="drop-age" title={t('metrics.elapsed')} data-testid="elapsed-time">
          {formatMeasuredDuration(run.state.nowMs, t, language)}
        </span>
      )}
      <span className="drop-note">{note}</span>
      {run !== undefined && <RunFigures run={run} />}
    </li>
  );
}

export function RunsPanel({ runs }: RunsPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const earlier = runs[0];
  const latest = runs[1];

  return (
    <section className="loot win" aria-label={t('comparison.heading')}>
      <h2 className="win-title">{t('comparison.heading')}</h2>
      <ul className="loot-list">
        <RunRow slot="b" run={latest} />
        {/* Only a real pair has an "earlier" half to divide off. */}
        {earlier !== undefined && latest !== undefined && <li className="older">{t('comparison.older')}</li>}
        <RunRow slot="a" run={earlier} />
      </ul>
    </section>
  );
}
