// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { content, validateContent } from '@narok/data';
import { createGrid, createSimulation, defaultStrategy, gridPosition, SimError } from '@narok/sim';
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

  test('rejects rest thresholds outside their sim-enforced bounds (R76: hpStart 0..89, mpStart 0..79)', () => {
    expect(validateLabInput(labInput({ rest: { hpStart: -1, mpStart: 30 } }), content)).toContainEqual(
      expect.objectContaining({ field: 'rest.hpStart', messageKey: 'validation.restRange' }),
    );
    expect(
      validateLabInput(labInput({ rest: { hpStart: 89, mpStart: 30 } }), content).some(
        (issue) => issue.field === 'rest.hpStart',
      ),
    ).toBe(false);
    expect(validateLabInput(labInput({ rest: { hpStart: 90, mpStart: 30 } }), content)).toContainEqual(
      expect.objectContaining({ field: 'rest.hpStart', messageKey: 'validation.restRange' }),
    );
    expect(
      validateLabInput(labInput({ rest: { hpStart: 50, mpStart: 79 } }), content).some(
        (issue) => issue.field === 'rest.mpStart',
      ),
    ).toBe(false);
    expect(validateLabInput(labInput({ rest: { hpStart: 50, mpStart: 80 } }), content)).toContainEqual(
      expect.objectContaining({ field: 'rest.mpStart', messageKey: 'validation.restRange' }),
    );
  });

  test('rejects a wipeLimit outside its sim-enforced bounds (R76: 1..5)', () => {
    expect(validateLabInput(labInput({ wipeLimit: 0 }), content)).toContainEqual(
      expect.objectContaining({ field: 'wipeLimit', messageKey: 'validation.wipeLimit' }),
    );
    expect(validateLabInput(labInput({ wipeLimit: 5 }), content).some((issue) => issue.field === 'wipeLimit')).toBe(
      false,
    );
    expect(validateLabInput(labInput({ wipeLimit: 6 }), content)).toContainEqual(
      expect.objectContaining({ field: 'wipeLimit', messageKey: 'validation.wipeLimit' }),
    );
  });

  test('R76: client rest/wipeLimit bounds agree with the real sim at every boundary, so they cannot silently drift apart', () => {
    const validated = validateContent(content);
    const sim = createSimulation(validated, createGrid(validated.grid, validated.shapes));

    function simRejects(candidate: LabInput, field: string): boolean {
      try {
        sim.start(candidate);
        return false;
      } catch (error) {
        return error instanceof SimError && error.field === field;
      }
    }

    for (let value = -1; value <= 100; value += 1) {
      const hpCandidate = labInput({ rest: { hpStart: value, mpStart: 30 } });
      const clientRejectsHp = validateLabInput(hpCandidate, content).some((issue) => issue.field === 'rest.hpStart');
      expect(clientRejectsHp).toBe(simRejects(hpCandidate, 'input.rest.hpStart'));

      const mpCandidate = labInput({ rest: { hpStart: 50, mpStart: value } });
      const clientRejectsMp = validateLabInput(mpCandidate, content).some((issue) => issue.field === 'rest.mpStart');
      expect(clientRejectsMp).toBe(simRejects(mpCandidate, 'input.rest.mpStart'));
    }

    for (let value = -1; value <= 8; value += 1) {
      const candidate = labInput({ wipeLimit: value });
      const clientRejects = validateLabInput(candidate, content).some((issue) => issue.field === 'wipeLimit');
      expect(clientRejects).toBe(simRejects(candidate, 'input.wipeLimit'));
    }
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

  test('rejects an "attacking" target mode whose partyId has fallen out of the roster', () => {
    const strategies: Record<ActorId, Strategy> = {
      p0: { ...defaultStrategy('guardian'), target: { kind: 'attacking', partyId: 'p9' } },
      p1: defaultStrategy('cleric'),
      p2: defaultStrategy('ranger'),
    };
    const input = labInput({ strategies });
    expect(validateLabInput(input, content)).toContainEqual(
      expect.objectContaining({
        field: 'strategies.p0.target.partyId',
        messageKey: 'validation.unknownTargetParty',
      }),
    );
  });

  test('accepts an "attacking" target mode whose partyId is a current roster member', () => {
    const strategies: Record<ActorId, Strategy> = {
      p0: { ...defaultStrategy('guardian'), target: { kind: 'attacking', partyId: 'p1' } },
      p1: defaultStrategy('cleric'),
      p2: defaultStrategy('ranger'),
    };
    const input = labInput({ strategies });
    expect(validateLabInput(input, content).some((issue) => issue.messageKey === 'validation.unknownTargetParty')).toBe(
      false,
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

  test('R77: the placement grid is reachable by Tab alone from a cold page load', () => {
    setup();
    const grid = screen.getByRole('grid', { name: /battlefield placement grid/i });
    const cells = within(grid).getAllByRole('gridcell');

    // Roving tabindex: exactly one cell is in the page's tab sequence. If that
    // cell is a native-disabled (or aria-disabled) enemy-row cell, a real Tab
    // press skips the whole grid entirely -- there is no other way in.
    const tabbable = cells.filter((cell) => cell.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
    const [entryPoint] = tabbable;
    expect((entryPoint as HTMLButtonElement).disabled).toBe(false);
    expect(entryPoint.getAttribute('aria-disabled')).not.toBe('true');

    // Prove it with REAL focus (not a hand-picked node + a synthetic event):
    // this is exactly what pressing Tab from outside the grid would land on.
    entryPoint.focus();
    expect(document.activeElement).toBe(entryPoint);
  });

  test('R77: arrow-key navigation moves real DOM focus and never lands on a disabled cell', () => {
    setup();
    const grid = screen.getByRole('grid', { name: /battlefield placement grid/i });
    const entryPoint = within(grid).getAllByRole('gridcell').find((cell) => cell.getAttribute('tabindex') === '0');
    if (!entryPoint) throw new Error('no tabbable cell found');
    entryPoint.focus();
    expect(document.activeElement).toBe(entryPoint);

    // Party rows are [3, 4] (enemyRows = [0, 1]): moving "up" from the first
    // party row must clamp within party rows, not walk onto a disabled cell.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    expect((document.activeElement as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement?.getAttribute('aria-disabled')).not.toBe('true');

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    const afterDown = document.activeElement as HTMLButtonElement;
    expect(afterDown.disabled).toBe(false);
    expect(afterDown.getAttribute('aria-disabled')).not.toBe('true');
    expect(afterDown).not.toBe(entryPoint); // actually moved to the other party row

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' });
    expect((document.activeElement as HTMLButtonElement).disabled).toBe(false);
  });

  test('placement is operable by keyboard: real Tab-reachable focus, arrow keys, Enter places the selected character', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Select p0' }));

    const grid = screen.getByRole('grid', { name: /battlefield placement grid/i });
    const entryPoint = within(grid).getAllByRole('gridcell').find((cell) => cell.getAttribute('tabindex') === '0');
    if (!entryPoint) throw new Error('no tabbable cell found');
    entryPoint.focus();
    expect(document.activeElement).toBe(entryPoint); // real focus, not a hand-picked node

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' });

    const rows = within(grid).getAllByRole('row');
    const placedInRow3 = within(rows[3])
      .getAllByRole('gridcell')
      .some((cell) => cell.textContent === 'p0');
    const placedInRow4 = within(rows[4])
      .getAllByRole('gridcell')
      .some((cell) => cell.textContent === 'p0');
    expect(placedInRow3 || placedInRow4).toBe(true);
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

  test('R80: the speed control resyncs to 1x on a new start (the hook always starts a fresh run at 1x)', () => {
    const { onStart } = setup();
    const grid = screen.getByRole('grid', { name: /battlefield placement grid/i });
    const rows = within(grid).getAllByRole('row');

    fireEvent.click(screen.getByRole('button', { name: 'Select p0' }));
    fireEvent.click(within(rows[3]).getAllByRole('gridcell')[2]);
    fireEvent.click(screen.getByRole('button', { name: 'Select p1' }));
    fireEvent.click(within(rows[4]).getAllByRole('gridcell')[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Select p2' }));
    fireEvent.click(within(rows[4]).getAllByRole('gridcell')[3]);

    const speed16 = screen.getByRole('radio', { name: '16x' }) as HTMLInputElement;
    fireEvent.click(speed16);
    expect(speed16.checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(onStart).toHaveBeenCalledTimes(1);

    const speed1 = screen.getByRole('radio', { name: '1x' }) as HTMLInputElement;
    expect(speed1.checked).toBe(true);
    expect((screen.getByRole('radio', { name: '16x' }) as HTMLInputElement).checked).toBe(false);
  });

  test('each roster member has a target mode selector; choosing "attacking" reveals a roster ally selector', () => {
    setup();
    const group = within(screen.getByRole('group', { name: 'Strategy: p0' }));
    const kindSelect = group.getByLabelText('Target mode') as HTMLSelectElement;
    // guardian's defaultStrategy() target is { kind: 'nearest' }.
    expect(kindSelect.value).toBe('nearest');

    expect(group.queryByLabelText('Watch ally')).toBeNull();
    fireEvent.change(kindSelect, { target: { value: 'attacking' } });

    const allySelect = group.getByLabelText('Watch ally') as HTMLSelectElement;
    expect(within(allySelect).getAllByRole('option')).toHaveLength(3); // p0, p1, p2
    expect(allySelect.value).toBe('p1'); // defaults to a roster member other than self

    fireEvent.change(allySelect, { target: { value: 'p2' } });
    expect(allySelect.value).toBe('p2');
  });

  test('orphaning an "attacking" target by shrinking the roster surfaces a validation message', () => {
    setup();
    const group = within(screen.getByRole('group', { name: 'Strategy: p0' }));
    fireEvent.change(group.getByLabelText('Target mode'), { target: { value: 'attacking' } });
    fireEvent.change(group.getByLabelText('Watch ally'), { target: { value: 'p2' } });

    fireEvent.click(screen.getByLabelText('1')); // shrink roster to just p0 -> p2 no longer exists
    expect(screen.getByText(/no longer in the roster/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('rule order is reorderable with labelled, keyboard-reachable move buttons; order is priority', () => {
    setup();
    const group = within(screen.getByRole('group', { name: 'Strategy: p0' }));
    const ruleLabel = (): string[] =>
      group.getAllByRole('checkbox').map((checkbox) => checkbox.closest('label')?.textContent?.trim() ?? '');

    // guardian's defaultStrategy() rules are [taunt, cleave].
    expect(ruleLabel()).toEqual(['taunt', 'cleave']);

    const moveTauntDown = group.getByRole('button', { name: 'Move taunt down for p0' }) as HTMLButtonElement;
    expect(moveTauntDown.disabled).toBe(false);
    expect((group.getByRole('button', { name: 'Move taunt up for p0' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(moveTauntDown);
    expect(ruleLabel()).toEqual(['cleave', 'taunt']);
    // Having moved to the end, taunt can no longer move down, and cleave (now first) can't move up.
    expect((group.getByRole('button', { name: 'Move taunt down for p0' }) as HTMLButtonElement).disabled).toBe(true);
    expect((group.getByRole('button', { name: 'Move cleave up for p0' }) as HTMLButtonElement).disabled).toBe(true);
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

  test('R79: stop() participates in the pending marker instead of firing regardless of an outstanding advance', () => {
    const { driver, setNow, pump } = createManualDriver();
    const { result } = renderHook(() => useExperiment({ driver, createWorker }));

    act(() => result.current.start(labInput()));
    const worker = workers[0];
    act(() => worker.respond({ type: 'frame', generation: 1, state: publicState(), events: [], reachedTarget: true }));

    setNow(5000);
    act(() => pump()); // sends the first advance; still unanswered
    expect(worker.sent).toHaveLength(2);
    expect(worker.sent[1]).toMatchObject({ type: 'advance', generation: 1 });

    act(() => result.current.stop());
    // The outstanding advance hasn't been answered yet -- a correctly-gated
    // stop must not fire alongside it (tied to request identity, not a bare
    // boolean that stop ignores).
    expect(worker.sent).toHaveLength(2);

    act(() =>
      worker.respond({
        type: 'frame',
        generation: 1,
        state: publicState({ nowMs: 1000 }),
        events: [],
        reachedTarget: false,
      }),
    );
    // The outstanding advance's own response arrives, reporting incomplete
    // work. The deferred stop must be sent now -- and the advance must NOT be
    // resent even though reachedTarget was false, because a frame only clears
    // the pending marker for the request it actually answers, and a stop is
    // what's actually pending by the time this frame lands.
    expect(worker.sent).toHaveLength(3);
    expect(worker.sent[2]).toEqual({ type: 'stop', generation: 1 });
  });
});
