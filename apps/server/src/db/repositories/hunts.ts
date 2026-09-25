/**
 * The checkpoint's storage (P-28, P-29, P-30).
 *
 * Two rules that are easy to state and expensive to get wrong:
 *
 * - **Bytes, not JSON.** The encoding `@narok/sim` produces is canonical, and
 *   the determinism and split-invariance tests compare those bytes. `jsonb`
 *   would reorder keys and renormalise numbers, so the column is `bytea` and
 *   this module never parses what it stores.
 * - **Fail closed on a version.** The four version columns are read *before*
 *   the blob is used, and a mismatch raises `WRONG_VERSION` naming the column.
 *   Nothing here substitutes a version to make a replay succeed (layer-1 §11).
 */
import { eq } from 'drizzle-orm';
import type { Database, Tx } from '../tx';
import * as schema from '../schema';

export interface CheckpointVersions {
  readonly simulationVersion: string;
  readonly contentVersion: string;
  readonly gridHash: string;
}

/** Raised instead of truncating: a shortened checkpoint is a corrupt one. */
export class CheckpointTooLargeError extends Error {
  readonly bytes: number;
  readonly maxBytes: number;

  constructor(bytes: number, maxBytes: number) {
    super(`checkpoint of ${bytes} bytes exceeds the ${maxBytes} byte cap`);
    this.name = 'CheckpointTooLargeError';
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

export class CheckpointVersionError extends Error {
  readonly code = 'WRONG_VERSION' as const;
  readonly field: string;

  constructor(field: string) {
    super(`checkpoint ${field} does not match the deployed pin`);
    this.name = 'CheckpointVersionError';
    this.field = field;
  }
}

export class CheckpointMissingError extends Error {
  readonly code = 'NOT_FOUND' as const;
  readonly field = 'hunt';

  constructor() {
    super('no checkpoint for this account');
    this.name = 'CheckpointMissingError';
  }
}

export interface SaveCheckpointSpec extends CheckpointVersions {
  readonly accountId: string;
  readonly status: string;
  readonly mapId: string;
  /** Exactly what `Simulation.encode` returned. Never re-serialised here. */
  readonly encoded: string;
  readonly checkpointSchemaVersion: number;
  readonly simAnchorMs: number;
  readonly wallAnchorAt: Date;
  readonly lastSeenAt: Date;
  readonly generation?: number;
  readonly paused?: boolean;
  /**
   * Written on every save, so a new hunt never inherits an old fault. Only
   * the explicit recovery passes the previous reason through.
   */
  readonly faultedReason?: string | null;
  readonly maxBytes: number;
}

export async function saveCheckpoint(tx: Database | Tx, spec: SaveCheckpointSpec): Promise<void> {
  const bytes = Buffer.from(spec.encoded, 'utf8');
  // Checked before the write, so an oversized checkpoint never half-lands.
  if (bytes.byteLength > spec.maxBytes) throw new CheckpointTooLargeError(bytes.byteLength, spec.maxBytes);

  const row = {
    accountId: spec.accountId,
    status: spec.status,
    mapId: spec.mapId,
    checkpoint: bytes,
    checkpointSchemaVersion: spec.checkpointSchemaVersion,
    simulationVersion: spec.simulationVersion,
    contentVersion: spec.contentVersion,
    gridHash: spec.gridHash,
    simAnchorMs: spec.simAnchorMs,
    wallAnchorAt: spec.wallAnchorAt,
    lastSeenAt: spec.lastSeenAt,
    generation: spec.generation ?? 0,
    paused: spec.paused ?? false,
    faultedReason: spec.faultedReason ?? null,
    updatedAt: new Date(),
  };

  await tx
    .insert(schema.hunts)
    .values(row)
    .onConflictDoUpdate({ target: schema.hunts.accountId, set: row });
}

export interface LoadedCheckpoint extends CheckpointVersions {
  readonly encoded: string;
  readonly status: string;
  readonly mapId: string;
  readonly checkpointSchemaVersion: number;
  readonly simAnchorMs: number;
  readonly wallAnchorAt: Date;
  readonly lastSeenAt: Date;
  readonly generation: number;
  readonly paused: boolean;
  readonly faultedReason: string | null;
}

export async function loadCheckpoint(
  db: Database | Tx,
  accountId: string,
  pins: CheckpointVersions,
): Promise<LoadedCheckpoint> {
  const [row] = await db.select().from(schema.hunts).where(eq(schema.hunts.accountId, accountId));
  if (row === undefined) throw new CheckpointMissingError();

  // Read the versions before the blob, and name the column that disagrees.
  if (row.simulationVersion !== pins.simulationVersion) throw new CheckpointVersionError('simulationVersion');
  if (row.contentVersion !== pins.contentVersion) throw new CheckpointVersionError('contentVersion');
  if (row.gridHash !== pins.gridHash) throw new CheckpointVersionError('gridHash');

  return {
    encoded: Buffer.from(row.checkpoint).toString('utf8'),
    status: row.status,
    mapId: row.mapId,
    checkpointSchemaVersion: row.checkpointSchemaVersion,
    simulationVersion: row.simulationVersion,
    contentVersion: row.contentVersion,
    gridHash: row.gridHash,
    simAnchorMs: row.simAnchorMs,
    wallAnchorAt: row.wallAnchorAt,
    lastSeenAt: row.lastSeenAt,
    generation: row.generation,
    paused: row.paused,
    faultedReason: row.faultedReason,
  };
}

/**
 * Copies a checkpoint into the archive (layer-1 §4.7 retention, §11 fault
 * capture). It is what makes the migration runbook's rollback a replay rather
 * than a hope, so it is never a move.
 */
export async function archiveCheckpoint(
  tx: Database | Tx,
  accountId: string,
  capturedFor: 'migration' | 'fault',
): Promise<void> {
  const [row] = await tx.select().from(schema.hunts).where(eq(schema.hunts.accountId, accountId));
  if (row === undefined) throw new CheckpointMissingError();

  await tx.insert(schema.huntCheckpointArchive).values({
    accountId: row.accountId,
    generation: row.generation,
    capturedFor,
    checkpoint: row.checkpoint,
    checkpointSchemaVersion: row.checkpointSchemaVersion,
    simulationVersion: row.simulationVersion,
    contentVersion: row.contentVersion,
    gridHash: row.gridHash,
  });
}

/**
 * Reward ids come from the persisted hunt namespace plus the reward sequence
 * (P-29). No UUID function is involved, which is what lets a replay from the
 * durable checkpoint produce the same ids and insert no duplicates.
 */
export function rewardId(huntNamespace: string, rewardSeq: number): string {
  return `${huntNamespace}:${rewardSeq}`;
}
