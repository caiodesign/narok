// @vitest-environment jsdom
/**
 * The Away report (milestone B Task 10; part 4 §3.5; UI spec §8; B-17).
 *
 * The screen is a read of already-settled progress: time away and simulated
 * time are separate; the wipe counts are the report's own (ruling R184 — it
 * carries the hunt's total and this absence's, and no per-member deaths, so
 * none is shown); the four states render their copy and actions, a cap as a
 * cap and never a combat failure; reopening and refreshing credit nothing;
 * and after Manage bag the action state is recomputed from current inventory.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { App } from '../src/App';
import type { AwayReportRecord, InventoryResponse } from '../src/commands';
import i18n from '../src/i18n';
import en from '../src/locales/en.json';
import { AwayReport } from '../src/town/AwayReport';
import { fakeApi, huntHarness } from './hunt-fakes';
import { bag, item, LOOT } from './town-fixtures';

afterEach(() => {
  cleanup();
});

const REPORT_ID = '40000000-0000-4000-8000-000000000001';

const RUNNING: AwayReportRecord = {
  reportVersion: 2,
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
};

function mount(report: AwayReportRecord, inventory: InventoryResponse = bag([])) {
  const actions = { onManageBag: vi.fn(), onReturnToHunt: vi.fn(), onStartHunt: vi.fn(), onReviewFilter: vi.fn() };
  const props = { report, lootPresetName: LOOT[0]!.name, zone: 'prototype', ...actions };
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

  test('the wipe counts are the hunt’s and this absence’s, separately; no member deaths are invented', () => {
    mount(RUNNING);
    const attempts = document.querySelector('.attempts') as HTMLElement;
    expect(attempts).toHaveTextContent(i18n.t('away.wipes.thisHunt', { count: 3 }));
    expect(attempts).toHaveTextContent(i18n.t('away.wipes.thisAbsence', { count: 1 }));
    expect(document.body.textContent).not.toMatch(/death/i);
    expect(document.querySelector('.pips')).toBeNull();
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
    expect(actionsBar()).toHaveTextContent(i18n.t('away.note.full', { used: 12, capacity: 12, lost: 2 }));
    fireEvent.click(primary);
    expect(view.actions.onManageBag).toHaveBeenCalledTimes(1);

    view.rerenderWith(bag([], { usedSlots: 7, capacity: 12 }));
    expect(actionsBar().querySelector('.collect')).toHaveTextContent(en.away.action['view-hunt']);
    expect(actionsBar()).toHaveTextContent(i18n.t('away.note.room', { used: 7, capacity: 12 }));
    expect(actionsBar()).not.toHaveTextContent(i18n.t('away.note.full', { used: 12, capacity: 12, lost: 2 }));
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
