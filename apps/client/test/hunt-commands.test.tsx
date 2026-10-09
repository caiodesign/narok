// @vitest-environment jsdom
/**
 * The Hunt shell's commands (milestone B Task 9; part 4 §3.1; ruling R166).
 *
 * The owner's Stop decision: Stop is a command that returns the party to town
 * and abandons the encounter, and there is no resume. The Orders window
 * carries Start hunt and Stop, each pending until the server acknowledges it,
 * and once the hunt has stopped the second control starts a *new* hunt. No
 * client path pauses authoritative time, and neither locale carries a Resume
 * string on the hunt path. The whole App is rendered against the hand-written
 * server in `hunt-fakes.ts`; nothing here touches a network.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ERROR_CODES, stopReasonSchema } from '@narok/protocol';
import { App } from '../src/App';
import { TOWN_RETURN_TRAVEL_MS } from '../src/useHunt';
import { CommandError, createApi } from '../src/commands';
import en from '../src/locales/en.json';
import ptBR from '../src/locales/pt-BR.json';
import { fakeApi, huntHarness, huntResponse, presetRecord, stoppedHunt, SUSTAIN, wireState } from './hunt-fakes';
import '../src/i18n';

afterEach(() => {
  cleanup();
});

const ACTIVE = { presetId: SUSTAIN, presetVersion: 1 };

async function mountApp() {
  const api = fakeApi();
  const harness = huntHarness(api);
  render(<App huntOptions={harness.options} />);
  const start = screen.getByRole('button', { name: 'Start hunt' });
  await waitFor(() => expect(start).toBeEnabled());
  return { api, ...harness, start };
}

function paused(): string | undefined {
  return document.body.dataset.paused;
}

/** Every string value in a locale tree, with its dotted key. */
function strings(tree: unknown, path = ''): [string, string][] {
  if (typeof tree === 'string') return [[path, tree]];
  if (tree === null || typeof tree !== 'object') return [];
  return Object.entries(tree).flatMap(([key, child]) => strings(child, path === '' ? key : `${path}.${key}`));
}

describe('Start hunt and Stop are commands, pending until acknowledged (R166)', () => {
  test('Start hunt shows pending until the server answers, then the hunt runs', async () => {
    const { api, start } = await mountApp();
    expect(paused()).toBe('true');

    fireEvent.click(start);
    const starting = await screen.findByRole('button', { name: 'Starting the hunt…' });
    await waitFor(() => expect(api.starts).toHaveLength(1));
    // Not presented as done: still busy, still disabled, the world still not running.
    expect(starting).toHaveAttribute('aria-busy', 'true');
    expect(starting).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    expect(paused()).toBe('true');

    await act(async () => api.starts[0]!.resolve(huntResponse(1, 'walking', ACTIVE)));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled());
    expect(paused()).toBe('false');
    expect(screen.getByTestId('orders-help')).toHaveTextContent(en.hunt.runningHelp);
  });

  test('Stop is pending until acknowledged; then the second control starts a new hunt and says what the stop cost', async () => {
    const { api, start, wall, timers } = await mountApp();
    fireEvent.click(start);
    await waitFor(() => expect(api.starts).toHaveLength(1));
    await act(async () => api.starts[0]!.resolve(huntResponse(1, 'walking', ACTIVE)));
    const stop = screen.getByRole('button', { name: 'Stop' });
    await waitFor(() => expect(stop).toBeEnabled());

    fireEvent.click(stop);
    const returning = await screen.findByRole('button', { name: 'Returning to town…' });
    expect(returning).toHaveAttribute('aria-busy', 'true');
    expect(api.stops).toHaveLength(1);
    // The hunt is still the server's running hunt until it says otherwise.
    expect(paused()).toBe('false');

    api.current = stoppedHunt('operator', ACTIVE);
    await act(async () => api.stops[0]!.resolve(stoppedHunt('operator', ACTIVE)));
    const again = await screen.findByRole('button', { name: 'Start a new hunt' });
    expect(paused()).toBe('true');
    const help = screen.getByTestId('orders-help');
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();

    // The party is travelling home: the server would refuse a start (`hunt.travel`),
    // so Start a new hunt is disabled and described by the journey's countdown.
    expect(help).toHaveTextContent(en.hunt.returningHelp);
    expect(en.hunt.returningHelp).toMatch(/abandoned/);
    expect(again).toBeDisabled();
    expect(again).toHaveAccessibleDescription(en.hunt.returning.replace('{{seconds}}', '10'));
    wall.now += TOWN_RETURN_TRAVEL_MS;
    act(() => timers.fireIntervals());
    await waitFor(() => expect(again).toBeEnabled());
    expect(screen.queryByTestId('orders-travel')).toBeNull();

    // In town, the helper names the abandoned encounter and the travel the return cost.
    expect(help).toHaveTextContent(en.hunt.stoppedHelp.operator);
    expect(en.hunt.stoppedHelp.operator).toMatch(/abandoned/);
    expect(en.hunt.stoppedHelp.operator).toMatch(/travel time/);
    fireEvent.click(again);
    await waitFor(() => expect(api.starts).toHaveLength(2));
  });

  test('the return journey counts down from the server’s arrival time, capped at the content’s journey', async () => {
    const { api, start, wall, timers } = await mountApp();
    fireEvent.click(start);
    await waitFor(() => expect(api.starts).toHaveLength(1));
    await act(async () => api.starts[0]!.resolve(huntResponse(1, 'walking', ACTIVE)));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled());

    // The server says the party arrives 4 s from now.
    api.current = { ...stoppedHunt('operator', ACTIVE), inTownAtWallMs: wall.now + 4_000 };
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(api.stops).toHaveLength(1));
    await act(async () => api.stops[0]!.resolve(stoppedHunt('operator', ACTIVE)));
    await waitFor(() => expect(screen.getByTestId('orders-travel')).toHaveTextContent('arrives in 4 s'));
    const again = screen.getByRole('button', { name: 'Start a new hunt' });
    expect(again).toBeDisabled();

    wall.now += 2_500;
    act(() => timers.fireIntervals());
    expect(screen.getByTestId('orders-travel')).toHaveTextContent('arrives in 2 s');
    wall.now += 1_500;
    act(() => timers.fireIntervals());
    await waitFor(() => expect(again).toBeEnabled());
  });

  test('a clock far behind the server never holds Start back longer than the journey', async () => {
    const api = fakeApi();
    const harness = huntHarness(api);
    api.current = { ...stoppedHunt('operator', ACTIVE), inTownAtWallMs: harness.wall.now + 3_600_000 };
    render(<App huntOptions={harness.options} />);
    await waitFor(() => expect(screen.getByTestId('orders-travel')).toHaveTextContent('arrives in 10 s'));
    harness.wall.now += TOWN_RETURN_TRAVEL_MS;
    act(() => harness.timers.fireIntervals());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start a new hunt' })).toBeEnabled());
  });

  test('a start the server refuses for the return journey says why, and re-reads the arrival time', async () => {
    const api = fakeApi();
    const harness = huntHarness(api);
    // A read that already says the party is in town (a clock ahead of the server's).
    api.current = { ...stoppedHunt('operator', ACTIVE), inTownAtWallMs: harness.wall.now - 1_000 };
    render(<App huntOptions={harness.options} />);
    const again = await screen.findByRole('button', { name: 'Start a new hunt' });
    await waitFor(() => expect(again).toBeEnabled());

    api.current = { ...stoppedHunt('operator', ACTIVE), inTownAtWallMs: harness.wall.now + 2_000 };
    fireEvent.click(again);
    await waitFor(() => expect(api.starts).toHaveLength(1));
    await act(async () => api.starts[0]!.reject(new CommandError('RULE_VIOLATION', 'hunt.travel')));
    expect(await screen.findByTestId('hunt-fault')).toHaveTextContent(en.hunt.travelRefused);
    await waitFor(() => expect(screen.getByTestId('orders-travel')).toHaveTextContent('arrives in 2 s'));
    expect(again).toBeDisabled();

    // Once the party arrives the refusal no longer applies.
    harness.wall.now += 2_000;
    act(() => harness.timers.fireIntervals());
    await waitFor(() => expect(again).toBeEnabled());
    expect(screen.queryByTestId('hunt-fault')).toBeNull();
  });

  test('a refused command renders the server code through i18n, never the server text', async () => {
    const { api, start } = await mountApp();
    fireEvent.click(start);
    await waitFor(() => expect(api.starts).toHaveLength(1));
    await act(async () => api.starts[0]!.reject(new CommandError('RULE_VIOLATION', 'hunt')));
    expect(await screen.findByTestId('hunt-fault')).toHaveTextContent(en.serverError.RULE_VIOLATION);
    expect(screen.getByRole('button', { name: 'Start hunt' })).toBeEnabled();
  });
});

describe('the stopped helper says why the hunt stopped (part 4 §3.1; R177)', () => {
  async function mountStopped(reason: (typeof stopReasonSchema.options)[number] | null) {
    const api = fakeApi();
    const record = stoppedHunt('operator', ACTIVE);
    api.current = { ...record, state: { ...record.state, stopReason: reason } };
    render(<App huntOptions={huntHarness(api).options} />);
    await screen.findByRole('button', { name: 'Start a new hunt' });
    return screen.getByTestId('orders-help');
  }

  test.each(stopReasonSchema.options)('%s has its own copy', async (reason) => {
    const help = await mountStopped(reason);
    expect(help).toHaveTextContent(en.hunt.stoppedHelp[reason]);
    for (const other of stopReasonSchema.options.filter((candidate) => candidate !== reason)) {
      expect(help).not.toHaveTextContent(en.hunt.stoppedHelp[other]);
    }
  });

  test('a wipe says the party fell and the town healed it, never that the encounter was abandoned', async () => {
    const help = await mountStopped('wipe');
    expect(help.textContent).not.toMatch(/abandon/i);
    expect(help.textContent).not.toMatch(/travel time/i);
    expect(help.textContent).toMatch(/fell/);
    expect(help.textContent).toMatch(/town/);
    expect(help.textContent).toMatch(/fully healed/);
    expect(ptBR.hunt.stoppedHelp.wipe).not.toMatch(/abandon/i);
  });

  test('a stopped hunt whose reason is not known says only what is certain', async () => {
    const help = await mountStopped(null);
    expect(help).toHaveTextContent(en.hunt.stoppedHelp.unknown);
    expect(help.textContent).not.toMatch(/abandon/i);
  });

  test('every reason the protocol defines is localised in EN and PT-BR', () => {
    for (const locale of [en, ptBR] as const) {
      const copy = locale.hunt.stoppedHelp as Record<string, string>;
      const keys = [...stopReasonSchema.options, 'unknown'];
      expect(keys.filter((key) => typeof copy[key] !== 'string' || copy[key] === '')).toEqual([]);
    }
  });
});

describe('the Orders window and the hunt it is running', () => {
  test('while a hunt runs, the strategy named is the active one, not the tab selected in the editor', async () => {
    const BURST = '10000000-0000-4000-8000-000000000002';
    const api = fakeApi([presetRecord(SUSTAIN, 'Sustain'), presetRecord(BURST, 'Burst')]);
    api.current = { ...huntResponse(1, 'fighting', { presetId: BURST, presetVersion: 1 }), status: 'running', mapId: 'prototype' };
    render(<App huntOptions={huntHarness(api).options} />);
    const orders = screen.getByRole('region', { name: en.hunt.orders });
    await waitFor(() => expect(within(orders).getByRole('button', { name: 'Stop' })).toBeEnabled());
    // The start selection is still Sustain (the first preset); the hunt runs Burst.
    expect(within(orders).getByText('Burst')).toBeInTheDocument();
    expect(within(orders).queryByText('Sustain')).toBeNull();
  });

  test('a faulted hunt offers no normal Start, and says why', async () => {
    const { api, start, sockets } = await mountApp();
    fireEvent.click(start);
    await waitFor(() => expect(api.starts).toHaveLength(1));
    api.current = { ...huntResponse(1, 'fighting', ACTIVE), status: 'running', mapId: 'prototype' };
    await act(async () => api.starts[0]!.resolve(huntResponse(1, 'walking', ACTIVE)));
    act(() => sockets[0]!.open());
    act(() => sockets[0]!.deliver({ type: 'error', generation: 1, code: 'HUNT_FAULTED', field: 'hunt' }));

    await waitFor(() => expect(screen.getByTestId('orders-help')).toHaveTextContent(en.hunt.faultedHelp));
    expect(screen.getByRole('button', { name: 'Start hunt' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Start a new hunt' })).toBeNull();
  });
});

describe('a faulted hunt offers the explicit recovery action, and only it (B-30; part 4 §2)', () => {
  /** A running hunt the server then reports faulted: the error, then the close it always sends. */
  async function mountFaulted() {
    const mounted = await mountApp();
    const { api, start, sockets } = mounted;
    // An account whose reads all succeed, so the only faults are the hunt's.
    api.inventoryResponse = { capacity: 40, usedSlots: 0, gold: 0, stateVersion: 7 };
    fireEvent.click(start);
    await waitFor(() => expect(api.starts).toHaveLength(1));
    api.current = { ...huntResponse(1, 'fighting', ACTIVE), status: 'running', mapId: 'prototype' };
    await act(async () => api.starts[0]!.resolve(huntResponse(1, 'walking', ACTIVE)));
    act(() => sockets[0]!.open());
    act(() => sockets[0]!.deliver({ type: 'snapshot', generation: 1, seq: 1, state: wireState(0) }));
    act(() => sockets[0]!.deliver({ type: 'error', generation: 1, code: 'HUNT_FAULTED', field: 'hunt.status' }));
    act(() => sockets[0]!.closeWith('HUNT_FAULTED'));
    return mounted;
  }

  test('the one control sends the guard, is pending until acknowledged, then the hunt reads back in town', async () => {
    const { api, sockets } = await mountFaulted();
    const orders = screen.getByRole('region', { name: en.hunt.orders });
    const recover = await within(orders).findByRole('button', { name: en.hunt.recover });
    // The fault survives the close that follows it: the control stays offered.
    expect(recover).toBeEnabled();
    expect(within(orders).getAllByRole('button', { name: /recover/i })).toHaveLength(1);
    expect(within(orders).getByRole('button', { name: 'Start hunt' })).toBeDisabled();
    expect(within(orders).queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.getByTestId('orders-help')).toHaveTextContent(en.hunt.faultedHelp);

    fireEvent.click(recover);
    const recovering = await within(orders).findByRole('button', { name: en.hunt.recoverPending });
    await waitFor(() => expect(api.recovers).toHaveLength(1));
    expect(api.recovers[0]!.body, 'the guard is the account version as it stands, and nothing else').toEqual({ expectedStateVersion: 7 });
    expect(recovering).toHaveAttribute('aria-busy', 'true');
    expect(recovering).toBeDisabled();

    // The server's recovered hunt keeps its generation and its last valid,
    // unstopped engine state; its record says it is in town.
    api.current = { ...huntResponse(1, 'fighting', ACTIVE), status: 'stopped', mapId: 'prototype' };
    const socketsBefore = sockets.length;
    await act(async () => api.recovers[0]!.gate.resolve(huntResponse(1, 'fighting', ACTIVE)));

    const again = await within(orders).findByRole('button', { name: 'Start a new hunt' });
    await waitFor(() => expect(again).toBeEnabled());
    expect(within(orders).queryByRole('button', { name: en.hunt.recover })).toBeNull();
    expect(screen.getByTestId('orders-help')).toHaveTextContent(en.hunt.stoppedHelp.unknown);
    expect(screen.queryByTestId('hunt-fault')).toBeNull();
    // The stream is reopened at once for a fresh snapshot, not left to the backoff.
    expect(sockets.length).toBe(socketsBefore + 1);
    act(() => sockets.at(-1)!.open());
    expect(sockets.at(-1)!.sent[0]).toEqual({ type: 'hello' });
    act(() => sockets.at(-1)!.deliver({ type: 'snapshot', generation: 1, seq: 1, state: wireState(0) }));
    expect(within(orders).getByRole('button', { name: 'Start a new hunt' })).toBeEnabled();
    expect(paused()).toBe('true');
  });

  test('a refused recovery renders the server code, and the control is offered again', async () => {
    const { api } = await mountFaulted();
    fireEvent.click(await screen.findByRole('button', { name: en.hunt.recover }));
    await waitFor(() => expect(api.recovers).toHaveLength(1));
    await act(async () => api.recovers[0]!.gate.reject(new CommandError('CONFLICT_STATE_VERSION', 'expectedStateVersion', 9)));
    expect(await screen.findByTestId('hunt-fault')).toHaveTextContent(en.serverError.CONFLICT_STATE_VERSION);
    expect(screen.getByRole('button', { name: en.hunt.recover })).toBeEnabled();
  });

  test('a hunt read answering HUNT_FAULTED on load offers the same control', async () => {
    const api = fakeApi();
    api.currentHunt = async () => {
      throw new CommandError('HUNT_FAULTED', 'hunt.status');
    };
    render(<App huntOptions={huntHarness(api).options} />);
    expect(await screen.findByRole('button', { name: en.hunt.recover })).toBeEnabled();
    expect(screen.getByTestId('orders-help')).toHaveTextContent(en.hunt.faultedHelp);
    expect(screen.getByRole('button', { name: 'Start hunt' })).toBeDisabled();
  });

  test('the control and its pending state are localised in EN and PT-BR', () => {
    for (const locale of [en, ptBR] as const) {
      expect(locale.hunt.recover).not.toBe('');
      expect(locale.hunt.recoverPending).not.toBe('');
    }
    expect(ptBR.hunt.recover).not.toBe(en.hunt.recover);
  });

  test('the API posts the guard to the recovery route with an idempotency key', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = createApi({
      newKey: () => 'k-1',
      fetch: async (input, init) => {
        calls.push({ url: String(input), init: init! });
        return new Response(JSON.stringify(huntResponse(1, 'fighting', ACTIVE)), { status: 200 });
      },
    });
    await api.recoverHunt({ expectedStateVersion: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/hunts/current/recover');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>)['idempotency-key']).toBe('k-1');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ expectedStateVersion: 3 });
  });
});

describe('a terminal socket close (part 4 §2)', () => {
  test.each(['UNAUTHENTICATED', 'FORBIDDEN_ORIGIN'] as const)(
    '%s is shown as closed, not as reconnecting, and no reconnect is attempted',
    async (code) => {
      const { api, start, sockets, timers } = await mountApp();
      // An account whose reads all succeed, so the only fault is the close.
      api.inventoryResponse = { capacity: 40, usedSlots: 0, gold: 0, stateVersion: 7 };
      fireEvent.click(start);
      await waitFor(() => expect(api.starts).toHaveLength(1));
      api.current = { ...huntResponse(1, 'fighting', ACTIVE), status: 'running', mapId: 'prototype' };
      await act(async () => api.starts[0]!.resolve(huntResponse(1, 'walking', ACTIVE)));
      act(() => sockets[0]!.open());
      act(() => sockets[0]!.deliver({ type: 'snapshot', generation: 1, seq: 1, state: wireState(0) }));

      act(() => sockets[0]!.closeWith(code));
      act(() => timers.fireTimeouts());
      expect(sockets).toHaveLength(1);
      const compass = screen.getByRole('region', { name: en.compass.label });
      expect(within(compass).getByText(en.playbackState.closed)).toBeInTheDocument();
      expect(within(compass).queryByText(en.playbackState.disconnected)).toBeNull();
      expect(screen.getByTestId('hunt-fault')).toHaveTextContent(en.serverError[code]);
    },
  );
});

describe('no client path pauses authoritative time (R166)', () => {
  test('no Pause or Resume control exists in any hunt state', async () => {
    const { api, start } = await mountApp();
    const noPause = () => expect(screen.queryAllByRole('button', { name: /pause|resume/i })).toEqual([]);
    noPause();
    fireEvent.click(start);
    await waitFor(() => expect(api.starts).toHaveLength(1));
    await act(async () => api.starts[0]!.resolve(huntResponse(1, 'walking', ACTIVE)));
    noPause();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await act(async () => api.stops[0]!.resolve(stoppedHunt('operator', ACTIVE)));
    noPause();
  });

  test('the API has no pause or resume command, and the socket sends only hello, heartbeat and ack', async () => {
    expect(Object.keys(createApi()).filter((name) => /pause|resume|advance/i.test(name))).toEqual([]);
    const { sockets } = await mountApp();
    act(() => sockets[0]!.open());
    act(() => sockets[0]!.deliver({ type: 'snapshot', generation: 1, seq: 1, state: wireState(0) }));
    const kinds = new Set(sockets.flatMap((socket) => socket.sent.map((message) => message.type)));
    expect([...kinds].every((kind) => ['hello', 'heartbeat', 'ack'].includes(kind))).toBe(true);
  });

  test('a buffering client is still hunting: body[data-paused] follows the authoritative status (R110)', async () => {
    const { api, start, sockets, clock } = await mountApp();
    fireEvent.click(start);
    await waitFor(() => expect(api.starts).toHaveLength(1));
    api.current = { ...huntResponse(1, 'fighting', ACTIVE), status: 'running', mapId: 'prototype' };
    await act(async () => api.starts[0]!.resolve(huntResponse(1, 'walking', ACTIVE)));

    act(() => sockets[0]!.open());
    act(() => sockets[0]!.deliver({ type: 'snapshot', generation: 1, seq: 1, state: wireState(1000) }));
    clock.setNow(10_000);
    act(() => clock.pump());

    const compass = screen.getByRole('region', { name: en.compass.label });
    expect(within(compass).getByText(en.playbackState.buffering)).toBeInTheDocument();
    expect(paused()).toBe('false');
  });

  test('neither locale carries a Resume or Pause string on the hunt path, nor respawn or wipe-limit copy', () => {
    for (const locale of [en, ptBR]) {
      const all = strings(locale);
      // No key names a pause or resume control anywhere in the client's resources.
      expect(all.filter(([key]) => /(^|\.)(pause|resume)$/i.test(key))).toEqual([]);
      // No Resume in either language: the laboratory's own "Resume"/"Retomar" live in apps/lab.
      expect(all.filter(([, value]) => /\bresum|\bretom/i.test(value))).toEqual([]);
      // The hunt path says nothing of pausing.
      expect(strings(locale.hunt).filter(([, value]) => /paus/i.test(value))).toEqual([]);
      // The owner's death rules: no respawn, no wipe limit (Task 7c).
      expect(all.filter(([, value]) => /respawn|renasc|wipe limit|limite de (derrotas|wipes)/i.test(value))).toEqual([]);
    }
  });
});

describe('account state binds the panels R108 left out', () => {
  test('wallet, bag occupancy and zone come from the server and are absent until it says so', async () => {
    const api = fakeApi();
    const harness = huntHarness(api);
    const view = render(<App huntOptions={harness.options} />);
    const compass = screen.getByRole('region', { name: en.compass.label });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start hunt' })).toBeEnabled());
    // No inventory read succeeded: no wallet row is invented.
    expect(within(compass).queryByText(en.compass.wallet)).toBeNull();
    view.unmount();

    api.inventoryResponse = { capacity: 40, usedSlots: 3, gold: 120, stateVersion: 7 };
    api.current = { ...huntResponse(1, 'walking', ACTIVE), status: 'running', mapId: 'prototype' };
    render(<App huntOptions={huntHarness(api).options} />);
    const bound = screen.getByRole('region', { name: en.compass.label });
    expect(await within(bound).findByLabelText(`${en.compass.wallet}: 120`)).toBeInTheDocument();
    expect(within(bound).getByLabelText(`${en.compass.bag}: 3 / 40`)).toBeInTheDocument();
    expect(await within(bound).findByText(en.map.prototype)).toBeInTheDocument();
  });
});

describe('every server code has a message (part 1 §7)', () => {
  test('each code in the protocol error union is localised in EN and PT-BR', () => {
    for (const locale of [en, ptBR] as const) {
      const messages = locale.serverError as Record<string, string>;
      expect(ERROR_CODES.filter((code) => typeof messages[code] !== 'string' || messages[code] === '')).toEqual([]);
    }
  });
});
