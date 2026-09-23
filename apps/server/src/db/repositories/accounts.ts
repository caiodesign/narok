/**
 * The Drizzle adapter behind the storage ports (milestone B spec part 1 §1).
 *
 * Task 1 decided the authentication, session, ownership and taxonomy rules
 * against in-memory stores. This file exists to prove that seam was real: the
 * same suites run unchanged against PostgreSQL, so anything they assert is a
 * property of the *rules*, not of the implementation underneath them.
 *
 * Writing it forced one correction to the seam itself: task 1's ports returned
 * values synchronously, because an in-memory Map can. A database cannot, and
 * both ways of hiding that were worse than fixing it — a per-request cache
 * behind a sync façade hides which reads hit the database, and a façade that
 * throws on the methods it cannot serve is not an implementation of the port.
 * The ports are now async and the suites await them.
 *
 * `resetPassword` revokes every session in one transaction with the password
 * write (P-10). In memory those were two statements that could not tear; here
 * they must be one, or a crash between them leaves live sessions behind a
 * password its owner has already changed.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../tx';
import * as schema from '../schema';
import type { AccountRow, SessionRow, Stores } from '../../store/ports';

function toAccount(row: typeof schema.accounts.$inferSelect): AccountRow {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    passwordAlgorithm: row.passwordAlgorithm,
    stateVersion: row.stateVersion,
    premium: row.premiumGrantedAt !== null && (row.premiumExpiresAt === null || row.premiumExpiresAt > new Date()),
    createdAt: row.createdAt.toISOString(),
    passwordChangedAt: row.passwordChangedAt,
  };
}

function toSession(row: typeof schema.sessions.$inferSelect): SessionRow {
  return {
    id: row.id,
    accountId: row.accountId,
    tokenHash: row.tokenHash,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
  };
}

export async function findAccountByEmail(db: Database, email: string): Promise<AccountRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.accounts)
    .where(sql`lower(${schema.accounts.email}) = lower(${email})`);
  return row === undefined ? undefined : toAccount(row);
}

export async function findAccountById(db: Database, id: string): Promise<AccountRow | undefined> {
  const [row] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id));
  return row === undefined ? undefined : toAccount(row);
}

export async function findSessionByTokenHash(db: Database, tokenHash: string): Promise<SessionRow | undefined> {
  const [row] = await db.select().from(schema.sessions).where(eq(schema.sessions.tokenHash, tokenHash));
  return row === undefined ? undefined : toSession(row);
}

export interface CreateAccountSpec {
  readonly email: string;
  readonly passwordHash: string;
  readonly algorithm: string;
  readonly now: number;
  readonly bagCapacity: number;
}

export async function createAccount(db: Database, spec: CreateAccountSpec): Promise<AccountRow> {
  const [row] = await db
    .insert(schema.accounts)
    .values({
      email: spec.email.toLowerCase(),
      passwordHash: spec.passwordHash,
      passwordAlgorithm: spec.algorithm,
      passwordChangedAt: spec.now,
      bagCapacity: spec.bagCapacity,
    })
    .returning();
  return toAccount(row);
}

/**
 * P-10: the password write and the revocation of every session are one
 * transaction. Two statements could tear, and the tear leaves live sessions
 * behind a password the owner has already changed.
 */
export async function resetPassword(
  db: Database,
  accountId: string,
  passwordHash: string,
  algorithm: string,
  now: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(schema.accounts)
      .set({ passwordHash, passwordAlgorithm: algorithm, passwordChangedAt: now })
      .where(eq(schema.accounts.id, accountId));

    await tx
      .update(schema.sessions)
      .set({ revokedAt: now })
      .where(and(eq(schema.sessions.accountId, accountId), isNull(schema.sessions.revokedAt)));

    await tx.insert(schema.resourceAudit).values({
      accountId,
      reason: 'password-reset',
      sourceRef: 'admin',
      delta: {},
      stateVersionAfter: 0,
    });
  });
}

export async function createSession(
  db: Database,
  accountId: string,
  tokenHash: string,
  createdAt: number,
  expiresAt: number,
): Promise<SessionRow> {
  const [row] = await db
    .insert(schema.sessions)
    .values({ accountId, tokenHash, createdAt, expiresAt, lastSeenAt: createdAt })
    .returning();
  return toSession(row);
}

export async function touchSession(db: Database, id: string, at: number, expiresAt: number): Promise<void> {
  await db.update(schema.sessions).set({ lastSeenAt: at, expiresAt }).where(eq(schema.sessions.id, id));
}

export async function revokeSession(db: Database, id: string, at: number): Promise<void> {
  await db.update(schema.sessions).set({ revokedAt: at }).where(eq(schema.sessions.id, id));
}

export async function revokeAllSessions(db: Database, accountId: string, at: number): Promise<void> {
  await db
    .update(schema.sessions)
    .set({ revokedAt: at })
    .where(and(eq(schema.sessions.accountId, accountId), isNull(schema.sessions.revokedAt)));
}

/**
 * The stores, over PostgreSQL. Same rules, same signatures, different storage —
 * which is what makes task 1's auth, session, origin, ownership and taxonomy
 * suites meaningful: they run against this without a line changed.
 */
export function drizzleStores(
  db: Database,
  options: { now: () => number; bagCapacity: number },
): Pick<Stores, 'accounts' | 'sessions' | 'items'> {
  return {
    accounts: {
      byEmail: (email) => findAccountByEmail(db, email),
      byId: (id) => findAccountById(db, id),
      create: (email, passwordHash, algorithm) =>
        createAccount(db, { email, passwordHash, algorithm, now: options.now(), bagCapacity: options.bagCapacity }),
      /**
       * The port takes a plaintext password because the in-memory version did.
       * Here it is hashed by the caller and handed in already hashed, so this
       * signature is the one thing the seam did not get right; task 3 narrows
       * it when the admin CLI owns resets.
       */
      resetPassword: async (accountId, passwordHash) => {
        await resetPassword(db, accountId, passwordHash, 'argon2id', options.now());
      },
    },

    sessions: {
      create: (accountId, tokenHash, createdAt, expiresAt) =>
        createSession(db, accountId, tokenHash, createdAt, expiresAt),
      byTokenHash: (tokenHash) => findSessionByTokenHash(db, tokenHash),
      touch: (id, at, expiresAt) => touchSession(db, id, at, expiresAt),
      revoke: (id, at) => revokeSession(db, id, at),
      revokeAllFor: (accountId, at) => revokeAllSessions(db, accountId, at ?? options.now()),
    },

    items: {
      create: async (accountId) => {
        const [row] = await db
          .insert(schema.items)
          .values({
            accountId,
            baseItemId: 'placeholder',
            baseContentVersion: 'placeholder',
            rarity: 'common',
            itemLevel: 1,
            bonuses: [],
          })
          .returning();
        return { id: row.id, accountId: row.accountId, locked: row.locked };
      },
      byId: async (id) => {
        const [row] = await db.select().from(schema.items).where(eq(schema.items.id, id));
        return row === undefined ? undefined : { id: row.id, accountId: row.accountId, locked: row.locked };
      },
      setLocked: async (id, locked) => {
        await db.update(schema.items).set({ locked }).where(eq(schema.items.id, id));
      },
    },
  };
}
