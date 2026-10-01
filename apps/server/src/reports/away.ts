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
 * Four states, each with its own copy key and actions:
 *
 * - `running` — the hunt is still going; the action views it.
 * - `capped` — accrual stopped at the offline cap and the hunt did not: a cap
 *   is reported as a cap, never as a combat failure (part 2 §4: reaching the
 *   cap is not a stop).
 * - `bag-full` — drops were lost to a full bag during the absence (part 3
 *   §3.4). The hunt kept going, so this is no stop either; managing the bag is
 *   the primary action, and the lost drops stay lost — reopening the report
 *   reclaims nothing (UI spec §8).
 * - `stopped` — the engine stopped the hunt inside the window; the report
 *   names the actual reason and offers the restart the hunt now needs.
 *
 * Precedence: a stop outranks everything, then a full bag (it asks the player
 * to act), then the cap.
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
import { consumedDuring } from '../hunt/rewards';
import type { Settlement } from '../hunt/settle';

/** 2: no wipe limit, and the consumables spent (owner decision 2026-09-30; R152, R154). */
export const AWAY_REPORT_VERSION = 2;

export type AwayStatus = 'running' | 'capped' | 'bag-full' | 'stopped';
/** Navigation only: no action a report offers grants anything (part 4 §3.5). */
export type AwayAction = 'view-hunt' | 'start-hunt' | 'manage-bag';

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
  /** Wipes during this absence — one at most, since a wipe ends the hunt (R154); `wipesThisHunt` is the hunt's total. */
  readonly wipes: number;
  readonly rawExp: number;
  readonly rawGold: number;
  /** Drops during this absence, by what became of them (part 3 §7). Counts only. */
  readonly drops: {
    readonly rolled: number;
    readonly kept: number;
    readonly autoSold: number;
    readonly ignored: number;
    readonly lost: number;
  };
  /**
   * Resource consumption during this absence: units spent per consumable id —
   * Idun's Apples (ruling R152). Ids with nothing spent are absent.
   */
  readonly consumed: Readonly<Record<string, number>>;
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
  readonly rewardsCredited: number;
}

function lostDuring(input: AwayReportInput): number {
  return input.after.metrics.drops.lost - input.before.metrics.drops.lost;
}

function statusOf(input: AwayReportInput): AwayStatus {
  // A stop outranks the cap: when the engine stopped first, the cap never bit.
  if (input.stop !== null || input.after.phase === 'stopped') return 'stopped';
  if (lostDuring(input) > 0) return 'bag-full';
  return input.window.cappedBy === 'cap' ? 'capped' : 'running';
}

const COPY: Record<Exclude<AwayStatus, 'stopped'>, string> = {
  running: 'away.running',
  capped: 'away.capped',
  'bag-full': 'away.bagFull',
};

const ACTIONS: Record<AwayStatus, readonly AwayAction[]> = {
  running: ['view-hunt'],
  capped: ['view-hunt'],
  // Manage bag first: the hunt is still running, and the bag is why drops were lost.
  'bag-full': ['manage-bag', 'view-hunt'],
  stopped: ['start-hunt'],
};

/** Builds a report from committed deltas. Pure: the same inputs give the same report, and nothing else. */
export function buildAwayReport(input: AwayReportInput): AwayReport {
  const status = statusOf(input);
  const stopReason = status === 'stopped' ? (input.stop?.reason ?? input.after.stopReason) : null;
  const delta = (key: Exclude<keyof AwayOutcomes, 'drops' | 'consumed'>) => input.after.metrics[key] - input.before.metrics[key];
  const drops = (key: 'kept' | 'autoSold' | 'ignored' | 'lost') =>
    input.after.metrics.drops[key] - input.before.metrics.drops[key];
  const rolled = (state: SimState) =>
    Object.values(state.metrics.drops.rolled).reduce((sum, count) => sum + count, 0) + state.metrics.drops.consumables;

  return {
    reportVersion: AWAY_REPORT_VERSION,
    huntId: input.huntId,
    generation: input.generation,
    status,
    stopReason,
    copyKey: status === 'stopped' ? `away.stopped.${stopReason ?? 'unknown'}` : COPY[status],
    actions: ACTIONS[status],
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
      drops: {
        rolled: rolled(input.after) - rolled(input.before),
        kept: drops('kept'),
        autoSold: drops('autoSold'),
        ignored: drops('ignored'),
        lost: drops('lost'),
      },
      consumed: consumedDuring(input.before, input.after),
    },
    wipesThisHunt: input.after.metrics.wipes,
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
