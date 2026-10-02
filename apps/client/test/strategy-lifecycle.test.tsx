// @vitest-environment jsdom
/**
 * The Strategy lifecycle (milestone B spec part 4 §3.2; UI spec §5; gate B-10),
 * one case per row of the table and per state it names. The commands are the
 * test's (`hunt-fakes.ts`) and answer only when the test resolves them, so
 * "on acknowledgement, not on click" is observable. The harness feeds the
 * screen the active and pending versions exactly as `useHunt` does: from the
 * server's answers, never from the click.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { content, type ClassId } from '@narok/data';
import { CommandError, type PresetRef, type StrategyPresetRecord } from '../src/commands';
import { StrategyScreen } from '../src/hud/strategy/StrategyScreen';
import en from '../src/locales/en.json';
import { useHunt, type StrategyCommands } from '../src/useHunt';
import { fakeApi, gate, huntHarness, huntResponse, presetRecord, SUSTAIN, wireState, type Gate } from './hunt-fakes';
import '../src/i18n';

afterEach(() => {
  cleanup();
});

const BURST = '10000000-0000-4000-8000-000000000002';
const SAFE = '10000000-0000-4000-8000-000000000003';
const FOURTH = '10000000-0000-4000-8000-000000000004';
const CLASSES: ClassId[] = ['guardian', 'cleric', 'ranger'];

interface Held {
  saves: { presetId: string; payload: unknown; expectedPresetVersion: number; gate: Gate<PresetRef> }[];
  applies: { ref: PresetRef; gate: Gate<{ active: PresetRef | null; pending: PresetRef | null }> }[];
}

function heldCommands(): StrategyCommands & Held {
  const held: Held = { saves: [], applies: [] };
  return {
    ...held,
    save: (presetId, payload, expectedPresetVersion) => {
      const answer = gate<PresetRef>();
      held.saves.push({ presetId, payload, expectedPresetVersion, gate: answer });
      return answer.promise;
    },
    apply: (ref) => {
      const answer = gate<{ active: PresetRef | null; pending: PresetRef | null }>();
      held.applies.push({ ref, gate: answer });
      return answer.promise;
    },
  };
}

/** Mirrors `useHunt`: the list re-read after a save, active and pending from the server's answer. */
function Harness(props: {
  commands: StrategyCommands;
  presets?: StrategyPresetRecord[];
  initialActive?: PresetRef | null;
  initialPending?: PresetRef | null;
  onClose?: () => void;
  serverReport?: (set: (active: PresetRef | null, pending: PresetRef | null) => void) => void;
  /** The list re-read from the server, as after another tab's save. */
  serverPresets?: (set: (list: StrategyPresetRecord[]) => void) => void;
}) {
  const [presets, setPresets] = useState(props.presets ?? [presetRecord(SUSTAIN, 'Sustain'), presetRecord(BURST, 'Burst')]);
  const [active, setActive] = useState<PresetRef | null>(props.initialActive ?? { presetId: SUSTAIN, presetVersion: 1 });
  const [pending, setPending] = useState<PresetRef | null>(props.initialPending ?? null);
  const [selected, setSelected] = useState<string | null>(null);
  props.serverReport?.((nextActive, nextPending) => {
    setActive(nextActive);
    setPending(nextPending);
  });
  props.serverPresets?.(setPresets);
  const commands: StrategyCommands = {
    async save(presetId, payload, expectedPresetVersion) {
      const ref = await props.commands.save(presetId, payload, expectedPresetVersion);
      setPresets((list) =>
        list.map((preset) => (preset.id === presetId ? { ...preset, payload, presetVersion: ref.presetVersion } : preset)),
      );
      return ref;
    },
    async apply(ref) {
      const answer = await props.commands.apply(ref);
      setActive(answer.active);
      setPending(answer.pending);
      return answer;
    },
  };
  return (
    <StrategyScreen
      open
      content={content}
      presets={presets}
      classes={CLASSES}
      selectedPresetId={selected}
      onSelectPreset={setSelected}
      active={active}
      pending={pending}
      status="running"
      commands={commands}
      onClose={props.onClose ?? (() => undefined)}
    />
  );
}

function restHp(): HTMLInputElement {
  return screen.getByLabelText(en.controls.restHp) as HTMLInputElement;
}

function edit(value = 61): void {
  fireEvent.change(restHp(), { target: { value: String(value) } });
}

function dirtyNote(): HTMLElement {
  return screen.getByTestId('dirty-note');
}

function selectedTab(): HTMLElement {
  return screen.getAllByRole('tab', { selected: true }).find((tab) => tab.closest('.preset-bar') !== null)!;
}

describe('Edit', () => {
  test('mutates the draft only, issues no command, and marks it unsaved', () => {
    const commands = heldCommands();
    const save = vi.spyOn(commands, 'save');
    const apply = vi.spyOn(commands, 'apply');
    render(<Harness commands={commands} />);
    expect(dirtyNote()).toHaveTextContent('Saved v1');

    edit();
    expect(restHp().value).toBe('61');
    expect(save).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(dirtyNote()).toHaveTextContent(en.strategy.unsavedDraft);
    expect(within(selectedTab()).getByRole('img', { name: en.strategy.unsaved })).toBeInTheDocument();
    // The running hunt is untouched: active is still v1, nothing is pending.
    expect(screen.getByTestId('strategy-active')).toHaveTextContent('Sustain v1');
    expect(screen.queryByTestId('strategy-pending')).toBeNull();
  });
});

describe('Save preset', () => {
  test('clears the unsaved marker on acknowledgement, not on click, and leaves the hunt alone', async () => {
    const commands = heldCommands();
    render(<Harness commands={commands} />);
    edit();
    fireEvent.click(screen.getByRole('button', { name: en.strategy.save }));

    expect(commands.saves).toHaveLength(1);
    expect(commands.saves[0]!.payload).toMatchObject({ rest: { hpStart: 61, mpStart: 30 } });
    expect(screen.getByRole('button', { name: en.strategy.saving })).toHaveAttribute('aria-busy', 'true');
    expect(dirtyNote()).toHaveTextContent(en.strategy.unsavedDraft);

    await act(async () => commands.saves[0]!.gate.resolve({ presetId: SUSTAIN, presetVersion: 2 }));
    expect(dirtyNote()).toHaveTextContent('Saved v2');
    expect(within(selectedTab()).queryByRole('img', { name: en.strategy.unsaved })).toBeNull();
    // Saving does not apply.
    expect(commands.applies).toHaveLength(0);
    expect(screen.getByTestId('strategy-active')).toHaveTextContent('Sustain v1');
  });
});

describe('Apply next encounter', () => {
  test('saves and queues that exact version, pending until the server reports it active', async () => {
    const commands = heldCommands();
    let report: (active: PresetRef | null, pending: PresetRef | null) => void = () => undefined;
    render(<Harness commands={commands} serverReport={(set) => (report = set)} />);
    edit();
    fireEvent.click(screen.getByRole('button', { name: en.strategy.apply }));

    await act(async () => commands.saves[0]!.gate.resolve({ presetId: SUSTAIN, presetVersion: 2 }));
    expect(commands.applies).toHaveLength(1);
    expect(commands.applies[0]!.ref).toEqual({ presetId: SUSTAIN, presetVersion: 2 });
    // Not shown as pending before the server acknowledges the apply.
    expect(screen.queryByTestId('strategy-pending')).toBeNull();
    expect(screen.getByRole('button', { name: en.strategy.applying })).toBeDisabled();

    await act(async () =>
      commands.applies[0]!.gate.resolve({
        active: { presetId: SUSTAIN, presetVersion: 1 },
        pending: { presetId: SUSTAIN, presetVersion: 2 },
      }),
    );
    // Active and pending are rendered separately.
    expect(screen.getByTestId('strategy-active')).toHaveTextContent('Sustain v1');
    expect(screen.getByTestId('strategy-pending')).toHaveTextContent('Sustain v2');

    // The server reports it active at the next encounter: pending is gone.
    act(() => report({ presetId: SUSTAIN, presetVersion: 2 }, null));
    expect(screen.getByTestId('strategy-active')).toHaveTextContent('Sustain v2');
    expect(screen.queryByTestId('strategy-pending')).toBeNull();
  });

  test('a clean draft queues the saved version without saving again', async () => {
    const commands = heldCommands();
    render(<Harness commands={commands} />);
    fireEvent.click(screen.getByRole('button', { name: en.strategy.apply }));
    expect(commands.saves).toHaveLength(0);
    expect(commands.applies[0]!.ref).toEqual({ presetId: SUSTAIN, presetVersion: 1 });
  });

  test('editing the saved preset after an apply does not mutate the queued snapshot', async () => {
    const commands = heldCommands();
    render(<Harness commands={commands} />);
    edit(61);
    fireEvent.click(screen.getByRole('button', { name: en.strategy.apply }));
    await act(async () => commands.saves[0]!.gate.resolve({ presetId: SUSTAIN, presetVersion: 2 }));
    await act(async () =>
      commands.applies[0]!.gate.resolve({
        active: { presetId: SUSTAIN, presetVersion: 1 },
        pending: { presetId: SUSTAIN, presetVersion: 2 },
      }),
    );

    edit(70);
    fireEvent.click(screen.getByRole('button', { name: en.strategy.save }));
    await act(async () => commands.saves[1]!.gate.resolve({ presetId: SUSTAIN, presetVersion: 3 }));
    expect(dirtyNote()).toHaveTextContent('Saved v3');
    // The queue holds version 2, not a reference to the preset.
    expect(screen.getByTestId('strategy-pending')).toHaveTextContent('Sustain v2');
    expect(commands.applies).toHaveLength(1);
  });

  test('a newer acknowledged apply replaces pending', async () => {
    const commands = heldCommands();
    render(<Harness commands={commands} initialPending={{ presetId: SUSTAIN, presetVersion: 2 }} presets={[presetRecord(SUSTAIN, 'Sustain', 2), presetRecord(BURST, 'Burst')]} />);
    expect(screen.getByTestId('strategy-pending')).toHaveTextContent('Sustain v2');

    fireEvent.click(screen.getByRole('tab', { name: /Burst/ }));
    fireEvent.click(screen.getByRole('button', { name: en.strategy.apply }));
    // Still the old pending until the server answers.
    expect(screen.getByTestId('strategy-pending')).toHaveTextContent('Sustain v2');
    await act(async () =>
      commands.applies[0]!.gate.resolve({
        active: { presetId: SUSTAIN, presetVersion: 1 },
        pending: { presetId: BURST, presetVersion: 1 },
      }),
    );
    expect(screen.getByTestId('strategy-pending')).toHaveTextContent('Burst v1');
  });
});

describe('Revert', () => {
  test('restores the last saved preset locally, with no command', () => {
    const commands = heldCommands();
    render(<Harness commands={commands} />);
    edit(75);
    fireEvent.click(screen.getByRole('button', { name: en.strategy.revert }));
    expect(restHp().value).toBe('50');
    expect(dirtyNote()).toHaveTextContent('Saved v1');
    expect(screen.getByTestId('apply-status')).toHaveTextContent(en.strategy.revertedNote);
    expect(commands.saves).toHaveLength(0);
    expect(commands.applies).toHaveLength(0);
  });
});

describe('Close with unsaved changes', () => {
  test('offers Keep editing, Discard and Save, and never silently loses the draft', async () => {
    const commands = heldCommands();
    const onClose = vi.fn();
    render(<Harness commands={commands} onClose={onClose} />);
    edit(64);

    fireEvent.click(screen.getByRole('button', { name: en.strategy.close }));
    const prompt = screen.getByRole('alertdialog');
    expect(within(prompt).getByText(en.strategy.closePrompt)).toBeInTheDocument();

    fireEvent.click(within(prompt).getByRole('button', { name: en.strategy.keepEditing }));
    expect(onClose).not.toHaveBeenCalled();
    expect(restHp().value).toBe('64');

    // Save: closes only once the server acknowledged it.
    fireEvent.click(screen.getByRole('button', { name: en.strategy.close }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: en.strategy.save }));
    expect(commands.saves).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => commands.saves[0]!.gate.resolve({ presetId: SUSTAIN, presetVersion: 2 }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('Discard drops the draft and closes; a clean screen closes without asking', () => {
    const commands = heldCommands();
    const onClose = vi.fn();
    render(<Harness commands={commands} onClose={onClose} />);
    edit(64);
    fireEvent.click(screen.getByRole('button', { name: en.strategy.close }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: en.strategy.discard }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(restHp().value).toBe('50');
    expect(commands.saves).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: en.strategy.close }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('Discard drops only this tab’s draft', () => {
  test('another preset’s draft survives a Discard and is still unsaved when its tab is opened', () => {
    const commands = heldCommands();
    const onClose = vi.fn();
    render(<Harness commands={commands} onClose={onClose} />);
    edit(64);
    fireEvent.click(screen.getByRole('tab', { name: /Burst/ }));
    edit(70);

    fireEvent.click(screen.getByRole('button', { name: en.strategy.close }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: en.strategy.discard }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(restHp().value).toBe('50');

    fireEvent.click(screen.getByRole('tab', { name: /Sustain/ }));
    expect(restHp().value).toBe('64');
    expect(dirtyNote()).toHaveTextContent(en.strategy.unsavedDraft);
    expect(commands.saves).toHaveLength(0);
  });
});

describe('a stale tab (R176)', () => {
  test('the draft sends the version it was loaded from; a newer saved version is a recoverable conflict', async () => {
    const commands = heldCommands();
    let replace: (list: StrategyPresetRecord[]) => void = () => undefined;
    render(<Harness commands={commands} serverPresets={(set) => (replace = set)} />);
    edit(66);
    // Another tab saved v2 meanwhile, and this tab's list was re-read.
    act(() => replace([presetRecord(SUSTAIN, 'Sustain', 2), presetRecord(BURST, 'Burst')]));

    fireEvent.click(screen.getByRole('button', { name: en.strategy.save }));
    expect(commands.saves[0]!.expectedPresetVersion).toBe(1);
    await act(async () =>
      commands.saves[0]!.gate.reject(new CommandError('CONFLICT_STATE_VERSION', 'expectedPresetVersion', 9)),
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(en.serverError.CONFLICT_STATE_VERSION);
    expect(alert).toHaveTextContent(en.strategy.presetConflictHelp);
    // The draft survives, still unsaved, measured against the version now saved.
    expect(restHp().value).toBe('66');
    expect(dirtyNote()).toHaveTextContent(en.strategy.unsavedDraft);

    // Saving again is the player's explicit choice to replace v2.
    fireEvent.click(screen.getByRole('button', { name: en.strategy.save }));
    expect(commands.saves[1]!.expectedPresetVersion).toBe(2);
    await act(async () => commands.saves[1]!.gate.resolve({ presetId: SUSTAIN, presetVersion: 3 }));
    expect(dirtyNote()).toHaveTextContent('Saved v3');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('Revert after a conflict takes the version the other tab saved', async () => {
    const commands = heldCommands();
    let replace: (list: StrategyPresetRecord[]) => void = () => undefined;
    render(<Harness commands={commands} serverPresets={(set) => (replace = set)} />);
    edit(66);
    act(() => replace([presetRecord(SUSTAIN, 'Sustain', 2), presetRecord(BURST, 'Burst')]));
    fireEvent.click(screen.getByRole('button', { name: en.strategy.save }));
    await act(async () =>
      commands.saves[0]!.gate.reject(new CommandError('CONFLICT_STATE_VERSION', 'expectedPresetVersion', 9)),
    );
    fireEvent.click(screen.getByRole('button', { name: en.strategy.revert }));
    expect(restHp().value).toBe('50');
    expect(dirtyNote()).toHaveTextContent('Saved v2');
    // A fresh edit is based on v2.
    edit(55);
    fireEvent.click(screen.getByRole('button', { name: en.strategy.save }));
    expect(commands.saves[1]!.expectedPresetVersion).toBe(2);
  });

  test('useHunt sends the draft’s version and re-reads the list when a save conflicts', async () => {
    const api = fakeApi();
    const harness = huntHarness(api);
    const { result } = renderHook(() => useHunt(harness.options));
    await waitFor(() => expect(result.current.presets).not.toBeNull());
    const reads = api.presetReads;
    api.strategyPresets = [presetRecord(SUSTAIN, 'Sustain', 2)];

    let outcome: Promise<PresetRef> = Promise.resolve({ presetId: SUSTAIN, presetVersion: 0 });
    act(() => {
      outcome = result.current.strategy.save(SUSTAIN, presetRecord(SUSTAIN, 'Sustain').payload, 1);
    });
    await waitFor(() => expect(api.saves).toHaveLength(1));
    expect(api.saves[0]!.body).toMatchObject({ expectedPresetVersion: 1, expectedStateVersion: 7 });
    const settled = outcome.then(
      () => null,
      (error: unknown) => error,
    );
    await act(async () => api.saves[0]!.gate.reject(new CommandError('CONFLICT_STATE_VERSION', 'expectedPresetVersion', 7)));
    expect(await settled).toMatchObject({ code: 'CONFLICT_STATE_VERSION', field: 'expectedPresetVersion' });
    await waitFor(() => expect(result.current.presets?.strategy[0]?.presetVersion).toBe(2));
    expect(api.presetReads).toBeGreaterThan(reads);
  });
});

describe('conflict', () => {
  test('CONFLICT_STATE_VERSION is a recoverable conflict, localised from the code', async () => {
    const commands = heldCommands();
    render(<Harness commands={commands} />);
    edit(66);
    fireEvent.click(screen.getByRole('button', { name: en.strategy.save }));
    await act(async () => commands.saves[0]!.gate.reject(new CommandError('CONFLICT_STATE_VERSION', 'expectedStateVersion', 9)));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(en.serverError.CONFLICT_STATE_VERSION);
    expect(alert).toHaveTextContent(en.strategy.conflictHelp);
    // The draft survives, still unsaved, and Save works again.
    expect(restHp().value).toBe('66');
    expect(dirtyNote()).toHaveTextContent(en.strategy.unsavedDraft);
    fireEvent.click(screen.getByRole('button', { name: en.strategy.save }));
    await act(async () => commands.saves[1]!.gate.resolve({ presetId: SUSTAIN, presetVersion: 2 }));
    expect(dirtyNote()).toHaveTextContent('Saved v2');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('tabs and the ported board (R111, R112, R113)', () => {
  test('three preset tabs, never four, and no premium slot', () => {
    render(
      <Harness
        commands={heldCommands()}
        presets={[
          presetRecord(SUSTAIN, 'Sustain'),
          presetRecord(BURST, 'Burst'),
          presetRecord(SAFE, 'Safe farm'),
          presetRecord(FOURTH, 'Fourth'),
        ]}
      />,
    );
    const tablist = screen.getByRole('tablist', { name: en.strategy.presets });
    expect(within(tablist).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['1Sustain', '2Burst', '3Safe farm']);
    expect(screen.queryByText(/premium/i)).toBeNull();
  });

  test('the placement board is a role="grid" of buttons under aria-hidden scenery', () => {
    render(<Harness commands={heldCommands()} />);
    const grid = screen.getByRole('grid', { name: en.controls.placementGrid });
    expect(within(grid).getAllByRole('gridcell').length).toBe(content.grid.width * content.grid.height);
    const screenRoot = screen.getByTestId('strategy-screen');
    const exposed = [...screenRoot.querySelectorAll('svg')].filter((svg) => svg.closest('[aria-hidden="true"]') === null);
    expect(exposed).toEqual([]);
  });
});

describe('pending survives a reload', () => {
  test('a fresh useHunt against a server holding a pending version shows it pending, from the server alone', async () => {
    const api = fakeApi([presetRecord(SUSTAIN, 'Sustain', 2)]);
    const queued = { presetId: SUSTAIN, presetVersion: 2 };
    api.current = { ...huntResponse(1, 'fighting', { presetId: SUSTAIN, presetVersion: 1 }, queued), status: 'running', mapId: 'prototype' };

    // The page that queued it is gone: nothing of a previous mount survives but the server.
    const harness = huntHarness(api);
    const { result } = renderHook(() => useHunt(harness.options));
    expect(result.current.hunt).toBeNull();
    await waitFor(() => expect(result.current.hunt?.pendingStrategy).toEqual(queued));
    act(() => harness.sockets[0]!.open());
    act(() => harness.sockets[0]!.deliver({ type: 'snapshot', generation: 1, seq: 1, state: wireState(5000) }));
    expect(result.current.status).toBe('running');

    render(
      <StrategyScreen
        open
        content={content}
        presets={result.current.presets!.strategy}
        classes={CLASSES}
        selectedPresetId={null}
        onSelectPreset={() => undefined}
        active={result.current.hunt!.activeStrategy}
        pending={result.current.hunt!.pendingStrategy}
        status={result.current.status}
        commands={heldCommands()}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByTestId('strategy-active')).toHaveTextContent('Sustain v1');
    expect(screen.getByTestId('strategy-pending')).toHaveTextContent('Sustain v2');
  });
});
