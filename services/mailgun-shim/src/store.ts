import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { hashApiKey, verifyApiKey } from './crypto.js';
import { isSafeRecipientAddress } from './recipientSafety.js';

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

/** 'held' is a lease: drained but not yet acknowledged. See claimForDrain. */
export type QueueRecipientStatus = 'pending' | 'held' | 'sent' | 'failed' | 'suppressed';

/** The parts of a parsed Mailgun send request a queued recipient still needs at drain time. */
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

/** A recipient row handed to a drain caller — held, with a lease, until it acks or the lease lapses. */
export interface DrainedRecipient {
  /** Stable across re-offers — the same crash-before-ack recipient comes back under this same id (LLD-6: "every message carries a stable id"). */
  id: string;
  batchId: string;
  domain: string;
  emailId: string | null;
  payload: QueueBatchPayload;
  recipient: string;
  /** How many times this row has been drained (including this one) — handed out again is not itself an error, only an unacked one left forever would be. */
  drainCount: number;
}

/**
 * What an ack names: not just the id, but the claim generation (the
 * `drainCount` the drainer was handed alongside that id). An id alone
 * cannot distinguish "the drainer that is currently holding this row" from
 * "a drainer whose lease on it has since lapsed and been re-offered to
 * someone else" — the id never changes across a re-offer, only
 * `drain_count` does. Carrying the generation is what lets `ackDrain` tell
 * those two apart (see its own doc comment).
 */
export interface AckRequest {
  id: string;
  drainCount: number;
}

export interface AckDrainResult {
  /** ids that were 'held' and are now 'sent' — this call's own work. */
  acked: string[];
  /** ids already 'sent' before this call — a duplicate ack, not an error (LLD-6: "the drainer can refuse a duplicate"). */
  alreadyHandled: string[];
  /** ids this store has no record of currently being held — an unknown id, or one whose lease had already lapsed and was re-offered under itself before this ack arrived. */
  unknown: string[];
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
  verifyTenant(domain: string, apiKey: string): Promise<Tenant | null>;
  tenantExists(domain: string): boolean;
  listTenants(): string[];

  recordEvent(event: Omit<StoredEvent, 'id'>): void;
  listEvents(domain: string, options: ListEventsOptions): ListEventsResult;

  addSuppression(domain: string, type: SuppressionType, email: string): void;
  removeSuppression(domain: string, type: SuppressionType, email: string): void;
  isSuppressed(domain: string, type: SuppressionType, email: string): boolean;

  /** Inserts the batch row and every recipient row (each given its own stable drain id) in one transaction. */
  enqueueBatch(params: EnqueueBatchParams): void;

  /**
   * Atomically claims up to `limit` recipients for hand-over: every row
   * already `pending`, plus every `held` row whose lease has lapsed
   * (re-offered under its original id — nothing here mints a new one). A
   * suppressed recipient is resolved in place (recorded, excluded, no
   * event) rather than ever being handed to a drainer; an unsafe address
   * is failed in place the same way. Both still count toward `limit`
   * being consumed for this call, so a caller wanting more should call
   * again rather than assume it always gets `limit` drainable rows back.
   *
   * `canSend` gates the hourly throttle — one bucket per shim process,
   * shared by every tenant that process ever holds (the deleted worker's
   * own `throttle.tryTake()` check immediately before dispatch — see
   * throttle.ts). It is asked once per row that would otherwise become
   * `held`, in claim order; the first `false` stops the whole claim
   * rather than skipping just that row, so a throttled candidate and
   * every candidate after it in this batch stay `pending` for the next
   * call, never reordered around the one that was throttled.
   * Suppressed/unsafe rows are resolved regardless of the throttle: they
   * were never going to consume a send. Omitted means unthrottled.
   */
  claimForDrain(
    now: number,
    leaseSeconds: number,
    limit: number,
    canSend?: () => boolean
  ): DrainedRecipient[];

  /**
   * The other half of the handover: a `held` id at the SAME generation the
   * ack names becomes `sent` (this store's job for that message is over),
   * a duplicate ack (already `sent`) is reported rather than erroring, and
   * anything else — an id this store has no record of, or one whose
   * `drainCount` no longer matches the row's current one — is reported as
   * `unknown` so the caller can decide what to do rather than have it
   * silently swallowed.
   *
   * The generation check is load-bearing, not decorative: an id is stable
   * across a re-offer (the row stays `held`, just with a new `held_until`
   * and an incremented `drain_count`), so a LATE ack from the drainer that
   * held it BEFORE that re-offer would otherwise still find `status ===
   * 'held'` and be accepted — crediting a claim that has since been
   * superseded, and silently discarding the mail the *new* holder is
   * responsible for while the old holder wrongly believes it is done. The
   * generation this ack was issued against, not just the id, is what
   * "held" has to mean here.
   *
   * Deliberately does not synthesize a "delivered" event: an ack means
   * the drainer took responsibility for the message, not that anyone
   * received it (LLD-6 M5) — that distinction is the whole reason the
   * old worker's premature "delivered" event was a defect, and it would
   * be the same defect one hop later to synthesize it here.
   */
  ackDrain(acks: AckRequest[], now: number): AckDrainResult;

  /**
   * Seconds since the oldest recipient still owed a hand-over (`pending`
   * or `held`) was enqueued, or null if none are outstanding. `held`
   * counts as outstanding on purpose: a drainer that keeps re-polling but
   * never acking must show up as a growing number here exactly like one
   * that stopped calling at all (LLD-8 §03b — "whatever it reports about
   * itself").
   */
  oldestUndrainedAgeSeconds(now: number): number | null;

  /** Total rows not yet resolved to a terminal state (sent/failed/suppressed) — pending plus held. */
  countUndrainedRecipients(): number;

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

    -- id is the drain-facing identity: stable across re-offers, and what
    -- an ack names. (batch_id, recipient) stays the primary key -- it is
    -- what enqueueBatch's own de-duplication and every existing join rely
    -- on -- id is a second, uniquely-indexed column rather than a
    -- replacement for it.
    CREATE TABLE IF NOT EXISTS queue_recipients (
      id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      recipient TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      drain_count INTEGER NOT NULL DEFAULT 0,
      available_at REAL NOT NULL,
      held_until REAL,
      last_error TEXT,
      PRIMARY KEY (batch_id, recipient)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_recipients_id ON queue_recipients (id);
    CREATE INDEX IF NOT EXISTS idx_queue_recipients_status_available
      ON queue_recipients (status, available_at);
    CREATE INDEX IF NOT EXISTS idx_queue_recipients_status_held_until
      ON queue_recipients (status, held_until);
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
    "INSERT INTO queue_recipients (id, batch_id, recipient, status, drain_count, available_at, held_until, last_error) VALUES (?, ?, ?, 'pending', 0, ?, NULL, NULL)"
  );
  const selectClaimCandidates = db.prepare(`
    SELECT qr.id AS id, qr.batch_id AS batch_id, qr.recipient AS recipient, qr.drain_count AS drain_count,
           qb.domain AS domain, qb.email_id AS email_id, qb.payload AS payload
    FROM queue_recipients qr
    JOIN queue_batches qb ON qb.batch_id = qr.batch_id
    WHERE (qr.status = 'pending' AND qr.available_at <= ?)
       OR (qr.status = 'held' AND qr.held_until <= ?)
    ORDER BY qb.created_at ASC, qr.rowid ASC
    LIMIT ?
  `);
  const updateHeld = db.prepare(
    'UPDATE queue_recipients SET status = ?, drain_count = drain_count + 1, held_until = ? WHERE id = ?'
  );
  const updateSuppressedById = db.prepare(
    "UPDATE queue_recipients SET status = 'suppressed', held_until = NULL WHERE id = ?"
  );
  const updateFailedById = db.prepare(
    "UPDATE queue_recipients SET status = 'failed', held_until = NULL, last_error = ? WHERE id = ?"
  );
  const selectRecipientById = db.prepare(
    'SELECT id, batch_id AS batch_id, status, drain_count FROM queue_recipients WHERE id = ?'
  );
  const updateSentById = db.prepare(
    "UPDATE queue_recipients SET status = 'sent', held_until = NULL WHERE id = ?"
  );
  const countUndrained = db.prepare(
    "SELECT COUNT(*) AS c FROM queue_recipients WHERE status IN ('pending', 'held')"
  );
  const selectOldestUndrained = db.prepare(`
    SELECT MIN(qb.created_at) AS oldest
    FROM queue_recipients qr
    JOIN queue_batches qb ON qb.batch_id = qr.batch_id
    WHERE qr.status IN ('pending', 'held')
  `);
  const countPendingForBatch = db.prepare(
    "SELECT COUNT(*) AS c FROM queue_recipients WHERE batch_id = ? AND status NOT IN ('sent', 'failed', 'suppressed')"
  );
  const updateCompletedAt = db.prepare(
    'UPDATE queue_batches SET completed_at = ? WHERE batch_id = ? AND completed_at IS NULL'
  );
  const selectOldBatchIds = db.prepare(
    'SELECT batch_id FROM queue_batches WHERE completed_at IS NOT NULL AND completed_at < ?'
  );
  const deleteRecipientsForBatch = db.prepare('DELETE FROM queue_recipients WHERE batch_id = ?');
  const deleteBatch = db.prepare('DELETE FROM queue_batches WHERE batch_id = ?');
  const pingStmt = db.prepare('SELECT 1');

  function maybeCompleteBatch(batchId: string, now: number): void {
    const row = countPendingForBatch.get(batchId) as { c: number };
    if (row.c === 0) {
      updateCompletedAt.run(now, batchId);
    }
  }

  return {
    registerTenant(domain, apiKey) {
      const { salt, hash } = hashApiKey(apiKey);
      insertTenant.run(domain, salt, hash);
    },

    async verifyTenant(domain, apiKey) {
      const row = selectTenantByDomain.get(domain) as
        { domain: string; api_key_salt: string; api_key_hash: string } | undefined;
      if (!row) {
        return null;
      }
      const ok = await verifyApiKey(apiKey, { salt: row.api_key_salt, hash: row.api_key_hash });
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
          insertRecipient.run(randomUUID(), batchId, recipient, now);
        }
      });
    },

    claimForDrain(now, leaseSeconds, limit, canSend) {
      return withTransaction(db, () => {
        const candidates = selectClaimCandidates.all(now, now, limit) as Array<{
          id: string;
          batch_id: string;
          recipient: string;
          drain_count: number;
          domain: string;
          email_id: string | null;
          payload: string;
        }>;

        const drained: DrainedRecipient[] = [];

        for (const row of candidates) {
          let suppressed = false;
          for (const type of SUPPRESSION_TYPES) {
            if (isSuppressed_(row.domain, type, row.recipient)) {
              suppressed = true;
              break;
            }
          }
          if (suppressed) {
            updateSuppressedById.run(row.id);
            maybeCompleteBatch(row.batch_id, now);
            continue;
          }

          if (!isSafeRecipientAddress(row.recipient)) {
            updateFailedById.run('Invalid recipient address', row.id);
            // Recorded so Ghost's own events polling learns about it —
            // the deleted worker recorded a 'failed' event for every
            // terminal failure it produced, and an unsafe address is a
            // terminal failure produced here now instead.
            insertEvent.run(
              randomUUID(),
              row.domain,
              'failed',
              'permanent',
              row.recipient,
              row.email_id,
              null,
              now,
              null,
              'Invalid recipient address'
            );
            maybeCompleteBatch(row.batch_id, now);
            continue;
          }

          if (canSend && !canSend()) {
            // Throttled — this row and every candidate after it in this
            // batch stay exactly as claimed (pending, or held with their
            // existing lease if this was a re-offer candidate): a
            // re-offer candidate that loses the throttle race keeps its
            // original held_until rather than being touched, so it is
            // still re-offered once that original lease lapses, not
            // pushed further out by an unrelated rate limit.
            break;
          }

          updateHeld.run('held', now + leaseSeconds, row.id);
          drained.push({
            id: row.id,
            batchId: row.batch_id,
            domain: row.domain,
            emailId: row.email_id,
            payload: JSON.parse(row.payload) as QueueBatchPayload,
            recipient: row.recipient,
            drainCount: row.drain_count + 1,
          });
        }

        return drained;
      });

      function isSuppressed_(domain: string, type: SuppressionType, email: string): boolean {
        return selectSuppression.get(domain, type, email) !== undefined;
      }
    },

    ackDrain(acks, now) {
      return withTransaction(db, () => {
        const acked: string[] = [];
        const alreadyHandled: string[] = [];
        const unknown: string[] = [];

        for (const { id, drainCount } of acks) {
          const row = selectRecipientById.get(id) as
            | { id: string; batch_id: string; status: QueueRecipientStatus; drain_count: number }
            | undefined;
          if (!row) {
            unknown.push(id);
            continue;
          }
          if (row.status === 'sent') {
            alreadyHandled.push(id);
            continue;
          }
          if (row.status !== 'held') {
            // 'pending' (lease lapsed and reclaimed before this ack arrived),
            // 'failed' or 'suppressed' — this ack is stale, not a success.
            unknown.push(id);
            continue;
          }
          if (row.drain_count !== drainCount) {
            // Held, but at a NEWER generation than this ack was issued
            // against: the lease lapsed and the row was re-offered (to
            // this same drainer or another) between this drainer taking
            // it and acking it. This ack is from a superseded claim —
            // reported unknown, never accepted as the current holder's.
            unknown.push(id);
            continue;
          }
          updateSentById.run(id);
          maybeCompleteBatch(row.batch_id, now);
          acked.push(id);
        }

        return { acked, alreadyHandled, unknown };
      });
    },

    oldestUndrainedAgeSeconds(now) {
      const row = selectOldestUndrained.get() as { oldest: number | null };
      return row.oldest === null ? null : now - row.oldest;
    },

    countUndrainedRecipients() {
      return (countUndrained.get() as { c: number }).c;
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
