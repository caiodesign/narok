/**
 * Town commands (part 3 §3–§5; part 1 §3, §4; ruling R144).
 *
 * Every one runs the account mutation sequence the hunt commands run, in the
 * same per-account order (R116 — one `CommandSequencer`, shared with the hunt
 * routes and the socket), and refuses in one order, the first failure only:
 *
 *   1. ownership — checked by the route before anything else; absent and
 *      not-yours answer identically (P-12);
 *   2. the idempotency replay and the account guard — `withAccountTx` under
 *      the account row lock (P-19, P-23, P-25);
 *   3. town-only — the account has no running or faulted hunt and its party
 *      is not still travelling home (part 3 §4) — else `RULE_VIOLATION` with
 *      field `TOWN_ONLY`;
 *   4. the pure `@narok/progression` rule, whose refusal becomes the envelope
 *      with the authoritative `stateVersion` attached (part 3 §5.3).
 *
 * The rule's result is persisted in the same transaction as the version
 * increment and the idempotency record, and a refusal throws inside it, so a
 * refused command commits nothing at all (B-16 atomicity).
 */
import { eq } from 'drizzle-orm';
import type { Content } from '@narok/data';
import type { Result, TownContext } from '@narok/progression';
import { characterMaxima } from '@narok/sim';
import * as schema from '../db/schema';
import { withAccountTx, type Database, type IdempotencySpec, type Tx } from '../db/tx';
import { AppError } from '../errors';
import type { CommandSequencer } from '../hunt/commands';
import { inTownAt } from '../hunt/lifecycle';
import { asAppError } from '../routes/hunts';

export interface TownDeps {
  readonly db: Database;
  /** The deployed, validated content: every rule and derivation reads it, never the bundle (B-29). */
  readonly content: Content;
  readonly sequencer: CommandSequencer;
}

export interface TownRequest {
  readonly accountId: string;
  readonly expectedStateVersion: number;
  readonly operation: string;
  readonly idempotency: IdempotencySpec;
  /**
   * `false` for the bag actions part 3 §4 allows while a hunt runs (lock):
   * still ordered, guarded and versioned, never refused as `TOWN_ONLY`.
   */
  readonly townOnly?: boolean;
}

export interface TownTx {
  readonly tx: Tx;
  readonly ctx: TownContext;
  /** The account version this command commits. */
  readonly stateVersionAfter: number;
}

/**
 * Whether the account is in town at `atWall`: no hunt row, or a stopped hunt
 * whose party has arrived. A running hunt is on the map; a faulted one is
 * still on it until its explicit recovery returns it (P-38).
 */
export async function accountInTown(tx: Tx, accountId: string, atWall: number): Promise<boolean> {
  const [hunt] = await tx
    .select({ status: schema.hunts.status, checkpoint: schema.hunts.checkpoint })
    .from(schema.hunts)
    .where(eq(schema.hunts.accountId, accountId));
  if (hunt === undefined) return true;
  if (hunt.status !== 'stopped') return false;
  return inTownAt(hunt.checkpoint) <= atWall;
}

export function runTownCommand<T>(deps: TownDeps, request: TownRequest, body: (town: TownTx) => Promise<T>): Promise<T> {
  return deps.sequencer.submit(request.accountId, async (stamp) => {
    try {
      return await withAccountTx(
        deps.db,
        {
          accountId: request.accountId,
          expectedStateVersion: request.expectedStateVersion,
          operation: request.operation,
          idempotency: request.idempotency,
        },
        async (tx) => {
          const inTown = request.townOnly === false || (await accountInTown(tx, request.accountId, stamp.commandAtWall));
          const ctx: TownContext = {
            content: deps.content,
            // Already checked by the transaction; the rule's own guard re-reads it.
            stateVersion: request.expectedStateVersion,
            expectedStateVersion: request.expectedStateVersion,
            inTown,
            maxima: characterMaxima(deps.content),
          };
          return body({ tx, ctx, stateVersionAfter: request.expectedStateVersion + 1 });
        },
      );
    } catch (error) {
      throw asAppError(error);
    }
  });
}

/** A rule's result, or its refusal as the client's envelope with the current version (part 3 §5.3). */
export function unwrap<T>(result: Result<T>, stateVersion: number): T {
  if (result.ok) return result.next;
  throw new AppError(result.code, result.field, stateVersion);
}
