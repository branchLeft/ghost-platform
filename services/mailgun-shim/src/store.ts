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
import { hashApiKey, keyMatchesSync, verifyApiKey } from './crypto.js';
import { MAIL_CLASS_RANK } from './mailClass.js';
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
  /**
   * The one From local part this credential may send as, lower-cased. `null`
   * means any local part at `senderDomain`. See store.md#sender-local-part.
   */
  senderLocalPart: string | null;
}

/** Why a registration was refused. See store.md#registration-refusals. */
export type RegistrationRefusal = 'key-bound-to-another-credential' | 'sender-address-claimed';

/**
 * Thrown, before anything is written, when a registration would let two
 * credentials act as one. `other` is the credential domain in the way: an
 * operator-visible label, never a key.
 */
export class TenantRegistrationRefused extends Error {
  constructor(
    readonly reason: RegistrationRefusal,
    readonly other: string
  ) {
    super(
      reason === 'key-bound-to-another-credential'
        ? `That key is already bound to ${other}; every credential needs its own key.`
        : `The sender address is already claimed by ${other}; one address belongs to one credential.`
    );
    this.name = 'TenantRegistrationRefused';
  }
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
export type QueueRecipientStatus =
  'pending' | 'held' | 'sent' | 'delivered' | 'failed' | 'suppressed';

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
 * What the drainer reports back about a message it has already acked, from
 * the receiving MTA's own outcome. 'delivered' means the receiving MTA
 * accepted it for the recipient; 'failed' carries a severity.
 */
export interface OutcomeRequest {
  id: string;
  drainCount: number;
  outcome: 'delivered' | 'failed';
  /** Required for 'failed'. Only 'permanent' ends the message and suppresses the address. */
  severity?: 'permanent' | 'temporary';
  code?: number;
  message?: string;
}

export interface RecordOutcomesResult {
  /** ids whose outcome this call recorded (a temporary failure is recorded as an event but leaves the row 'sent'). */
  recorded: string[];
  /** ids already carrying a final outcome: a duplicate report, not an error. */
  alreadyHandled: string[];
  /** ids not acked at the named generation: unknown, stale, superseded or not yet acked. */
  unknown: string[];
}

/**
 * Storage seam for tenant keys, delivery events, suppressions and the durable
 * send queue: one SQLite file, single-instance by design. See store.md.
 */
export interface ShimStore {
  /**
   * `senderDomain` is required, never defaulted from `domain`; `null` only
   * reproduces a row that predates the field. `senderLocalPart` binds the
   * credential to one From local part; omitted or `null` leaves any local part
   * at the sender domain. Throws `TenantRegistrationRefused` when the key is
   * already bound to a different credential, or when the registration would
   * newly overlap another credential's sender address.
   * See store.md#sender-domain, #sender-local-part and #registration-refusals.
   */
  registerTenant(
    domain: string,
    apiKey: string,
    senderDomain: string | null,
    senderLocalPart?: string | null
  ): void;
  /** Resolves null for an unknown domain and for a wrong key alike: both are the same 401. */
  verifyTenant(domain: string, apiKey: string): Promise<Tenant | null>;
  tenantExists(domain: string): boolean;
  /** Every tenant with its sender domain, sorted by domain; `null` exactly when unset. */
  listTenants(): Array<{
    domain: string;
    senderDomain: string | null;
    senderLocalPart: string | null;
  }>;
  /**
   * Sets a tenant's sender domain without rotating its key; false if the domain is unregistered.
   * Throws `TenantRegistrationRefused` when the move would newly overlap another credential's address.
   */
  setSenderDomain(domain: string, senderDomain: string): boolean;
  /**
   * Binds a tenant to one From local part without rotating its key; false if
   * the domain is unregistered. Throws `TenantRegistrationRefused` when
   * another credential already claims that address.
   */
  setSenderLocalPart(domain: string, senderLocalPart: string): boolean;
  /**
   * Deletes exactly the one credential row and nothing else: its events,
   * suppressions and queued mail stay. False if the domain is unregistered.
   * See store.md#removing-a-credential.
   */
  removeTenant(domain: string): boolean;

  recordEvent(event: Omit<StoredEvent, 'id'>): void;
  listEvents(domain: string, options: ListEventsOptions): ListEventsResult;

  addSuppression(domain: string, type: SuppressionType, email: string): void;
  removeSuppression(domain: string, type: SuppressionType, email: string): void;
  isSuppressed(domain: string, type: SuppressionType, email: string): boolean;

  /** Inserts the batch row and every recipient row (each given its own stable drain id) in one transaction. */
  enqueueBatch(params: EnqueueBatchParams): void;

  /**
   * Atomically claims up to `limit` recipients: pending rows, and held rows
   * whose lease lapsed, login mail (no email id) before bulk, then oldest batch first. Suppressed and unsafe rows are
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
   * Records the receiving MTA's outcome for messages already acked ('sent').
   * Only this method ever records a 'delivered' event; an ack never does.
   * A permanent failure ends the row 'failed' and suppresses the address as a
   * bounce; a temporary one is recorded as an event only. See
   * store.md#outcomes-come-back-after-the-ack.
   */
  recordOutcomes(outcomes: OutcomeRequest[], now: number): RecordOutcomesResult;

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

const TERMINAL_STATUSES: QueueRecipientStatus[] = ['sent', 'delivered', 'failed', 'suppressed'];
const UNDRAINED_STATUSES: QueueRecipientStatus[] = ['pending', 'held'];
/** A recipient in one of these for a newsletter is not queued again for it. */
const REPLAY_REFUSING_STATUSES: QueueRecipientStatus[] = ['pending', 'held', 'sent', 'delivered'];

// The type is compile-time only, and a typo'd string stored under a real
// column would never match a lookup rather than fail loudly.
function assertSuppressionType(type: SuppressionType): void {
  if (!(SUPPRESSION_TYPES as readonly string[]).includes(type)) {
    throw new TypeError(`Unknown suppression type: ${String(type)}`);
  }
}

/** The address a credential may send as: its sender domain and, when bound, its one local part. */
interface SenderClaim {
  senderDomain: string | null;
  senderLocalPart: string | null;
}

/**
 * Domains and local parts are compared lower-cased, so one address cannot be
 * claimed twice by differing in case. A local part that is empty or holds
 * whitespace or `@` is a caller error, never stored.
 */
function normaliseClaim(senderDomain: string | null, senderLocalPart: string | null): SenderClaim {
  if (senderLocalPart !== null && !/^[^\s@]+$/.test(senderLocalPart)) {
    throw new TypeError(`Not a From local part: ${JSON.stringify(senderLocalPart)}`);
  }
  return {
    senderDomain: senderDomain === null ? null : senderDomain.toLowerCase(),
    senderLocalPart: senderLocalPart === null ? null : senderLocalPart.toLowerCase(),
  };
}

/**
 * Two credentials overlap when they could send as the same address: the same
 * sender domain, and either side unrestricted or the same local part. A row
 * with no sender domain claims nothing (it is refused at send time).
 */
function claimsOverlap(a: SenderClaim, b: SenderClaim): boolean {
  if (a.senderDomain === null || b.senderDomain === null) return false;
  if (a.senderDomain !== b.senderDomain) return false;
  return (
    a.senderLocalPart === null ||
    b.senderLocalPart === null ||
    a.senderLocalPart === b.senderLocalPart
  );
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

  /**
   * The credential domain, other than `domain`, whose stored hash `apiKey`
   * matches. A row whose hash is already in `checked` was hashed against this
   * key by an earlier call and is skipped; every row looked at is added, so a
   * second call hashes only rows that are new or rotated since the first.
   */
  function otherHolderOf(
    q: Db | Tx,
    domain: string,
    apiKey: string,
    checked: Map<string, string>
  ): string | undefined {
    for (const other of q.select().from(tenants).all()) {
      if (other.domain === domain || checked.get(other.domain) === other.apiKeyHash) continue;
      if (keyMatchesSync(apiKey, { salt: other.apiKeySalt, hash: other.apiKeyHash })) {
        return other.domain;
      }
      checked.set(other.domain, other.apiKeyHash);
    }
    return undefined;
  }

  /**
   * Refuses a claim that overlaps another credential's where the credential's
   * previous claim did not. Narrowing a legacy row, or rotating it unchanged,
   * therefore always passes: no registration ever creates an overlap.
   */
  function assertNoNewOverlap(q: Db | Tx, domain: string, next: SenderClaim): void {
    const rows = q.select().from(tenants).all();
    const previous = rows.find((row) => row.domain === domain);
    for (const other of rows) {
      if (other.domain === domain) continue;
      const theirs = normaliseClaim(other.senderDomain, other.senderLocalPart);
      const alreadyOverlapped =
        previous !== undefined &&
        claimsOverlap(normaliseClaim(previous.senderDomain, previous.senderLocalPart), theirs);
      if (claimsOverlap(next, theirs) && !alreadyOverlapped) {
        throw new TenantRegistrationRefused('sender-address-claimed', other.domain);
      }
    }
  }

  return {
    registerTenant(domain, apiKey, senderDomain, senderLocalPart = null) {
      const claim = normaliseClaim(senderDomain, senderLocalPart);
      // Salts are per row, so a shared key is invisible to a lookup: it is found
      // by hashing the key under every other credential's salt, one scrypt each.
      // That runs before the write lock is taken, so a host with many
      // credentials does not hold up the service's own writes while it does.
      const checked = new Map<string, string>();
      const holder = otherHolderOf(db, domain, apiKey, checked);
      if (holder !== undefined) {
        throw new TenantRegistrationRefused('key-bound-to-another-credential', holder);
      }
      // One immediate transaction, so the remaining checks and the write see the
      // same rows even with the service or a second CLI process writing meanwhile.
      db.transaction(
        (tx) => {
          // Only a row added or rotated since the scan above still needs hashing.
          const late = otherHolderOf(tx, domain, apiKey, checked);
          if (late !== undefined) {
            throw new TenantRegistrationRefused('key-bound-to-another-credential', late);
          }
          assertNoNewOverlap(tx, domain, claim);
          const { salt, hash } = hashApiKey(apiKey);
          const row = { apiKeySalt: salt, apiKeyHash: hash, ...claim };
          tx.insert(tenants)
            .values({ domain, ...row })
            .onConflictDoUpdate({ target: tenants.domain, set: row })
            .run();
        },
        { behavior: 'immediate' }
      );
    },

    async verifyTenant(domain, apiKey) {
      const row = db.select().from(tenants).where(eq(tenants.domain, domain)).get();
      if (!row) {
        return null;
      }
      const ok = await verifyApiKey(apiKey, { salt: row.apiKeySalt, hash: row.apiKeyHash });
      return ok
        ? {
            domain: row.domain,
            senderDomain: row.senderDomain,
            senderLocalPart: row.senderLocalPart,
          }
        : null;
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
        .select({
          domain: tenants.domain,
          senderDomain: tenants.senderDomain,
          senderLocalPart: tenants.senderLocalPart,
        })
        .from(tenants)
        .orderBy(asc(tenants.domain))
        .all();
    },

    setSenderDomain(domain, senderDomain) {
      return db.transaction(
        (tx) => {
          const row = tx.select().from(tenants).where(eq(tenants.domain, domain)).get();
          if (!row) return false;
          const claim = normaliseClaim(senderDomain, row.senderLocalPart);
          assertNoNewOverlap(tx, domain, claim);
          tx.update(tenants)
            .set({ senderDomain: claim.senderDomain })
            .where(eq(tenants.domain, domain))
            .run();
          return true;
        },
        { behavior: 'immediate' }
      );
    },

    setSenderLocalPart(domain, senderLocalPart) {
      return db.transaction(
        (tx) => {
          const row = tx.select().from(tenants).where(eq(tenants.domain, domain)).get();
          if (!row) return false;
          const claim = normaliseClaim(row.senderDomain, senderLocalPart);
          assertNoNewOverlap(tx, domain, claim);
          tx.update(tenants)
            .set({ senderLocalPart: claim.senderLocalPart })
            .where(eq(tenants.domain, domain))
            .run();
          return true;
        },
        { behavior: 'immediate' }
      );
    },

    removeTenant(domain) {
      const result = db.delete(tenants).where(eq(tenants.domain, domain)).run();
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

    enqueueBatch({ batchId, domain, emailId, payload, recipients: offered, now }) {
      db.transaction((tx) => {
        // A recipient already queued or sent this newsletter is dropped, whichever
        // batch carried it; a failed or suppressed copy is not. Mail with no
        // email id is not checked. See store.md#a-replayed-batch-is-refused.
        const recipients =
          emailId === null || emailId === ''
            ? offered
            : offered.filter(
                (recipient) =>
                  tx
                    .select({ one: sql<number>`1` })
                    .from(queueRecipients)
                    .innerJoin(queueBatches, eq(queueBatches.batchId, queueRecipients.batchId))
                    .where(
                      and(
                        eq(queueBatches.domain, domain),
                        eq(queueBatches.emailId, emailId),
                        eq(queueRecipients.recipient, recipient),
                        inArray(queueRecipients.status, REPLAY_REFUSING_STATUSES)
                      )
                    )
                    .limit(1)
                    .get() === undefined
              );
        if (recipients.length === 0 && offered.length > 0) {
          return;
        }
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
          // Login mail first, so it is never queued behind a bulk batch enqueued earlier;
          // then oldest batch first. rowid is enqueue order within a batch; SQLite-only,
          // and the one ordering key the schema lacks. See store.md#claiming-for-drain.
          .orderBy(
            asc(MAIL_CLASS_RANK),
            asc(queueBatches.createdAt),
            asc(sql`${queueRecipients}.rowid`)
          )
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
          } else if (row.status === 'sent' || row.status === 'delivered') {
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

    recordOutcomes(outcomes, now) {
      return db.transaction((tx) => {
        const recorded: string[] = [];
        const alreadyHandled: string[] = [];
        const unknown: string[] = [];

        for (const report of outcomes) {
          const row = tx
            .select({
              status: queueRecipients.status,
              drainCount: queueRecipients.drainCount,
              recipient: queueRecipients.recipient,
              domain: queueBatches.domain,
              emailId: queueBatches.emailId,
            })
            .from(queueRecipients)
            .innerJoin(queueBatches, eq(queueBatches.batchId, queueRecipients.batchId))
            .where(eq(queueRecipients.id, report.id))
            .get();
          if (!row || row.drainCount !== report.drainCount) {
            unknown.push(report.id);
            continue;
          }
          if (row.status === 'delivered' || (row.status === 'failed' && row.drainCount > 0)) {
            alreadyHandled.push(report.id);
            continue;
          }
          if (row.status !== 'sent') {
            // Not acked yet (or never drained): the drainer has no outcome to give.
            unknown.push(report.id);
            continue;
          }

          const base = {
            domain: row.domain,
            recipient: row.recipient,
            emailId: row.emailId,
            providerMessageId: null,
            timestamp: now,
          };
          if (report.outcome === 'delivered') {
            tx.update(queueRecipients)
              .set({ status: 'delivered' })
              .where(eq(queueRecipients.id, report.id))
              .run();
            insertEvent(tx, {
              ...base,
              type: 'delivered',
              severity: null,
              errorCode: null,
              errorMessage: null,
            });
          } else if (report.severity === 'permanent') {
            tx.update(queueRecipients)
              .set({ status: 'failed', lastError: report.message ?? 'Permanent delivery failure' })
              .where(eq(queueRecipients.id, report.id))
              .run();
            insertEvent(tx, {
              ...base,
              type: 'failed',
              severity: 'permanent',
              errorCode: report.code ?? null,
              errorMessage: report.message ?? null,
            });
            tx.insert(suppressions)
              .values({ domain: row.domain, type: 'bounces', email: row.recipient })
              .onConflictDoNothing()
              .run();
          } else {
            // Temporary: the receiving MTA may still deliver, so the row stays 'sent'
            // (accepted) and a later final outcome can still arrive.
            insertEvent(tx, {
              ...base,
              type: 'failed',
              severity: 'temporary',
              errorCode: report.code ?? null,
              errorMessage: report.message ?? null,
            });
          }
          recorded.push(report.id);
        }

        return { recorded, alreadyHandled, unknown };
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
