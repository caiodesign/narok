// @vitest-environment jsdom
/**
 * The Away report (milestone B Task 10; part 4 §3.5; UI spec §8; B-17).
 *
 * The screen is a read of already-settled progress: time away and simulated
 * time are separate; the three counts — wipes this hunt, wipes this absence
 * and individual member deaths — are the report's own and shown separately
 * (report version 3, Task 10 fix round 1), with each member's outcome, the
 * notable loot and the bounded timeline; a version-2 report shows none of
 * what it never carried (ruling R194); the four states render their copy and
 * actions, a cap as a cap and never a combat failure; reopening and
 * refreshing credit nothing; and after Manage bag the action state is
 * recomputed from current inventory.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { content } from '@narok/data';
import { App } from '../src/App';
import { decodeAwayReport, type AwayReportRecord, type InventoryResponse } from '../src/commands';
import i18n, { formatDuration } from '../src/i18n';
import en from '../src/locales/en.json';
import { AwayReport } from '../src/town/AwayReport';
import { fakeApi, huntHarness, huntResponse, SUSTAIN } from './hunt-fakes';
import { bag, BJORN, item, KAIO, LOOT, PARTY, SIGRUN } from './town-fixtures';

afterEach(() => {
  cleanup();
});

const REPORT_ID = '40000000-0000-4000-8000-000000000001';

const HOUR = 3_600_000;

const RUNNING: AwayReportRecord = {
  reportVersion: 3,
  huntId: '20000000-0000-4000-8000-000000000001',
  generation: 3,
  status: 'running',
  stopReason: null,
  copyKey: 'away.running',
  actions: ['view-hunt'],
  awayFromWall: 1_000,
  returnedAtWall: 1_000 + 3 * 3_600_000,
  timeAwayMs: 3 * 3_600_000,
  simulatedMs: 2 * 3_600_000 + 30 * 60_000,
  accrualEndedAtWall: 1_000 + 2 * 3_600_000,
  capCutoffWall: 1_000 + 12 * 3_600_000,
  uncovered: { afterStopMs: 0, afterCapMs: 0 },
  outcomes: {
    kills: 41,
    wins: 9,
    wipes: 1,
    rawExp: 900,
    rawGold: 77,
    drops: { rolled: 12, kept: 4, autoSold: 5, ignored: 1, lost: 2 },
    consumed: { 'small-hp-potion': 6 },
  },
  wipesThisHunt: 3,
  rewardsCredited: 11,
  mapId: 'prototype',
  party: [
    { characterId: BJORN, classId: 'guardian', levelBefore: 4, levelAfter: 4, expBefore: 10, expAfter: 70, deaths: 2, revives: 1 },
    { characterId: SIGRUN, classId: 'cleric', levelBefore: 4, levelAfter: 5, expBefore: 90, expAfter: 3, deaths: 1, revives: 0 },
    { characterId: KAIO, classId: 'ranger', levelBefore: 5, levelAfter: 5, expBefore: 0, expAfter: 40, deaths: 2, revives: 0 },
  ],
  memberDeaths: 5,
  notable: [
    { rewardId: 'h:4', definitionId: 'ranger-bow', rarity: 'epic', itemLevel: 9, bonusCount: 3, atWallMs: 1_000 + HOUR },
    { rewardId: 'h:2', definitionId: 'leather-cap', rarity: 'uncommon', itemLevel: 4, bonusCount: 1, atWallMs: 1_000 + 30 * 60_000 },
  ],
  notableTotal: 4,
  timeline: [
    { kind: 'won', atWallMs: 1_000 + 60_000, characterId: null, count: 6, reason: null },
    { kind: 'death', atWallMs: 1_000 + HOUR, characterId: SIGRUN, count: 1, reason: null },
    { kind: 'revive', atWallMs: 1_000 + HOUR + 60_000, characterId: SIGRUN, count: 1, reason: 'idun-apple' },
    { kind: 'drop-lost', atWallMs: 1_000 + 2 * HOUR, characterId: null, count: 2, reason: null },
  ],
  timelineOmitted: 3,
};

/** What a version-2 row in the database decodes to: none of version 3's fields (R194). */
const VERSION_2 = decodeAwayReport({
  reportVersion: 2,
  huntId: RUNNING.huntId,
  generation: RUNNING.generation,
  status: RUNNING.status,
  stopReason: RUNNING.stopReason,
  copyKey: RUNNING.copyKey,
  actions: RUNNING.actions,
  awayFromWall: RUNNING.awayFromWall,
  returnedAtWall: RUNNING.returnedAtWall,
  timeAwayMs: RUNNING.timeAwayMs,
  simulatedMs: RUNNING.simulatedMs,
  accrualEndedAtWall: RUNNING.accrualEndedAtWall,
  capCutoffWall: RUNNING.capCutoffWall,
  uncovered: RUNNING.uncovered,
  outcomes: RUNNING.outcomes,
  wipesThisHunt: RUNNING.wipesThisHunt,
  rewardsCredited: RUNNING.rewardsCredited,
});

function mount(report: AwayReportRecord, inventory: InventoryResponse = bag([])) {
  const actions = { onManageBag: vi.fn(), onReturnToHunt: vi.fn(), onStartHunt: vi.fn(), onReviewFilter: vi.fn() };
  const props = { report, content, characters: PARTY, lootPresetName: LOOT[0]!.name, ...actions };
  const view = render(<AwayReport {...props} inventory={inventory} />);
  return { ...view, actions, rerenderWith: (next: InventoryResponse) => view.rerender(<AwayReport {...props} inventory={next} />) };
}

const actionsBar = () => document.querySelector('.actions') as HTMLElement;

describe('B-17: the report reads settled progress', () => {
  test('time away and the simulated duration are two separate facts, against the server’s cap', () => {
    mount(RUNNING);
    const away = document.querySelector('.fact--away') as HTMLElement;
    expect(away).toHaveTextContent(i18n.t('duration.hoursMinutes', { hours: 3, minutes: 0 }));
    const cap = document.querySelector('.fact.cap') as HTMLElement;
    expect(cap).toHaveTextContent(i18n.t('duration.hoursMinutes', { hours: 2, minutes: 30 }));
    expect(cap).toHaveTextContent(i18n.t('duration.hoursMinutes', { hours: 12, minutes: 0 }));
    expect(document.body.textContent).not.toMatch(/premium/i);
  });

  test('the three counts are separate: wipes this hunt, wipes this absence, member deaths over the absence', () => {
    mount(RUNNING);
    const attempts = document.querySelector('.attempts') as HTMLElement;
    const lines = [...attempts.children].map((node) => node.textContent);
    expect(lines).toEqual([
      i18n.t('away.wipes.thisHunt', { count: 3 }),
      i18n.t('away.wipes.thisAbsence', { count: 1 }),
      i18n.t('away.wipes.memberDeaths', { count: 5 }),
    ]);
    expect(new Set(lines).size).toBe(3);
    expect(document.querySelector('.pips')).toBeNull();
  });

  test('party outcomes: encounters won and lost, and each member’s level, EXP, deaths and revives', () => {
    mount(RUNNING);
    const party = document.querySelector('.party-results') as HTMLElement;
    expect(document.getElementById('party-title')).toHaveTextContent(i18n.t('away.party.outcomes', { won: 9, lost: 1 }));
    const units = party.querySelectorAll('.result');
    expect(units).toHaveLength(3);
    expect(within(units[0] as HTMLElement).getByText('Bjorn')).toBeInTheDocument();
    expect(units[0]).toHaveTextContent(i18n.t('away.party.level', { level: 4 }));
    expect(units[0]).toHaveTextContent(i18n.t('away.party.exp', { from: 10, to: 70 }));
    expect((units[0] as HTMLElement).querySelector('.deaths dd')).toHaveTextContent('2');
    expect((units[0] as HTMLElement).querySelector('.revives dd')).toHaveTextContent('1');
    // A level gained is flagged with both levels.
    expect(units[1]).toHaveClass('result--up');
    expect(units[1]!.querySelector('.lvl-change')).toHaveTextContent(/4.*5/);
    expect(units[0]).not.toHaveClass('result--up');
  });

  test('notable loot: the report’s kept equipment in its order, and how many more were kept', () => {
    mount(RUNNING);
    const notable = document.querySelector('.notable') as HTMLElement;
    const rows = notable.querySelectorAll('.drop');
    expect([...rows].map((row) => row.querySelector('.drop-name')!.textContent)).toEqual([
      i18n.t('item.ranger-bow'),
      i18n.t('item.leather-cap'),
    ]);
    expect(rows[0]).toHaveClass('drop--epic');
    expect(rows[0]!.querySelector('.drop-age')).toHaveTextContent(formatDuration(HOUR, i18n.t, 'en'));
    expect(document.querySelector('.loot-pane')).toHaveTextContent(i18n.t('away.notable.more', { count: 2 }));
    // The recovery action is outside the scrolling body: no find can cover it.
    expect(actionsBar().closest('.report-body')).toBeNull();
  });

  test('the timeline: the report’s entries in order on the absence’s track, the return last, and what was let go', () => {
    mount(RUNNING);
    const chronicle = document.querySelector('.chronicle') as HTMLElement;
    const marks = [...chronicle.querySelectorAll('ol > li.mark')];
    expect(marks).toHaveLength(RUNNING.timeline!.length + 1);
    const span = (ms: number) => formatDuration(ms, i18n.t, 'en');
    expect(marks.map((mark) => mark.querySelector('.mark-label')!.textContent)).toEqual([
      span(60_000) + i18n.t('away.timeline.won', { count: 6 }),
      span(HOUR) + i18n.t('away.timeline.death', { name: 'Sigrun' }),
      span(HOUR + 60_000) + i18n.t('away.timeline.apple', { name: 'Sigrun', item: i18n.t('consumable.idun-apple') }),
      span(2 * HOUR) + i18n.t('away.timeline.dropLost', { count: 2 }),
      span(3 * HOUR) + en.away.timeline.returned,
    ]);
    const at = (mark: Element) => (mark as HTMLElement).style.getPropertyValue('--at');
    expect(at(marks[0]!)).toBe(`${(60_000 / (3 * HOUR)) * 100}%`);
    expect(at(marks.at(-1)!)).toBe('100%');
    expect(chronicle).toHaveTextContent(i18n.t('away.timeline.omitted', { count: 3 }));
  });

  test('the map is the report’s own', () => {
    mount({ ...RUNNING, mapId: 'prototype' });
    expect(document.querySelector('.fact--map')).toHaveTextContent(i18n.t('map.prototype'));
    cleanup();
    mount({ ...RUNNING, mapId: null });
    expect(document.querySelector('.fact--map')).toBeNull();
  });

  test('a version-2 report shows none of what it never carried (R194)', () => {
    expect(VERSION_2).toMatchObject({
      mapId: null,
      party: null,
      memberDeaths: null,
      notable: null,
      notableTotal: null,
      timeline: null,
      timelineOmitted: null,
    });
    mount(VERSION_2);
    const attempts = document.querySelector('.attempts') as HTMLElement;
    expect(attempts.children).toHaveLength(2);
    expect(document.querySelector('.party-results')).toBeNull();
    expect(document.querySelector('.notable')).toBeNull();
    expect(document.querySelector('.chronicle')).toBeNull();
    expect(document.querySelector('.fact--map')).toBeNull();
  });

  test('outcomes and drops are the report’s counts; lost drops are said to be lost', () => {
    mount(RUNNING);
    const totals = document.querySelector('.totals') as HTMLElement;
    expect(totals).toHaveTextContent('41');
    expect(totals).toHaveTextContent('900');
    expect(totals).toHaveTextContent('77');
    const loot = document.querySelector('.loot-pane') as HTMLElement;
    expect(loot).toHaveTextContent(i18n.t('away.loot.lost', { count: 2 }));
    expect(loot).toHaveTextContent(i18n.t('away.loot.autoSold', { count: 5 }));
  });

  test('running: the copy and one action, Return to hunt', () => {
    mount(RUNNING);
    expect(screen.getByText(en.away.running)).toBeInTheDocument();
    expect(within(actionsBar()).getAllByRole('button').map((button) => button.textContent)).toEqual([
      expect.stringContaining(en.away.action['view-hunt']),
      expect.stringContaining(LOOT[0]!.name),
    ]);
    expect(within(actionsBar()).queryByText(/collect|resume/i)).toBeNull();
  });

  test('capped: a cap, never a failure', () => {
    mount({ ...RUNNING, status: 'capped', copyKey: 'away.capped' });
    expect(screen.getByText(en.away.capped)).toBeInTheDocument();
    expect(document.querySelector('.verdict')).not.toHaveClass('verdict--failure');
    expect(within(actionsBar()).getByRole('button', { name: new RegExp(en.away.action['view-hunt']) })).toBeInTheDocument();
  });

  test('stopped: the actual reason and the restart the hunt now needs', () => {
    const view = mount({ ...RUNNING, status: 'stopped', stopReason: 'wipe', copyKey: 'away.stopped.wipe', actions: ['start-hunt'] });
    expect(screen.getByText(en.away.stopped.wipe)).toBeInTheDocument();
    expect(document.querySelector('.verdict')).toHaveClass('verdict--failure');
    expect(within(actionsBar()).queryByRole('button', { name: new RegExp(en.away.action['view-hunt']) })).toBeNull();
    fireEvent.click(within(actionsBar()).getByRole('button', { name: new RegExp(en.away.action['start-hunt']) }));
    expect(view.actions.onStartHunt).toHaveBeenCalledTimes(1);
  });

  test('bag full: Manage bag is primary, and after freeing space the state is recomputed', () => {
    const full = bag([item()], { usedSlots: 12, capacity: 12 });
    const view = mount({ ...RUNNING, status: 'bag-full', copyKey: 'away.bagFull', actions: ['manage-bag', 'view-hunt'] }, full);
    expect(screen.getByText(en.away.bagFull)).toBeInTheDocument();
    const primary = actionsBar().querySelector('.collect') as HTMLElement;
    expect(primary).toHaveTextContent(en.away.action['manage-bag']);
    expect(actionsBar()).toHaveTextContent(i18n.t('away.note.full', { used: 12, capacity: 12, count: 2 }));
    fireEvent.click(primary);
    expect(view.actions.onManageBag).toHaveBeenCalledTimes(1);

    view.rerenderWith(bag([], { usedSlots: 7, capacity: 12 }));
    expect(actionsBar().querySelector('.collect')).toHaveTextContent(en.away.action['view-hunt']);
    expect(actionsBar()).toHaveTextContent(i18n.t('away.note.room', { used: 7, capacity: 12 }));
    expect(actionsBar()).not.toHaveTextContent(i18n.t('away.note.full', { used: 12, capacity: 12, count: 2 }));
  });
});

describe('B-17: one account state, and no credit on reopen or refresh', () => {
  async function arrive() {
    const api = fakeApi();
    api.inventoryResponse = bag([item()], { gold: 500 });
    api.reports[REPORT_ID] = { ...RUNNING, status: 'bag-full', copyKey: 'away.bagFull', actions: ['manage-bag', 'view-hunt'] };
    const harness = huntHarness(api);
    const view = render(<App huntOptions={harness.options} />);
    await act(async () => {
      harness.sockets[0]!.open();
      harness.sockets[0]!.deliver({ type: 'report', generation: 3, reportId: REPORT_ID });
    });
    await waitFor(() => expect(document.querySelector('.report')).not.toBeNull());
    return { api, harness, view };
  }

  test('the report opens from the socket and is read, never credited', async () => {
    const { api } = await arrive();
    expect(api.reportReads).toEqual([REPORT_ID]);
    expect(api.mutations).toEqual([]);
    expect(api.starts).toHaveLength(0);
  });

  test('reopening and refreshing read the same report and credit nothing', async () => {
    const first = await arrive();
    first.view.unmount();
    const api = first.api;
    const harness = huntHarness(api);
    render(<App huntOptions={harness.options} />);
    await act(async () => {
      harness.sockets[0]!.open();
      harness.sockets[0]!.deliver({ type: 'report', generation: 3, reportId: REPORT_ID });
    });
    await waitFor(() => expect(document.querySelector('.report')).not.toBeNull());
    expect(api.reportReads).toEqual([REPORT_ID, REPORT_ID]);
    expect(api.mutations).toEqual([]);
  });

  test('Manage bag opens the real bag: the same counters the hunt shows', async () => {
    await arrive();
    // The bag has room now, so Manage bag is the secondary action.
    fireEvent.click(screen.getByRole('button', { name: en.away.action['manage-bag'] }));
    await waitFor(() => expect(document.querySelector('.bag.win')).not.toBeNull());
    const ledger = document.querySelector('.statusbar .ledger') as HTMLElement;
    expect(ledger).toHaveTextContent('500');
    expect(ledger).toHaveTextContent(`2 / 12`);
    expect(document.querySelector('style[data-route-sheet="away"]')).toBeNull();
    expect(document.querySelector('style[data-route-sheet="bag"]')).not.toBeNull();
  });
});

describe('copy (Minor 5)', () => {
  test('the full-bag note pluralises the lost drops', () => {
    expect(i18n.t('away.note.full', { used: 9, capacity: 9, count: 1 })).toBe(en.away.note.full_one.replace('{{used}}', '9').replace('{{capacity}}', '9').replace('{{count}}', '1'));
    expect(i18n.t('away.note.full', { used: 9, capacity: 9, count: 2 })).toBe(en.away.note.full_other.replace('{{used}}', '9').replace('{{capacity}}', '9').replace('{{count}}', '2'));
  });
});

describe('the loot filter named is the one the hunt runs (I1)', () => {
  const ALPHA = { ...LOOT[0]!, name: 'Alpha' };
  const BETA = { ...LOOT[0]!, id: '30000000-0000-4000-8000-000000000002', name: 'Beta' };

  async function mountWith(running: boolean) {
    const api = fakeApi();
    api.lootPresets = [ALPHA, BETA];
    api.inventoryResponse = bag([]);
    if (running) {
      api.current = {
        ...huntResponse(2, 'walking', { presetId: SUSTAIN, presetVersion: 1 }),
        activeLoot: { presetId: BETA.id, presetVersion: BETA.presetVersion },
        status: 'running',
        mapId: 'prototype',
      };
    }
    api.reports[REPORT_ID] = RUNNING;
    const harness = huntHarness(api);
    render(<App huntOptions={harness.options} />);
    await act(async () => {
      harness.sockets[0]!.open();
    });
    return { api, harness };
  }

  const lootButton = () => screen.getByRole('button', { name: new RegExp(en.hunt.lootFilter) });

  test('while a hunt runs, Orders names its active loot preset, not the first one', async () => {
    await mountWith(true);
    await waitFor(() => expect(lootButton()).toHaveTextContent('Beta'));
    expect(lootButton()).not.toHaveTextContent('Alpha');
  });

  test('in town, Orders names the preset a start would use', async () => {
    await mountWith(false);
    await waitFor(() => expect(lootButton()).toHaveTextContent('Alpha'));
  });

  test('Away’s current loot filter is the running hunt’s active preset', async () => {
    const { harness } = await mountWith(true);
    await waitFor(() => expect(lootButton()).toHaveTextContent('Beta'));
    await act(async () => {
      harness.sockets[0]!.deliver({ type: 'report', generation: 3, reportId: REPORT_ID });
    });
    await waitFor(() => expect(document.querySelector('.report')).not.toBeNull());
    expect(document.querySelector('.actions .preset')).toHaveTextContent('Beta');
  });

  test('the bag’s filter pane opens on the active preset', async () => {
    await mountWith(true);
    await waitFor(() => expect(lootButton()).toHaveTextContent('Beta'));
    fireEvent.click(lootButton());
    await waitFor(() => expect(document.querySelector('.filter')).not.toBeNull());
    const tabs = within(document.querySelector('.fpresets') as HTMLElement);
    expect(tabs.getByRole('radio', { name: /Beta/ })).toHaveAttribute('aria-checked', 'true');
    expect(tabs.getByRole('radio', { name: /Alpha/ })).toHaveAttribute('aria-checked', 'false');
  });
});
