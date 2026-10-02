/**
 * The maintenance settlement, as an operator command (part 2 §7; P-31; ruling
 * R199). Milestone B shipped the arithmetic — `resumeAfterMaintenance`
 * (`hunt/settle.ts`, R119) — with no path that runs it; this is that path, and
 * the smallest one: an offline operator CLI, never imported by the app and
 * reachable by no route.
 *
 *   freeze  — records the cutoff `T_c` in the single `maintenance` row. The
 *             operator's precondition is that no `api` process is running:
 *             in B the stopped process *is* the freeze, because the routes do
 *             not yet refuse commands while `maintenance.frozen` is set (open,
 *             named in `artifacts/milestone-b-results.md`).
 *   settle  — settles every running hunt to `T_c` under the artifacts this
 *             build carries. A hunt pinned to any other version is refused
 *             and reported (`CONTENT_VERSION_MISMATCH`), never replayed under
 *             substituted artifacts (P-28, B-29).
 *   resume  — re-anchors every running hunt settled to `T_c` at the resume
 *             instant with `resumeAfterMaintenance` (downtime is a pause, never
 *             simulated, and does not bill the offline allowance), each in its
 *             own guarded account transaction, then lifts the freeze.
 *
 * Usage: DATABASE_URL=... node --import tsx apps/server/src/ops/maintenance.ts <freeze|settle|resume>
 * Prints one JSON line per hunt and a summary line.
 */
import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { saveCheckpoint } from '../db/repositories/hunts';
import { withAccountTx } from '../db/tx';
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

export async function freeze(deps: LifecycleDeps, cutoffWall: number, note: string): Promise<void> {
  await deps.db
    .insert(schema.maintenance)
    .values({ id: 1, frozen: true, cutoffAt: new Date(cutoffWall), note, updatedBy: 'ops/maintenance' })
    .onConflictDoUpdate({
      target: schema.maintenance.id,
      set: { frozen: true, cutoffAt: new Date(cutoffWall), note, updatedAt: new Date(), updatedBy: 'ops/maintenance' },
    });
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
      const settled = await persistHunt(deps, accountId, { live: false, atWall: cutoff });
      outcomes.push({ accountId, outcome: 'settled', detail: `simNowMs=${settled.envelope.simAnchorMs} wallAnchorMs=${settled.envelope.wallAnchorMs}` });
    } catch (error) {
      if (error instanceof AppError) outcomes.push({ accountId, outcome: 'refused', detail: `${error.code} ${error.field}` });
      else throw error;
    }
  }
  return outcomes;
}

/** Part 2 §7 step 5: resume with new anchors, then lift the freeze. */
export async function resumeAll(deps: LifecycleDeps, resumeWall: number): Promise<MaintenanceOutcome[]> {
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
      { accountId, expectedStateVersion: loaded.stateVersion, operation: 'hunt.maintenance-resume' },
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
  await deps.db
    .update(schema.maintenance)
    .set({ frozen: false, updatedAt: new Date(), updatedBy: 'ops/maintenance' })
    .where(eq(schema.maintenance.id, 1));
  return outcomes;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const composed = compose(process.env);
  const lifecycle = composed.deps.hunts?.lifecycle;
  if (lifecycle === undefined) throw new Error('DATABASE_URL is required');
  try {
    const now = Date.now();
    if (command === 'freeze') {
      await freeze(lifecycle, now, process.argv[3] ?? 'maintenance');
      console.log(JSON.stringify({ frozen: true, cutoffWall: now }));
    } else if (command === 'settle' || command === 'resume') {
      const outcomes = command === 'settle' ? await settleAll(lifecycle) : await resumeAll(lifecycle, now);
      for (const outcome of outcomes) console.log(JSON.stringify(outcome));
      console.log(JSON.stringify({ command, hunts: outcomes.length, at: now }));
    } else {
      throw new Error('usage: maintenance.ts <freeze|settle|resume>');
    }
  } finally {
    await composed.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
