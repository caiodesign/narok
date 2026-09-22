/**
 * The storage ports (milestone B spec part 1 §1, §5).
 *
 * Task 1 runs the whole server against in-memory implementations; task 2
 * substitutes the Drizzle adapter behind exactly these signatures without
 * touching a line of task 1's tests. That is the point of the seam: the auth,
 * origin, session, ownership and taxonomy rules are decided here, once, and
 * the database work that follows cannot quietly redecide them.
 *
 * Every write that will become a gameplay mutation already carries
 * `expectedStateVersion`, so the guard of P-20 has somewhere to live when the
 * real transaction arrives.
 */

export interface AccountRow {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  /** The algorithm tag stored beside the hash, so rehash-on-login stays possible (part 1 §9 #2). */
  readonly passwordAlgorithm: string;
  readonly stateVersion: number;
  readonly premium: boolean;
  readonly createdAt: string;
  /**
   * Epoch milliseconds, in the *same clock domain as sessions*. It was an ISO
   * string read off `Date.now()` while sessions used the injected clock, and a
   * test with a controlled clock then saw every fresh session as predating the
   * password it was issued for. One injected clock, one domain.
   */
  readonly passwordChangedAt: number;
}

export interface SessionRow {
  readonly id: string;
  readonly accountId: string;
  readonly tokenHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastSeenAt: number;
  readonly revokedAt: number | null;
}

export interface ItemRow {
  readonly id: string;
  readonly accountId: string;
  readonly locked: boolean;
}

export interface AuditRow {
  readonly accountId: string;
  readonly occurredAt: string;
  readonly reason: string;
  readonly sourceRef: string;
  readonly stateVersionAfter: number;
}

export interface AccountStore {
  byEmail(email: string): AccountRow | undefined;
  byId(id: string): AccountRow | undefined;
  create(email: string, passwordHash: string, algorithm: string): AccountRow;
  /** Revokes every session for the account in the same call (P-10). */
  resetPassword(accountId: string, password: string): Promise<void>;
}

export interface SessionStore {
  create(accountId: string, tokenHash: string, createdAt: number, expiresAt: number): SessionRow;
  byTokenHash(tokenHash: string): SessionRow | undefined;
  /** Refreshes the idle window; called per request and per heartbeat (P-11). */
  touch(id: string, at: number, expiresAt: number): void;
  revoke(id: string, at: number): void;
  revokeAllFor(accountId: string, at?: number): void;
}

export interface ItemStore {
  create(accountId: string): ItemRow;
  byId(id: string): ItemRow | undefined;
  setLocked(id: string, locked: boolean): void;
}

export interface AuditStore {
  append(row: AuditRow): void;
  rows(): readonly AuditRow[];
}

/** An idempotency record, written in the same transaction as its effect (P-25). */
export interface CommandResultStore {
  get(accountId: string, key: string): { requestHash: string; response: unknown } | undefined;
  put(accountId: string, key: string, requestHash: string, response: unknown): void;
}

export interface Stores {
  readonly accounts: AccountStore;
  readonly sessions: SessionStore;
  readonly items: ItemStore;
  readonly audit: AuditStore;
  readonly commands: CommandResultStore;
}
