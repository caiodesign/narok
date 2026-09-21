/**
 * The Realm HUD's command bar (`codex-examples/realm-refined/hunt.html:1410-1447`).
 *
 * Three stacked pieces, in the reference's order: the cast bar, the one-line
 * inspection readout and the hotbar of party skillsets. Two things the reference
 * shows are deliberately absent:
 *
 * - the `.slot--passive` state. Ruling R84: milestone A has no passive skills, so
 *   the state is unreachable and rendering it would invent a skill kind.
 * - the `.expline` XP strip below the bar. There is no levelling mechanic and no
 *   experience curve to fill it from.
 *
 * Every figure below is read from `PublicActor` or from the bound content's skill
 * definitions; nothing is estimated.
 */
import { useTranslation } from 'react-i18next';
import { content } from '@narok/data';
import type { SkillDefinition } from '@narok/data';
import type { PublicActor, PublicState } from '@narok/sim';
import { formatDuration, formatNumber } from '../i18n';
import {
  castingMember,
  classNames,
  cooldownRemaining,
  displayName,
  glyphId,
  schoolModifier,
  selectedMember,
  skillActivity,
  skillGlyph,
  skillsFor,
  slotModifier,
  splitSides,
} from './model';

export interface CommandBarProps {
  state: PublicState | null;
  selectedId: string | null;
  inspected: { actorId: string; skillId: string } | null;
  onInspect: (actorId: string, skillId: string) => void;
}

/** A skill definition by id, or `null` for an id the bound content does not carry. */
function skillById(id: string | null): SkillDefinition | null {
  if (id === null) return null;
  const table: Record<string, SkillDefinition> = content.skills;
  return table[id] ?? null;
}

/**
 * The reference makes `.skill` itself the interactive element. A list needs its
 * `<li>`, so the button carries the class and fills the 55px grid cell the `<li>`
 * occupies; this is layout the stylesheet cannot express for a nested button.
 */
const SKILL_BUTTON: React.CSSProperties = { width: '100%' };

export function CommandBar(props: CommandBarProps): React.JSX.Element {
  const { state, selectedId, inspected, onInspect } = props;
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const nowMs = state?.nowMs ?? 0;

  const { party } = splitSides(state);
  const selected = selectedMember(state, selectedId);

  const caster = castingMember(state);
  const castSkill = skillById(caster?.casting ?? null);

  const inspectedActor =
    inspected === null ? null : (state?.actors.find((actor) => actor.id === inspected.actorId) ?? null);
  const inspectedSkill = inspected === null ? null : skillById(inspected.skillId);

  /** The per-state sentence for the inspected skill, from its measured state alone. */
  function inspectionDetail(actor: PublicActor, skill: SkillDefinition): string {
    const activity = skillActivity(actor, skill, nowMs);
    switch (activity) {
      case 'cooldown':
        return t('inspect.cooldown', {
          remaining: formatDuration(Math.max(0, (actor.cooldowns[skill.id] ?? 0) - nowMs), t, language),
        });
      case 'unavailable':
        return t('inspect.unavailable', {
          cost: formatNumber(skill.mp, language),
          mp: formatNumber(actor.mp, language),
          actor: displayName(t, actor),
        });
      case 'casting':
        return t('inspect.casting');
      case 'active':
        return t('inspect.active');
      case 'ready':
        return t('inspect.ready');
    }
  }

  return (
    <section className="command" aria-label={t('app.skills')}>
      {/*
       * No progress fill and no "1.2 / 2.0s" readout: `PublicActor.casting`
       * projects the skill id only. `startedAt` and `completesAt` live on the
       * simulation-internal `PendingCast` and are not published, so there is
       * nothing to measure the bar against and faking it would be an invention.
       * The bar names the caster and the skill, which are facts, and carries
       * `role="status"` rather than the reference's `role="progressbar"` — a
       * progressbar without a value would lie to assistive technology.
       */}
      {caster !== null && castSkill !== null && (
        <div
          className="castbar"
          role="status"
          aria-label={t('castbar.label', {
            actor: displayName(t, caster),
            skill: t(`skill.${castSkill.id}`),
          })}
        >
          <div className="castbar-track">
            <div className="castbar-text">
              <span>
                {t('castbar.text', { actor: displayName(t, caster), skill: t(`skill.${castSkill.id}`) })}
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="auto-inspection" role="status">
        {inspectedActor === null || inspectedSkill === null ? (
          t('inspect.hint')
        ) : (
          <>
            {t('inspect.heading', {
              skill: t(`skill.${inspectedSkill.id}`),
              state: t(`skillState.${skillActivity(inspectedActor, inspectedSkill, nowMs)}`),
            })}
            {' · '}
            {inspectionDetail(inspectedActor, inspectedSkill)}
            {' · '}
            <span className="num">{t('inspect.cost', { cost: formatNumber(inspectedSkill.mp, language) })}</span>
            <a href={`#rule-${inspectedActor.id}-${inspectedSkill.id}`}>
              {t('inspect.editRule', { skill: t(`skill.${inspectedSkill.id}`) })}
            </a>
          </>
        )}
      </div>

      <div className="hotbar win">
        {party.length === 0 ? (
          <p className="skillset-owner">{t('unit.empty')}</p>
        ) : (
          party.map((actor) => (
            <div
              key={actor.id}
              className={classNames('skillset', selected?.id === actor.id && 'is-selected')}
              aria-label={t('hotbar.owner', { actor: displayName(t, actor) })}
            >
              <p className="skillset-owner">
                <svg aria-hidden="true">
                  <use href={`#${glyphId(actor)}`} />
                </svg>
                {displayName(t, actor)}
                {/* The reference's key hint. Nothing here is hand-cast (R84), so the
                    slot advertises the automation instead of a keyboard binding. */}
                <span className="keys">{t('hotbar.auto')}</span>
              </p>
              <ol className="slots">
                {skillsFor(actor).map((skill) => {
                  const activity = skillActivity(actor, skill, nowMs);
                  const remaining = cooldownRemaining(actor, skill.id, nowMs);
                  const isInspected = inspected?.actorId === actor.id && inspected.skillId === skill.id;
                  return (
                    <li key={skill.id}>
                      <button
                        type="button"
                        className={classNames(
                          'skill',
                          activity === 'casting' && 'skill--casting',
                          activity === 'unavailable' && 'skill--starved',
                        )}
                        style={SKILL_BUTTON}
                        aria-pressed={isInspected}
                        aria-label={t('inspect.heading', {
                          skill: t(`skill.${skill.id}`),
                          state: t(`skillState.${activity}`),
                        })}
                        onClick={() => onInspect(actor.id, skill.id)}
                      >
                        <span className={classNames('slot', slotModifier(activity), schoolModifier(actor.definitionId))}>
                          <svg aria-hidden="true">
                            <use href={`#${skillGlyph(skill.id)}`} />
                          </svg>
                          <span className="corner-text num">{formatNumber(skill.mp, language)}</span>
                          {remaining !== null && <span className="cd num">{formatNumber(remaining, language)}</span>}
                        </span>
                        <span className="skill-name">{t(`skill.${skill.id}`)}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

