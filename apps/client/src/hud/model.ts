/**
 * The Realm HUD's view model.
 *
 * `codex-examples/realm-refined/hunt.html` is the approved design and its CSS is
 * ported verbatim into `styles.css`. This module is the adapter between that
 * markup's vocabulary and milestone A's actual projection: every figure the HUD
 * prints is derived here from `PublicState`, `@narok/data` content, or nothing at
 * all.
 *
 * The rule the mockup cannot state for itself: milestone A publishes twelve
 * fields on `PublicActor` and no loot, wallet, zone, level curve, buff list or
 * threat table. Where the design shows a figure the simulation does not measure,
 * this module returns `null` and the region renders the region's own empty state.
 * Nothing here invents a value to fill a panel.
 */
import { content } from '@narok/data';
import type { SkillDefinition, SkillId } from '@narok/data';
import type { DomainEvent, Metrics, PublicActor, PublicState } from '@narok/sim';
import type { Translate } from '../i18n';

/** The four declared classes; anything else gets no school tint (see `--school`). */
const SCHOOL_MODIFIERS: Record<string, string> = {
  guardian: 'school-guard',
  cleric: 'school-cleric',
  ranger: 'school-ranger',
  arcanist: 'school-arcanist',
};

/**
 * `hunt.html` tints a slot and a medal from one `--school` variable set by a
 * modifier class (`hunt.html:685-687`). Mirror that indirection rather than
 * emitting a colour per element.
 */
export function schoolModifier(definitionId: string): string {
  return SCHOOL_MODIFIERS[definitionId] ?? '';
}

/**
 * The medal's own tint class. The reference tints a class medal with
 * `medal--cleric` / `medal--ranger` (`styles.css:228-229`) and a *skill slot*
 * with `--school` — two separate variables, so `schoolModifier` does not serve
 * the medal. Guardian is the declared default of the medal's gradient and so
 * needs no modifier; the arcanist, which the reference never drew, gets one of
 * its own alongside the new `--school-arcanist`.
 */
const MEDAL_MODIFIERS: Record<string, string> = {
  cleric: 'medal--cleric',
  ranger: 'medal--ranger',
  arcanist: 'medal--arcanist',
};

export function medalModifier(definitionId: string): string {
  return MEDAL_MODIFIERS[definitionId] ?? '';
}

/**
 * The sprite-sheet symbol for an actor's class or family.
 *
 * The reference drew three schools and this build ships four, so the arcanist
 * borrows the sheet's hooded-caster emblem rather than repeating the cleric's
 * and making two classes indistinguishable. It is shared with the reed-slinger,
 * which the party/enemy tinting keeps apart.
 */
const GLYPH_IDS: Record<string, string> = {
  guardian: 'g-guardian',
  cleric: 'g-cleric',
  ranger: 'g-ranger',
  arcanist: 'g-revenant',
};

/** The three monsters milestone A ships, mapped onto the sheet's foe emblems. */
const MONSTER_GLYPH_IDS: Record<string, string> = {
  'briar-boar': 'g-slagjaw',
  mossling: 'g-grub',
  'reed-slinger': 'g-revenant',
};

/** The sheet emblem for a class, for a screen that has a class but no actor yet. */
export function classGlyphId(classId: string): string {
  return GLYPH_IDS[classId] ?? 'g-guardian';
}

export function glyphId(actor: PublicActor): string {
  if (actor.side === 'party') return classGlyphId(actor.definitionId);
  return MONSTER_GLYPH_IDS[actor.definitionId] ?? 'g-grub';
}

export function classNames(...names: readonly (string | false | null | undefined)[]): string {
  return names.filter((name): name is string => typeof name === 'string' && name !== '').join(' ');
}

/** `hunt.html` fills every meter from a `--v` custom property. */
export function meterVar(current: number, max: number): string {
  if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) return '0%';
  const ratio = Math.max(0, Math.min(1, current / max));
  return `${(ratio * 100).toFixed(1)}%`;
}

export function percent(current: number, max: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.round(Math.max(0, Math.min(1, current / max)) * 100);
}

/**
 * The actor's printed name. Milestone A has no per-character name field anywhere
 * in `packages/sim` or `packages/data`, so this is the translated class or
 * monster name — "Guardian", not "Bjorn". The stable id disambiguates three
 * Mosslings and is printed beside the name by the caller, not folded in here.
 */
export function displayName(t: Translate, actor: PublicActor): string {
  const key = actor.side === 'party' ? `class.${actor.definitionId}` : `monster.${actor.definitionId}`;
  return t(key, { defaultValue: actor.definitionId });
}

/**
 * The actor's level. Not projected on `PublicActor`, but statically declared on
 * the class and monster definitions the run was built from, so it is a fact about
 * this actor rather than an invention. Returns `null` for a definition the loaded
 * content does not carry.
 */
export function actorLevel(actor: PublicActor): number | null {
  if (actor.side === 'party') {
    return content.classes[actor.definitionId as keyof typeof content.classes]?.level ?? null;
  }
  return content.monsters[actor.definitionId as keyof typeof content.monsters]?.level ?? null;
}

/** A depleted caster, the reference's `bar--mp-low` state. Presentation only. */
const LOW_MP_RATIO = 0.25;

export function isLowMp(actor: PublicActor): boolean {
  return actor.maxMp > 0 && actor.mp / actor.maxMp < LOW_MP_RATIO;
}

/** The reference blinks a foe below this share of its health (`foe-low`). */
const LOW_HP_RATIO = 0.2;

export function isLowHp(actor: PublicActor): boolean {
  return actor.maxHp > 0 && actor.hp / actor.maxHp < LOW_HP_RATIO;
}

export type SkillActivity = 'casting' | 'active' | 'cooldown' | 'unavailable' | 'ready';

/**
 * Ruling R84: milestone A has no passive skills, so these five states are the
 * complete reachable set, all derived from `PublicActor` alone — the cast in
 * flight, the additive `cooldowns` ready-at stamps (R12/R42) and the actor's MP
 * against the skill's cost.
 *
 * `active` and `casting` are the same projected field split by whether there is a
 * bar worth drawing: nothing here is instantaneous (R87), so a `baseCastMs === 0`
 * skill still occupies a 1 ms cast — real, but too short to render against.
 */
export function skillActivity(actor: PublicActor, skill: SkillDefinition, nowMs: number): SkillActivity {
  if (actor.casting === skill.id) return skill.baseCastMs > 0 ? 'casting' : 'active';
  const readyAt = actor.cooldowns[skill.id] ?? 0;
  if (readyAt > nowMs) return 'cooldown';
  if (actor.mp < skill.mp) return 'unavailable';
  return 'ready';
}

/** `hunt.html`'s slot state modifiers, keyed by the activity above. */
const SLOT_MODIFIERS: Record<SkillActivity, string> = {
  ready: 'slot--ready',
  active: 'slot--active',
  cooldown: 'slot--cooldown',
  casting: 'slot--casting',
  unavailable: 'slot--starved',
};

export function slotModifier(activity: SkillActivity): string {
  return SLOT_MODIFIERS[activity];
}

/** The nine skills, mapped onto the sheet's twelve skill emblems. */
const SKILL_GLYPHS: Record<SkillId, string> = {
  taunt: 's-taunt',
  cleave: 's-cleave',
  heal: 's-heal',
  // Divine damage reads as the sheet's halo rather than its bolt, which the
  // arcanist's fire-bolt has the better claim to.
  smite: 's-blessing',
  revive: 's-groupheal',
  'double-shot': 's-doubleshot',
  'arrow-rain': 's-arrowrain',
  'fire-bolt': 's-smite',
  // A radial burst, not the healing cross `s-groupheal` would have drawn.
  'frost-nova': 's-focus',
};

export function skillGlyph(skillId: string): string {
  return SKILL_GLYPHS[skillId as SkillId] ?? 's-focus';
}

/** Seconds of cooldown left, or `null` when the skill is not cooling down. */
export function cooldownRemaining(actor: PublicActor, skillId: SkillId, nowMs: number): number | null {
  const readyAt = actor.cooldowns[skillId];
  if (readyAt === undefined || readyAt <= nowMs) return null;
  return Math.ceil((readyAt - nowMs) / 1000);
}

/** The skills a party member actually carries, in their declared order. */
export function skillsFor(actor: PublicActor): SkillDefinition[] {
  const declaration = content.classes[actor.definitionId as keyof typeof content.classes];
  if (declaration === undefined) return [];
  return declaration.skills
    .map((id) => content.skills[id as keyof typeof content.skills])
    .filter((skill): skill is SkillDefinition => skill !== undefined);
}

export interface SideActors {
  readonly party: readonly PublicActor[];
  readonly enemies: readonly PublicActor[];
}

export function splitSides(state: PublicState | null): SideActors {
  if (state === null) return { party: [], enemies: [] };
  return {
    party: state.actors.filter((actor) => actor.side === 'party'),
    enemies: state.actors.filter((actor) => actor.side === 'enemy'),
  };
}

/**
 * The foe the target frame should describe: whichever enemy the party is
 * actually pointed at, else the healthiest remaining enemy so the frame is not
 * empty mid-encounter. Returns `null` when there are no enemies at all.
 */
export function focusedEnemy(state: PublicState | null): PublicActor | null {
  const { party, enemies } = splitSides(state);
  if (enemies.length === 0) return null;
  for (const member of party) {
    if (member.currentTarget === null) continue;
    const aimed = enemies.find((enemy) => enemy.id === member.currentTarget);
    if (aimed !== undefined) return aimed;
  }
  return enemies.reduce((best, enemy) => (enemy.hp > best.hp ? enemy : best), enemies[0]);
}

/** The party member whose skillset the command bar is showing. */
export function selectedMember(
  state: PublicState | null,
  selectedId: string | null,
): PublicActor | null {
  const { party } = splitSides(state);
  if (party.length === 0) return null;
  return party.find((actor) => actor.id === selectedId) ?? party[0];
}

/** A party member with a cast bar worth drawing, if any. */
export function castingMember(state: PublicState | null): PublicActor | null {
  const { party } = splitSides(state);
  return (
    party.find((actor) => {
      if (actor.casting === null || actor.casting === 'basic') return false;
      const skill = content.skills[actor.casting as keyof typeof content.skills];
      return skill !== undefined && skill.baseCastMs > 0;
    }) ?? null
  );
}

export interface SessionRates {
  readonly kills: number | null;
  readonly exp: number | null;
  readonly gold: number | null;
  readonly damage: number | null;
}

/**
 * Per-hour rates over the actually simulated window (R63). A zero or absent
 * denominator has no rate, so it reports `null` and the region prints the em
 * dash rather than a fabricated figure. No NaN can reach the DOM.
 */
export function sessionRates(metrics: Metrics | null, elapsedMs: number): SessionRates {
  const rate = (total: number): number | null => {
    if (!Number.isFinite(total) || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
    return (total * 3_600_000) / elapsedMs;
  };
  if (metrics === null) return { kills: null, exp: null, gold: null, damage: null };
  return {
    kills: rate(metrics.kills),
    exp: rate(metrics.rawExp),
    gold: rate(metrics.rawGold),
    damage: rate(metrics.damageDealt),
  };
}

/** Floating combat numbers the battlefield draws, newest first. */
export interface Floater {
  readonly seq: number;
  readonly targetId: string;
  readonly amount: number;
  readonly kind: 'damage' | 'heal';
  readonly critical: boolean;
}

const FLOATER_KINDS = new Set(['damage', 'heal']);

/**
 * How long a blow stays on the board, in simulated milliseconds. It matches the
 * `pop-drift` keyframe's 2.8s so a number leaves the screen exactly once its
 * animation has run. Without a bound the last three blows of a finished run keep
 * rising and fading forever, reading as combat that is still happening.
 */
export const FLOATER_LIFETIME_MS = 2_800;

export function recentFloaters(
  events: readonly DomainEvent[],
  nowMs: number,
  limit = 3,
): Floater[] {
  const floaters: Floater[] = [];
  const oldest = nowMs - FLOATER_LIFETIME_MS;
  for (let index = events.length - 1; index >= 0 && floaters.length < limit; index -= 1) {
    const event = events[index];
    if (!FLOATER_KINDS.has(event.kind)) continue;
    if (event.targetId === null || event.amount === null) continue;
    // Events arrive in ascending `at`, so the first stale one ends the walk.
    if (event.at < oldest) break;
    floaters.push({
      seq: event.seq,
      targetId: event.targetId,
      amount: event.amount,
      kind: event.kind === 'heal' ? 'heal' : 'damage',
      critical: event.reason?.endsWith(':critical') ?? false,
    });
  }
  return floaters;
}
