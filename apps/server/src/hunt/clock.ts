/**
 * The anchor arithmetic (milestone B spec part 2 §3, layer-1 §4.6).
 *
 * Pure integer millisecond maths, deliberately separate from the database and
 * from the engine, because this is where every honest answer about offline
 * accrual is decided: what the cap covers, what is discarded, and why waiting
 * longer to reconnect can never convert unattended hours into production.
 *
 * The rule that makes that true is the re-anchor. Presence moves to **now**,
 * not to the cutoff that was actually simulated, and no residual is stored —
 * so there is nothing a later settlement could redeem, and a duplicate
 * settlement asks the engine to advance to exactly where it already is.
 */

/**
 * The shared beta cap: 12 hours (layer-1 §4.6, a 🟡 proposed default).
 *
 * It bounds unattended disconnection, not daily production — a maintained
 * connection re-anchors on every heartbeat and never reaches it.
 */
export const OFFLINE_CAP_MS = 43_200_000;

export interface HuntAnchors {
  /** Wall instant the current simulated time is anchored to. */
  readonly wallAnchorMs: number;
  /** Simulated time at that wall instant. */
  readonly simAnchorMs: number;
  /** Wall milliseconds spent paused since the anchor; never simulated. */
  readonly pausedWallMs: number;
  /** Presence, as of the last settlement. */
  readonly lastSeenAt: number;
  readonly offlineCapMs: number;
}

export interface SettlementWindow {
  /** Where accrual would stop if nothing else ended it. */
  readonly capCutoffWall: number;
  /** The earlier of now and the cap cutoff. */
  readonly eligibleCutoffWall: number;
  /** The simulated instant to advance to. Never earlier than the anchor. */
  readonly simTarget: number;
  /** How much simulated time this settlement may add at most. */
  readonly creditableMs: number;
  /** Which bound ended the window — the player's return, or the cap. */
  readonly cappedBy: 'presence' | 'cap';
}

/**
 * The window a settlement may credit.
 *
 * The engine may stop earlier on its own — a wipe, a stalemate — and keeps its
 * exact stop time, so the credited duration is always the `state.nowMs` delta
 * and never the requested horizon.
 */
export function settlementWindow(anchors: HuntAnchors, nowWall: number): SettlementWindow {
  const capCutoffWall = anchors.lastSeenAt + anchors.offlineCapMs;
  const eligibleCutoffWall = Math.min(nowWall, capCutoffWall);

  const elapsedWall = eligibleCutoffWall - anchors.wallAnchorMs;
  const rawTarget = anchors.simAnchorMs + elapsedWall - anchors.pausedWallMs;

  // A wall clock can go backwards, and the engine treats a rewind as an
  // invariant error (contracts §3, TIME_REWIND). Clamping here means the
  // simulation is never handed one.
  const simTarget = Math.max(anchors.simAnchorMs, rawTarget);

  return {
    capCutoffWall,
    eligibleCutoffWall,
    simTarget,
    creditableMs: simTarget - anchors.simAnchorMs,
    cappedBy: nowWall <= capCutoffWall ? 'presence' : 'cap',
  };
}

/**
 * Settle → commit → refresh presence → **re-anchor** (layer-1 §4.4 step 2).
 *
 * `simNowMs` is where the engine actually stopped, which may be short of
 * the window asked for. Presence still moves to `nowWall`: that asymmetry is
 * the mechanism, not an oversight.
 */
export function reanchor(anchors: HuntAnchors, nowWall: number, simNowMs: number): HuntAnchors {
  return {
    wallAnchorMs: nowWall,
    simAnchorMs: simNowMs,
    pausedWallMs: 0,
    lastSeenAt: nowWall,
    offlineCapMs: anchors.offlineCapMs,
  };
}

/**
 * The wall instant a stop happened at, computed with the **pre-settlement**
 * anchors — after the re-anchor the information needed to place it is gone.
 */
export function stopWallInstant(anchors: HuntAnchors, stopSimMs: number): number {
  return anchors.wallAnchorMs + (stopSimMs - anchors.simAnchorMs) + anchors.pausedWallMs;
}

/**
 * Simulated time at a wall instant, without settling anything. Used to decide
 * what has *elapsed* and may therefore be released to a client (part 2 §1
 * step 4).
 */
export function simTimeAt(anchors: HuntAnchors, wallMs: number): number {
  return Math.max(anchors.simAnchorMs, anchors.simAnchorMs + (wallMs - anchors.wallAnchorMs) - anchors.pausedWallMs);
}
