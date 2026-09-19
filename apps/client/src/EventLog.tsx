/**
 * The bounded, translated event log (rulings R61 and R82).
 *
 * Milestone A has no loot, so there are exactly two tabs — Combat and System —
 * and both filter the same bounded history: the cap is 500 rows in total, not 500
 * per tab. Every row is a whole translated sentence built from the event's own
 * fields; nothing is assembled by concatenating English fragments.
 *
 * `PositionId` is never parsed here (only `BattlefieldView` may call
 * `gridCoordinates`), so a cell is reported by its opaque id.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
 * One event, one translated sentence. The switch is exhaustive over
 * `DomainEvent['kind']`, so a new kind is a compile error rather than a blank row.
 */
export function describeEvent(
  t: Translate,
  language: string,
  event: DomainEvent,
  actors: readonly PublicActor[],
): string {
  const actor = actorLabel(t, event.actorId, actors);
  const target = actorLabel(t, event.targetId, actors);
  const amount = amountLabel(t, event.amount, language);
  const position = event.position ?? '';

  switch (event.kind) {
    case 'move':
      return t('event.move', { actor, position });
    case 'cast':
      return event.targetId === null
        ? t('event.cast.noTarget', { actor, skill: skillLabel(t, event.reason) })
        : t('event.cast.withTarget', { actor, target, skill: skillLabel(t, event.reason) });
    case 'damage':
      return t(event.reason?.endsWith(':critical') === true ? 'event.damage.critical' : 'event.damage.normal', {
        actor,
        target,
        amount,
        skill: skillLabel(t, event.reason),
      });
    case 'miss':
      return t(event.reason?.endsWith(':fizzle') === true ? 'event.miss.fizzle' : 'event.miss.normal', {
        actor,
        target,
        skill: skillLabel(t, event.reason),
      });
    case 'heal':
      return t('event.heal', { actor, target, amount, skill: skillLabel(t, event.reason) });
    case 'death':
      return t('event.death', { actor, target });
    case 'status':
      return t(event.reason === 'slow' ? 'event.status.slow' : 'event.status.other', { actor, target });
    case 'taunt':
      return t('event.taunt', { actor, target, amount });
    case 'phase': {
      const phase = PHASES.find((candidate) => candidate === event.reason);
      return phase === undefined ? t('event.phase.other') : t(`event.phase.${phase}`);
    }
    case 'spawn':
      return t('event.spawn', { actor, position });
    case 'regen':
      return t(event.reason === 'hp' ? 'event.regen.hp' : event.reason === 'mp' ? 'event.regen.mp' : 'event.regen.other', {
        actor,
        amount,
      });
    case 'win':
      return t('event.win');
    case 'wipe':
      return t('event.wipe');
    case 'stop': {
      const reason = STOP_REASONS.find((candidate) => candidate === event.reason);
      return reason === undefined ? t('event.stop.other') : t(`event.stop.${reason}`);
    }
  }
}

export interface EventLogProps {
  events: readonly DomainEvent[];
  /** Current projection, used only to name actors. Absent names fall back to the raw id. */
  actors?: readonly PublicActor[];
}

export function EventLog({ events, actors = [] }: EventLogProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const [active, setActive] = useState<EventTab>('combat');
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // One bounded history shared by both tabs (R61): 500 rows in total.
  const bounded = useMemo(
    () => (events.length > EVENT_ROW_LIMIT ? events.slice(events.length - EVENT_ROW_LIMIT) : [...events]),
    [events],
  );
  const rows = useMemo(() => eventsForTab(active, bounded), [active, bounded]);
  const counts = useMemo(
    () => Object.fromEntries(EVENT_TABS.map((tab) => [tab, eventsForTab(tab, bounded).length])) as Record<EventTab, number>,
    [bounded],
  );

  const scrollToLatest = useCallback(() => {
    pinnedRef.current = true;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, []);

  // Follow the newest row only while the reader has not scrolled back (R61).
  useEffect(() => {
    if (!pinnedRef.current) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
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
    <section className="win panel log-panel" aria-label={t('app.log')}>
      <h2 className="win-title">{t('app.log')}</h2>
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

      <div
        className="log-scroll"
        role="tabpanel"
        id={`log-panel-${active}`}
        aria-labelledby={`log-tab-${active}`}
        tabIndex={0}
        ref={scrollRef}
        onScroll={onScroll}
      >
        {rows.length === 0 ? (
          <p className="log-empty">{t('log.empty')}</p>
        ) : (
          <ul className="log-rows" aria-label={t('log.rows')}>
            {rows.map((event) => (
              <li key={`${event.encounter}-${event.seq}`} className={`log-row log-row--${event.kind}`}>
                <span className="log-time num">{formatDuration(event.at, t, language)}</span>
                <span className="log-text">{describeEvent(t, language, event, actors)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="log-foot">
        {/* Reduced motion suppresses movement, never information: the newest row is
            still appended above and announced here. */}
        <p className="sr-only" role="status">
          {latest === null ? t('log.empty') : describeEvent(t, language, latest, actors)}
        </p>
        <button type="button" className="ghost-button" onClick={scrollToLatest}>
          {t('log.returnToLatest')}
        </button>
        <span className="log-cap">{t('log.cap', { limit: formatNumber(EVENT_ROW_LIMIT, language) })}</span>
      </div>
    </section>
  );
}
