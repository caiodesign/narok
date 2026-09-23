/**
 * Periodic work (P-05, P-41).
 *
 * Three properties, each decided by a test rather than by a comment:
 *
 * - **Durable.** Each job records when it last completed, so a restart knows
 *   what it missed instead of assuming the process has been up forever.
 * - **Exclusive.** A *transaction-scoped* advisory lock keeps two runners out
 *   of one job, and the loser *skips* rather than queueing: a sweep that just
 *   ran does not need to run again a millisecond later. The scope matters.
 *   Session-level `pg_advisory_lock` is bound to a connection, and over a pool
 *   the lock and the unlock can land on different connections — the unlock
 *   fails silently and the lock leaks until the pooled connection closes, so
 *   the next run of that job skips forever. `pg_try_advisory_xact_lock` is
 *   held by the transaction and released when it ends, whichever connection it
 *   ran on.
 * - **Honest about failure.** A throw records the error and leaves
 *   `last_completed_at` alone, because a run that failed is not a completion.
 *
 * Part 1 §9 #11 is recorded here where it bites: these are in-process timers,
 * and scaling `api` past one instance means revisiting them. The advisory lock
 * is what makes that a decision rather than a corruption.
 */
import { lt, sql } from 'drizzle-orm';
import type { Database } from './tx';
import * as schema from './schema';

export interface JobOptions {
  readonly now: () => Date;
}

export type JobOutcome<T> = { ran: true; result: T } | { ran: false };

/** A stable 64-bit key per job name, for `pg_try_advisory_lock`. */
function lockKey(name: string): bigint {
  let hash = 0n;
  for (const char of name) hash = (hash * 131n + BigInt(char.codePointAt(0) ?? 0)) % 9_007_199_254_740_881n;
  return hash;
}

export async function runPeriodicJob<T>(
  db: Database,
  name: string,
  options: JobOptions,
  body: () => Promise<T>,
): Promise<JobOutcome<T>> {
  const key = lockKey(name);

  try {
    return await db.transaction(async (tx) => {
      const [lock] = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(${key}) as locked`);
      if (lock?.locked !== true) return { ran: false } as JobOutcome<T>;

      const result = await body();
      await tx
        .insert(schema.periodicJobs)
        .values({ name, lastCompletedAt: options.now(), lastError: null })
        .onConflictDoUpdate({
          target: schema.periodicJobs.name,
          set: { lastCompletedAt: options.now(), lastError: null },
        });
      return { ran: true, result } as JobOutcome<T>;
    });
  } catch (error) {
    // Recorded outside the transaction, which has already rolled back. The
    // completion stamp is deliberately untouched: a run that threw is not a
    // completion, and a restart must still see the work as outstanding.
    const message = String((error as { message?: string }).message ?? error).slice(0, 500);
    await db
      .insert(schema.periodicJobs)
      .values({ name, lastCompletedAt: null, lastError: message })
      .onConflictDoUpdate({ target: schema.periodicJobs.name, set: { lastError: message } });
    throw error;
  }
}

export interface SweepCounts {
  readonly sessions: number;
  readonly commandResults: number;
  readonly reports: number;
}

/**
 * Drops what has passed its retention window.
 *
 * `resource_audit` is deliberately absent: it is the only defence against a
 * resource anomaly (layer-1 §8.4) and is retained for the whole beta, so no
 * sweep may delete from it. The application role cannot delete from it anyway,
 * which is the belt to this suspenders.
 */
export async function sweepExpired(db: Database, at: Date): Promise<SweepCounts> {
  const sessions = await db
    .delete(schema.sessions)
    .where(lt(schema.sessions.expiresAt, at.getTime()))
    .returning({ id: schema.sessions.id });

  const commandResults = await db
    .delete(schema.commandResults)
    .where(lt(schema.commandResults.expiresAt, at))
    .returning({ key: schema.commandResults.idempotencyKey });

  const reports = await db
    .delete(schema.huntReports)
    .where(lt(schema.huntReports.expiresAt, at))
    .returning({ id: schema.huntReports.id });

  return { sessions: sessions.length, commandResults: commandResults.length, reports: reports.length };
}
