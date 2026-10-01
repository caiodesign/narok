// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { PublicState } from '@narok/sim';
import { SessionPanel } from '../src/hud/SessionPanel';
import '../src/i18n';

afterEach(() => {
  cleanup();
});

function state(nowMs: number, overrides: Partial<PublicState['metrics']> = {}): PublicState {
  const metrics = {
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
    consumed: {},
    actors: {},
    ...overrides,
  } as unknown as PublicState['metrics'];
  return { nowMs, phase: 'fighting', stopReason: null, actors: [], metrics };
}

describe('the session window', () => {
  // UI spec §4: "Observed rates include their measurement window and handle zero
  // duration." A per-hour figure read off 2.6 seconds is not wrong, but it is
  // unreadable without the window it was divided by, and the window lives in a
  // different window of the HUD.
  test('names the window its rates were measured over', () => {
    render(<SessionPanel state={state(2_600, { damageDealt: 178 })} />);

    expect(screen.getByTestId('session-window')).toHaveTextContent('2.6 s');
  });

  test('a rate is still the rate: damage over 2.6 s is its hourly projection', () => {
    render(<SessionPanel state={state(2_600, { damageDealt: 178 })} />);

    expect(screen.getByTestId('session-damage-per-hour')).toHaveTextContent('246,461.5');
  });

  test('zero elapsed time measures nothing, and says so rather than printing a duration', () => {
    render(<SessionPanel state={state(0)} />);

    expect(screen.getByTestId('session-damage-per-hour')).toHaveTextContent('—');
    expect(screen.getByTestId('session-window')).toHaveTextContent(
      'No simulated time elapsed, so no rate can be measured.',
    );
  });

  test('before any run there is no window at all, not a zero one', () => {
    render(<SessionPanel state={null} />);

    expect(screen.getByTestId('session-window')).toHaveTextContent(
      'No simulated time elapsed, so no rate can be measured.',
    );
  });
});
