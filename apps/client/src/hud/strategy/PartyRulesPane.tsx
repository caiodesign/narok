/**
 * The party rules pane (`codex-examples/realm-refined/strategy.html:1331-1414`).
 *
 * Three of the reference's four sections survive into milestone A, and each is
 * bound to a real field of `LabInput`:
 *
 * - "Rest between fights" → `rest.hpStart` / `rest.mpStart`, on the design's own
 *   HP and MP ranges.
 * - The retreat section's death pips → `wipeLimit`. The reference's pips count
 *   deaths against a five-death cap; the laboratory's are wipes against the
 *   configured limit, which defaults to one (the rules override the mockup's
 *   five — see the UI spec's correction table).
 * - Roster size, recipe and seed have no counterpart on a game screen, which
 *   starts from a party that already exists. They are the laboratory's own and
 *   use the design's `.section` / `.subhead` / `.chips` / `.rule` vocabulary
 *   rather than a new one.
 *
 * Dropped whole: potions and the bag-full policy (no items in A), and "return to
 * town" (no town, and travel costs are an open milestone B decision).
 */
import { useTranslation } from 'react-i18next';
import type { Content, RecipeId } from '@narok/data';
import type { LabInput } from '@narok/sim';
import { formatNumber, type Translate } from '../../i18n';
import type { ValidationIssue } from '../../validation';

/** The reference's pip strip is five wide; the laboratory's cap is the same. */
const WIPE_PIPS = [1, 2, 3, 4, 5] as const;

export interface PartyRulesPaneProps {
  content: Content;
  draft: LabInput;
  onRosterSize: (size: number) => void;
  onRecipe: (recipe: RecipeId | 'mixed') => void;
  onSeed: (seed: number) => void;
  onRest: (part: 'hpStart' | 'mpStart', value: number) => void;
  onWipeLimit: (limit: number) => void;
  issuesFor: (field: string) => ValidationIssue[];
}

function Alerts({ issues }: { issues: ValidationIssue[] }): React.JSX.Element | null {
  const { t } = useTranslation();
  if (issues.length === 0) return null;
  return (
    <>
      {issues.map((issue, index) => (
        <p role="alert" className="alert" key={`${issue.field}-${index}`}>
          {t(issue.messageKey)}
        </p>
      ))}
    </>
  );
}

export function PartyRulesPane(props: PartyRulesPaneProps): React.JSX.Element {
  const { content, draft } = props;
  const { t: rawT, i18n } = useTranslation();
  const t = rawT as unknown as Translate;
  const language = i18n.language;

  return (
    <section className="pane" aria-labelledby="party-title">
      <h2 className="win-title" id="party-title">
        {t('controls.partyRules')}
      </h2>
      <div className="pane-body">
        <div className="section">
          <fieldset className="chips chips--grid">
            <legend className="subhead">{t('controls.rosterSize')}</legend>
            {[1, 2, 3].map((size) => (
              <label key={size} className="chip">
                <input
                  type="radio"
                  name="roster-size"
                  value={size}
                  aria-label={t('controls.rosterSizeOption', { count: size })}
                  checked={draft.classes.length === size}
                  onChange={() => props.onRosterSize(size)}
                />
                <span className="num">{formatNumber(size, language)}</span>
              </label>
            ))}
          </fieldset>
          <Alerts issues={props.issuesFor('classes')} />
        </div>

        <div className="section">
          <h3 className="subhead">
            {t('controls.recipeAndSeed')}
            <span className="aside">{t('controls.recipeAside')}</span>
          </h3>
          <div className="inline-rule">
            <label className="rule-label" htmlFor="recipe">
              {t('controls.recipe')}
            </label>
            <select id="recipe" value={draft.recipe} onChange={(event) => props.onRecipe(event.target.value as RecipeId | 'mixed')}>
              {[...Object.keys(content.recipes), 'mixed'].map((recipeId) => (
                <option key={recipeId} value={recipeId}>
                  {t(`recipe.${recipeId}`)}
                </option>
              ))}
            </select>
          </div>
          <Alerts issues={props.issuesFor('recipe')} />
          <div className="inline-rule" style={{ marginTop: 8 }}>
            <label className="rule-label" htmlFor="seed">
              {t('controls.seed')}
            </label>
            <input
              id="seed"
              type="number"
              className="val num"
              value={draft.seed}
              onChange={(event) => props.onSeed(Number(event.target.value))}
            />
          </div>
          <Alerts issues={props.issuesFor('seed')} />
        </div>

        <div className="section">
          <h3 className="subhead">{t('controls.restBetween')}</h3>
          <div className="rule">
            <label className="rule-label" htmlFor="rest-hp">
              {t('controls.restHp')}
            </label>
            <span className="rule-val">
              <output className="val" htmlFor="rest-hp">
                {t('controls.percent', { value: formatNumber(draft.rest.hpStart, language) })}
              </output>
            </span>
            <div className="range range--hp">
              <span className="ticks" />
              <input
                type="range"
                id="rest-hp"
                min={0}
                max={89}
                step={1}
                value={draft.rest.hpStart}
                style={{ ['--p' as string]: draft.rest.hpStart / 100 }}
                onChange={(event) => props.onRest('hpStart', Number(event.target.value))}
              />
            </div>
          </div>
          <div className="rule">
            <label className="rule-label" htmlFor="rest-mp">
              {t('controls.restMp')}
            </label>
            <span className="rule-val">
              <output className="val" htmlFor="rest-mp">
                {t('controls.percent', { value: formatNumber(draft.rest.mpStart, language) })}
              </output>
            </span>
            <div className="range range--mp">
              <span className="ticks" />
              <input
                type="range"
                id="rest-mp"
                min={0}
                max={79}
                step={1}
                value={draft.rest.mpStart}
                style={{ ['--p' as string]: draft.rest.mpStart / 100 }}
                onChange={(event) => props.onRest('mpStart', Number(event.target.value))}
              />
            </div>
          </div>
          <Alerts issues={props.issuesFor('rest')} />
        </div>

        <div className="section">
          <h3 className="subhead">{t('controls.wipeLimit')}</h3>
          <div className="inline-rule">
            <div className="attempts">
              <fieldset className="attempt-pips">
                <legend className="sr-only">{t('controls.wipeLimit')}</legend>
                {WIPE_PIPS.map((limit) => (
                  <label key={limit}>
                    <input
                      type="radio"
                      name="wipe-limit"
                      aria-label={t('controls.wipeLimitOption', { count: limit })}
                      checked={draft.wipeLimit === limit}
                      onChange={() => props.onWipeLimit(limit)}
                    />
                    <span className="pip num">{formatNumber(limit, language)}</span>
                  </label>
                ))}
              </fieldset>
              <span className="rule-label">
                {t('controls.wipeLimitNote', { count: draft.wipeLimit })}
              </span>
            </div>
          </div>
          <Alerts issues={props.issuesFor('wipeLimit')} />
        </div>
      </div>
    </section>
  );
}
