/**
 * Renders the laboratory controls plus a plain, factual placeholder where the
 * battlefield board and event log will go (ruling R57). `BattlefieldView.tsx`
 * (PixiJS), `EventLog.tsx`, `Comparison.tsx`, and real i18n are Task 10 — this
 * never fabricates a mock board or invented numbers in their place.
 */
import { content } from '@narok/data';
import { ExperimentControls } from './ExperimentControls';
import { useExperiment } from './useExperiment';

export function App(): React.JSX.Element {
  const { state, status, start, pause, resume, stop, setSpeed } = useExperiment();

  return (
    <main>
      <h1>Combat laboratory</h1>
      <ExperimentControls
        content={content}
        status={status}
        onStart={start}
        onPause={pause}
        onResume={resume}
        onStop={stop}
        onSpeedChange={setSpeed}
      />
      <section aria-label="Battlefield and event log placeholder">
        <p>
          The battlefield view and event log are not part of this build (Task 10). This panel reports
          only the real, currently held experiment status below — it never displays a mock board or
          invented numbers.
        </p>
        <p>Status: {status}</p>
        <p>Simulated time: {state ? `${state.nowMs} ms` : '—'}</p>
        <p>Phase: {state ? state.phase : '—'}</p>
      </section>
    </main>
  );
}
