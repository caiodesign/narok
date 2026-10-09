/**
 * The maintenance settlement, as an operator command (part 2 §7; P-31; ruling
 * R199). Milestone B shipped the arithmetic — `resumeAfterMaintenance`
 * (`hunt/settle.ts`, R119) — with no path that runs it; this is that path, and
 * the smallest one: an offline operator CLI, never imported by the app and
 * reachable by no route.
 *
 *   freeze  — records the cutoff `T_c` in the single `maintenance` row. A
 *             running `api` honours it (ruling R206): every gameplay write —
 *             each REST command, each socket settlement — checks the row
 *             inside its account transaction under a shared advisory lock and
 *             answers `MAINTENANCE`, while reads keep answering. `freeze`
 *             takes that lock exclusively, so it returns only after every
 *             write already past the check has committed, and `T_c` is read
 *             from the clock after that: nothing a player did commits after
 *             the cutoff (part 1 §6 step 1's verification).
 *   settle  — settles every running hunt to `T_c` under the artifacts this
 *             build carries. A hunt pinned to any other version is refused
 *             and reported (`CONTENT_VERSION_MISMATCH`), never replayed under
 *             substituted artifacts (P-28, B-29).
 *   resume  — re-anchors every running hunt settled to `T_c` at the resume
 *             instant with `resumeAfterMaintenance` (downtime is a pause, never
 *             simulated, and does not bill the offline allowance), each in its
 *             own guarded account transaction, then lifts the freeze.
 *
 * Ruling R201: `resume` keeps the freeze while any running hunt was skipped
 * (not anchored at `T_c` — typically `freeze` then `resume` with no `settle`),
 * reports it, and exits 2; `resume --force` is the operator's explicit
 * override and lifts it anyway, still leaving the skipped hunts untouched —
 * because lifting the freeze over an unsettled hunt bills the whole outage to
 * that player's offline allowance, the exact outcome P-31 forbids, and an
 * operator who forgot `settle` should be stopped, not silently obeyed. A hunt
 * `refused` for a pin mismatch does not hold the freeze: this build can never
 * settle it, and every route refuses it the same way (P-28).
 *
 * Usage: DATABASE_URL=... node --import tsx apps/server/src/ops/maintenance.ts <freeze|settle|resume> [--force]
 * Prints one JSON line per hunt and a summary line.
 */
import { pathToFileURL } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { saveCheckpoint } from '../db/repositories/hunts';
import { MAINTENANCE_LOCK_KEY, withAccountTx } from '../db/tx';
import { AppError } from '../errors';
import { compose } from '../compose';
import { decodeCheckpoint, encodeCheckpoint, ENVELOPE_VERSION } from '../hunt/envelope';
import { persistHunt, readHunt, type LifecycleDeps } from '../hunt/lifecycle';
import { resumeAfterMaintenance } from '../hunt/settle';

export interface MaintenanceOutcome {
  readonly accountId: string;
  readonly outcome: 'settled' | 'resumed' | 'refused' | 'skipped';
  readonly detail: string;
}

/**
 * Part 2 §7 step 1. `cutoff` is the wall instant, or a clock read once the
 * lock is held — the operator command passes the clock, so `T_c` falls after
 * every commit the lock waited for (R206). Returns the recorded cutoff.
 */
export async function freeze(deps: LifecycleDeps, cutoff: number | (() => number), note: string): Promise<number> {
  return deps.db.transaction(async (tx) => {
    // Exclusive: waits for every account transaction holding it shared, and
    // holds every later one until this commit makes the flag visible to it.
    await tx.execute(sql`select pg_advisory_xact_lock(${MAINTENANCE_LOCK_KEY})`);
    const cutoffWall = typeof cutoff === 'function' ? cutoff() : cutoff;
    await tx
      .insert(schema.maintenance)
      .values({ id: 1, frozen: true, cutoffAt: new Date(cutoffWall), note, updatedBy: 'ops/maintenance' })
      .onConflictDoUpdate({
        target: schema.maintenance.id,
        set: { frozen: true, cutoffAt: new Date(cutoffWall), note, updatedAt: new Date(), updatedBy: 'ops/maintenance' },
      });
    return cutoffWall;
  });
}

/** The operator's own deps: its settlements commit under the freeze (R206). */
function operator(deps: LifecycleDeps): LifecycleDeps {
  return { ...deps, maintenanceOperator: true };
}

async function frozenCutoff(deps: LifecycleDeps): Promise<number> {
  const [row] = await deps.db.select().from(schema.maintenance).where(eq(schema.maintenance.id, 1));
  if (row === undefined || !row.frozen || row.cutoffAt === null) throw new Error('maintenance is not frozen: run freeze first');
  return row.cutoffAt.getTime();
}

async function runningHunts(deps: LifecycleDeps): Promise<string[]> {
  const rows = await deps.db.select({ accountId: schema.hunts.accountId }).from(schema.hunts).where(eq(schema.hunts.status, 'running'));
  return rows.map((row) => row.accountId);
}

/** Part 2 §7 step 2: every running hunt settled to `T_c` under its own pinned artifacts. */
export async function settleAll(deps: LifecycleDeps): Promise<MaintenanceOutcome[]> {
  const cutoff = await frozenCutoff(deps);
  const outcomes: MaintenanceOutcome[] = [];
  for (const accountId of await runningHunts(deps)) {
    try {
      const settled = await persistHunt(operator(deps), accountId, { live: false, atWall: cutoff });
      outcomes.push({ accountId, outcome: 'settled', detail: `simNowMs=${settled.envelope.simAnchorMs} wallAnchorMs=${settled.envelope.wallAnchorMs}` });
    } catch (error) {
      if (error instanceof AppError) outcomes.push({ accountId, outcome: 'refused', detail: `${error.code} ${error.field}` });
      else throw error;
    }
  }
  return outcomes;
}

export interface ResumeResult {
  readonly outcomes: MaintenanceOutcome[];
  /** Whether the freeze was lifted: false while a hunt was skipped and `force` was not given (R201). */
  readonly lifted: boolean;
}

/** Part 2 §7 step 5: resume with new anchors, then lift the freeze unless a hunt was skipped (R201). */
export async function resumeAll(
  deps: LifecycleDeps,
  resumeWall: number,
  options: { readonly force?: boolean } = {},
): Promise<ResumeResult> {
  const cutoff = await frozenCutoff(deps);
  const outcomes: MaintenanceOutcome[] = [];
  for (const accountId of await runningHunts(deps)) {
    let loaded;
    try {
      loaded = await readHunt(deps, accountId);
    } catch (error) {
      if (error instanceof AppError) {
        outcomes.push({ accountId, outcome: 'refused', detail: `${error.code} ${error.field}` });
        continue;
      }
      throw error;
    }
    if (loaded.envelope.wallAnchorMs !== cutoff) {
      // Not settled to this cutoff (a stop inside the window, or a refused pin):
      // resuming it would bill or simulate the wrong span, so it is left alone.
      outcomes.push({ accountId, outcome: 'skipped', detail: `anchored at ${loaded.envelope.wallAnchorMs}, not the cutoff ${cutoff}` });
      continue;
    }
    const resumed = resumeAfterMaintenance(loaded.envelope, cutoff, resumeWall);
    await withAccountTx(
      deps.db,
      { accountId, expectedStateVersion: loaded.stateVersion, operation: 'hunt.maintenance-resume', whileFrozen: true },
      async (tx) => {
        const [row] = await tx.select().from(schema.hunts).where(eq(schema.hunts.accountId, accountId));
        if (row === undefined) throw new AppError('NOT_FOUND', 'hunt');
        const current = decodeCheckpoint(Buffer.from(row.checkpoint).toString('utf8'));
        if (current.checkpointSeq !== loaded.envelope.checkpointSeq) throw new AppError('CONFLICT_STATE_VERSION', 'hunt');
        await saveCheckpoint(tx, {
          accountId,
          status: row.status,
          mapId: row.mapId,
          encoded: encodeCheckpoint(resumed),
          checkpointSchemaVersion: ENVELOPE_VERSION,
          simulationVersion: row.simulationVersion,
          contentVersion: row.contentVersion,
          gridHash: row.gridHash,
          simAnchorMs: resumed.simAnchorMs,
          wallAnchorAt: new Date(resumed.wallAnchorMs),
          lastSeenAt: new Date(resumed.lastSeenAt),
          generation: row.generation,
          maxBytes: deps.config.maxCheckpointBytes,
        });
      },
    );
    outcomes.push({ accountId, outcome: 'resumed', detail: `wallAnchorMs=${resumed.wallAnchorMs} lastSeenAt=${resumed.lastSeenAt}` });
  }
  const skipped = outcomes.some((outcome) => outcome.outcome === 'skipped');
  if (skipped && options.force !== true) return { outcomes, lifted: false };
  await deps.db
    .update(schema.maintenance)
    .set({ frozen: false, updatedAt: new Date(), updatedBy: 'ops/maintenance' })
    .where(eq(schema.maintenance.id, 1));
  return { outcomes, lifted: true };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const composed = compose(process.env);
  const lifecycle = composed.deps.hunts?.lifecycle;
  if (lifecycle === undefined) throw new Error('DATABASE_URL is required');
  try {
    const now = Date.now();
    if (command === 'freeze') {
      const cutoffWall = await freeze(lifecycle, () => Date.now(), process.argv[3] ?? 'maintenance');
      console.log(JSON.stringify({ frozen: true, cutoffWall }));
    } else if (command === 'settle') {
      const outcomes = await settleAll(lifecycle);
      for (const outcome of outcomes) console.log(JSON.stringify(outcome));
      console.log(JSON.stringify({ command, hunts: outcomes.length, at: now }));
    } else if (command === 'resume') {
      const { outcomes, lifted } = await resumeAll(lifecycle, now, { force: process.argv.includes('--force') });
      for (const outcome of outcomes) console.log(JSON.stringify(outcome));
      console.log(JSON.stringify({ command, hunts: outcomes.length, lifted, at: now }));
      if (!lifted) {
        console.error('maintenance stays frozen: a running hunt was not settled to the cutoff; run settle, or resume --force');
        process.exitCode = 2;
      }
    } else {
      throw new Error('usage: maintenance.ts <freeze|settle|resume> [--force]');
    }
  } finally {
    await composed.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
