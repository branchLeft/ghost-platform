import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { hashApiKey, verifyApiKey } from './crypto.js';

export type SuppressionType = 'bounces' | 'complaints' | 'unsubscribes';

export const SUPPRESSION_TYPES: readonly SuppressionType[] = [
  'bounces',
  'complaints',
  'unsubscribes',
];

export interface Tenant {
  domain: string;
}

export interface StoredEvent {
  id: string;
  domain: string;
  type: string;
  severity: string | null;
  recipient: string;
  emailId: string | null;
  providerMessageId: string | null;
  timestamp: number;
  errorCode: number | null;
  errorMessage: string | null;
}

export interface ListEventsOptions {
  limit: number;
  offset: number;
  eventTypes?: string[];
}

export interface ListEventsResult {
  events: StoredEvent[];
  nextOffset: number;
}

export type QueueRecipientStatus = 'pending' | 'sent' | 'failed' | 'suppressed';

/** The parts of a parsed Mailgun send request a queued recipient still needs at send time. */
export interface QueueBatchPayload {
  from: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  recipientVariables: Record<string, Record<string, string>>;
}

export interface EnqueueBatchParams {
  batchId: string;
  domain: string;
  emailId: string | null;
  payload: QueueBatchPayload;
  recipients: string[];
  now: number;
}

export interface DueRecipient {
  batchId: string;
  domain: string;
  emailId: string | null;
  payload: QueueBatchPayload;
  recipient: string;
  attempts: number;
}

/**
 * Storage seam for tenant keys, delivery events, suppressions and the
 * durable send queue.
 *
 * Backed by SQLite here — durable across process restarts with nothing to
 * provision, which is what a single Hetzner host with a persistent disk
 * needs: no cloud database, no separate queue service. It is not built for
 * multi-instance coordination — a local file isn't shared between
 * processes — which this service doesn't need at its single-instance,
 * single-tenant-credentials scale.
 */
export interface ShimStore {
  registerTenant(domain: string, apiKey: string): void;
  /**
   * Looks up the tenant by domain (always present in the URL path — see
   * doc 13 §2.6) and verifies the presented key against that tenant's
   * salted hash. Collapses "unknown domain" and "wrong key for a domain
   * that exists" into a single check, since both get the same 401 (see
   * requireTenantForDomain in auth.ts).
   */
  verifyTenant(domain: string, apiKey: string): Tenant | null;
  tenantExists(domain: string): boolean;
  listTenants(): string[];

  recordEvent(event: Omit<StoredEvent, 'id'>): void;
  listEvents(domain: string, options: ListEventsOptions): ListEventsResult;

  addSuppression(domain: string, type: SuppressionType, email: string): void;
  removeSuppression(domain: string, type: SuppressionType, email: string): void;
  isSuppressed(domain: string, type: SuppressionType, email: string): boolean;

  /** Inserts the batch row and every recipient row in one transaction. */
  enqueueBatch(params: EnqueueBatchParams): void;
  /** Oldest-batch-first; a caller-supplied limit bounds one claim's work. */
  claimDueRecipients(now: number, limit: number): DueRecipient[];
  recordRecipientSent(batchId: string, recipient: string, event: Omit<StoredEvent, 'id'>): void;
  /** No event is recorded — a suppressed recipient never had mail attempted. */
  recordRecipientSuppressed(batchId: string, recipient: string): void;
  scheduleRecipientRetry(
    batchId: string,
    recipient: string,
    attempts: number,
    nextAttemptAt: number,
    lastError: string
  ): void;
  recordRecipientFailed(
    batchId: string,
    recipient: string,
    attempts: number,
    lastError: string,
    event: Omit<StoredEvent, 'id'>
  ): void;
  countPendingRecipients(): number;
  /** Returns the number of batches deleted. The events table is untouched. */
  cleanupCompletedBatches(olderThan: number): number;
  /** Throws if the underlying connection can't run a trivial query. */
  ping(): void;

  close(): void;
}

// SuppressionType is compile-time only — the suppressions route already
// filters to known types before it reaches the store (routes/suppressions.ts),
// but that guard doesn't cover other callers of this interface, and a
// typo'd type string stored under a real-looking column would silently
// never match a real isSuppressed lookup rather than failing loudly.
function assertSuppressionType(type: SuppressionType): void {
  if (!(SUPPRESSION_TYPES as readonly string[]).includes(type)) {
    throw new TypeError(`Unknown suppression type: ${String(type)}`);
  }
}

/**
 * Exported so the branch that's unreachable through the real sqlite driver
 * in a test (a file-backed PRAGMA that reports something other than "wal")
 * can still be exercised directly.
 */
export function assertWalEnabled(filename: string, journalMode: string | undefined): void {
  if (filename === ':memory:') {
    return;
  }
  if (journalMode !== 'wal') {
    throw new Error(
      `Failed to enable WAL journal mode for ${filename} (got "${String(journalMode)}")`
    );
  }
}

function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function createSqliteStore(filename = ':memory:'): ShimStore {
  const db = new DatabaseSync(filename);

  // WAL + a busy timeout rather than SQLite's default DELETE journal mode:
  // the CLI (register/list/events) opens this same file directly while the
  // service is running, and a snapshot-consistent backup needs to read the
  // file without blocking on the service's writes. `PRAGMA journal_mode`
  // returns the mode it actually ended up in (it can silently fall back,
  // e.g. on some network filesystems) — read that back and fail startup
  // rather than run every write path unprotected without saying so.
  const journalModeRow = db.prepare('PRAGMA journal_mode = WAL').get() as
    { journal_mode: string } | undefined;
  try {
    assertWalEnabled(filename, journalModeRow?.journal_mode);
  } catch (err) {
    // assertWalEnabled's own throw is unit-tested directly; forcing
    // node:sqlite itself to report a non-wal mode for a file-backed DB
    // isn't practical without mocking the built-in module.
    /* v8 ignore start */
    db.close();
    throw err;
    /* v8 ignore stop */
  }
  db.exec('PRAGMA busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      domain TEXT PRIMARY KEY,
      api_key_salt TEXT NOT NULL,
      api_key_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL,
      domain TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT,
      recipient TEXT NOT NULL,
      email_id TEXT,
      provider_message_id TEXT,
      timestamp REAL NOT NULL,
      error_code INTEGER,
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_events_domain_seq ON events (domain, seq);

    CREATE TABLE IF NOT EXISTS suppressions (
      domain TEXT NOT NULL,
      type TEXT NOT NULL,
      email TEXT NOT NULL,
      PRIMARY KEY (domain, type, email)
    );

    CREATE TABLE IF NOT EXISTS queue_batches (
      batch_id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      email_id TEXT,
      payload TEXT NOT NULL,
      created_at REAL NOT NULL,
      completed_at REAL
    );

    CREATE TABLE IF NOT EXISTS queue_recipients (
      batch_id TEXT NOT NULL,
      recipient TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at REAL NOT NULL,
      last_error TEXT,
      PRIMARY KEY (batch_id, recipient)
    );

    CREATE INDEX IF NOT EXISTS idx_queue_recipients_status_next
      ON queue_recipients (status, next_attempt_at);
  `);

  const insertTenant = db.prepare(
    'INSERT OR REPLACE INTO tenants (domain, api_key_salt, api_key_hash) VALUES (?, ?, ?)'
  );
  const selectTenantByDomain = db.prepare(
    'SELECT domain, api_key_salt, api_key_hash FROM tenants WHERE domain = ?'
  );
  const selectAllDomains = db.prepare('SELECT domain FROM tenants ORDER BY domain ASC');
  const insertEvent = db.prepare(`
    INSERT INTO events
      (id, domain, type, severity, recipient, email_id, provider_message_id, timestamp, error_code, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSuppression = db.prepare(
    'INSERT OR IGNORE INTO suppressions (domain, type, email) VALUES (?, ?, ?)'
  );
  const deleteSuppression = db.prepare(
    'DELETE FROM suppressions WHERE domain = ? AND type = ? AND email = ?'
  );
  const selectSuppression = db.prepare(
    'SELECT 1 FROM suppressions WHERE domain = ? AND type = ? AND email = ?'
  );

  const insertBatch = db.prepare(
    'INSERT INTO queue_batches (batch_id, domain, email_id, payload, created_at, completed_at) VALUES (?, ?, ?, ?, ?, NULL)'
  );
  const insertRecipient = db.prepare(
    "INSERT INTO queue_recipients (batch_id, recipient, status, attempts, next_attempt_at, last_error) VALUES (?, ?, 'pending', 0, ?, NULL)"
  );
  const selectDue = db.prepare(`
    SELECT qr.batch_id AS batch_id, qr.recipient AS recipient, qr.attempts AS attempts,
           qb.domain AS domain, qb.email_id AS email_id, qb.payload AS payload
    FROM queue_recipients qr
    JOIN queue_batches qb ON qb.batch_id = qr.batch_id
    WHERE qr.status = 'pending' AND qr.next_attempt_at <= ?
    ORDER BY qb.created_at ASC, qr.rowid ASC
    LIMIT ?
  `);
  const updateSent = db.prepare(
    "UPDATE queue_recipients SET status = 'sent' WHERE batch_id = ? AND recipient = ?"
  );
  const updateSuppressed = db.prepare(
    "UPDATE queue_recipients SET status = 'suppressed' WHERE batch_id = ? AND recipient = ?"
  );
  const updateRetry = db.prepare(
    'UPDATE queue_recipients SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE batch_id = ? AND recipient = ?'
  );
  const updateFailed = db.prepare(
    "UPDATE queue_recipients SET status = 'failed', attempts = ?, last_error = ? WHERE batch_id = ? AND recipient = ?"
  );
  const countPendingForBatch = db.prepare(
    "SELECT COUNT(*) AS c FROM queue_recipients WHERE batch_id = ? AND status = 'pending'"
  );
  const updateCompletedAt = db.prepare(
    'UPDATE queue_batches SET completed_at = ? WHERE batch_id = ? AND completed_at IS NULL'
  );
  const countAllPending = db.prepare(
    "SELECT COUNT(*) AS c FROM queue_recipients WHERE status = 'pending'"
  );
  const selectOldBatchIds = db.prepare(
    'SELECT batch_id FROM queue_batches WHERE completed_at IS NOT NULL AND completed_at < ?'
  );
  const deleteRecipientsForBatch = db.prepare('DELETE FROM queue_recipients WHERE batch_id = ?');
  const deleteBatch = db.prepare('DELETE FROM queue_batches WHERE batch_id = ?');
  const pingStmt = db.prepare('SELECT 1');

  function maybeCompleteBatch(batchId: string): void {
    const row = countPendingForBatch.get(batchId) as { c: number };
    if (row.c === 0) {
      updateCompletedAt.run(Date.now() / 1000, batchId);
    }
  }

  return {
    registerTenant(domain, apiKey) {
      const { salt, hash } = hashApiKey(apiKey);
      insertTenant.run(domain, salt, hash);
    },

    verifyTenant(domain, apiKey) {
      const row = selectTenantByDomain.get(domain) as
        { domain: string; api_key_salt: string; api_key_hash: string } | undefined;
      if (!row) {
        return null;
      }
      const ok = verifyApiKey(apiKey, { salt: row.api_key_salt, hash: row.api_key_hash });
      return ok ? { domain: row.domain } : null;
    },

    tenantExists(domain) {
      return selectTenantByDomain.get(domain) !== undefined;
    },

    listTenants() {
      return (selectAllDomains.all() as Array<{ domain: string }>).map((row) => row.domain);
    },

    recordEvent(event) {
      insertEvent.run(
        randomUUID(),
        event.domain,
        event.type,
        event.severity,
        event.recipient,
        event.emailId,
        event.providerMessageId,
        event.timestamp,
        event.errorCode,
        event.errorMessage
      );
    },

    listEvents(domain, { limit, offset, eventTypes }) {
      // mailgun.js's search syntax (`event: 'delivered OR opened OR ...'`)
      // isn't reimplemented — Ghost only ever sends an OR-list of exact
      // type names (email-analytics-provider-mailgun.js), so matching on
      // that list covers every real caller without a query-language parser.
      const rows = db
        .prepare('SELECT * FROM events WHERE domain = ? ORDER BY seq ASC LIMIT ? OFFSET ?')
        .all(domain, limit, offset) as Array<{
        id: string;
        domain: string;
        type: string;
        severity: string | null;
        recipient: string;
        email_id: string | null;
        provider_message_id: string | null;
        timestamp: number;
        error_code: number | null;
        error_message: string | null;
      }>;

      const filtered = eventTypes ? rows.filter((row) => eventTypes.includes(row.type)) : rows;

      return {
        events: filtered.map((row) => ({
          id: row.id,
          domain: row.domain,
          type: row.type,
          severity: row.severity,
          recipient: row.recipient,
          emailId: row.email_id,
          providerMessageId: row.provider_message_id,
          timestamp: row.timestamp,
          errorCode: row.error_code,
          errorMessage: row.error_message,
        })),
        nextOffset: offset + rows.length,
      };
    },

    addSuppression(domain, type, email) {
      assertSuppressionType(type);
      insertSuppression.run(domain, type, email);
    },

    removeSuppression(domain, type, email) {
      assertSuppressionType(type);
      deleteSuppression.run(domain, type, email);
    },

    isSuppressed(domain, type, email) {
      assertSuppressionType(type);
      return selectSuppression.get(domain, type, email) !== undefined;
    },

    enqueueBatch({ batchId, domain, emailId, payload, recipients, now }) {
      withTransaction(db, () => {
        insertBatch.run(batchId, domain, emailId, JSON.stringify(payload), now);
        for (const recipient of recipients) {
          insertRecipient.run(batchId, recipient, now);
        }
      });
    },

    claimDueRecipients(now, limit) {
      const rows = selectDue.all(now, limit) as Array<{
        batch_id: string;
        recipient: string;
        attempts: number;
        domain: string;
        email_id: string | null;
        payload: string;
      }>;
      return rows.map((row) => ({
        batchId: row.batch_id,
        domain: row.domain,
        emailId: row.email_id,
        payload: JSON.parse(row.payload) as QueueBatchPayload,
        recipient: row.recipient,
        attempts: row.attempts,
      }));
    },

    recordRecipientSent(batchId, recipient, event) {
      withTransaction(db, () => {
        updateSent.run(batchId, recipient);
        insertEvent.run(
          randomUUID(),
          event.domain,
          event.type,
          event.severity,
          event.recipient,
          event.emailId,
          event.providerMessageId,
          event.timestamp,
          event.errorCode,
          event.errorMessage
        );
        maybeCompleteBatch(batchId);
      });
    },

    recordRecipientSuppressed(batchId, recipient) {
      withTransaction(db, () => {
        updateSuppressed.run(batchId, recipient);
        maybeCompleteBatch(batchId);
      });
    },

    scheduleRecipientRetry(batchId, recipient, attempts, nextAttemptAt, lastError) {
      updateRetry.run(attempts, nextAttemptAt, lastError, batchId, recipient);
    },

    recordRecipientFailed(batchId, recipient, attempts, lastError, event) {
      withTransaction(db, () => {
        updateFailed.run(attempts, lastError, batchId, recipient);
        insertEvent.run(
          randomUUID(),
          event.domain,
          event.type,
          event.severity,
          event.recipient,
          event.emailId,
          event.providerMessageId,
          event.timestamp,
          event.errorCode,
          event.errorMessage
        );
        maybeCompleteBatch(batchId);
      });
    },

    countPendingRecipients() {
      return (countAllPending.get() as { c: number }).c;
    },

    cleanupCompletedBatches(olderThan) {
      return withTransaction(db, () => {
        const rows = selectOldBatchIds.all(olderThan) as Array<{ batch_id: string }>;
        for (const row of rows) {
          deleteRecipientsForBatch.run(row.batch_id);
          deleteBatch.run(row.batch_id);
        }
        return rows.length;
      });
    },

    ping() {
      pingStmt.get();
    },

    close() {
      db.close();
    },
  };
}
