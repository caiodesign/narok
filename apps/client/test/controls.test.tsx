// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { content } from '@narok/data';
import { defaultStrategy, gridPosition } from '@narok/sim';
import type { ActorId, LabInput, Metrics, PublicState, Strategy } from '@narok/sim';
import { ExperimentControls } from '../src/ExperimentControls';
import { validateLabInput } from '../src/validation';
import { useExperiment, type ClockDriver, type WorkerLike } from '../src/useExperiment';
import type { WorkerRequest, WorkerResponse } from '../src/worker-contract';

function labInput(overrides: Partial<LabInput> = {}): LabInput {
  const classes: LabInput['classes'] = ['guardian', 'cleric', 'ranger'];
  const strategies: Record<ActorId, Strategy> = {};
  classes.forEach((classId, index) => {
    strategies[`p${index}`] = defaultStrategy(classId);
  });
  return {
    seed: 1,
    classes,
    recipe: 'mixed',
    placement: { p0: gridPosition(2, 3), p1: gridPosition(1, 4), p2: gridPosition(3, 4) },
    strategies,
    rest: { hpStart: 50, mpStart: 30 },
    wipeLimit: 1,
    ...overrides,
  };
}

const EMPTY_METRICS: Metrics = {
  kills: 0,
  wins: 0,
  wipes: 0,
  rawExp: 0,
  rawGold: 0,
  damageDealt: 0,
  effectiveHealing: 0,
  walkMs: 0,
  fightMs: 0,
  restMs: 0,
  respawnMs: 0,
  actors: {},
};

afterEach(() => {
  cleanup();
});

function publicState(overrides: Partial<PublicState> = {}): PublicState {
  return {
    nowMs: 0,
    phase: 'walking',
    stopReason: null,
    actors: [],
    metrics: EMPTY_METRICS,
    ...overrides,
  };
}

// --- validation.ts (unit) -----------------------------------------------

describe('validateLabInput', () => {
  test('rejects roster sizes outside 1..3', () => {
    expect(validateLabInput(labInput({ classes: [] }), content)).toContainEqual(
      expect.objectContaining({ field: 'classes', messageKey: 'validation.rosterSize' }),
    );
    expect(
      validateLabInput(labInput({ classes: ['guardian', 'cleric', 'ranger', 'arcanist'] }), content),
    ).toContainEqual(expect.objectContaining({ field: 'classes', messageKey: 'validation.rosterSize' }));
  });

  test('accepts roster sizes 1 and 3', () => {
    const one = labInput({ classes: ['guardian'], placement: { p0: gridPosition(2, 3) } });
    const three = labInput();
    expect(validateLabInput(one, content).some((issue) => issue.field === 'classes')).toBe(false);
    expect(validateLabInput(three, content).some((issue) => issue.field === 'classes')).toBe(false);
  });

  test('rejects an unknown class id', () => {
    const input = labInput({ classes: ['not-a-class' as LabInput['classes'][number]] });
    expect(validateLabInput(input, content)).toContainEqual(
      expect.objectContaining({ field: 'classes.0', messageKey: 'validation.unknownClass' }),
    );
  });

  test('rejects a seed outside 1..4294967295', () => {
    expect(validateLabInput(labInput({ seed: 0 }), content)).toContainEqual(
      expect.objectContaining({ field: 'seed' }),
    );
    expect(validateLabInput(labInput({ seed: 4_294_967_296 }), content)).toContainEqual(
      expect.objectContaining({ field: 'seed' }),
    );
    expect(validateLabInput(labInput({ seed: 1.5 }), content)).toContainEqual(
      expect.objectContaining({ field: 'seed' }),
    );
  });

  test('rejects an unknown recipe', () => {
    const input = labInput({ recipe: 'not-a-recipe' as LabInput['recipe'] });
    expect(validateLabInput(input, content)).toContainEqual(
      expect.objectContaining({ field: 'recipe', messageKey: 'validation.unknownRecipe' }),
    );
  });

  test('rejects duplicate placement cells', () => {
    const input = labInput({ placement: { p0: gridPosition(1, 4), p1: gridPosition(1, 4), p2: gridPosition(3, 4) } });
    expect(validateLabInput(input, content)).toContainEqual(
      expect.objectContaining({ field: 'placement.p1', messageKey: 'validation.duplicatePlacement' }),
    );
  });

  test('rejects a cell outside the grid or off the party side', () => {
    const enemySide = labInput({ placement: { p0: gridPosition(2, 0), p1: gridPosition(1, 4), p2: gridPosition(3, 4) } });
    expect(validateLabInput(enemySide, content)).toContainEqual(
      expect.objectContaining({ field: 'placement.p0', messageKey: 'validation.invalidCell' }),
    );
    const outOfBounds = labInput({ placement: { p0: gridPosition(99, 99), p1: gridPosition(1, 4), p2: gridPosition(3, 4) } });
    expect(validateLabInput(outOfBounds, content)).toContainEqual(
      expect.objectContaining({ field: 'placement.p0', messageKey: 'validation.invalidCell' }),
    );
  });

  test('rejects rest thresholds outside 0..100', () => {
    expect(validateLabInput(labInput({ rest: { hpStart: -1, mpStart: 30 } }), content)).toContainEqual(
      expect.objectContaining({ field: 'rest.hpStart', messageKey: 'validation.restRange' }),
    );
    expect(validateLabInput(labInput({ rest: { hpStart: 50, mpStart: 101 } }), content)).toContainEqual(
      expect.objectContaining({ field: 'rest.mpStart', messageKey: 'validation.restRange' }),
    );
  });

  test('rejects wipeLimit < 1', () => {
    expect(validateLabInput(labInput({ wipeLimit: 0 }), content)).toContainEqual(
      expect.objectContaining({ field: 'wipeLimit', messageKey: 'validation.wipeLimit' }),
    );
  });

  test('rejects a rule threshold outside its declared range', () => {
    const strategies: Record<ActorId, Strategy> = {
      p0: defaultStrategy('guardian'),
      p1: defaultStrategy('cleric'),
      p2: defaultStrategy('ranger'),
    };
    strategies.p1 = {
      ...strategies.p1,
      rules: strategies.p1.rules.map((rule) =>
        rule.skillId === 'heal' ? { ...rule, condition: { kind: 'ally-hp-below' as const, value: 500 } } : rule,
      ),
    };
    const input = labInput({ strategies });
    expect(validateLabInput(input, content)).toContainEqual(
      expect.objectContaining({ field: 'strategies.p1.rules.0.condition.value', messageKey: 'validation.ruleThreshold' }),
    );
  });

  test('a fully valid default input has no issues', () => {
    expect(validateLabInput(labInput(), content)).toEqual([]);
  });
});

// --- ExperimentControls (component) --------------------------------------

describe('ExperimentControls', () => {
  function setup() {
    const onStart = vi.fn();
    render(
      <ExperimentControls
        content={content}
        status="idle"
        onStart={onStart}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onStop={vi.fn()}
        onSpeedChange={vi.fn()}
      />,
    );
    return { onStart };
  }

  test('marks invalid (non-party) cells with aria-disabled and a visible, non-colour marker', () => {
    setup();
    const grid = screen.getByRole('grid', { name: /battlefield placement grid/i });
    const rows = within(grid).getAllByRole('row');
    // Row 0 is an enemy row (content.grid.enemyRows = [0, 1]) -> every cell invalid for placement.
    const enemyCell = within(rows[0]).getAllByRole('gridcell')[0];
    expect(enemyCell.getAttribute('aria-disabled')).toBe('true');
    expect(enemyCell.textContent).toBe('×');
  });

  test('selecting a character shows a text label naming the selection (non-colour signal)', () => {
    setup();
    expect(screen.getByText(/no character selected/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select p0' }));
    expect(screen.getByText('Selected: guardian (p0)')).toBeTruthy();
  });

  test('duplicate placement cells are rejected and disable Start', () => {
    setup();
    const grid = screen.getByRole('grid', { name: /battlefield placement grid/i });
    const rows = within(grid).getAllByRole('row');
    const partyCell = within(rows[4]).getAllByRole('gridcell')[1]; // row 4, column 1 -> (1,4)

    fireEvent.click(screen.getByRole('button', { name: 'Select p0' }));
    fireEvent.click(partyCell);
    fireEvent.click(screen.getByRole('button', { name: 'Select p1' }));
    fireEvent.click(partyCell);

    expect(screen.getByText(/two members cannot share a cell/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('placement is operable by keyboard: arrow keys move focus, Enter places the selected character', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Select p0' }));

    const grid = screen.getByRole('grid', { name: /battlefield placement grid/i });
    const rows = within(grid).getAllByRole('row');
    const origin = within(rows[0]).getAllByRole('gridcell')[0];
    origin.focus();

    // Move from (0,0) down to row 4 (a party row) via ArrowDown x4, then Enter to place.
    fireEvent.keyDown(origin, { key: 'ArrowDown' });
    const afterRows = within(grid).getAllByRole('row');
    let focused = document.activeElement as HTMLElement;
    for (let i = 0; i < 3; i += 1) {
      fireEvent.keyDown(focused, { key: 'ArrowDown' });
      focused = document.activeElement as HTMLElement;
    }
    fireEvent.keyDown(focused, { key: 'Enter' });

    const targetCell = within(afterRows[4]).getAllByRole('gridcell')[0];
    expect(targetCell.textContent).toBe('p0');
  });

  test('roster sizes 1 and 3 are accepted (no roster-size validation message)', () => {
    setup();
    fireEvent.click(screen.getByLabelText('1'));
    expect(screen.queryByText(/roster must have/i)).toBeNull();
    fireEvent.click(screen.getByLabelText('3'));
    expect(screen.queryByText(/roster must have/i)).toBeNull();
  });

  test('a fully valid setup enables Start, and Start hands the draft to onStart', () => {
    const { onStart } = setup();
    const grid = screen.getByRole('grid', { name: /battlefield placement grid/i });
    const rows = within(grid).getAllByRole('row');

    fireEvent.click(screen.getByRole('button', { name: 'Select p0' }));
    fireEvent.click(within(rows[3]).getAllByRole('gridcell')[2]); // (2,3)
    fireEvent.click(screen.getByRole('button', { name: 'Select p1' }));
    fireEvent.click(within(rows[4]).getAllByRole('gridcell')[1]); // (1,4)
    fireEvent.click(screen.getByRole('button', { name: 'Select p2' }));
    fireEvent.click(within(rows[4]).getAllByRole('gridcell')[3]); // (3,4)

    const startButton = screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(false);
    fireEvent.click(startButton);
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});

// --- useExperiment (hook, driven through a hand-written fake worker) -----

class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  sent: WorkerRequest[] = [];
  terminated = false;

  postMessage(message: WorkerRequest): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(message: WorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>);
  }
}

function createManualDriver(): { driver: ClockDriver; setNow: (ms: number) => void; pump: () => void } {
  let currentNow = 0;
  let pending: Array<() => void> = [];
  const driver: ClockDriver = {
    now: () => currentNow,
    schedule: (callback) => {
      pending.push(callback);
      return pending.length;
    },
    cancel: () => {
      // Manual driver: cancellation is a no-op, matched by pump() only ever
      // running callbacks captured at the start of its own call.
    },
  };
  return {
    driver,
    setNow: (ms: number) => {
      currentNow = ms;
    },
    pump: () => {
      const due = pending;
      pending = [];
      due.forEach((callback) => callback());
    },
  };
}

describe('useExperiment', () => {
  let workers: FakeWorker[];
  let createWorker: () => WorkerLike;

  beforeEach(() => {
    workers = [];
    createWorker = () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('pause and speed changes reanchor the clock without sending the worker an advance', () => {
    const { driver, setNow, pump } = createManualDriver();
    const { result } = renderHook(() => useExperiment({ driver, createWorker }));

    act(() => result.current.start(labInput()));
    const worker = workers[0];
    expect(worker.sent).toEqual([{ type: 'start', generation: 1, input: labInput() }]);

    act(() => worker.respond({ type: 'frame', generation: 1, state: publicState(), events: [], reachedTarget: true }));
    expect(result.current.status).toBe('running');

    act(() => result.current.pause());
    setNow(20_000);
    act(() => pump());
    expect(worker.sent).toHaveLength(1); // still just the initial start

    act(() => result.current.setSpeed(16));
    act(() => pump());
    expect(worker.sent).toHaveLength(1);

    act(() => result.current.resume());
    act(() => pump()); // horizon is still 0 right at the resume anchor: no new work yet
    expect(worker.sent).toHaveLength(1);

    setNow(25_000); // 5s of real time at the new 16x speed
    act(() => pump());
    expect(worker.sent).toHaveLength(2);
    expect(worker.sent[1]).toMatchObject({ type: 'advance', generation: 1 });
  });

  test('never sends two outstanding advances (bounded pending frames)', () => {
    const { driver, setNow, pump } = createManualDriver();
    const { result } = renderHook(() => useExperiment({ driver, createWorker }));

    act(() => result.current.start(labInput()));
    const worker = workers[0];
    act(() => worker.respond({ type: 'frame', generation: 1, state: publicState(), events: [], reachedTarget: true }));

    setNow(5000);
    act(() => pump());
    expect(worker.sent).toHaveLength(2); // start + first advance

    // A second tick before the worker responds must not send another advance.
    setNow(9000);
    act(() => pump());
    expect(worker.sent).toHaveLength(2);
  });

  test('requests exactly the supplied horizon, never beyond it, and resends the same target while incomplete', () => {
    const { driver, setNow, pump } = createManualDriver();
    const { result } = renderHook(() => useExperiment({ driver, createWorker }));

    act(() => result.current.start(labInput()));
    const worker = workers[0];
    act(() => worker.respond({ type: 'frame', generation: 1, state: publicState(), events: [], reachedTarget: true }));

    setNow(5000);
    act(() => pump());
    // horizon = floor(0 + (5000 - 0) * 1 - 2000) = 3000
    expect(worker.sent[1]).toMatchObject({ type: 'advance', generation: 1, untilMs: 3000 });

    act(() =>
      worker.respond({
        type: 'frame',
        generation: 1,
        state: publicState({ nowMs: 1000 }),
        events: [],
        reachedTarget: false,
      }),
    );
    // Incomplete batch: immediately resent to the SAME target, not a new one.
    expect(worker.sent[2]).toMatchObject({ type: 'advance', generation: 1, untilMs: 3000 });
  });

  test('worker error transitions to error status and recovers to usable running on the next start', () => {
    const { driver, pump } = createManualDriver();
    const { result } = renderHook(() => useExperiment({ driver, createWorker }));

    act(() => result.current.start(labInput()));
    const first = workers[0];
    act(() => first.respond({ type: 'error', generation: 1, code: 'STALE_GENERATION', field: 'advance' }));
    expect(result.current.status).toBe('error');

    act(() => result.current.start(labInput()));
    const second = workers[1];
    expect(second.sent).toEqual([{ type: 'start', generation: 2, input: labInput() }]);
    act(() => second.respond({ type: 'frame', generation: 2, state: publicState(), events: [], reachedTarget: true }));
    expect(result.current.status).toBe('running');
    void pump;
  });

  test('a stale (superseded) generation frame is dropped with no effect (dropped-older branch)', () => {
    const { driver, pump } = createManualDriver();
    const { result } = renderHook(() => useExperiment({ driver, createWorker }));

    act(() => result.current.start(labInput()));
    const first = workers[0];
    act(() => first.respond({ type: 'frame', generation: 1, state: publicState(), events: [], reachedTarget: true }));

    act(() => result.current.start(labInput())); // generation becomes 2
    const second = workers[1];
    act(() => second.respond({ type: 'frame', generation: 2, state: publicState({ nowMs: 42 }), events: [], reachedTarget: true }));
    expect(result.current.state?.nowMs).toBe(42);

    // A late frame from the superseded generation 1 worker must be ignored.
    act(() => first.respond({ type: 'frame', generation: 1, state: publicState({ nowMs: 999 }), events: [], reachedTarget: true }));
    expect(result.current.state?.nowMs).toBe(42);
    expect(result.current.status).toBe('running');
    void pump;
  });

  test('an errored-unseen-generation response surfaces as a worker error', () => {
    const { driver, pump } = createManualDriver();
    const { result } = renderHook(() => useExperiment({ driver, createWorker }));

    act(() => result.current.start(labInput()));
    const worker = workers[0];
    act(() => worker.respond({ type: 'frame', generation: 1, state: publicState(), events: [], reachedTarget: true }));

    // The worker reports a protocol bug: a request referenced a generation it
    // never established (or arrived with no experiment loaded).
    act(() => worker.respond({ type: 'error', generation: 1, code: 'STALE_GENERATION', field: 'stop' }));
    expect(result.current.status).toBe('error');
    void pump;
  });

  test('produces comparison summaries on completion and shifts A/B across two runs', () => {
    const { driver, pump } = createManualDriver();
    const { result } = renderHook(() => useExperiment({ driver, createWorker }));

    act(() => result.current.start(labInput({ seed: 1 })));
    const first = workers[0];
    act(() =>
      first.respond({
        type: 'frame',
        generation: 1,
        state: publicState({ phase: 'stopped', stopReason: 'operator', nowMs: 100 }),
        events: [],
        reachedTarget: true,
      }),
    );
    expect(result.current.status).toBe('stopped');
    expect(result.current.comparisonB?.nowMs).toBe(100);
    expect(result.current.comparisonA).toBeNull();

    act(() => result.current.start(labInput({ seed: 2 })));
    const second = workers[1];
    act(() =>
      second.respond({
        type: 'frame',
        generation: 2,
        state: publicState({ phase: 'stopped', stopReason: 'operator', nowMs: 200 }),
        events: [],
        reachedTarget: true,
      }),
    );
    expect(result.current.comparisonB?.nowMs).toBe(200);
    expect(result.current.comparisonA?.nowMs).toBe(100);
    void pump;
  });
});
