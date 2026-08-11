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

/**
 * Storage seam for tenant keys, delivery events and suppressions.
 *
 * Backed by SQLite here — durable across process restarts with nothing to
 * provision, which is what a story that deploys nowhere needs. It is not
 * the production answer: Cloud Run scale-to-zero can run more than one
 * instance, and a local file isn't shared between them. The platform
 * already runs one shared Cloud SQL instance (infra/platform) that a real
 * deployment should point this interface at instead — nothing above this
 * seam should need to change when that happens.
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

  recordEvent(event: Omit<StoredEvent, 'id'>): void;
  listEvents(domain: string, options: ListEventsOptions): ListEventsResult;

  addSuppression(domain: string, type: SuppressionType, email: string): void;
  removeSuppression(domain: string, type: SuppressionType, email: string): void;
  isSuppressed(domain: string, type: SuppressionType, email: string): boolean;

  close(): void;
}

export function createSqliteStore(filename = ':memory:'): ShimStore {
  const db = new DatabaseSync(filename);

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
  `);

  const insertTenant = db.prepare(
    'INSERT OR REPLACE INTO tenants (domain, api_key_salt, api_key_hash) VALUES (?, ?, ?)'
  );
  const selectTenantByDomain = db.prepare(
    'SELECT domain, api_key_salt, api_key_hash FROM tenants WHERE domain = ?'
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
      insertSuppression.run(domain, type, email);
    },

    removeSuppression(domain, type, email) {
      deleteSuppression.run(domain, type, email);
    },

    isSuppressed(domain, type, email) {
      return selectSuppression.get(domain, type, email) !== undefined;
    },

    close() {
      db.close();
    },
  };
}
