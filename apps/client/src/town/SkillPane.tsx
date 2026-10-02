/**
 * The Character screen's skill pane (part 4 §3.4; B-16).
 *
 * The class's skills as content lists them, each with the rank the server
 * holds. A raisable skill stages one rank and Learn sends it as one command;
 * one that cannot be raised names what it is missing (ruling R186: content
 * has no skill prerequisites, so that is town, a skill point, or the rank
 * cap). The footer's next skill point is read from content's own table —
 * one at creation and one every four levels in B, never a divisor here.
 */
import { useTranslation } from 'react-i18next';
import type { Content, SkillId } from '@narok/data';
import type { CharacterSummary } from '../commands';
import { classNames, schoolModifier } from '../hud/model';
import { formatNumber } from '../i18n';
import { nextSkillPointLevel, skillRows } from './model';

const SKILL_GLYPHS: Partial<Record<SkillId, string>> = {
  taunt: 's-taunt',
  cleave: 's-cleave',
  heal: 's-heal',
  smite: 's-smite',
  revive: 's-blessing',
  'double-shot': 's-doubleshot',
  'arrow-rain': 's-arrowrain',
  'fire-bolt': 's-smite',
  'frost-nova': 's-focus',
};

export interface SkillPaneProps {
  readonly character: CharacterSummary;
  readonly content: Content;
  readonly hunting: boolean;
  readonly staged: SkillId | null;
  readonly learning: boolean;
  readonly onStage: (skillId: SkillId | null) => void;
  readonly onLearn: () => void;
}

export function SkillPane({ character, content, hunting, staged, learning, onStage, onLearn }: SkillPaneProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const rows = skillRows(character, content, hunting);
  const next = nextSkillPointLevel(character.level, content.progression);
  const stagedRow = rows.find((row) => row.skillId === staged) ?? null;
  const name = (skillId: SkillId) => t(`skill.${skillId}`);

  return (
    <section className="pane skills" aria-labelledby="skill-title">
      <h2 className="pane-title" id="skill-title">
        {t('character.skills')}{' '}
        <span className="points">
          <span className="pts num">{formatNumber(character.skillPoints ?? 0, i18n.language)}</span>
          {t('character.skillPoints', { count: character.skillPoints ?? 0 })}
        </span>
      </h2>

      <ol className="skill-list">
        {rows.map((row) => {
          const locked = row.missing.length > 0;
          const pips = Array.from({ length: row.maxRank }, (_, index) => index < row.rank);
          return (
            <li className={classNames('skillrow', locked && 'skillrow--locked')} key={row.skillId}>
              <span className={classNames('slot', locked ? 'slot--locked' : 'slot--ready', schoolModifier(character.classId))}>
                <svg aria-hidden="true">
                  <use href={`#${SKILL_GLYPHS[row.skillId] ?? 's-focus'}`} />
                </svg>
              </span>
              <div>
                <p className="skill-top">
                  <span className="skill-title">{name(row.skillId)}</span>
                  <span className="lv-pips" role="img" aria-label={t('character.skill.rank', { rank: row.rank, max: row.maxRank })}>
                    {pips.map((on, index) => (
                      <i key={index} className={on ? 'on' : undefined} />
                    ))}
                  </span>
                </p>
                {locked && (
                  <ul className="reqs" aria-label={t('character.notLearnable')}>
                    {row.missing.map((missing) => (
                      <li key={missing}>
                        <svg aria-hidden="true">
                          <use href="#i-cross" />
                        </svg>
                        {t(`character.skill.missing.${missing}`)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {!locked && (
                <button
                  className="addbtn"
                  type="button"
                  aria-label={t('character.skill.raise', { skill: name(row.skillId), rank: row.rank + 1 })}
                  aria-pressed={staged === row.skillId}
                  onClick={() => onStage(row.skillId)}
                >
                  <i>
                    <svg aria-hidden="true">
                      <use href="#i-plus" />
                    </svg>
                  </i>
                </button>
              )}
            </li>
          );
        })}
      </ol>

      <div className="allocation-preview">
        <p id="skill-message" aria-live="polite">
          {stagedRow === null
            ? t('character.skillChoose')
            : t('character.skillPreview', { skill: name(stagedRow.skillId), from: stagedRow.rank, to: stagedRow.rank + 1 })}
        </p>
        <div className="allocation-actions">
          <button type="button" disabled={stagedRow === null || stagedRow.missing.length > 0 || learning} aria-busy={learning} onClick={onLearn}>
            {learning ? t('character.learning') : t('character.learn')}
          </button>
          <button type="button" disabled={stagedRow === null || learning} onClick={() => onStage(null)}>
            {t('character.cancel')}
          </button>
        </div>
      </div>
      <p className="skills-foot">{next === null ? t('character.noNextSkillPoint') : t('character.nextSkillPoint', { level: next })}</p>
    </section>
  );
}
