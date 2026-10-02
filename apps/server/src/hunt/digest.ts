/**
 * The settlement digest (milestone B Task 10 fix round 1; part 4 §3.5): what an
 * away report says happened during an absence, folded from the domain events
 * the settlement itself produced while it advanced the hunt.
 *
 * A summary settlement keeps no events (layer-1 §4.8), so per-member deaths,
 * revives and the order things happened in were lost with them. When a
 * settlement asks for a digest, the segment runner advances in `'events'`
 * mode — which changes no state, RNG draw or reward — and folds each accepted
 * step's events into this small record before letting them go. Nothing here
 * is computed from anything but those events: an entry the engine did not
 * emit is never written.
 *
 * Ruling R191 — the timeline is bounded and chronological. It keeps the
 * events that change the hunt's course (a death, a revive, a wipe, the stop)
 * one entry each, and folds the repetitive ones (encounters won, kept drops
 * lost to a full bag) into a run that a course event closes — so a run's
 * entry stands at its first event and counts the rest. At most
 * {@link TIMELINE_LIMIT} entries are kept, the most recent ones, and
 * `omitted` counts the earlier entries let go: the stop is always the last
 * thing that happens, and the most recent stretch is what the player returns
 * to. *Why:* part 4 §3.5 asks for the chronological timeline and the
 * reference draws ten marks on one track (nine here plus the return); an
 * unbounded list of every win would be neither readable nor bounded in the
 * report row.
 */
import type { DomainEvent } from '@narok/sim';

/** Ruling R191: nine kept entries, the return mark makes the reference's ten. */
export const TIMELINE_LIMIT = 9;

export type DigestKind = 'won' | 'wipe' | 'death' | 'revive' | 'drop-lost' | 'stop';

export interface DigestEntry {
  readonly kind: DigestKind;
  /** The simulated instant of the entry's first event. */
  readonly atSimMs: number;
  /** The party member a death or revive names; `null` otherwise. */
  readonly actorId: string | null;
  /** Events the entry stands for: one, or the length of a run. */
  readonly count: number;
  /** A stop's reason, a revive's source (an apple's id or `revive`); `null` otherwise. */
  readonly reason: string | null;
}

export interface HuntDigest {
  /** Party deaths per roster id; members who never died are absent. */
  readonly deaths: Readonly<Record<string, number>>;
  readonly revives: Readonly<Record<string, number>>;
  readonly entries: readonly DigestEntry[];
  /** Earlier entries let go to keep the bound. */
  readonly omitted: number;
}

export function emptyDigest(): HuntDigest {
  return { deaths: {}, revives: {}, entries: [], omitted: 0 };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Folds events into a digest, one accepted step at a time. */
export class DigestFolder {
  private readonly deaths: Record<string, number> = {};
  private readonly revives: Record<string, number> = {};
  private readonly entries: Mutable<DigestEntry>[] = [];
  private omitted = 0;
  private openWon: Mutable<DigestEntry> | null = null;
  private openLost: Mutable<DigestEntry> | null = null;

  /** `party` is the roster's actor ids: an enemy's death is a kill, not a member's death. */
  constructor(private readonly party: ReadonlySet<string>) {}

  fold(events: readonly DomainEvent[]): void {
    for (const event of events) this.one(event);
  }

  result(): HuntDigest {
    return {
      deaths: { ...this.deaths },
      revives: { ...this.revives },
      entries: this.entries.map((entry) => ({ ...entry })),
      omitted: this.omitted,
    };
  }

  private one(event: DomainEvent): void {
    switch (event.kind) {
      case 'win':
        if (this.openWon !== null) this.openWon.count += 1;
        else this.openWon = this.push({ kind: 'won', atSimMs: event.at, actorId: null, count: 1, reason: null });
        return;
      case 'drop-lost':
        if (this.openLost !== null) this.openLost.count += 1;
        else this.openLost = this.push({ kind: 'drop-lost', atSimMs: event.at, actorId: null, count: 1, reason: null });
        return;
      case 'death': {
        const id = event.actorId;
        if (id === null || !this.party.has(id)) return;
        this.deaths[id] = (this.deaths[id] ?? 0) + 1;
        this.course({ kind: 'death', atSimMs: event.at, actorId: id, count: 1, reason: null });
        return;
      }
      case 'revive': {
        const id = event.actorId;
        if (id === null) return;
        this.revives[id] = (this.revives[id] ?? 0) + 1;
        this.course({ kind: 'revive', atSimMs: event.at, actorId: id, count: 1, reason: event.reason });
        return;
      }
      case 'wipe':
        this.course({ kind: 'wipe', atSimMs: event.at, actorId: null, count: 1, reason: null });
        return;
      case 'stop':
        this.course({ kind: 'stop', atSimMs: event.at, actorId: null, count: 1, reason: event.reason });
        return;
      default:
        return;
    }
  }

  /** A course event: its own entry, and it closes any open run. */
  private course(entry: Mutable<DigestEntry>): void {
    this.openWon = null;
    this.openLost = null;
    this.push(entry);
  }

  private push(entry: Mutable<DigestEntry>): Mutable<DigestEntry> {
    this.entries.push(entry);
    while (this.entries.length > TIMELINE_LIMIT) {
      const dropped = this.entries.shift()!;
      this.omitted += 1;
      if (dropped === this.openWon) this.openWon = null;
      if (dropped === this.openLost) this.openLost = null;
    }
    return entry;
  }
}

/**
 * Two consecutive digests as one — a settlement that a full reward carrier
 * split into committed rounds. A run cut by the commit stays two entries,
 * which is still what happened.
 */
export function mergeDigests(first: HuntDigest, second: HuntDigest): HuntDigest {
  const add = (a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>) => {
    const out: Record<string, number> = { ...a };
    for (const [id, count] of Object.entries(b)) out[id] = (out[id] ?? 0) + count;
    return out;
  };
  const entries = [...first.entries, ...second.entries];
  const overflow = Math.max(0, entries.length - TIMELINE_LIMIT);
  return {
    deaths: add(first.deaths, second.deaths),
    revives: add(first.revives, second.revives),
    entries: entries.slice(overflow),
    omitted: first.omitted + second.omitted + overflow,
  };
}
