// @vitest-environment jsdom
/**
 * Gate B-09's component cases (part 4 §3.1 "Must show" and "Never"): the
 * hotbar's six skill states render distinctly with animation disabled, a
 * passive is never a button, inspecting a skill issues no command of any kind,
 * and the waiting reason is the factual one the server's projection carries —
 * the remaining cooldown, or the MP cost against the actor's MP.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { content, gridPosition, type SkillDefinition } from '@narok/data';
import type { PublicActor, PublicState } from '@narok/sim';
import { CommandBar, SkillSlot, type SlotState } from '../src/hud/CommandBar';
import en from '../src/locales/en.json';
import { wireState } from './hunt-fakes';
import '../src/i18n';

beforeEach(() => {
  // Animation disabled: the world's ambient motion is paused, so nothing below
  // may rely on movement to tell one state from another.
  document.body.dataset.paused = 'true';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete document.body.dataset.paused;
});

const skills = content.skills as Record<string, SkillDefinition>;

function cleric(overrides: Partial<PublicActor> = {}): PublicActor {
  return {
    id: 'p0',
    definitionId: 'cleric',
    side: 'party',
    position: gridPosition(1, 4),
    hp: 100,
    mp: 50,
    maxHp: 100,
    maxMp: 50,
    currentTarget: null,
    casting: null,
    targetReason: null,
    cooldowns: {},
    ...overrides,
  } as PublicActor;
}

function stateWith(actor: PublicActor, nowMs = 10_000): PublicState {
  return { ...wireState(nowMs), actors: [actor] } as unknown as PublicState;
}

const STATES: SlotState[] = ['ready', 'active', 'cooldown', 'casting', 'unavailable', 'passive'];

describe('the six skill states (B-09)', () => {
  test('render distinctly, by class, state and accessible name, with animation disabled', () => {
    const onInspect = vi.fn();
    render(
      <ul>
        {STATES.map((state) => (
          <li key={state}>
            <SkillSlot
              actor={cleric()}
              skill={skills.heal!}
              state={state}
              remaining={state === 'cooldown' ? 2 : null}
              inspected={false}
              onInspect={onInspect}
            />
          </li>
        ))}
      </ul>,
    );
    const rendered = STATES.map((state) => document.querySelector(`[data-state="${state}"]`)!);
    expect(rendered.every((element) => element !== null)).toBe(true);
    const slotClasses = rendered.map((element) => element.querySelector('.slot')!.className);
    expect(new Set(slotClasses).size).toBe(STATES.length);
    const names = rendered.map((element) => element.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(STATES.length);
    STATES.forEach((state, index) => expect(names[index]).toContain(en.skillState[state]));
  });

  test('a passive is never a button', () => {
    render(
      <SkillSlot actor={cleric()} skill={skills.heal!} state="passive" remaining={null} inspected={false} onInspect={vi.fn()} />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('img', { name: new RegExp(en.skillState.passive) })).toBeInTheDocument();
  });
});

describe('inspection', () => {
  test('selecting a skill inspects it and issues no cast command', () => {
    const fetchSpy = vi.fn();
    const socketSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('WebSocket', socketSpy);
    const onInspect = vi.fn();
    render(<CommandBar state={stateWith(cleric())} selectedId="p0" inspected={null} onInspect={onInspect} />);

    for (const button of screen.getAllByRole('button')) fireEvent.click(button);
    expect(onInspect).toHaveBeenCalledWith('p0', 'heal');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(socketSpy).not.toHaveBeenCalled();
  });

  test('a cooling-down skill names the remaining time the projection carries', () => {
    const actor = cleric({ cooldowns: { heal: 12_000 } });
    render(<CommandBar state={stateWith(actor)} selectedId="p0" inspected={{ actorId: 'p0', skillId: 'heal' }} onInspect={vi.fn()} />);
    const readout = document.querySelector('.auto-inspection')!;
    expect(readout).toHaveTextContent(en.skillState.cooldown);
    expect(readout.textContent).toMatch(/On cooldown for another 2(\.0)? ?s/);
  });

  test('an MP-starved skill names its cost against the actor’s MP', () => {
    const actor = cleric({ mp: 3 });
    render(<CommandBar state={stateWith(actor)} selectedId="p0" inspected={{ actorId: 'p0', skillId: 'heal' }} onInspect={vi.fn()} />);
    const readout = document.querySelector('.auto-inspection')!;
    expect(readout).toHaveTextContent(en.skillState.unavailable);
    expect(readout.textContent).toContain(`Needs ${skills.heal!.mp} MP`);
    expect(readout.textContent).toContain('has 3 MP');
  });
});
