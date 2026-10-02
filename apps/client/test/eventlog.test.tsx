// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { DomainEvent, PositionId, PublicActor } from '@narok/sim';
import { gridPosition } from '@narok/sim';
import { EventLog, EVENT_ROW_LIMIT, EVENT_TAB_BY_KIND, EVENT_TABS, eventsForTab, type EventTab } from '../src/EventLog';
import { resources } from '../src/i18n';

afterEach(() => {
  cleanup();
});

function event(kind: DomainEvent['kind'], overrides: Partial<DomainEvent> = {}): DomainEvent {
  const base: DomainEvent = {
    seq: 0,
    at: 1_000,
    encounter: 1,
    kind,
    actorId: 'p0',
    targetId: 'e0',
    amount: 12,
    reason: null,
    position: gridPosition(2, 3) as PositionId,
    ...overrides,
  };
  return base;
}

const ACTORS: PublicActor[] = [
  {
    id: 'p0',
    definitionId: 'guardian',
    side: 'party',
    position: gridPosition(2, 3),
    hp: 100,
    mp: 30,
    maxHp: 250,
    maxMp: 60,
    currentTarget: 'e0',
    casting: null,
    targetReason: 'priority',
    cooldowns: {},
  },
  {
    id: 'e0',
    definitionId: 'briar-boar',
    side: 'enemy',
    position: gridPosition(2, 1),
    hp: 180,
    mp: 0,
    maxHp: 180,
    maxMp: 0,
    currentTarget: 'p0',
    casting: null,
    targetReason: 'threat',
    cooldowns: {},
  },
];

/**
 * Exhaustive over `DomainEvent['kind']` by construction: `EVENT_TAB_BY_KIND` is
 * typed `Record<DomainEvent['kind'], EventTab>`, so a kind added to the sim makes
 * this file fail to compile instead of quietly vanishing from the log (R82).
 */
const ALL_KINDS = Object.keys(EVENT_TAB_BY_KIND) as DomainEvent['kind'][];

describe('event tabs', () => {
  test('R82: every DomainEvent kind resolves to exactly one of the three tabs', () => {
    const exhaustive: Record<DomainEvent['kind'], EventTab> = EVENT_TAB_BY_KIND;
    expect(EVENT_TABS).toEqual(['combat', 'loot', 'system']);
    expect(new Set(ALL_KINDS).size).toBe(ALL_KINDS.length);

    for (const kind of ALL_KINDS) {
      const tab = exhaustive[kind];
      expect(EVENT_TABS).toContain(tab);
      const others = EVENT_TABS.filter((candidate) => candidate !== tab);
      expect(eventsForTab(tab, [event(kind)])).toHaveLength(1);
      for (const other of others) {
        expect(eventsForTab(other, [event(kind)])).toHaveLength(0);
      }
    }
  });

  test('R82: `move` is a combat event, not an unreachable one', () => {
    expect(EVENT_TAB_BY_KIND.move).toBe('combat');
  });

  test('the Loot tab is bound to the published loot event, and lists nothing else (part 4 §3.1, R108)', () => {
    expect(EVENT_TAB_BY_KIND['drop-lost']).toBe('loot');
    const lootKinds = ALL_KINDS.filter((kind) => EVENT_TAB_BY_KIND[kind] === 'loot');
    expect(lootKinds).toEqual(['drop-lost']);

    render(<EventLog events={[event('drop-lost', { amount: 4, reason: 'iron-sword' }), event('win')]} actors={ACTORS} />);
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    const loot = screen.getByRole('tab', { name: /loot/i });
    expect(loot.textContent).toContain('1');
    fireEvent.click(loot);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain(resources.en.translation.event.dropLost);
    expect(rows[0]!.className).toContain('line-drop');
  });
});

describe('EventLog', () => {
  test('bounds the visible history to the last 500 rows across both tabs', () => {
    const events = Array.from({ length: 700 }, (_, index) =>
      event(index % 2 === 0 ? 'damage' : 'regen', { seq: index, at: index * 10, reason: index % 2 === 0 ? 'basic' : 'hp' }),
    );
    render(<EventLog events={events} actors={ACTORS} />);

    const combatRows = within(screen.getByRole('tabpanel')).getAllByRole('listitem');
    fireEvent.click(screen.getByRole('tab', { name: /system/i }));
    const systemRows = within(screen.getByRole('tabpanel')).getAllByRole('listitem');

    expect(EVENT_ROW_LIMIT).toBe(500);
    // 500 total, not 500 per tab.
    expect(combatRows.length + systemRows.length).toBe(500);
    expect(combatRows.length).toBeLessThan(500);
  });

  test('keeps only the newest rows when the history overflows', () => {
    const events = Array.from({ length: 700 }, (_, index) => event('damage', { seq: index, amount: index, reason: 'basic' }));
    render(<EventLog events={events} actors={ACTORS} />);
    const rows = within(screen.getByRole('tabpanel')).getAllByRole('listitem');
    expect(rows).toHaveLength(500);
    expect(rows[rows.length - 1].textContent).toContain('699');
    expect(rows[0].textContent).toContain('200');
  });

  test('every kind renders a translated sentence, never a raw key or concatenated fragment', () => {
    for (const kind of ALL_KINDS) {
      const reason =
        kind === 'phase' ? 'fighting' : kind === 'stop' ? 'operator' : kind === 'regen' ? 'hp' : kind === 'status' ? 'slow' : 'cleave';
      render(<EventLog events={[event(kind, { reason })]} actors={ACTORS} />);
      // Open the tab this kind belongs to, so every kind is genuinely reachable.
      fireEvent.click(screen.getAllByRole('tab')[EVENT_TABS.indexOf(EVENT_TAB_BY_KIND[kind])]);
      const rows = within(screen.getByRole('tabpanel')).getAllByRole('listitem');
      expect(rows, `kind ${kind}`).toHaveLength(1);
      const text = rows[0].textContent ?? '';
      expect(text, `kind ${kind}`).not.toMatch(/event\./);
      expect(text.replace(/\s+/g, ' ').trim().length, `kind ${kind}`).toBeGreaterThan(0);
      cleanup();
    }
  });

  test('the tab list keeps a single roving tabindex and the other tab stays arrow-reachable', () => {
    render(<EventLog events={[event('damage', { reason: 'basic' })]} actors={ACTORS} />);
    const tabs = screen.getAllByRole('tab') as HTMLButtonElement[];
    expect(tabs.filter((tab) => tab.tabIndex === 0)).toHaveLength(1);

    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(screen.getAllByRole('tab')[1].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getAllByRole('tab')[1]);
    expect((screen.getAllByRole('tab') as HTMLButtonElement[]).filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
  });

  test('offers a visible, keyboard-reachable return-to-latest control', () => {
    render(<EventLog events={[event('damage', { reason: 'basic' })]} actors={ACTORS} />);
    const button = screen.getByRole('button', { name: /return to latest/i });
    expect(button).toBeVisible();
    expect(button.tabIndex).toBeGreaterThanOrEqual(0);
  });

  test('names actors from the projection, falling back to the raw id when unknown', () => {
    render(<EventLog events={[event('damage', { actorId: 'p0', targetId: 'e9', reason: 'cleave' })]} actors={ACTORS} />);
    const row = within(screen.getByRole('tabpanel')).getAllByRole('listitem')[0];
    expect(row.textContent).toContain('Guardian');
    expect(row.textContent).toContain('e9');
  });
});
