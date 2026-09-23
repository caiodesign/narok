/**
 * Grants (layer-1 §7.4, §8.2, P-36).
 *
 * Onboarding and admin grants are idempotent by `(account_id, grant_key)`, and
 * the idempotency is the database's rather than the caller's: `onConflictDoNothing`
 * against the unique index means two racing attempts cannot both succeed, which
 * a read-then-write check could not promise.
 */
import type { Database, Tx } from '../tx';
import * as schema from '../schema';

export interface GrantSpec {
  readonly accountId: string;
  /** Unique per account. `starter-kit:0` is the kit for character slot 0. */
  readonly grantKey: string;
  readonly kind: string;
  readonly payload: object;
  readonly grantedBy: string;
}

export interface GrantOutcome {
  /** False when the grant already existed, which is a no-op and not an error. */
  readonly granted: boolean;
}

export async function grantOnce(db: Database | Tx, spec: GrantSpec): Promise<GrantOutcome> {
  const inserted = await db
    .insert(schema.accountGrants)
    .values({
      accountId: spec.accountId,
      grantKey: spec.grantKey,
      kind: spec.kind,
      payload: spec.payload,
      grantedBy: spec.grantedBy,
    })
    .onConflictDoNothing({ target: [schema.accountGrants.accountId, schema.accountGrants.grantKey] })
    .returning({ id: schema.accountGrants.id });

  return { granted: inserted.length > 0 };
}
