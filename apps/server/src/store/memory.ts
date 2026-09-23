/**
 * In-memory stores behind the ports (milestone B spec part 1 §1).
 *
 * These exist so task 1's rules — authentication, origin, session lifetime,
 * ownership, the taxonomy — are decided and tested before a database is
 * involved. Task 2 replaces this file with the Drizzle adapter; if a rule in
 * this file turns out to be load-bearing, that is a bug in the port, not a
 * feature of this implementation.
 *
 * Not for production: it holds passwords' hashes in a Map and forgets
 * everything on restart.
 */
import { randomUUID } from 'node:crypto';
import type {
  AccountRow,
  AccountStore,
  AuditRow,
  AuditStore,
  CommandResultStore,
  ItemRow,
  ItemStore,
  SessionRow,
  SessionStore,
  Stores,
} from './ports';

export interface MemoryStores extends Stores {
  readonly accounts: AccountStore;
  readonly sessions: SessionStore;
  readonly items: ItemStore;
  readonly audit: AuditStore;
  readonly commands: CommandResultStore;
}

export interface MemoryStoreOptions {
  /** The one clock. Shared with `createApp` so session ages compare honestly. */
  readonly now?: () => number;
  readonly rehash?: (password: string) => Promise<{ hash: string; algorithm: string }>;
}

export function memoryStores(options: MemoryStoreOptions = {}): MemoryStores {
  const now = options.now ?? (() => Date.now());
  const rehash = options.rehash;
  const accounts = new Map<string, AccountRow>();
  const sessions = new Map<string, SessionRow>();
  const items = new Map<string, ItemRow>();
  const auditRows: AuditRow[] = [];
  const commands = new Map<string, { requestHash: string; response: unknown }>();

  const accountStore: AccountStore = {
    async byEmail(email) {
      const wanted = email.toLowerCase();
      for (const account of accounts.values()) if (account.email === wanted) return account;
      return undefined;
    },
    async byId(id) {
      return accounts.get(id);
    },
    async create(email, passwordHash, algorithm) {
      const at = now();
      const row: AccountRow = {
        id: randomUUID(),
        email: email.toLowerCase(),
        passwordHash,
        passwordAlgorithm: algorithm,
        stateVersion: 0,
        premium: false,
        createdAt: new Date(at).toISOString(),
        passwordChangedAt: at,
      };
      accounts.set(row.id, row);
      return row;
    },
    async resetPassword(accountId, password) {
      const existing = accounts.get(accountId);
      if (existing === undefined) return;
      const hashed = rehash === undefined
        ? { hash: `hashed:${randomUUID()}`, algorithm: existing.passwordAlgorithm }
        : await rehash(password);
      accounts.set(accountId, {
        ...existing,
        passwordHash: hashed.hash,
        passwordAlgorithm: hashed.algorithm,
        passwordChangedAt: now(),
      });
      // P-10: a password change revokes every session for the account.
      await sessionStore.revokeAllFor(accountId, now());
      auditRows.push({
        accountId,
        occurredAt: new Date(now()).toISOString(),
        reason: 'password-reset',
        sourceRef: 'admin',
        stateVersionAfter: existing.stateVersion,
      });
    },
  };

  const sessionStore: SessionStore = {
    async create(accountId, tokenHash, createdAt, expiresAt) {
      const row: SessionRow = {
        id: randomUUID(),
        accountId,
        tokenHash,
        createdAt,
        expiresAt,
        lastSeenAt: createdAt,
        revokedAt: null,
      };
      sessions.set(row.id, row);
      return row;
    },
    async byTokenHash(tokenHash) {
      for (const row of sessions.values()) if (row.tokenHash === tokenHash) return row;
      return undefined;
    },
    async touch(id, at, expiresAt) {
      const row = sessions.get(id);
      if (row !== undefined) sessions.set(id, { ...row, lastSeenAt: at, expiresAt });
    },
    async revoke(id, at) {
      const row = sessions.get(id);
      if (row !== undefined) sessions.set(id, { ...row, revokedAt: at });
    },
    async revokeAllFor(accountId, at = now()) {
      for (const [id, row] of sessions) {
        if (row.accountId === accountId && row.revokedAt === null) sessions.set(id, { ...row, revokedAt: at });
      }
    },
  };

  const itemStore: ItemStore = {
    async create(accountId) {
      const row: ItemRow = { id: randomUUID(), accountId, locked: false };
      items.set(row.id, row);
      return row;
    },
    async byId(id) {
      return items.get(id);
    },
    async setLocked(id, locked) {
      const row = items.get(id);
      if (row !== undefined) items.set(id, { ...row, locked });
    },
  };

  const auditStore: AuditStore = {
    async append(row) {
      auditRows.push(row);
    },
    async rows() {
      return auditRows;
    },
  };

  const commandStore: CommandResultStore = {
    async get(accountId, key) {
      return commands.get(`${accountId}:${key}`);
    },
    async put(accountId, key, requestHash, response) {
      commands.set(`${accountId}:${key}`, { requestHash, response });
    },
  };

  return {
    accounts: accountStore,
    sessions: sessionStore,
    items: itemStore,
    audit: auditStore,
    commands: commandStore,
  };
}
