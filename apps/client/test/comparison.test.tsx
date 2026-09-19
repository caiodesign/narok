// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { Comparison } from '../src/Comparison';
import '../src/i18n';
import { lab, labInput } from '../../../packages/sim/test/fixtures';

afterEach(() => {
  cleanup();
});

// --- binding snippet from the plan (Task 10), reproduced verbatim -----------
test('comparison renders actual-time rates and zero-time absence', () => {
  const sim = lab();
  const input = labInput();
  const initial = sim.project(sim.start(input));
  const completed = { ...initial, nowMs: 30000,
    metrics: { ...initial.metrics, kills: 5 } };
  render(<Comparison runs={[{ input, state: completed }, { input, state: initial }]} />);
  const a = within(screen.getByTestId('comparison-slot-a'));
  const b = within(screen.getByTestId('comparison-slot-b'));
  expect(a.getByTestId('kills-per-hour')).toHaveTextContent('600');
  expect(a.getByTestId('elapsed-time')).toHaveTextContent('30 s');
  expect(b.getByTestId('kills-per-hour')).toHaveTextContent('—');
});
// --- end binding snippet ---------------------------------------------------

test('both slots always exist; an absent run renders an explicit empty state', () => {
  render(<Comparison runs={[]} />);
  const a = screen.getByTestId('comparison-slot-a');
  const b = screen.getByTestId('comparison-slot-b');
  expect(a).toBeInTheDocument();
  expect(b).toBeInTheDocument();
  // Not a blank box (R63): each empty slot says, in words, that it holds no run.
  expect(a.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  expect(b.textContent?.trim().length ?? 0).toBeGreaterThan(0);
});

test('R81: an empty slot carries neither the elapsed-time nor the kills-per-hour test id', () => {
  render(<Comparison runs={[]} />);
  expect(screen.queryAllByTestId('elapsed-time')).toHaveLength(0);
  expect(screen.queryAllByTestId('kills-per-hour')).toHaveLength(0);
});

test('a single retained run fills slot A and leaves slot B empty', () => {
  const sim = lab();
  const input = labInput();
  const state = sim.project(sim.start(input));
  render(<Comparison runs={[{ input, state: { ...state, nowMs: 60_000, metrics: { ...state.metrics, kills: 2 } } }]} />);

  const a = within(screen.getByTestId('comparison-slot-a'));
  expect(a.getByTestId('elapsed-time')).toHaveTextContent('1 min 0 s');
  expect(a.getByTestId('kills-per-hour')).toHaveTextContent('120');
  expect(within(screen.getByTestId('comparison-slot-b')).queryByTestId('kills-per-hour')).toBeNull();
});

test('no fabricated figure reaches the DOM: never NaN, never Infinity', () => {
  const sim = lab();
  const input = labInput();
  const zero = sim.project(sim.start(input));
  render(
    <Comparison
      runs={[
        { input, state: { ...zero, nowMs: 0, metrics: { ...zero.metrics, kills: 7 } } },
        { input, state: zero },
      ]}
    />,
  );
  const text = screen.getByTestId('comparison-slot-a').textContent ?? '';
  expect(text).not.toMatch(/NaN|Infinity/);
  expect(within(screen.getByTestId('comparison-slot-a')).getByTestId('kills-per-hour')).toHaveTextContent('—');
});

test('the stop report states observed facts only (stop reason, wipes, kills, elapsed)', () => {
  const sim = lab();
  const input = labInput();
  const state = sim.project(sim.start(input));
  render(
    <Comparison
      runs={[
        {
          input,
          state: {
            ...state,
            nowMs: 30_000,
            phase: 'stopped',
            stopReason: 'wipe-limit',
            metrics: { ...state.metrics, kills: 5, wipes: 1 },
          },
        },
      ]}
    />,
  );
  const a = within(screen.getByTestId('comparison-slot-a'));
  expect(a.getByTestId('stop-reason')).toHaveTextContent('Wipe limit reached');
  expect(a.getByTestId('wipes')).toHaveTextContent('1');
  expect(a.getByTestId('kills')).toHaveTextContent('5');
});
