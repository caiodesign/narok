/**
 * The character pane (`codex-examples/realm-refined/strategy.html:1225-1330`).
 *
 * One tab per roster member, and under it the priority list: the rules are
 * scanned top to bottom and the first whose condition holds is cast (R28), so
 * the design's ordered `.prio-list` is not decoration — the order *is* the
 * strategy. Each row carries the skill's real MP cost from `content.skills`,
 * its enable toggle and, when its condition takes one, its threshold.
 *
 * Dropped from the reference, because milestone A publishes nothing behind
 * them (R108): the Mana reserve rule (no reserve exists in the simulation), the
 * unsaved-changes pips (a setup edit starts a new experiment, so there is no
 * draft to be dirty against) and the drag grips (replaced by the labelled move
 * buttons R79 requires, which a keyboard can reach).
 *
 * The reference's party-wide "Focus target" chips become a per-character select
 * here: the simulation's target mode is per strategy, and one of its five modes
 * takes an ally as an argument, which a chip cannot carry.
 */
import { useTranslation } from 'react-i18next';
import type { Content } from '@narok/data';
import type { ActorId, Rule, Strategy, TargetMode } from '@narok/sim';
import { formatNumber, type Translate } from '../../i18n';
import { ruleValueRange, type ValidationIssue } from '../../validation';
import { classGlyphId } from '../model';

const CLASS_IDS = ['guardian', 'cleric', 'ranger', 'arcanist'] as const;
const PRIORITY_TARGET_KINDS = ['lowest-hp', 'highest-hp', 'highest-level', 'nearest'] as const;

/** The skill emblems the sheet ships, by the skill ids milestone A publishes. */
const SKILL_GLYPHS: Record<string, string> = {
  taunt: 's-taunt',
  cleave: 's-cleave',
  heal: 's-heal',
  smite: 's-smite',
  revive: 's-groupheal',
  'double-shot': 's-doubleshot',
  'arrow-rain': 's-arrowrain',
  'fire-bolt': 's-focus',
  'frost-nova': 's-keeneye',
  basic: 's-bulwark',
};

export interface CharacterPaneProps {
  content: Content;
  rosterIds: readonly ActorId[];
  classes: readonly string[];
  strategies: Record<ActorId, Strategy>;
  activeActorId: ActorId;
  onActivate: (actorId: ActorId) => void;
  onClassChange: (actorId: ActorId, classId: string) => void;
  onRuleEnabled: (actorId: ActorId, ruleIndex: number, enabled: boolean) => void;
  onRuleThreshold: (actorId: ActorId, ruleIndex: number, value: number) => void;
  onMoveRule: (actorId: ActorId, ruleIndex: number, direction: -1 | 1) => void;
  onTargetKind: (actorId: ActorId, kind: TargetMode['kind']) => void;
  onTargetPartyId: (actorId: ActorId, partyId: ActorId) => void;
  issuesFor: (field: string) => ValidationIssue[];
}

/** The sentence the design puts next to a rule's control, per condition kind. */
function conditionLabel(t: Translate, rule: Rule): string {
  return t(`condition.${rule.condition.kind}`);
}

function PriorityRow(props: {
  actorId: ActorId;
  classId: string;
  rule: Rule;
  index: number;
  total: number;
  cost: number;
  pane: CharacterPaneProps;
}): React.JSX.Element {
  const { actorId, rule, index, total, cost, pane } = props;
  const { t: rawT, i18n } = useTranslation();
  const t = rawT as unknown as Translate;
  const language = i18n.language;
  const skillName = t(`skill.${rule.skillId}`);
  const threshold = 'value' in rule.condition ? rule.condition.value : null;
  const inputId = `rule-${actorId}-${rule.skillId}-value`;
  const isPercent = rule.condition.kind === 'ally-hp-below';
  // The slider cannot offer a value the simulation would reject: its bounds are
  // the same ones `validateLabInput` enforces for this skill (R76).
  const [min, max] = ruleValueRange(rule.skillId) ?? (isPercent ? [1, 99] : [1, 5]);

  return (
    <li className="prio" id={`rule-${actorId}-${rule.skillId}`}>
      <span className="grip-stack">
        <button
          type="button"
          className="grip"
          aria-label={t('controls.moveRuleUp', { skill: skillName, actor: actorId })}
          disabled={index === 0}
          onClick={() => pane.onMoveRule(actorId, index, -1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="grip"
          aria-label={t('controls.moveRuleDown', { skill: skillName, actor: actorId })}
          disabled={index === total - 1}
          onClick={() => pane.onMoveRule(actorId, index, 1)}
        >
          ↓
        </button>
      </span>
      <span className="skill">
        <span className={`slot slot--ready school-${props.classId}`}>
          <kbd>{formatNumber(index + 1, language)}</kbd>
          <svg aria-hidden="true">
            <use href={`#${SKILL_GLYPHS[rule.skillId] ?? 's-focus'}`} />
          </svg>
        </span>
      </span>
      <div className="prio-body">
        <p className="prio-head">
          <span className="prio-name">{skillName}</span>
          <span className="prio-meta">
            <span className="mp">{t('controls.mpCost', { cost: formatNumber(cost, language) })}</span>
          </span>
          <input
            className="toggle"
            type="checkbox"
            checked={rule.enabled}
            aria-label={t('controls.ruleEnabled', { skill: skillName })}
            onChange={(event) => pane.onRuleEnabled(actorId, index, event.target.checked)}
          />
        </p>
        <div className="rule">
          <label className="rule-label" htmlFor={threshold === null ? undefined : inputId}>
            {conditionLabel(t, rule)}
          </label>
          {threshold !== null && (
            <>
              <span className="rule-val">
                <output className="val" htmlFor={inputId}>
                  {isPercent
                    ? t('controls.percent', { value: formatNumber(threshold, language) })
                    : formatNumber(threshold, language)}
                </output>
              </span>
              <div className={`range ${isPercent ? 'range--hp' : 'range--foe'}`}>
                <span className="ticks" />
                <input
                  type="range"
                  id={inputId}
                  min={min}
                  max={max}
                  step={1}
                  value={threshold}
                  aria-label={t('controls.ruleThresholdFor', { skill: skillName })}
                  style={{ ['--p' as string]: max === min ? 0 : (threshold - min) / (max - min) }}
                  onChange={(event) => pane.onRuleThreshold(actorId, index, Number(event.target.value))}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

export function CharacterPane(props: CharacterPaneProps): React.JSX.Element {
  const { content, rosterIds, classes, strategies, activeActorId } = props;
  const { t: rawT } = useTranslation();
  const t = rawT as unknown as Translate;
  const strategy = strategies[activeActorId];
  const activeIndex = rosterIds.indexOf(activeActorId);
  const activeClass = classes[activeIndex] ?? 'guardian';

  return (
    <section className="pane" aria-labelledby="char-title">
      <h2 className="sr-only" id="char-title">
        {t('controls.strategy')}
      </h2>

      <div className="char-tabs" role="tablist" aria-label={t('controls.character')}>
        {rosterIds.map((actorId, index) => {
          const classId = classes[index] ?? 'guardian';
          const active = actorId === activeActorId;
          return (
            <button
              key={actorId}
              className="char-tab"
              type="button"
              role="tab"
              id={`char-tab-${actorId}`}
              aria-selected={active}
              aria-controls={`char-rules-${actorId}`}
              tabIndex={active ? 0 : -1}
              onClick={() => props.onActivate(actorId)}
            >
              <span className={`medal medal--${classId}`} aria-hidden="true">
                <svg>
                  <use href={`#${classGlyphId(classId)}`} />
                </svg>
              </span>
              <span className="char-tab-name">{actorId}</span>
              <span className="char-tab-class">{t(`class.${classId}`)}</span>
            </button>
          );
        })}
      </div>

      <div className="pane-body" id={`char-rules-${activeActorId}`} role="tabpanel" aria-labelledby={`char-tab-${activeActorId}`}>
        <div role="group" aria-label={t('controls.strategyFor', { actor: activeActorId })}>
          <div className="section">
            <div className="inline-rule">
              <label className="rule-label" htmlFor={`class-${activeActorId}`}>
                {t('controls.member', { actor: activeActorId })}
              </label>
              <select
                id={`class-${activeActorId}`}
                value={activeClass}
                onChange={(event) => props.onClassChange(activeActorId, event.target.value)}
              >
                {CLASS_IDS.map((classId) => (
                  <option key={classId} value={classId}>
                    {t(`class.${classId}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="section">
            <h3 className="subhead">
              {t('controls.skillPriority')}
              <span className="aside">{t('controls.ruleOrderHelp')}</span>
            </h3>
            <ol className="prio-list">
              {strategy?.rules.map((rule, index) => (
                <PriorityRow
                  key={rule.skillId}
                  actorId={activeActorId}
                  classId={activeClass}
                  rule={rule}
                  index={index}
                  total={strategy.rules.length}
                  cost={content.skills[rule.skillId]?.mp ?? 0}
                  pane={props}
                />
              ))}
              {/*
               * The design's locked fallback row. This one is not invented: the
               * resolver really does fall back to a basic attack when no rule
               * above can be cast, and it really cannot be disabled or moved.
               */}
              <li className="prio prio--fallback">
                <span className="grip grip--fixed" aria-hidden="true" />
                <span className="skill">
                  <span className="slot slot--passive">
                    <svg aria-hidden="true">
                      <use href="#s-bulwark" />
                    </svg>
                  </span>
                </span>
                <div className="prio-body">
                  <p className="prio-head">
                    <span className="prio-name">{t('skill.basic')}</span>
                    <span className="hint">{t('controls.alwaysOn')}</span>
                  </p>
                </div>
              </li>
            </ol>
          </div>

          <div className="section">
            <h3 className="subhead">{t('controls.focusTarget')}</h3>
            <div className="inline-rule">
              <label className="rule-label" htmlFor={`target-kind-${activeActorId}`}>
                {t('controls.targetMode')}
              </label>
              <select
                id={`target-kind-${activeActorId}`}
                value={strategy?.target.kind ?? 'nearest'}
                onChange={(event) => props.onTargetKind(activeActorId, event.target.value as TargetMode['kind'])}
              >
                {PRIORITY_TARGET_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`targetMode.${kind}`)}
                  </option>
                ))}
                <option value="attacking">{t('targetMode.attacking')}</option>
              </select>
            </div>
            {strategy?.target.kind === 'attacking' && (
              <div className="inline-rule" style={{ marginTop: 8 }}>
                <label className="rule-label" htmlFor={`target-party-${activeActorId}`}>
                  {t('controls.watchAlly')}
                </label>
                <select
                  id={`target-party-${activeActorId}`}
                  value={strategy.target.partyId}
                  onChange={(event) => props.onTargetPartyId(activeActorId, event.target.value)}
                >
                  {rosterIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {props.issuesFor(`strategies.${activeActorId}`).map((issue, index) => (
            <p role="alert" className="alert" key={`${issue.field}-${index}`}>
              {t(issue.messageKey)}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}
