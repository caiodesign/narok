/**
 * The run status the HUD's controls and readouts render. It was declared beside
 * the laboratory's `useExperiment` hook; that hook moved to `apps/lab` (Task 8),
 * and the HUD that stays here may not import the laboratory (ruling R164), so the
 * type lives with the HUD and the lab imports it from `@narok/client`.
 */
export type ExperimentStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'error';
