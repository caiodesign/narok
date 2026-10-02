/**
 * The Character screen's attribute pane (part 4 §3.4; UI spec §7; B-16).
 *
 * A staged allocation, local until applied: each + stages one point at
 * `@narok/progression`'s step cost, the pane shows the server's unspent
 * points apart from the pending cost, and each control previews its own
 * before and after. Apply sends the whole draft once with the cost the player
 * saw (the server replays it and refuses a mismatch); Reset is local.
 *
 * A stale account answer is never retried blind: the screen re-reads the
 * account and keeps the draft, which this pane then revalidates against the
 * fresh figures — a draft the new state cannot afford is held, explained and
 * not applicable until the player resets it. Nothing overspends and nothing
 * is discarded silently.
 *
 * Ruling R187: the combat block shows the server's derived stats as they are;
 * no "after" combat figure is projected, because that formula is the
 * engine's and the client runs none (B-02).
 */
import { useTranslation } from 'react-i18next';
import type { Attributes, Content } from '@narok/data';
import { ATTRIBUTE_KEYS, type AttributeKey } from '@narok/progression';
import type { CharacterSummary } from '../commands';
import { classNames } from '../hud/model';
import { formatNumber } from '../i18n';
import { allocationSummary, nextStep, percentOf, secondsOf, type AttributeSpend } from './model';

export type AllocationNotice = 'stale' | 'refused' | null;

export interface AttributePaneProps {
  readonly character: CharacterSummary;
  readonly attributes: Attributes;
  readonly gear: Partial<Record<AttributeKey, number>>;
  readonly content: Content;
  readonly spend: AttributeSpend;
  readonly focus: AttributeKey | null;
  readonly hunting: boolean;
  readonly applying: boolean;
  readonly notice: AllocationNotice;
  readonly refusal: string | null;
  readonly onStage: (key: AttributeKey) => void;
  readonly onApply: () => void;
  readonly onReset: () => void;
}

export function AttributePane(props: AttributePaneProps): React.JSX.Element {
  const { character, attributes, gear, content, spend, focus, hunting, applying, notice, refusal } = props;
  const { t, i18n } = useTranslation();
  const number = (value: number, digits = 0) => formatNumber(value, i18n.language, digits);
  const statPoints = character.statPoints ?? 0;
  const summary = allocationSummary(attributes, statPoints, spend);
  const cap = content.progression.attributeCap;
  const abbr = (key: AttributeKey) => t(`attribute.${key}.abbr`);

  const focusStep = focus === null ? null : { key: focus, staged: attributes[focus] + (spend[focus] ?? 0) };
  const message = !summary.staged
    ? t('character.choose')
    : focusStep === null
      ? ''
      : t('character.stepPreview', {
          attr: abbr(focusStep.key),
          from: attributes[focusStep.key],
          to: focusStep.staged,
          cost: nextStepCostOf(focusStep.key),
        });

  function nextStepCostOf(key: AttributeKey): number {
    // The cost of the points staged on this attribute, replayed from its base.
    const without = { ...spend, [key]: 0 };
    return allocationSummary(attributes, statPoints, spend).pending - allocationSummary(attributes, statPoints, without).pending;
  }

  const stats = character.stats;
  return (
    <section className="pane attrs" aria-labelledby="attr-title">
      <h2 className="pane-title" id="attr-title">
        {t('character.attributes')}{' '}
        <span className="points">
          <span className="pts num">{number(summary.unspent)}</span>
          {t('character.unspent')}
        </span>
      </h2>

      <ul className="attrs-list">
        {ATTRIBUTE_KEYS.map((key) => {
          const step = nextStep(attributes, statPoints, spend, key, cap);
          const staged = spend[key] ?? 0;
          const bonus = gear[key] ?? 0;
          const refused = hunting || step.refused !== null || applying;
          const label =
            step.refused === 'cap'
              ? t('character.raiseCapped', { attr: abbr(key) })
              : step.refused === 'points'
                ? t('character.raiseRefused', { attr: abbr(key), cost: step.cost })
                : t('character.raise', { attr: abbr(key), cost: step.cost });
          return (
            <li className={classNames('attr', staged > 0 && 'is-staged', focus === key && 'is-focus')} key={key}>
              <p className="attr-name">
                <abbr title={t(`attribute.${key}.name`)}>{abbr(key)}</abbr>
                <span>{t(`attribute.${key}.name`)}</span>
              </p>
              <span className="attr-total">{number(attributes[key] + staged + bonus)}</span>
              <span className="attr-split">
                {number(attributes[key] + staged)} <span className={bonus > 0 ? 'bonus' : 'nil'}>+{number(bonus)}</span>
              </span>
              <button className="addbtn" type="button" disabled={refused} aria-label={label} onClick={() => props.onStage(key)}>
                <i>
                  <svg aria-hidden="true">
                    <use href="#i-plus" />
                  </svg>
                </i>
                {number(step.cost)}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="allocation-preview">
        <p id="allocation-message" aria-live="polite">
          {message}
          {summary.staged && <> {t('character.pending', { pending: summary.pending, remaining: Math.max(0, summary.remaining) })}</>}
          {summary.staged && !summary.affordable && <> {t('character.insufficient', { pending: summary.pending, unspent: summary.unspent })}</>}
          {notice === 'stale' && <> {t('character.stale')}</>}
          {notice === 'refused' && refusal !== null && <> {t('town.refused', { reason: t(`serverError.${refusal}`) })}</>}
          {hunting && <> {t('character.allocateTown')}</>}
        </p>
        <div className="allocation-actions">
          <button type="button" disabled={!summary.staged || !summary.affordable || hunting || applying} aria-busy={applying} onClick={props.onApply}>
            {applying ? t('character.applying') : t('character.apply')}
          </button>
          <button type="button" disabled={!summary.staged || applying} onClick={props.onReset}>
            {t('character.reset')}
          </button>
        </div>
      </div>

      {character.autoSpendTemplate != null && (
        <div className="autospend">
          <div className="autospend-row">
            <span className="autospend-label">{t('character.autoSpend')}</span>
          </div>
          <div className="autospend-template">
            <ol aria-label={t('character.autoSpend')}>
              {character.autoSpendTemplate.targets.map((target) => (
                <li key={target.attribute}>{t('character.autoSpendTarget', { attr: abbr(target.attribute), value: target.value })}</li>
              ))}
              {character.autoSpendTemplate.remainder !== null && (
                <li>{t('character.autoSpendRest', { attr: abbr(character.autoSpendTemplate.remainder) })}</li>
              )}
            </ol>
          </div>
        </div>
      )}

      {stats !== undefined && (
        <>
          <h3 className="sub-title">{t('character.combat')}</h3>
          <dl className="derived">
            <div>
              <dt>{t('character.stat.atk')}</dt>
              <dd>{number(stats.atk)}</dd>
            </div>
            <div>
              <dt>{t('character.stat.matk')}</dt>
              <dd>{number(stats.matk)}</dd>
            </div>
            <div>
              <dt>{t('character.stat.def')}</dt>
              <dd>{number(stats.def)}</dd>
            </div>
            <div>
              <dt>{t('character.stat.mdef')}</dt>
              <dd>{number(stats.mdef)}</dd>
            </div>
            <div>
              <dt>{t('character.stat.hit')}</dt>
              <dd>{number(stats.hit)}</dd>
            </div>
            <div>
              <dt>{t('character.stat.flee')}</dt>
              <dd>{number(stats.flee)}</dd>
            </div>
            <div>
              <dt>{t('character.stat.crit')}</dt>
              <dd>{t('bag.percent', { value: number(percentOf(stats.critBp), 2) })}</dd>
            </div>
            <div>
              <dt>{t('character.stat.interval')}</dt>
              <dd>{t('duration.seconds', { value: number(secondsOf(stats.intervalMs), 2) })}</dd>
            </div>
          </dl>
        </>
      )}
    </section>
  );
}
