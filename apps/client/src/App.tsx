/**
 * The laboratory shell: Realm Refined's window/unit/skill vocabulary adapted to
 * milestone A's actual content and controls.
 *
 * Everything on screen comes from a real `PublicState`. There is no loot, wallet,
 * inventory, allocation, away report, premium wording, EXP-loss copy or survival
 * forecast anywhere here (realm-ui-spec §9, milestone spec §11), and no figure is
 * invented: an unmeasurable value renders an em dash instead.
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { content } from '@narok/data';
import type { SkillDefinition, SkillId } from '@narok/data';
import type { LabInput, PublicActor } from '@narok/sim';
import { BattlefieldView } from './BattlefieldView';
import { Comparison, type ComparisonRun } from './Comparison';
import { EventLog } from './EventLog';
import { ExperimentControls } from './ExperimentControls';
import {
  actorLabel,
  formatDuration,
  formatMeasuredDuration,
  formatNumber,
  formatPerHour,
  setLanguage,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
  type Translate,
} from './i18n';
import { useExperiment } from './useExperiment';

/**
 * Ruling R84: milestone A has no passive skills, so the five states below are the
 * complete reachable set. Everything is derived from `PublicActor` alone — the
 * cast in flight, the additive `cooldowns` ready-at stamps (R12/R42) and the
 * actor's MP against the skill's cost.
 *
 * `active` and `casting` are the same projected field (`actor.casting`) split by
 * whether there is a cast bar worth drawing. Nothing in this engine is
 * instantaneous (ruling R87): `castDuration` in `packages/sim/src/actions.ts:36-37`
 * is `Math.max(1, Math.ceil((baseCastMs * (150 - min(dex, 99))) / 150))`, so a
 * `baseCastMs === 0` skill (taunt, cleave, double-shot) still occupies a 1 ms
 * cast — too short to render a bar against, but a real, observable commitment.
 * `casting` is a skill with a non-zero `baseCastMs` (heal 800, smite 600,
 * arrow-rain 700, fire-bolt 900, frost-nova 900) whose bar is meaningful.
 *
 * `active` is rare but genuinely reachable, so this branch is not dead code: a
 * controller probe sampling the projection at every millisecond across 300,000 ms
 * of a real seed-1 run observed it 55 times out of 27,027 casting observations
 * (~0.2%), covering all three zero-cast skills. Do not "optimize it away".
 */
export type SkillActivity = 'casting' | 'active' | 'cooldown' | 'unavailable' | 'ready';

export function skillActivity(actor: PublicActor, skill: SkillDefinition, nowMs: number): SkillActivity {
  if (actor.casting === skill.id) return skill.baseCastMs > 0 ? 'casting' : 'active';
  const readyAt = actor.cooldowns[skill.id] ?? 0;
  if (readyAt > nowMs) return 'cooldown';
  if (actor.mp < skill.mp) return 'unavailable';
  return 'ready';
}

function actorDisplayName(t: Translate, actor: PublicActor): string {
  const key = actor.side === 'party' ? `class.${actor.definitionId}` : `monster.${actor.definitionId}`;
  return t(key, { defaultValue: actor.definitionId });
}

/**
 * The factual reason this actor is pointed where it is (R60), read from the
 * projection only. `forced` names the forcing actor — `project()` only reports
 * `forced` when the unexpired forced-target record names the current target, so
 * that actor *is* `currentTarget`. `priority` names the mode the running
 * experiment was actually started with; with no running input there is no mode to
 * name, and the label says only that the strategy chose it. Nothing here invents
 * a reason the projection did not supply.
 */
function targetReasonLabel(
  t: Translate,
  actor: PublicActor,
  actors: readonly PublicActor[],
  input: LabInput | null,
): string | null {
  switch (actor.targetReason) {
    case null:
      return null;
    case 'forced':
      return t('targetReason.forced', { source: actorLabel(t, actor.currentTarget, actors) });
    case 'threat':
      return t('targetReason.threat');
    case 'priority': {
      const mode = input?.strategies[actor.id]?.target.kind;
      return mode === undefined
        ? t('targetReason.priorityUnknown')
        : t('targetReason.priority', { mode: t(`targetMode.${mode}`) });
    }
  }
}

function Meter({ label, value, max, kind }: { label: string; value: string; max: number; kind: 'hp' | 'mp' }) {
  return (
    <div className={`meter meter--${kind}`}>
      <span className="meter-label">{label}</span>
      <span className="meter-track">
        <span className="meter-fill" style={{ width: `${Math.max(0, Math.min(100, max))}%` }} />
      </span>
      <span className="meter-value num">{value}</span>
    </div>
  );
}

export function App(): React.JSX.Element {
  const { t: rawT, i18n } = useTranslation();
  const t = rawT as unknown as Translate;
  const language = i18n.language;

  const { state, events, status, comparisonA, comparisonB, start, pause, resume, stop, setSpeed } = useExperiment();
  const [inspected, setInspected] = useState<{ actorId: string; skillId: SkillId } | null>(null);
  // The input the *running* experiment was started with. Editing the draft
  // afterwards never touches it; only a new start replaces it.
  const [activeInput, setActiveInput] = useState<LabInput | null>(null);

  const onStart = useCallback(
    (input: LabInput) => {
      setActiveInput(input);
      setInspected(null);
      start(input);
    },
    [start],
  );

  const nowMs = state?.nowMs ?? 0;
  const party = useMemo(() => (state?.actors ?? []).filter((actor) => actor.side === 'party'), [state]);
  const enemies = useMemo(() => (state?.actors ?? []).filter((actor) => actor.side === 'enemy'), [state]);

  // Slot A is the earlier retained run, slot B the latest (R54/R63).
  const runs = useMemo<ComparisonRun[]>(
    () =>
      [comparisonA, comparisonB]
        .filter((summary) => summary !== null)
        .map((summary) => ({ input: summary.input, state: summary.state })),
    [comparisonA, comparisonB],
  );

  const onLanguage = useCallback((next: SupportedLanguage) => {
    void setLanguage(next);
  }, []);

  const inspectedActor = inspected === null ? null : (state?.actors.find((actor) => actor.id === inspected.actorId) ?? null);
  const inspectedSkill = inspected === null ? null : content.skills[inspected.skillId];

  function inspectionDetail(): string {
    if (inspectedActor === null || inspectedSkill === null) return t('inspect.noSelection');
    const activity = skillActivity(inspectedActor, inspectedSkill, nowMs);
    switch (activity) {
      case 'cooldown':
        return t('inspect.cooldown', {
          remaining: formatDuration(Math.max(0, (inspectedActor.cooldowns[inspectedSkill.id] ?? 0) - nowMs), t, language),
        });
      case 'unavailable':
        return t('inspect.unavailable', {
          cost: formatNumber(inspectedSkill.mp, language),
          mp: formatNumber(inspectedActor.mp, language),
          actor: actorDisplayName(t, inspectedActor),
        });
      case 'casting':
        return t('inspect.casting');
      case 'active':
        return t('inspect.active');
      case 'ready':
        return t('inspect.ready');
    }
  }

  const metrics = state?.metrics ?? null;

  return (
    <div className="realm">
      <header className="realm-head">
        <div className="brand">
          <h1>{t('app.title')}</h1>
          <p className="tagline">{t('app.tagline')}</p>
        </div>
        <div className="playback" role="group" aria-label={t('status.label')}>
          <span className="playback-item">
            <span className="playback-key">{t('status.label')}</span>
            <strong data-testid="playback-status">{t(`status.${status}`)}</strong>
          </span>
          <span className="playback-item">
            <span className="playback-key">{t('playback.elapsed')}</span>
            <strong className="num" data-testid="elapsed-time">
              {formatDuration(nowMs, t, language)}
            </strong>
          </span>
          <span className="playback-item">
            <span className="playback-key">{t('playback.phase')}</span>
            <strong>{state === null ? t('value.none') : t(`phase.${state.phase}`)}</strong>
          </span>
        </div>
        <div className="languages" role="group" aria-label={t('language.label')}>
          {SUPPORTED_LANGUAGES.map((code) => (
            <button
              key={code}
              type="button"
              className="ghost-button"
              aria-pressed={language === code}
              onClick={() => onLanguage(code)}
            >
              {t(`language.${code}`)}
            </button>
          ))}
        </div>
      </header>

      <p className="playback-note" data-testid="playback-note">
        {t('playback.note')}
      </p>
      {status === 'error' && (
        <p role="alert" className="alert">
          {t('error.title')}
        </p>
      )}

      <div className="realm-body">
        <div className="col col--left">
          <section className="win panel" aria-label={t('unit.party')}>
            <h2 className="win-title">{t('unit.party')}</h2>
            {party.length === 0 ? (
              <p className="help">{t('unit.empty')}</p>
            ) : (
              <ul className="units">
                {party.map((actor) => (
                  <li key={actor.id} className="unit">
                    <p className="unit-name">
                      {actorDisplayName(t, actor)} <span className="unit-id num">{actor.id}</span>
                    </p>
                    <Meter
                      kind="hp"
                      label={t('unit.hp')}
                      value={`${formatNumber(actor.hp, language)} / ${formatNumber(actor.maxHp, language)}`}
                      max={(actor.hp / Math.max(1, actor.maxHp)) * 100}
                    />
                    <Meter
                      kind="mp"
                      label={t('unit.mp')}
                      value={`${formatNumber(actor.mp, language)} / ${formatNumber(actor.maxMp, language)}`}
                      max={(actor.mp / Math.max(1, actor.maxMp)) * 100}
                    />
                    <p className="unit-line">
                      {t('unit.target')}:{' '}
                      {actor.currentTarget === null
                        ? t('unit.noTarget')
                        : actorLabel(t, actor.currentTarget, state?.actors ?? [])}
                      {targetReasonLabel(t, actor, state?.actors ?? [], activeInput) === null
                        ? ''
                        : ` — ${targetReasonLabel(t, actor, state?.actors ?? [], activeInput)}`}
                    </p>
                    <p className="unit-line">
                      {actor.casting === null
                        ? t('unit.notCasting')
                        : t('unit.casting', { skill: t(`skill.${actor.casting}`) })}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="win panel" aria-label={t('unit.enemies')}>
            <h2 className="win-title">{t('unit.enemies')}</h2>
            {enemies.length === 0 ? (
              <p className="help">{t('unit.empty')}</p>
            ) : (
              <ul className="units units--foe">
                {enemies.map((actor) => (
                  <li key={actor.id} className="unit">
                    <p className="unit-name">
                      {actorDisplayName(t, actor)} <span className="unit-id num">{actor.id}</span>
                    </p>
                    <Meter
                      kind="hp"
                      label={t('unit.hp')}
                      value={`${formatNumber(actor.hp, language)} / ${formatNumber(actor.maxHp, language)}`}
                      max={(actor.hp / Math.max(1, actor.maxHp)) * 100}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="col col--centre">
          <BattlefieldView state={state} grid={content.grid} />

          <section className="win panel skills-panel" aria-label={t('app.skills')}>
            <h2 className="win-title">{t('app.skills')}</h2>
            <p className="help">{t('inspect.hint')}</p>
            {party.length === 0 ? (
              <p className="help">{t('unit.empty')}</p>
            ) : (
              <div className="skillsets">
                {party.map((actor) => {
                  const definition = content.classes[actor.definitionId as keyof typeof content.classes];
                  const skills = definition?.skills ?? [];
                  return (
                    <div key={actor.id} className="skillset" aria-label={actorDisplayName(t, actor)}>
                      <p className="skillset-owner">
                        {actorDisplayName(t, actor)} <span className="num">{actor.id}</span>
                      </p>
                      <ul className="slots">
                        {skills.map((skillId) => {
                          const skill = content.skills[skillId];
                          const activity = skillActivity(actor, skill, nowMs);
                          const selected = inspected?.actorId === actor.id && inspected.skillId === skillId;
                          return (
                            <li key={skillId}>
                              <button
                                type="button"
                                className={`slot slot--${activity}`}
                                aria-pressed={selected}
                                aria-label={`${t(`skill.${skillId}`)} — ${t(`skillState.${activity}`)}`}
                                onClick={() => setInspected({ actorId: actor.id, skillId })}
                              >
                                <span className="slot-name">{t(`skill.${skillId}`)}</span>
                                {/* Shape/text cue, never hue alone (§3). */}
                                <span className="slot-state">{t(`skillState.${activity}`)}</span>
                                <span className="slot-cost num">{formatNumber(skill.mp, language)}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="inspection" role="status">
              {inspected === null || inspectedSkill === null ? (
                <p>{t('inspect.noSelection')}</p>
              ) : (
                <>
                  <p className="inspection-head">
                    {t('inspect.heading', {
                      skill: t(`skill.${inspected.skillId}`),
                      state:
                        inspectedActor === null
                          ? t('value.none')
                          : t(`skillState.${skillActivity(inspectedActor, inspectedSkill, nowMs)}`),
                    })}
                  </p>
                  <p>{inspectionDetail()}</p>
                  <p className="num">{t('inspect.cost', { cost: formatNumber(inspectedSkill.mp, language) })}</p>
                  <a className="rule-link" href={`#rule-${inspected.actorId}-${inspected.skillId}`}>
                    {t('inspect.editRule', { skill: t(`skill.${inspected.skillId}`) })}
                  </a>
                </>
              )}
            </div>
          </section>
        </div>

        <div className="col col--right">
          <section className="win panel" aria-label={t('app.session')}>
            <h2 className="win-title">{t('app.session')}</h2>
            <dl className="figures">
              <div className="figure">
                <dt>{t('metrics.kills')}</dt>
                <dd className="num">{metrics === null ? t('value.none') : formatNumber(metrics.kills, language)}</dd>
              </div>
              <div className="figure">
                <dt>{t('metrics.killsPerHour')}</dt>
                <dd className="num">{metrics === null ? t('value.none') : formatPerHour(metrics.kills, nowMs, t, language)}</dd>
              </div>
              <div className="figure">
                <dt>{t('metrics.wins')}</dt>
                <dd className="num">{metrics === null ? t('value.none') : formatNumber(metrics.wins, language)}</dd>
              </div>
              <div className="figure">
                <dt>{t('metrics.wipes')}</dt>
                <dd className="num">{metrics === null ? t('value.none') : formatNumber(metrics.wipes, language)}</dd>
              </div>
              <div className="figure">
                <dt>{t('metrics.damageDealt')}</dt>
                <dd className="num">{metrics === null ? t('value.none') : formatNumber(metrics.damageDealt, language)}</dd>
              </div>
              <div className="figure">
                <dt>{t('metrics.effectiveHealing')}</dt>
                <dd className="num">
                  {metrics === null ? t('value.none') : formatNumber(metrics.effectiveHealing, language)}
                </dd>
              </div>
              <div className="figure">
                <dt>{t('metrics.rawExp')}</dt>
                <dd className="num">{metrics === null ? t('value.none') : formatNumber(metrics.rawExp, language)}</dd>
              </div>
              <div className="figure">
                <dt>{t('metrics.rawGold')}</dt>
                <dd className="num">{metrics === null ? t('value.none') : formatNumber(metrics.rawGold, language)}</dd>
              </div>
              <div className="figure">
                <dt>{t('metrics.walkMs')}</dt>
                <dd className="num">{metrics === null ? t('value.none') : formatMeasuredDuration(metrics.walkMs, t, language)}</dd>
              </div>
              <div className="figure">
                <dt>{t('metrics.fightMs')}</dt>
                <dd className="num">{metrics === null ? t('value.none') : formatMeasuredDuration(metrics.fightMs, t, language)}</dd>
              </div>
              <div className="figure">
                <dt>{t('metrics.restMs')}</dt>
                <dd className="num">{metrics === null ? t('value.none') : formatMeasuredDuration(metrics.restMs, t, language)}</dd>
              </div>
              <div className="figure">
                <dt>{t('metrics.stopReason')}</dt>
                <dd>{state === null || state.stopReason === null ? t('stopReason.none') : t(`stopReason.${state.stopReason}`)}</dd>
              </div>
            </dl>
          </section>

          <EventLog events={events} actors={state?.actors ?? []} />
        </div>
      </div>

      <Comparison runs={runs} />

      <ExperimentControls
        content={content}
        status={status}
        onStart={onStart}
        onPause={pause}
        onResume={resume}
        onStop={stop}
        onSpeedChange={setSpeed}
      />

      <p className="scope-note">{t('app.scope')}</p>
    </div>
  );
}
