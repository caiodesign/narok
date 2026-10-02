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
 *
 * Version 3 (Task 10 fix round 1; part 4 §3.5's "Must show"; rulings
 * R191–R194) adds what the screen must show and version 2 left out: the
 * hunt's map; each member's level and EXP before and after and its deaths and
 * revives during the absence, with the deaths summed as the third count
 * beside the hunt's and the absence's wipes; the notable loot; and the
 * bounded chronological timeline. All of it comes from what the settlement
 * already settled — the committed states, the credited rewards, and the
 * digest of the events the settlement produced (`hunt/digest.ts`).
 */
import { and, eq, gt, ne } from 'drizzle-orm';
import { RARITIES, type Rarity } from '@narok/data';
import type { SimState, StopReason } from '@narok/sim';
import * as schema from '../db/schema';
import type { Database } from '../db/tx';
import { notOwned } from '../errors';
import { stopWallInstant, type HuntAnchors, type SettlementWindow } from '../hunt/clock';
import { TIMELINE_LIMIT, type DigestKind, type HuntDigest } from '../hunt/digest';
import { consumedDuring, type HuntReward } from '../hunt/rewards';
import type { Settlement } from '../hunt/settle';

/**
 * 2: no wipe limit, and the consumables spent (owner decision 2026-09-30; R152, R154).
 * 3: the map, per-member results, member deaths, notable loot and the timeline (R191–R194).
 */
export const AWAY_REPORT_VERSION = 3;

/**
 * Ruling R193 — notable loot is the absence's kept equipment, rarest first
 * (content's own rarity order), earliest first within a rarity, at most this
 * many, with the total kept beside it. *Why:* content defines no "notable"
 * rule, so the report invents no rarity threshold: every kept equipment drop
 * is eligible and the order alone decides what leads. Six is the reference's
 * own list length (`away.html`'s `.notable`), a display bound and not a rarity
 * rule; auto-sold drops were never the player's to inspect and lost ones are
 * not loot the player has (part 4 §3.5: never imply missed drops can be
 * reclaimed).
 */
export const NOTABLE_LIMIT = 6;

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
  /** The hunt's map: the report names its own, never whatever hunt runs when it is read. */
  readonly mapId: string;
  /** The pre-settlement anchors: where a simulated instant falls on the wall clock. */
  readonly anchors: HuntAnchors;
  /** What the settlement's events said, folded (ruling R191). */
  readonly digest: HuntDigest;
  /** Every reward the settlement drained and committed, in order. */
  readonly rewards: readonly HuntReward[];
}

/** One party member across the absence (part 4 §3.5: party outcomes). */
export interface AwayMember {
  readonly characterId: string;
  readonly classId: string;
  readonly levelBefore: number;
  readonly levelAfter: number;
  /** EXP into the level held, before and after. */
  readonly expBefore: number;
  readonly expAfter: number;
  /** Deaths during this absence, each counted; a wipe kills every member. */
  readonly deaths: number;
  readonly revives: number;
}

export interface AwayNotableDrop {
  readonly rewardId: string;
  readonly definitionId: string;
  readonly rarity: Rarity;
  readonly itemLevel: number;
  readonly bonusCount: number;
  readonly atWallMs: number;
}

export type AwayTimelineKind = DigestKind | 'cap';

export interface AwayTimelineEntry {
  readonly kind: AwayTimelineKind;
  readonly atWallMs: number;
  /** The member a death or revive names. */
  readonly characterId: string | null;
  readonly count: number;
  readonly reason: string | null;
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
  readonly mapId: string;
  /** Roster order; empty for a state that carries no progression (a laboratory run). */
  readonly party: readonly AwayMember[];
  /** Individual member deaths summed over the absence: the third count, beside the two wipe counts. */
  readonly memberDeaths: number;
  readonly notable: readonly AwayNotableDrop[];
  /** Every kept equipment drop of the absence; `notable` shows the first {@link NOTABLE_LIMIT}. */
  readonly notableTotal: number;
  /** Chronological, at most {@link TIMELINE_LIMIT} entries (ruling R191). */
  readonly timeline: readonly AwayTimelineEntry[];
  /** Earlier entries let go to keep the bound. */
  readonly timelineOmitted: number;
}

function partyOf(input: AwayReportInput): AwayMember[] {
  const { before, after, digest } = input;
  if (after.progression === null) return [];
  return Object.entries(after.progression).map(([actorId, now]) => {
    const was = before.progression?.[actorId] ?? now;
    return {
      characterId: now.characterId,
      classId: after.actors[actorId]?.definitionId ?? '',
      levelBefore: was.level,
      levelAfter: now.level,
      expBefore: was.exp,
      expAfter: now.exp,
      deaths: digest.deaths[actorId] ?? 0,
      revives: digest.revives[actorId] ?? 0,
    };
  });
}

function notableOf(input: AwayReportInput): { notable: AwayNotableDrop[]; total: number } {
  const rank = (rarity: Rarity) => RARITIES.indexOf(rarity);
  const kept = input.rewards.flatMap((reward) =>
    reward.item.kind === 'equipment' && reward.disposition.outcome === 'kept'
      ? [
          {
            drop: {
              rewardId: reward.rewardId,
              definitionId: reward.item.definitionId,
              rarity: reward.item.rarity,
              itemLevel: reward.itemLevel,
              bonusCount: reward.item.bonuses.length,
              atWallMs: stopWallInstant(input.anchors, reward.atSimMs),
            },
            seq: reward.rewardSeq,
          },
        ]
      : [],
  );
  kept.sort((a, b) => rank(b.drop.rarity) - rank(a.drop.rarity) || a.seq - b.seq);
  return { notable: kept.slice(0, NOTABLE_LIMIT).map((entry) => entry.drop), total: kept.length };
}

function timelineOf(input: AwayReportInput, status: AwayStatus): { timeline: AwayTimelineEntry[]; omitted: number } {
  const characterOf = (actorId: string | null) =>
    actorId === null ? null : (input.after.progression?.[actorId]?.characterId ?? actorId);
  const entries: AwayTimelineEntry[] = input.digest.entries.map((entry) => ({
    kind: entry.kind,
    atWallMs: stopWallInstant(input.anchors, entry.atSimMs),
    characterId: characterOf(entry.actorId),
    count: entry.count,
    reason: entry.reason,
  }));
  // The cap is no event: it is the window's own bound, and it bit only when
  // accrual ran to it — a stop ends accrual first.
  if (status !== 'stopped' && input.window.cappedBy === 'cap') {
    entries.push({ kind: 'cap', atWallMs: input.window.capCutoffWall, characterId: null, count: 1, reason: null });
  }
  const overflow = Math.max(0, entries.length - TIMELINE_LIMIT);
  return { timeline: entries.slice(overflow), omitted: input.digest.omitted + overflow };
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

  const party = partyOf(input);
  const { notable, total } = notableOf(input);
  const { timeline, omitted } = timelineOf(input, status);

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
    mapId: input.mapId,
    party,
    memberDeaths: party.reduce((sum, member) => sum + member.deaths, 0),
    notable,
    notableTotal: total,
    timeline,
    timelineOmitted: omitted,
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

/**
 * Reads a report. Writes nothing; absent, expired and not-yours answer
 * identically (P-12). A report past its `expires_at` is gone even before a
 * sweep deletes the row (final review M4).
 */
export async function readAwayReport(db: Database, accountId: string, reportId: string, nowWall: number): Promise<AwayReport> {
  if (!UUID.test(reportId)) throw notOwned('reportId');
  const [row] = await db
    .select({ payload: schema.huntReports.payload })
    .from(schema.huntReports)
    .where(and(
      eq(schema.huntReports.id, reportId),
      eq(schema.huntReports.accountId, accountId),
      gt(schema.huntReports.expiresAt, new Date(nowWall)),
    ));
  if (row === undefined) throw notOwned('reportId');
  return row.payload as AwayReport;
}
