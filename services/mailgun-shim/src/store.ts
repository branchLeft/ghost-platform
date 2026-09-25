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
  /**
   * The domain this tenant actually sends From — held separately from
   * `domain` (the credential's lookup key) because the two are not
   * guaranteed equal: tenant zero's credential key is the Mailgun
   * `bulkEmailDomain` (`blog.branchleft.co.uk`), but its real newsletters
   * go out From the apex (`branchleft.co.uk`). `null` for a tenant that
   * predates this field (a row migrated in from before it existed) or was
   * never given one — callers must fail closed on `null`, never fall back
   * to `domain`.
   */
  senderDomain: string | null;
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
  /**
   * `senderDomain` is required, never defaulted from `domain` — a caller
   * that only has the credential key must decide explicitly (the CLI's
   * `register` command refuses to run without `--sender-domain` for
   * exactly this reason; see cli.ts). Pass `null` only for a test
   * reproducing a pre-migration row; every real registration path must
   * supply a real domain.
   */
  registerTenant(domain: string, apiKey: string, senderDomain: string | null): void;
  /**
   * Looks up the tenant by domain (always present in the URL path — see
   * doc 13 §2.6) and verifies the presented key against that tenant's
   * salted hash. Collapses "unknown domain" and "wrong key for a domain
   * that exists" into a single check, since both get the same 401 (see
   * requireTenantForDomain in auth.ts).
   */
  verifyTenant(domain: string, apiKey: string): Promise<Tenant | null>;
  tenantExists(domain: string): boolean;
  /**
   * Domain and sender domain together — an operator diagnosing "is the
   * sender-domain control actually live for this tenant" (e.g. the
   * shim-upgrade runbook's post-redeploy check) needs both, and a bare
   * domain list can't answer it: a tenant with `senderDomain: null` shows
   * identically to a fully-configured one in a list of credential domains
   * alone. `senderDomain` is `null` exactly when `Tenant.senderDomain` is
   * (see that field's own doc comment) — never defaulted or guessed here.
   */
  listTenants(): Array<{ domain: string; senderDomain: string | null }>;
  /**
   * Sets a tenant's sending domain without touching its API key — the
   * operator path for a tenant that already exists (every row migrated in
   * from before this field existed) rather than re-registering it, which
   * would rotate its credential out from under it. Returns false if the
   * domain isn't a registered tenant at all.
   */
  setSenderDomain(domain: string, senderDomain: string): boolean;

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

/**
 * `CREATE TABLE IF NOT EXISTS` below already gives a brand-new database
 * `sender_domain` from the start — this only patches a database created
 * before the column existed, which is the shim's live production state
 * (mx1's SQLite file predates this field). `PRAGMA table_info` is cheap
 * (no table scan) and safe to run on every startup, so this always runs
 * rather than being gated behind a version check: it is a no-op the
 * instant the column is already there, on both the fresh-install and the
 * already-migrated path.
 */
function hasSenderDomainColumn(db: DatabaseSync): boolean {
  const columns = db.prepare('PRAGMA table_info(tenants)').all() as Array<{ name: string }>;
  return columns.some((col) => col.name === 'sender_domain');
}

/**
 * More than one process can reach this on the same pre-migration database
 * at once — the service's own container and an operator's `docker
 * run`/`exec` CLI invocation, or two CLI invocations back to back.
 * `PRAGMA table_info` then `ALTER TABLE` is a read followed
 * by a write with nothing serialising them, so two processes can both read
 * "column missing" before either has added it, and the loser's `ALTER`
 * fails with "duplicate column name: sender_domain" once the winner's has
 * committed. That failure means the column now exists — exactly what this
 * function was trying to ensure — so it is caught and re-verified via a
 * fresh `table_info` read rather than left to crash startup. Any other
 * error (a real schema problem, a locked-out connection past the busy
 * timeout) still propagates: this only swallows the one specific,
 * harmless race outcome.
 */
export function ensureSenderDomainColumn(db: DatabaseSync): void {
  if (hasSenderDomainColumn(db)) {
    return;
  }
  try {
    // Existing rows get NULL, never a guessed default (e.g. the credential
    // key) — a tenant migrated in this way must fail closed until an
    // operator sets its real sending domain explicitly (setSenderDomain /
    // the CLI's set-sender-domain command), never be silently bound to a
    // value nobody confirmed.
    db.exec('ALTER TABLE tenants ADD COLUMN sender_domain TEXT');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('duplicate column name: sender_domain')) {
      throw err;
    }
    /* v8 ignore start -- proven unreachable through the real sqlite
     * driver: it only ever raises this exact error once the column really
     * is there, so the re-check below always succeeds. Kept as a
     * fail-closed guard against a future sqlite version changing what
     * "duplicate column" means, mirroring assertWalEnabled's own
     * unreachable-branch pattern above. */
    if (!hasSenderDomainColumn(db)) {
      throw err;
    }
    /* v8 ignore stop */
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

  // busy_timeout BEFORE journal_mode=WAL, deliberately: sqlite's default
  // busy timeout is 0 (fail immediately on SQLITE_BUSY, no wait at all),
  // and the `PRAGMA journal_mode = WAL` statement itself takes a lock
  // another concurrently-opening process (the CLI, run directly against
  // this file — see below) can hold at the exact moment this one runs it.
  // Setting the timeout first means that very first statement already
  // waits rather than failing outright — the alternative ordering leaves a
  // window, right at startup, where two processes opening the same
  // pre-migration file at once could hit a bare SQLITE_BUSY before either
  // had a timeout in effect.
  db.exec('PRAGMA busy_timeout = 5000');

  // WAL + that busy timeout rather than SQLite's default DELETE journal
  // mode: the CLI (register/list/events) opens this same file directly
  // while the service is running, and a snapshot-consistent backup needs
  // to read the file without blocking on the service's writes. `PRAGMA
  // journal_mode` returns the mode it actually ended up in (it can
  // silently fall back, e.g. on some network filesystems) — read that
  // back and fail startup rather than run every write path unprotected
  // without saying so.
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      domain TEXT PRIMARY KEY,
      api_key_salt TEXT NOT NULL,
      api_key_hash TEXT NOT NULL,
      sender_domain TEXT
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

  // Patches a database created before sender_domain existed — see the
  // function's own doc comment. Runs after the CREATE TABLE above (which
  // already gives a brand-new database the column) so this is always a
  // no-op except on a database that predates the column.
  ensureSenderDomainColumn(db);

  const insertTenant = db.prepare(
    'INSERT OR REPLACE INTO tenants (domain, api_key_salt, api_key_hash, sender_domain) VALUES (?, ?, ?, ?)'
  );
  const selectTenantByDomain = db.prepare(
    'SELECT domain, api_key_salt, api_key_hash, sender_domain FROM tenants WHERE domain = ?'
  );
  const updateSenderDomain = db.prepare('UPDATE tenants SET sender_domain = ? WHERE domain = ?');
  const selectAllDomains = db.prepare(
    'SELECT domain, sender_domain FROM tenants ORDER BY domain ASC'
  );
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
    registerTenant(domain, apiKey, senderDomain) {
      const { salt, hash } = hashApiKey(apiKey);
      insertTenant.run(domain, salt, hash, senderDomain);
    },

    async verifyTenant(domain, apiKey) {
      const row = selectTenantByDomain.get(domain) as
        | {
            domain: string;
            api_key_salt: string;
            api_key_hash: string;
            sender_domain: string | null;
          }
        | undefined;
      if (!row) {
        return null;
      }
      const ok = await verifyApiKey(apiKey, { salt: row.api_key_salt, hash: row.api_key_hash });
      return ok ? { domain: row.domain, senderDomain: row.sender_domain } : null;
    },

    tenantExists(domain) {
      return selectTenantByDomain.get(domain) !== undefined;
    },

    listTenants() {
      return (
        selectAllDomains.all() as Array<{ domain: string; sender_domain: string | null }>
      ).map((row) => ({ domain: row.domain, senderDomain: row.sender_domain }));
    },

    setSenderDomain(domain, senderDomain) {
      const result = updateSenderDomain.run(senderDomain, domain);
      // `changes` is typed `number | bigint` (node:sqlite) — Number() first
      // so this never risks a bigint/number operator mismatch.
      return Number(result.changes) > 0;
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
