/**
 * The bounded, translated event log (rulings R61 and R82), in the Realm HUD's
 * vocabulary.
 *
 * Milestone A has no loot, so there are exactly two tabs — Combat and System —
 * and both filter the same bounded history: the cap is 500 rows in total, not 500
 * per tab. Every row is a whole translated sentence built from the event's own
 * fields; nothing is assembled by concatenating English fragments.
 *
 * `codex-examples/realm-refined/hunt.html:1387-1408` is the approved chrome, so
 * the tab strip emits `.tabs`/`.tab` and the rows emit `.log`, with the reference's
 * per-line colour spans (`.ally`, `.foe`, `<b>`, `.line-crit`, `.line-defeat`,
 * `.line-cast`) applied to the slots the sentence already interpolates. The two
 * line types the reference also shows — `.line-drop` and `.line-level` — have no
 * matching `DomainEvent` kind in milestone A, so they are never emitted. The
 * `.chat win` shell around this component is `hud/ChatPanel.tsx`.
 *
 * `PositionId` is never parsed here (only the board renderers may call
 * `gridCoordinates` — see ruling R106), so a cell is reported by its opaque id.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DomainEvent, Phase, PublicActor } from '@narok/sim';
import { actorLabel, formatDuration, formatNumber } from './i18n';

export const EVENT_TABS = ['combat', 'system'] as const;
export type EventTab = (typeof EVENT_TABS)[number];

/** The visible history bound from milestone spec §11. */
export const EVENT_ROW_LIMIT = 500;

/**
 * Ruling R82: every member of `DomainEvent['kind']` belongs to exactly one tab.
 * The `Record<DomainEvent['kind'], EventTab>` annotation is the guard — a kind
 * added to the simulation later fails to compile here instead of being silently
 * retained in history and unreachable in the UI. `move` is a combat action; the
 * System tab is for run lifecycle.
 */
export const EVENT_TAB_BY_KIND: Record<DomainEvent['kind'], EventTab> = {
  move: 'combat',
  cast: 'combat',
  damage: 'combat',
  miss: 'combat',
  heal: 'combat',
  death: 'combat',
  status: 'combat',
  taunt: 'combat',
  phase: 'system',
  spawn: 'system',
  regen: 'system',
  win: 'system',
  wipe: 'system',
  stop: 'system',
};

export function eventsForTab(tab: EventTab, events: readonly DomainEvent[]): DomainEvent[] {
  return events.filter((event) => EVENT_TAB_BY_KIND[event.kind] === tab);
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

const PHASES: readonly Phase[] = ['walking', 'fighting', 'resting', 'respawning', 'stopped'];
const STOP_REASONS = ['wipe-limit', 'stalemate', 'operator'] as const;

/** `reason` on a damage/miss/cast event is `<skillId|basic>[:critical|:fizzle]`. */
function skillLabel(t: Translate, reason: string | null): string {
  const id = (reason ?? 'basic').split(':')[0];
  if (id === 'basic' || id === '') return t('skill.basic');
  return t(`skill.${id}`, { defaultValue: id });
}

function amountLabel(t: Translate, amount: number | null, language: string): string {
  if (amount === null || !Number.isFinite(amount)) return t('value.none');
  return formatNumber(amount, language);
}

/**
 * The sentence key for an event. Split out of `describeEvent` so the same choice
 * drives both the plain string and the decorated row, and still exhaustive over
 * `DomainEvent['kind']`: a new kind is a compile error rather than a blank row.
 */
function eventKey(event: DomainEvent): string {
  switch (event.kind) {
    case 'move':
      return 'event.move';
    case 'cast':
      return event.targetId === null ? 'event.cast.noTarget' : 'event.cast.withTarget';
    case 'damage':
      return event.reason?.endsWith(':critical') === true ? 'event.damage.critical' : 'event.damage.normal';
    case 'miss':
      return event.reason?.endsWith(':fizzle') === true ? 'event.miss.fizzle' : 'event.miss.normal';
    case 'heal':
      return 'event.heal';
    case 'death':
      return 'event.death';
    case 'status':
      return event.reason === 'slow' ? 'event.status.slow' : 'event.status.other';
    case 'taunt':
      return 'event.taunt';
    case 'phase': {
      const phase = PHASES.find((candidate) => candidate === event.reason);
      return phase === undefined ? 'event.phase.other' : `event.phase.${phase}`;
    }
    case 'spawn':
      return 'event.spawn';
    case 'regen':
      return event.reason === 'hp' ? 'event.regen.hp' : event.reason === 'mp' ? 'event.regen.mp' : 'event.regen.other';
    case 'win':
      return 'event.win';
    case 'wipe':
      return 'event.wipe';
    case 'stop': {
      const reason = STOP_REASONS.find((candidate) => candidate === event.reason);
      return reason === undefined ? 'event.stop.other' : `event.stop.${reason}`;
    }
  }
}

/** The only values an event sentence ever interpolates. */
const EVENT_SLOTS = ['actor', 'target', 'amount', 'skill', 'position'] as const;
type EventSlot = (typeof EVENT_SLOTS)[number];
type EventParts = Record<EventSlot, string>;

function eventParts(t: Translate, language: string, event: DomainEvent, actors: readonly PublicActor[]): EventParts {
  return {
    actor: actorLabel(t, event.actorId, actors),
    target: actorLabel(t, event.targetId, actors),
    amount: amountLabel(t, event.amount, language),
    skill: skillLabel(t, event.reason),
    position: event.position ?? '',
  };
}

/**
 * One event, one translated sentence.
 */
export function describeEvent(
  t: Translate,
  language: string,
  event: DomainEvent,
  actors: readonly PublicActor[],
): string {
  return t(eventKey(event), eventParts(t, language, event, actors));
}

/**
 * The reference colours the *parts* of a line, not the line as a whole, so a row
 * has to know where each interpolated value landed in the translated sentence.
 * Rather than parsing English (which would break the moment PT-BR reorders the
 * clause), the sentence is rendered twice: once with sentinels in the slots, which
 * gives the exact split points, and then each slot is replaced by its real value
 * inside the reference's span. The visible text is byte-for-byte `describeEvent`'s.
 */
const SLOT_MARK = '\u0000';
const SLOT_PATTERN = new RegExp(`${SLOT_MARK}(${EVENT_SLOTS.join('|')})${SLOT_MARK}`);
const MARKED_PARTS: EventParts = {
  actor: `${SLOT_MARK}actor${SLOT_MARK}`,
  target: `${SLOT_MARK}target${SLOT_MARK}`,
  amount: `${SLOT_MARK}amount${SLOT_MARK}`,
  skill: `${SLOT_MARK}skill${SLOT_MARK}`,
  position: `${SLOT_MARK}position${SLOT_MARK}`,
};

function isSlot(value: string): value is EventSlot {
  return (EVENT_SLOTS as readonly string[]).includes(value);
}

/** `.ally` / `.foe` come from the projection's own `side`, never from the id's shape. */
function sideClass(id: string | null, actors: readonly PublicActor[]): string {
  if (id === null || id === '') return '';
  const actor = actors.find((candidate) => candidate.id === id);
  if (actor === undefined) return '';
  return actor.side === 'party' ? 'ally' : 'foe';
}

function slotNode(
  slot: EventSlot,
  key: number,
  parts: EventParts,
  event: DomainEvent,
  actors: readonly PublicActor[],
): React.JSX.Element {
  switch (slot) {
    case 'actor':
      return (
        <span key={key} className={sideClass(event.actorId, actors) || undefined}>
          {parts.actor}
        </span>
      );
    case 'target':
      return (
        <span key={key} className={sideClass(event.targetId, actors) || undefined}>
          {parts.target}
        </span>
      );
    case 'amount':
      // `.heal-amt` is the reference's own green amount; every other amount is the
      // plain white `<b>` it uses for damage and threat.
      return (
        <b key={key} className={event.kind === 'heal' ? 'heal-amt' : undefined}>
          {parts.amount}
        </b>
      );
    case 'skill':
      return (
        <span key={key} className="spell">
          {parts.skill}
        </span>
      );
    case 'position':
      return (
        <span key={key} className="num">
          {parts.position}
        </span>
      );
  }
}

function eventNodes(
  t: Translate,
  language: string,
  event: DomainEvent,
  actors: readonly PublicActor[],
): React.ReactNode[] {
  const parts = eventParts(t, language, event, actors);
  const pieces = t(eventKey(event), MARKED_PARTS).split(SLOT_PATTERN);
  return pieces.map((piece, index) =>
    isSlot(piece) && index % 2 === 1 ? slotNode(piece, index, parts, event, actors) : piece,
  );
}

/**
 * The reference's line types, restricted to the ones milestone A can actually
 * produce. `.line-drop` needs a loot event and `.line-level` a level-up event;
 * neither kind exists, so neither class is ever emitted.
 */
function lineModifier(event: DomainEvent): string {
  if (event.kind === 'death') return 'line-defeat';
  if (event.kind === 'cast') return 'line-cast';
  if (event.kind === 'damage' && event.reason?.endsWith(':critical') === true) return 'line-crit';
  return '';
}

/**
 * One row, memoised.
 *
 * A published frame arrives up to sixty times a second and the history holds up
 * to five hundred rows, but a row's rendered output depends only on the event
 * (immutable once appended) and on the roster's ids, sides and definitions —
 * none of which change as hit points fall. Rebuilding every row on every frame
 * meant two `t()` passes, a regex split and two linear roster scans per row, per
 * frame, to produce identical markup; the memo skips all of it for every row but
 * the ones that are genuinely new.
 *
 * `roster` must therefore be identity-stable while the roster is unchanged —
 * `EventLog` holds it steady, since the projection hands out a fresh actor array
 * every frame.
 */
const LogRow = memo(function LogRow({
  event,
  t,
  language,
  roster,
}: {
  event: DomainEvent;
  t: Translate;
  language: string;
  roster: readonly PublicActor[];
}): React.JSX.Element {
  return (
    <li className={lineModifier(event) || undefined}>
      <span className="num">{formatDuration(event.at, t, language)}</span>{' '}
      {eventNodes(t, language, event, roster)}
    </li>
  );
});

export interface EventLogProps {
  events: readonly DomainEvent[];
  /** Current projection, used only to name actors. Absent names fall back to the raw id. */
  actors?: readonly PublicActor[];
}

/**
 * The reference fakes its scrollbar: `.log` is `overflow:hidden` and `.scroll` is a
 * painted thumb. The real log has 500 rows and a tested return-to-latest control
 * (R61), so the rows scroll for real while the painted thumb stays as the visual
 * cue — hence the two inline properties no class in `styles.css` can supply.
 */
const LOG_SCROLL: React.CSSProperties = { overflowY: 'auto', scrollbarWidth: 'none' };

export function EventLog({ events, actors = [] }: EventLogProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const [active, setActive] = useState<EventTab>('combat');
  const scrollRef = useRef<HTMLOListElement>(null);
  const pinnedRef = useRef(true);

  /**
   * The projection publishes a new actor array every frame, but a row only reads
   * each actor's id, side and definition, and those change only when someone
   * joins, dies out of the roster or is replaced. Holding the array steady until
   * one of them does is what makes `LogRow`'s memo able to hit at all.
   */
  const rosterKey = actors.map((actor) => `${actor.id}:${actor.side}:${actor.definitionId}`).join('|');
  const rosterRef = useRef<readonly PublicActor[]>(actors);
  const rosterKeyRef = useRef(rosterKey);
  if (rosterKeyRef.current !== rosterKey) {
    rosterKeyRef.current = rosterKey;
    rosterRef.current = actors;
  }
  const roster = rosterRef.current;

  // One bounded history shared by both tabs (R61): 500 rows in total.
  const bounded = useMemo<readonly DomainEvent[]>(
    () => (events.length > EVENT_ROW_LIMIT ? events.slice(events.length - EVENT_ROW_LIMIT) : events),
    [events],
  );
  const rows = useMemo(() => eventsForTab(active, bounded), [active, bounded]);
  // Same elements by identity when nothing changed, so React skips the subtree
  // rather than re-reconciling five hundred list items.
  const rendered = useMemo(
    () =>
      rows.map((event) => (
        <LogRow key={`${event.encounter}-${event.seq}`} event={event} t={t} language={language} roster={roster} />
      )),
    [rows, t, language, roster],
  );
  // One pass for both tallies; `eventsForTab` per tab would walk the history once
  // per tab and build the filtered arrays only to measure them.
  const counts = useMemo(() => {
    const tally = { combat: 0, system: 0 } as Record<EventTab, number>;
    for (const event of bounded) tally[EVENT_TAB_BY_KIND[event.kind]] += 1;
    return tally;
  }, [bounded]);

  const scrollToLatest = useCallback(() => {
    pinnedRef.current = true;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, []);

  // Follow the newest row only while the reader has not scrolled back (R61).
  // The write below fires `onScroll`, which reads three geometry properties back;
  // skipping a write that would not move anything keeps that forced layout off
  // the frames where the log is already at the bottom.
  useEffect(() => {
    if (!pinnedRef.current) return;
    const element = scrollRef.current;
    if (element === null) return;
    if (element.scrollTop !== element.scrollHeight) element.scrollTop = element.scrollHeight;
  }, [rows.length, active]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  }, []);

  // Roving tabindex across the tab list: only the selected tab is in the page's
  // tab sequence, so the arrow keys must be able to reach the other one.
  const onTabKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const index = EVENT_TABS.indexOf(active);
      let next: EventTab | null = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = EVENT_TABS[(index + 1) % EVENT_TABS.length];
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        next = EVENT_TABS[(index - 1 + EVENT_TABS.length) % EVENT_TABS.length];
      }
      if (event.key === 'Home') next = EVENT_TABS[0];
      if (event.key === 'End') next = EVENT_TABS[EVENT_TABS.length - 1];
      if (next === null) return;
      event.preventDefault();
      setActive(next);
      document.getElementById(`log-tab-${next}`)?.focus();
    },
    [active],
  );

  const latest = bounded.length === 0 ? null : bounded[bounded.length - 1];

  return (
    <>
      {/* Two tabs, never the reference's third: milestone A has no loot to list. */}
      <div className="tabs" role="tablist" aria-label={t('log.tabs')}>
        {EVENT_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            id={`log-tab-${tab}`}
            className="tab"
            aria-selected={tab === active}
            aria-controls={`log-panel-${tab}`}
            tabIndex={tab === active ? 0 : -1}
            onClick={() => setActive(tab)}
            onKeyDown={onTabKeyDown}
          >
            {t(`log.${tab}`)}
            <span className="count num">{formatNumber(counts[tab], language)}</span>
          </button>
        ))}
      </div>

      <div className="log-wrap" role="tabpanel" id={`log-panel-${active}`} aria-labelledby={`log-tab-${active}`}>
        {rows.length === 0 ? (
          <p className="log">{t('log.empty')}</p>
        ) : (
          <ol className="log" aria-label={t('log.rows')} tabIndex={0} ref={scrollRef} onScroll={onScroll} style={LOG_SCROLL}>
            {rendered}
          </ol>
        )}
        <div className="scroll" aria-hidden="true">
          <i />
        </div>
      </div>

      <p className="older">
        {/* Reduced motion suppresses movement, never information: the newest row is
            still appended above and announced here. */}
        <span className="sr-only" role="status">
          {latest === null ? t('log.empty') : describeEvent(t, language, latest, roster)}
        </span>
        <span className="num">{t('log.cap', { limit: formatNumber(EVENT_ROW_LIMIT, language) })}</span>
        <button type="button" className="preset-edit" onClick={scrollToLatest}>
          {t('log.returnToLatest')}
        </button>
      </p>
    </>
  );
}
