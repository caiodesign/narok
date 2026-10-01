/**
 * Worker message unions (contract §7, ruling R52), imported by both the worker
 * module and the hook. The worker module itself is never imported by the hook —
 * only instantiated via `new Worker(new URL('./experiment.worker.ts', import.meta.url), { type: 'module' })`.
 */
import type { DomainEvent, LabInput, PublicState, SimErrorCode } from '@narok/sim';

/** `SimErrorCode` plus the laboratory's own protocol error codes. */
export type WorkerErrorCode = SimErrorCode | 'STALE_GENERATION' | 'PROTOCOL' | 'INTERNAL';

export type WorkerRequest =
  | { type: 'start'; generation: number; input: LabInput }
  | { type: 'advance'; generation: number; untilMs: number }
  | { type: 'stop'; generation: number }
  | { type: 'export'; generation: number }
  | { type: 'import'; generation: number; text: string };

export type WorkerResponse =
  | { type: 'frame'; generation: number; state: PublicState; events: DomainEvent[]; reachedTarget: boolean }
  | { type: 'snapshot'; generation: number; text: string }
  | { type: 'error'; generation: number; code: WorkerErrorCode; field: string };
