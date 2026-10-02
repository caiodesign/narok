/**
 * The Realm HUD's command bar (`codex-examples/realm-refined/hunt.html:1410-1447`).
 *
 * Three stacked pieces, in the reference's order: the cast bar, the one-line
 * inspection readout and the hotbar of party skillsets. Two things the reference
 * shows are deliberately absent:
 *
 * - a passive *in the content*. Ruling R84: no class carries a passive skill, so
 *   `skillActivity` never yields one and nothing here infers one. The renderer
 *   for the state exists (`SkillSlot`, ruling R173) so that when content does
 *   declare a passive it is drawn as the reference's `.slot--passive` — and
 *   never as a button, because a passive is not a thing a player can inspect
 *   into casting (part 4 §3.1, gate B-09).
 *   Ruling R173: `SkillSlot` draws all six states — the five `skillActivity`
 *   yields, plus passive — and draws a passive as a non-interactive image,
 *   never a button — because gate B-09 requires the six to render distinctly
 *   and a passive never to be a cast affordance, while R84 still forbids
 *   inferring a passive the content does not declare.
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
  type SkillActivity,
} from './model';

/** Every state a hotbar slot can be drawn in: the five `skillActivity` yields, and passive. */
export type SlotState = SkillActivity | 'passive';

export interface SkillSlotProps {
  actor: PublicActor;
  skill: SkillDefinition;
  state: SlotState;
  /** Whole seconds of cooldown left, from `PublicActor.cooldowns`; `null` when not cooling down. */
  remaining: number | null;
  inspected: boolean;
  onInspect: (actorId: string, skillId: string) => void;
}

/**
 * One hotbar slot. A clickable slot *inspects* — it selects the skill so the
 * readout above names why it is waiting — and issues no command of any kind:
 * casting is the strategy's, never the player's (R84, part 4 §3.1 "never cast
 * a skill on click"). A passive is rendered as the reference draws it and is
 * not a button at all.
 */
export function SkillSlot({ actor, skill, state, remaining, inspected, onInspect }: SkillSlotProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const name = t(`skill.${skill.id}`);
  const label = t('inspect.heading', { skill: name, state: t(`skillState.${state}`) });
  const slot = (
    <span className={classNames('slot', slotModifier(state), schoolModifier(actor.definitionId))}>
      <svg aria-hidden="true">
        <use href={`#${skillGlyph(skill.id)}`} />
      </svg>
      {state !== 'passive' && <span className="corner-text num">{formatNumber(skill.mp, language)}</span>}
      {remaining !== null && <span className="cd num">{formatNumber(remaining, language)}</span>}
    </span>
  );

  if (state === 'passive') {
    return (
      <span className="skill skill--passive" role="img" aria-label={label} data-state={state}>
        {slot}
        <span className="skill-name">{name}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className={classNames('skill', state === 'casting' && 'skill--casting', state === 'unavailable' && 'skill--starved')}
      style={SKILL_BUTTON}
      aria-pressed={inspected}
      aria-label={label}
      data-state={state}
      onClick={() => onInspect(actor.id, skill.id)}
    >
      {slot}
      <span className="skill-name">{name}</span>
    </button>
  );
}

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
                      <SkillSlot
                        actor={actor}
                        skill={skill}
                        state={activity}
                        remaining={remaining}
                        inspected={isInspected}
                        onInspect={onInspect}
                      />
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

