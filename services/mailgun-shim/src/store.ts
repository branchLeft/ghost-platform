import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  min,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { hashApiKey, verifyApiKey } from './crypto.js';
import { migrateStore } from './migrate.js';
import { isSafeRecipientAddress } from './recipientSafety.js';
import { events, queueBatches, queueRecipients, suppressions, tenants } from './schema.js';

// The store's design, its schema history and its concurrency guarantees: store.md.

export type SuppressionType = 'bounces' | 'complaints' | 'unsubscribes';

export const SUPPRESSION_TYPES: readonly SuppressionType[] = [
  'bounces',
  'complaints',
  'unsubscribes',
];

export interface Tenant {
  domain: string;
  /**
   * The domain this tenant sends From, which need not equal `domain`, the
   * credential's lookup key. `null` must fail closed, never fall back to
   * `domain`. See store.md#sender-domain.
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
  /** Stable across re-offers: a crash-before-ack recipient comes back under this same id. */
  id: string;
  batchId: string;
  domain: string;
  emailId: string | null;
  payload: QueueBatchPayload;
  recipient: string;
  /** How many times this row has been drained, this time included. */
  drainCount: number;
}

/**
 * What an ack names: the id and the claim generation (`drainCount`) it was
 * handed at, since the id alone survives a re-offer. See store.md#acks-name-a-generation.
 */
export interface AckRequest {
  id: string;
  drainCount: number;
}

export interface AckDrainResult {
  /** ids that were 'held' and are now 'sent' — this call's own work. */
  acked: string[];
  /** ids already 'sent' before this call — a duplicate ack, not an error. */
  alreadyHandled: string[];
  /** ids not currently held at the named generation: unknown, stale, or superseded. */
  unknown: string[];
}

/**
 * Storage seam for tenant keys, delivery events, suppressions and the durable
 * send queue: one SQLite file, single-instance by design. See store.md.
 */
export interface ShimStore {
  /**
   * `senderDomain` is required, never defaulted from `domain`; `null` only
   * reproduces a row that predates the field. See store.md#sender-domain.
   */
  registerTenant(domain: string, apiKey: string, senderDomain: string | null): void;
  /** Resolves null for an unknown domain and for a wrong key alike: both are the same 401. */
  verifyTenant(domain: string, apiKey: string): Promise<Tenant | null>;
  tenantExists(domain: string): boolean;
  /** Every tenant with its sender domain, sorted by domain; `null` exactly when unset. */
  listTenants(): Array<{ domain: string; senderDomain: string | null }>;
  /** Sets a tenant's sender domain without rotating its key; false if the domain is unregistered. */
  setSenderDomain(domain: string, senderDomain: string): boolean;

  recordEvent(event: Omit<StoredEvent, 'id'>): void;
  listEvents(domain: string, options: ListEventsOptions): ListEventsResult;

  addSuppression(domain: string, type: SuppressionType, email: string): void;
  removeSuppression(domain: string, type: SuppressionType, email: string): void;
  isSuppressed(domain: string, type: SuppressionType, email: string): boolean;

  /** Inserts the batch row and every recipient row (each given its own stable drain id) in one transaction. */
  enqueueBatch(params: EnqueueBatchParams): void;

  /**
   * Atomically claims up to `limit` recipients: pending rows, and held rows
   * whose lease lapsed, oldest batch first. Suppressed and unsafe rows are
   * resolved in place and still count toward `limit`; the first `false` from
   * `canSend` ends the claim. See store.md#claiming-for-drain.
   */
  claimForDrain(
    now: number,
    leaseSeconds: number,
    limit: number,
    canSend?: () => boolean
  ): DrainedRecipient[];

  /**
   * Moves each id held at the named generation to 'sent'. Never records a
   * "delivered" event: an ack means the drainer took responsibility, not
   * that anyone received it. See store.md#acks-name-a-generation.
   */
  ackDrain(acks: AckRequest[], now: number): AckDrainResult;

  /**
   * Seconds since the oldest pending or held recipient was enqueued, or null.
   * Held counts, so a drainer that polls but never acks still shows here.
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

type Db = BetterSQLite3Database;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const TERMINAL_STATUSES: QueueRecipientStatus[] = ['sent', 'failed', 'suppressed'];
const UNDRAINED_STATUSES: QueueRecipientStatus[] = ['pending', 'held'];

// The type is compile-time only, and a typo'd string stored under a real
// column would never match a lookup rather than fail loudly.
function assertSuppressionType(type: SuppressionType): void {
  if (!(SUPPRESSION_TYPES as readonly string[]).includes(type)) {
    throw new TypeError(`Unknown suppression type: ${String(type)}`);
  }
}

/** Exported so the non-WAL branch, unreachable through a real file, can be tested directly. */
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
 * Opens (creating if absent) the store's SQLite file and migrates it to the
 * current schema. See store.md#opening-the-file.
 */
export function createSqliteStore(filename = ':memory:'): ShimStore {
  // The busy timeout is set at open, before the WAL switch below can contend.
  const client = new Database(filename, { timeout: 5000 });
  const journalMode = client.pragma('journal_mode = WAL', { simple: true }) as string | undefined;
  try {
    assertWalEnabled(filename, journalMode);
    migrateStore(client);
  } catch (err) {
    client.close();
    throw err;
  }
  const db = drizzle(client);

  function isSuppressedIn(q: Db | Tx, domain: string, type: string, email: string): boolean {
    return (
      q
        .select({ email: suppressions.email })
        .from(suppressions)
        .where(
          and(
            eq(suppressions.domain, domain),
            eq(suppressions.type, type),
            eq(suppressions.email, email)
          )
        )
        .get() !== undefined
    );
  }

  function insertEvent(q: Db | Tx, event: Omit<StoredEvent, 'id'>): void {
    q.insert(events)
      .values({ id: randomUUID(), ...event })
      .run();
  }

  function maybeCompleteBatch(tx: Tx, batchId: string, now: number): void {
    const outstanding = tx
      .select({ c: count() })
      .from(queueRecipients)
      .where(
        and(
          eq(queueRecipients.batchId, batchId),
          notInArray(queueRecipients.status, TERMINAL_STATUSES)
        )
      )
      .get();
    if (outstanding?.c === 0) {
      tx.update(queueBatches)
        .set({ completedAt: now })
        .where(and(eq(queueBatches.batchId, batchId), isNull(queueBatches.completedAt)))
        .run();
    }
  }

  return {
    registerTenant(domain, apiKey, senderDomain) {
      const { salt, hash } = hashApiKey(apiKey);
      const row = { apiKeySalt: salt, apiKeyHash: hash, senderDomain };
      db.insert(tenants)
        .values({ domain, ...row })
        .onConflictDoUpdate({ target: tenants.domain, set: row })
        .run();
    },

    async verifyTenant(domain, apiKey) {
      const row = db.select().from(tenants).where(eq(tenants.domain, domain)).get();
      if (!row) {
        return null;
      }
      const ok = await verifyApiKey(apiKey, { salt: row.apiKeySalt, hash: row.apiKeyHash });
      return ok ? { domain: row.domain, senderDomain: row.senderDomain } : null;
    },

    tenantExists(domain) {
      return (
        db
          .select({ domain: tenants.domain })
          .from(tenants)
          .where(eq(tenants.domain, domain))
          .get() !== undefined
      );
    },

    listTenants() {
      return db
        .select({ domain: tenants.domain, senderDomain: tenants.senderDomain })
        .from(tenants)
        .orderBy(asc(tenants.domain))
        .all();
    },

    setSenderDomain(domain, senderDomain) {
      const result = db
        .update(tenants)
        .set({ senderDomain })
        .where(eq(tenants.domain, domain))
        .run();
      return result.changes > 0;
    },

    recordEvent(event) {
      insertEvent(db, event);
    },

    listEvents(domain, { limit, offset, eventTypes }) {
      // Ghost only ever sends an OR-list of exact type names, so the filter
      // is a list match on the page, not a query-language parser.
      const rows = db
        .select()
        .from(events)
        .where(eq(events.domain, domain))
        .orderBy(asc(events.seq))
        .limit(limit)
        .offset(offset)
        .all();

      const filtered = eventTypes ? rows.filter((row) => eventTypes.includes(row.type)) : rows;

      return {
        events: filtered.map(({ seq: _seq, ...event }) => event),
        nextOffset: offset + rows.length,
      };
    },

    addSuppression(domain, type, email) {
      assertSuppressionType(type);
      db.insert(suppressions).values({ domain, type, email }).onConflictDoNothing().run();
    },

    removeSuppression(domain, type, email) {
      assertSuppressionType(type);
      db.delete(suppressions)
        .where(
          and(
            eq(suppressions.domain, domain),
            eq(suppressions.type, type),
            eq(suppressions.email, email)
          )
        )
        .run();
    },

    isSuppressed(domain, type, email) {
      assertSuppressionType(type);
      return isSuppressedIn(db, domain, type, email);
    },

    enqueueBatch({ batchId, domain, emailId, payload, recipients, now }) {
      db.transaction((tx) => {
        tx.insert(queueBatches)
          .values({ batchId, domain, emailId, payload: JSON.stringify(payload), createdAt: now })
          .run();
        for (const recipient of recipients) {
          tx.insert(queueRecipients)
            .values({ id: randomUUID(), batchId, recipient, availableAt: now })
            .run();
        }
      });
    },

    claimForDrain(now, leaseSeconds, limit, canSend) {
      return db.transaction((tx) => {
        const candidates = tx
          .select({
            id: queueRecipients.id,
            batchId: queueRecipients.batchId,
            recipient: queueRecipients.recipient,
            drainCount: queueRecipients.drainCount,
            domain: queueBatches.domain,
            emailId: queueBatches.emailId,
            payload: queueBatches.payload,
          })
          .from(queueRecipients)
          .innerJoin(queueBatches, eq(queueBatches.batchId, queueRecipients.batchId))
          .where(
            or(
              and(eq(queueRecipients.status, 'pending'), lte(queueRecipients.availableAt, now)),
              and(eq(queueRecipients.status, 'held'), lte(queueRecipients.heldUntil, now))
            )
          )
          // rowid is enqueue order within a batch; SQLite-only, and the one ordering key the schema lacks.
          .orderBy(asc(queueBatches.createdAt), asc(sql`${queueRecipients}.rowid`))
          .limit(limit)
          .all();

        const drained: DrainedRecipient[] = [];

        for (const row of candidates) {
          if (
            SUPPRESSION_TYPES.some((type) => isSuppressedIn(tx, row.domain, type, row.recipient))
          ) {
            tx.update(queueRecipients)
              .set({ status: 'suppressed', heldUntil: null })
              .where(eq(queueRecipients.id, row.id))
              .run();
            maybeCompleteBatch(tx, row.batchId, now);
            continue;
          }

          if (!isSafeRecipientAddress(row.recipient)) {
            tx.update(queueRecipients)
              .set({ status: 'failed', heldUntil: null, lastError: 'Invalid recipient address' })
              .where(eq(queueRecipients.id, row.id))
              .run();
            // Recorded so Ghost's events polling learns of this terminal failure.
            insertEvent(tx, {
              domain: row.domain,
              type: 'failed',
              severity: 'permanent',
              recipient: row.recipient,
              emailId: row.emailId,
              providerMessageId: null,
              timestamp: now,
              errorCode: null,
              errorMessage: 'Invalid recipient address',
            });
            maybeCompleteBatch(tx, row.batchId, now);
            continue;
          }

          if (canSend && !canSend()) {
            // Throttled: this row and every later candidate stay exactly as they were,
            // a lapsed lease keeping its original held_until. See store.md#claiming-for-drain.
            break;
          }

          const drainCount = row.drainCount + 1;
          tx.update(queueRecipients)
            .set({ status: 'held', drainCount, heldUntil: now + leaseSeconds })
            .where(eq(queueRecipients.id, row.id))
            .run();
          drained.push({
            id: row.id,
            batchId: row.batchId,
            domain: row.domain,
            emailId: row.emailId,
            payload: JSON.parse(row.payload) as QueueBatchPayload,
            recipient: row.recipient,
            drainCount,
          });
        }

        return drained;
      });
    },

    ackDrain(acks, now) {
      return db.transaction((tx) => {
        const acked: string[] = [];
        const alreadyHandled: string[] = [];
        const unknown: string[] = [];

        for (const { id, drainCount } of acks) {
          const row = tx
            .select({
              batchId: queueRecipients.batchId,
              status: queueRecipients.status,
              drainCount: queueRecipients.drainCount,
            })
            .from(queueRecipients)
            .where(eq(queueRecipients.id, id))
            .get();
          if (!row) {
            unknown.push(id);
          } else if (row.status === 'sent') {
            alreadyHandled.push(id);
          } else if (row.status !== 'held' || row.drainCount !== drainCount) {
            // Lapsed and reclaimed, resolved otherwise, or re-offered to a newer claim.
            unknown.push(id);
          } else {
            tx.update(queueRecipients)
              .set({ status: 'sent', heldUntil: null })
              .where(eq(queueRecipients.id, id))
              .run();
            maybeCompleteBatch(tx, row.batchId, now);
            acked.push(id);
          }
        }

        return { acked, alreadyHandled, unknown };
      });
    },

    oldestUndrainedAgeSeconds(now) {
      const row = db
        .select({ oldest: min(queueBatches.createdAt) })
        .from(queueRecipients)
        .innerJoin(queueBatches, eq(queueBatches.batchId, queueRecipients.batchId))
        .where(inArray(queueRecipients.status, UNDRAINED_STATUSES))
        .get();
      const oldest = row?.oldest ?? null;
      return oldest === null ? null : now - oldest;
    },

    countUndrainedRecipients() {
      const row = db
        .select({ c: count() })
        .from(queueRecipients)
        .where(inArray(queueRecipients.status, UNDRAINED_STATUSES))
        .get();
      return row?.c ?? 0;
    },

    cleanupCompletedBatches(olderThan) {
      return db.transaction((tx) => {
        const rows = tx
          .select({ batchId: queueBatches.batchId })
          .from(queueBatches)
          .where(and(isNotNull(queueBatches.completedAt), lt(queueBatches.completedAt, olderThan)))
          .all();
        for (const { batchId } of rows) {
          tx.delete(queueRecipients).where(eq(queueRecipients.batchId, batchId)).run();
          tx.delete(queueBatches).where(eq(queueBatches.batchId, batchId)).run();
        }
        return rows.length;
      });
    },

    ping() {
      db.select({ c: count() }).from(tenants).get();
    },

    close() {
      client.close();
    },
  };
}
