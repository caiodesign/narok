/**
 * `withAccountTx` — the only path that writes gameplay rows (P-19, P-20, P-25,
 * P-27).
 *
 * The sequence is layer-1 §8.1's, and the order is the guarantee:
 *
 *   1. `SELECT ... FOR UPDATE` on the account row. The lock is the writer
 *      token, and the order commands acquire it in *is* their total order.
 *      Then the maintenance freeze (ruling R206): a shared advisory lock the
 *      operator's `freeze` takes exclusively, and the `maintenance` row read
 *      under it. A frozen database answers `MAINTENANCE` before anything else.
 *   2. The idempotency check, inside the lock, so two copies of one retry
 *      cannot both find the key absent.
 *   3. The caller's body.
 *   4. `UPDATE accounts SET state_version = state_version + 1 WHERE id = $id
 *      AND state_version = $read`. Zero rows affected aborts the whole
 *      transaction — this single predicate is what stops a stale snapshot
 *      overwriting a newer town action.
 *   5. The `command_results` row, in the same transaction as its effect. A
 *      record written afterwards can be lost in exactly the crash a retrying
 *      client is recovering from.
 *
 * Long work — a catch-up run, a hash — belongs *outside* this call. The lock is
 * held for the duration of the body, so the body is only the commit.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ErrorCode } from '@narok/protocol';
import { AppError } from '../errors';
import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** A refusal the caller can translate straight into an error envelope. */
export class ConflictError extends Error {
  readonly code: ErrorCode;
  readonly field: string;
  readonly currentStateVersion?: number;

  constructor(code: ErrorCode, field: string, currentStateVersion?: number) {
    super(`${code}:${field}`);
    this.name = 'ConflictError';
    this.code = code;
    this.field = field;
    this.currentStateVersion = currentStateVersion;
  }
}

export interface IdempotencySpec {
  readonly key: string;
  /** A hash of the request, so the same key with different input is caught. */
  readonly requestHash: string;
  /** How long the record outlives the client's retry schedule (part 1 §9 #8). */
  readonly ttlMs?: number;
}

export interface AccountTxOptions {
  readonly accountId: string;
  /** The version the caller read the state at. Guards the commit (P-20). */
  readonly expectedStateVersion: number;
  /** A bounded label, recorded with the idempotency row. */
  readonly operation: string;
  readonly idempotency?: IdempotencySpec;
  /** Bounded internal retries (P-22). Configuration, not a constant here. */
  readonly maxAttempts?: number;
  readonly backoffMs?: (attempt: number) => number;
  /**
   * The maintenance operator's own writes — settling to the cutoff and
   * re-anchoring at resume — proceed under the freeze they exist to serve.
   * Nothing a player can reach sets it (R206).
   */
  readonly whileFrozen?: boolean;
}

/**
 * The one advisory key the freeze serialises on (R206). Every account
 * transaction holds it shared until it commits; `freeze` takes it exclusively,
 * so it waits out every write already past the check and every later one reads
 * the flag it set. An advisory lock rather than `FOR SHARE` on the row: it
 * needs no row to exist and writes nothing to the row it guards.
 */
export const MAINTENANCE_LOCK_KEY = 0x6e61_726f_6b00n;

/**
 * Refuses with `MAINTENANCE` while the freeze is set (part 1 §6 step 1; part 2
 * §7 step 1). Two statements, in this order: under READ COMMITTED each takes
 * its snapshot when it starts, so the read must begin after the lock is held
 * or it could miss a freeze that committed while it waited.
 */
export async function assertNotFrozen(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${MAINTENANCE_LOCK_KEY})`);
  const [row] = await tx
    .select({ frozen: schema.maintenance.frozen })
    .from(schema.maintenance)
    .where(eq(schema.maintenance.id, 1));
  if (row?.frozen === true) throw new AppError('MAINTENANCE', 'maintenance');
}

const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function jitteredBackoff(attempt: number): number {
  return Math.min(50, 2 ** attempt) * (0.5 + Math.random());
}

async function runOnce<T>(db: Database, options: AccountTxOptions, body: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(
    async (tx) => {
      // 1. The writer token. Everything else in this transaction happens under it.
      const [account] = await tx
        .select({ stateVersion: schema.accounts.stateVersion })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, options.accountId))
        .for('update');

      if (account === undefined) throw new ConflictError('NOT_OWNED', 'accountId');

      // The freeze, before the replay and the guard: a frozen database answers
      // every gameplay command alike (R206).
      if (options.whileFrozen !== true) await assertNotFrozen(tx);

      // 2. A replay returns what the first attempt returned, without re-running
      //    the body — and without failing on a guard the first attempt moved.
      if (options.idempotency !== undefined) {
        const [existing] = await tx
          .select()
          .from(schema.commandResults)
          .where(
            and(
              eq(schema.commandResults.accountId, options.accountId),
              eq(schema.commandResults.idempotencyKey, options.idempotency.key),
            ),
          );

        if (existing !== undefined) {
          if (existing.requestHash !== options.idempotency.requestHash) {
            throw new ConflictError('IDEMPOTENCY_KEY_REUSED', 'idempotency-key', account.stateVersion);
          }
          return existing.response as T;
        }
      }

      if (account.stateVersion !== options.expectedStateVersion) {
        throw new ConflictError('CONFLICT_STATE_VERSION', 'expectedStateVersion', account.stateVersion);
      }

      // 3. The caller's work.
      const result = await body(tx);

      // 4. The guard. Zero rows here means the version moved under us despite
      //    the lock, and the whole transaction aborts rather than merging.
      const updated = await tx
        .update(schema.accounts)
        .set({ stateVersion: sql`${schema.accounts.stateVersion} + 1` })
        .where(
          and(
            eq(schema.accounts.id, options.accountId),
            eq(schema.accounts.stateVersion, options.expectedStateVersion),
          ),
        )
        .returning({ stateVersion: schema.accounts.stateVersion });

      if (updated.length === 0) {
        throw new ConflictError('CONFLICT_STATE_VERSION', 'expectedStateVersion', account.stateVersion);
      }

      // 5. The idempotency record, atomic with the effect it describes.
      if (options.idempotency !== undefined) {
        const ttl = options.idempotency.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
        await tx.insert(schema.commandResults).values({
          accountId: options.accountId,
          idempotencyKey: options.idempotency.key,
          operation: options.operation,
          requestHash: options.idempotency.requestHash,
          response: (result ?? {}) as object,
          stateVersionAfter: updated[0].stateVersion,
          expiresAt: new Date(Date.now() + ttl),
        });
      }

      return result;
    },
    // READ COMMITTED: the row lock, not the isolation level, is what serialises
    // writers for one account (layer-1 §8.1).
    { isolationLevel: 'read committed' },
  );
}

export async function withAccountTx<T>(
  db: Database,
  options: AccountTxOptions,
  body: (tx: Tx) => Promise<T>,
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoff = options.backoffMs ?? jitteredBackoff;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await runOnce(db, options, body);
    } catch (error) {
      lastError = error;
      // Only contention is retried. A rule violation or a reused key is an
      // answer, and retrying an answer just delays it.
      const retryable = error instanceof ConflictError && error.code === 'CONFLICT_STATE_VERSION';
      if (!retryable || attempt === maxAttempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoff(attempt)));
    }
  }

  throw lastError;
}
