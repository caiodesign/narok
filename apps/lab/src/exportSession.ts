/**
 * Session export: everything that happened in the laboratory, as one JSON file.
 *
 * The simulation is deterministic, so `input` (which carries the seed) plus the
 * three version hashes is enough to reproduce a run exactly — the bundle does
 * not need, and deliberately does not carry, an encoded snapshot. What it adds
 * beyond reproducibility is the *observed* record: the retained event log, the
 * ending projection, and both comparison slots.
 *
 * `buildSessionExport` is pure so it can be tested without a DOM. `downloadJson`
 * is the only part that touches the browser, and it writes a local file — the
 * client still makes no network request of any kind (ruling R51).
 */
import type { DomainEvent, LabInput, PublicState } from '@narok/sim';
import type { Summary } from './useExperiment';

/** Bumped only when the bundle's own shape changes, independent of the sim version. */
export const SESSION_EXPORT_FORMAT = 1;

export interface SessionExportVersions {
  simulationVersion: string;
  contentVersion: string;
  gridHash: string;
}

export interface SessionExportRun {
  label: string;
  input: LabInput;
  nowMs: number;
  stopReason: string | null;
  metrics: Summary['metrics'];
}

export interface SessionExport {
  format: number;
  exportedAt: string;
  versions: SessionExportVersions;
  status: string;
  /** The input the *running* experiment was started with; null before any start. */
  input: LabInput | null;
  /** The live projection at export time, including its metrics. */
  state: PublicState | null;
  /**
   * The retained event log. The hook caps history at 500 entries for display
   * (ruling R54), so a long run exports its most recent 500 — `eventsTruncated`
   * says whether that cap was reached, because a silently short log would
   * misrepresent the run.
   */
  events: DomainEvent[];
  eventCount: number;
  eventsTruncated: boolean;
  /** Retained comparison runs: A is the earlier, B the latest (ruling R54/R63). */
  comparison: { a: SessionExportRun | null; b: SessionExportRun | null };
}

export interface BuildSessionExportInput {
  versions: SessionExportVersions;
  status: string;
  input: LabInput | null;
  state: PublicState | null;
  events: DomainEvent[];
  eventHistoryLimit: number;
  comparisonA: Summary | null;
  comparisonB: Summary | null;
  /** Injected so tests are not clock-dependent. */
  now: () => Date;
}

function toRun(summary: Summary | null): SessionExportRun | null {
  if (summary === null) return null;
  return {
    label: summary.label,
    input: summary.input,
    nowMs: summary.nowMs,
    stopReason: summary.stopReason,
    metrics: summary.metrics,
  };
}

export function buildSessionExport(source: BuildSessionExportInput): SessionExport {
  return {
    format: SESSION_EXPORT_FORMAT,
    exportedAt: source.now().toISOString(),
    versions: source.versions,
    status: source.status,
    input: source.input,
    state: source.state,
    events: source.events,
    eventCount: source.events.length,
    eventsTruncated: source.events.length >= source.eventHistoryLimit,
    comparison: { a: toRun(source.comparisonA), b: toRun(source.comparisonB) },
  };
}

/** `narok-session-<seed>-<timestamp>.json`, or `unseeded` before any run started. */
export function sessionExportFilename(bundle: SessionExport): string {
  const seed = bundle.input === null ? 'unseeded' : `seed${bundle.input.seed}`;
  const stamp = bundle.exportedAt.replace(/[:.]/g, '-');
  return `narok-session-${seed}-${stamp}.json`;
}

/** Writes the bundle as a local file. No network, no clipboard permission prompt. */
export function downloadJson(filename: string, bundle: SessionExport): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
