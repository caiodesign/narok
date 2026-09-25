/**
 * The away report (milestone B spec part 2 §1 step 2, §3; UI spec §8; part 4
 * §3.5; ruling R118).
 *
 * A report describes settled, already credited progress. It is built **after**
 * the settlement commits, from the committed deltas — the state before and
 * after, and the window that bounded the settlement — and it holds numbers,
 * never a claim on anything. Reading it, reopening it or refreshing it goes
 * through {@link readAwayReport}, which selects one row and writes nothing,
 * so no path from a report can credit twice (B-17).
 *
 * Three states ship now, each with its own copy key and actions:
 *
 * - `running` — the hunt is still going; the action views it.
 * - `capped` — accrual stopped at the offline cap and the hunt did not: a cap
 *   is reported as a cap, never as a combat failure (part 2 §4: reaching the
 *   cap is not a stop).
 * - `stopped` — the engine stopped the hunt inside the window; the report
 *   names the actual reason and offers the restart the hunt now needs.
 *
 * The fourth, a full bag, arrives with the bag (task 6).
 *
 * Retention is part 4 §3.5's option (a): only the latest report is kept, with
 * no read state; its age bound is `HuntConfig.reportRetentionMs`.
 */
import { and, eq, ne } from 'drizzle-orm';
import type { SimState, StopReason } from '@narok/sim';
import * as schema from '../db/schema';
import type { Database } from '../db/tx';
import { notOwned } from '../errors';
import type { SettlementWindow } from '../hunt/clock';
import type { Settlement } from '../hunt/settle';

export const AWAY_REPORT_VERSION = 1;

export type AwayStatus = 'running' | 'capped' | 'stopped';
/** Navigation only: no action a report offers grants anything (part 4 §3.5). */
export type AwayAction = 'view-hunt' | 'start-hunt';

export interface AwayReportInput {
  readonly huntId: string;
  readonly generation: number;
  /** Presence before the settlement: where time away starts and the cap was measured from. */
  readonly previousLastSeenAt: number;
  readonly returnedAtWall: number;
  readonly window: SettlementWindow;
  readonly creditedSimMs: number;
  readonly uncovered: Settlement['uncovered'];
  readonly stop: Settlement['stop'];
  /** The committed state before and after the settlement. */
  readonly before: SimState;
  readonly after: SimState;
  /** Rewards the settlement drained and committed. */
  readonly rewardsCredited: number;
}

export interface AwayOutcomes {
  readonly kills: number;
  readonly wins: number;
  /** Wipes during this absence; `wipesThisHunt` is the hunt's running total. */
  readonly wipes: number;
  readonly rawExp: number;
  readonly rawGold: number;
}

export interface AwayReport {
  readonly reportVersion: typeof AWAY_REPORT_VERSION;
  readonly huntId: string;
  readonly generation: number;
  readonly status: AwayStatus;
  /** Only for `stopped`: a cap is not a stop. */
  readonly stopReason: StopReason | null;
  /** A stable key the client localizes; never prose (layer-1 §9). */
  readonly copyKey: string;
  readonly actions: readonly AwayAction[];
  readonly awayFromWall: number;
  readonly returnedAtWall: number;
  /** Wall time away and simulated time credited, separately (UI spec §8). */
  readonly timeAwayMs: number;
  readonly simulatedMs: number;
  /** Where accrual ended: the engine's stop, or the eligible cutoff. */
  readonly accrualEndedAtWall: number;
  readonly capCutoffWall: number;
  readonly uncovered: Settlement['uncovered'];
  readonly outcomes: AwayOutcomes;
  readonly wipesThisHunt: number;
  readonly wipeLimit: number;
  readonly rewardsCredited: number;
}

function statusOf(input: AwayReportInput): AwayStatus {
  // A stop outranks the cap: when the engine stopped first, the cap never bit.
  if (input.stop !== null || input.after.phase === 'stopped') return 'stopped';
  return input.window.cappedBy === 'cap' ? 'capped' : 'running';
}

/** Builds a report from committed deltas. Pure: the same inputs give the same report, and nothing else. */
export function buildAwayReport(input: AwayReportInput): AwayReport {
  const status = statusOf(input);
  const stopReason = status === 'stopped' ? (input.stop?.reason ?? input.after.stopReason) : null;
  const delta = (key: keyof AwayOutcomes) => input.after.metrics[key] - input.before.metrics[key];

  return {
    reportVersion: AWAY_REPORT_VERSION,
    huntId: input.huntId,
    generation: input.generation,
    status,
    stopReason,
    copyKey: status === 'stopped' ? `away.stopped.${stopReason ?? 'unknown'}` : `away.${status}`,
    actions: status === 'stopped' ? ['start-hunt'] : ['view-hunt'],
    awayFromWall: input.previousLastSeenAt,
    returnedAtWall: input.returnedAtWall,
    timeAwayMs: input.returnedAtWall - input.previousLastSeenAt,
    simulatedMs: input.creditedSimMs,
    accrualEndedAtWall: input.stop?.atWallMs ?? input.window.eligibleCutoffWall,
    capCutoffWall: input.window.capCutoffWall,
    uncovered: { ...input.uncovered },
    outcomes: {
      kills: delta('kills'),
      wins: delta('wins'),
      wipes: delta('wipes'),
      rawExp: delta('rawExp'),
      rawGold: delta('rawGold'),
    },
    wipesThisHunt: input.after.metrics.wipes,
    wipeLimit: input.after.input.wipeLimit,
    rewardsCredited: input.rewardsCredited,
  };
}

/**
 * Stores `report` as the account's only report and returns its id. Not a
 * gameplay write: it takes no account version and moves none, because a
 * report is a description of a commit that has already happened.
 */
export async function recordAwayReport(
  db: Database,
  accountId: string,
  report: AwayReport,
  options: { readonly nowWall: number; readonly retentionMs: number },
): Promise<string> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.huntReports)
      .values({
        accountId,
        generation: report.generation,
        payload: report,
        expiresAt: new Date(options.nowWall + options.retentionMs),
      })
      .returning({ id: schema.huntReports.id });
    await tx
      .delete(schema.huntReports)
      .where(and(eq(schema.huntReports.accountId, accountId), ne(schema.huntReports.id, row.id)));
    return row.id;
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads a report. Writes nothing; absent and not-yours answer identically (P-12). */
export async function readAwayReport(db: Database, accountId: string, reportId: string): Promise<AwayReport> {
  if (!UUID.test(reportId)) throw notOwned('reportId');
  const [row] = await db
    .select({ payload: schema.huntReports.payload })
    .from(schema.huntReports)
    .where(and(eq(schema.huntReports.id, reportId), eq(schema.huntReports.accountId, accountId)));
  if (row === undefined) throw notOwned('reportId');
  return row.payload as AwayReport;
}
