import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashApiKey } from '../../src/crypto.js';
import {
  assertWalEnabled,
  createSqliteStore,
  ensureSenderDomainColumn,
  type QueueBatchPayload,
  type ShimStore,
  type StoredEvent,
} from '../../src/store.js';

const DOMAIN = 'tenant.example.com';

function makeEvent(overrides: Partial<Omit<StoredEvent, 'id'>> = {}): Omit<StoredEvent, 'id'> {
  return {
    domain: DOMAIN,
    type: 'delivered',
    severity: null,
    recipient: 'member@example.com',
    emailId: null,
    providerMessageId: null,
    timestamp: Date.now() / 1000,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

describe('createSqliteStore — tenant key/domain mapping', () => {
  let store: ShimStore;

  beforeEach(() => {
    store = createSqliteStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('registers a tenant and verifies its own key against its own domain', async () => {
    store.registerTenant(DOMAIN, 'the-secret-key', DOMAIN);
    await expect(store.verifyTenant(DOMAIN, 'the-secret-key')).resolves.toEqual({
      domain: DOMAIN,
      senderDomain: DOMAIN,
    });
  });

  it('returns null for an unknown domain', async () => {
    await expect(
      store.verifyTenant('never-registered.example.com', 'anything')
    ).resolves.toBeNull();
  });

  it('returns null for a known domain with the wrong key', async () => {
    store.registerTenant(DOMAIN, 'the-secret-key', DOMAIN);
    await expect(store.verifyTenant(DOMAIN, 'wrong-key')).resolves.toBeNull();
  });

  it('re-registering a domain (INSERT OR REPLACE) replaces its key rather than erroring', async () => {
    store.registerTenant(DOMAIN, 'old-key', DOMAIN);
    store.registerTenant(DOMAIN, 'new-key', DOMAIN);
    await expect(store.verifyTenant(DOMAIN, 'old-key')).resolves.toBeNull();
    await expect(store.verifyTenant(DOMAIN, 'new-key')).resolves.toEqual({
      domain: DOMAIN,
      senderDomain: DOMAIN,
    });
  });

  it("registers a tenant whose sender domain differs from its credential key — tenant zero's own live shape", async () => {
    // The credential key (bulkEmailDomain) and the tenant's real sending
    // domain are not the same value.
    store.registerTenant('blog.branchleft.co.uk', 'blog-key', 'branchleft.co.uk');
    await expect(store.verifyTenant('blog.branchleft.co.uk', 'blog-key')).resolves.toEqual({
      domain: 'blog.branchleft.co.uk',
      senderDomain: 'branchleft.co.uk',
    });
  });

  it('setSenderDomain updates an existing tenant without touching its API key', async () => {
    store.registerTenant('blog.branchleft.co.uk', 'blog-key', null);
    expect(store.setSenderDomain('blog.branchleft.co.uk', 'branchleft.co.uk')).toBe(true);
    await expect(store.verifyTenant('blog.branchleft.co.uk', 'blog-key')).resolves.toEqual({
      domain: 'blog.branchleft.co.uk',
      senderDomain: 'branchleft.co.uk',
    });
  });

  it('setSenderDomain returns false and changes nothing for a domain that was never registered', () => {
    expect(store.setSenderDomain('never-registered.example.com', 'branchleft.co.uk')).toBe(false);
    expect(store.tenantExists('never-registered.example.com')).toBe(false);
  });
});

describe('createSqliteStore — migrating a database that predates sender_domain', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-store-migration-test-'));
    dbPath = join(dir, 'shim.sqlite');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Reproduces the live shim's SQLite file on mx1: a `tenants` table
   * created before `sender_domain` existed, already holding a real
   * tenant row. `createSqliteStore` must not choke on it, and must not
   * invent a value for the column it adds — see `ensureSenderDomainColumn`
   * (store.ts) and its own doc comment.
   */
  function createPreMigrationDatabase(): void {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE tenants (
        domain TEXT PRIMARY KEY,
        api_key_salt TEXT NOT NULL,
        api_key_hash TEXT NOT NULL
      );
    `);
    const { salt, hash } = hashApiKey('legacy-key');
    db.prepare('INSERT INTO tenants (domain, api_key_salt, api_key_hash) VALUES (?, ?, ?)').run(
      'blog.branchleft.co.uk',
      salt,
      hash
    );
    db.close();
  }

  it('opens a pre-existing database with no sender_domain column, adding it with every existing row NULL rather than refusing to start', async () => {
    createPreMigrationDatabase();

    const store = createSqliteStore(dbPath);
    try {
      await expect(store.verifyTenant('blog.branchleft.co.uk', 'legacy-key')).resolves.toEqual({
        domain: 'blog.branchleft.co.uk',
        senderDomain: null,
      });
      // The pre-existing key still works — the migration touches only the
      // schema, never the row's own credential.
      await expect(store.verifyTenant('blog.branchleft.co.uk', 'wrong-key')).resolves.toBeNull();
    } finally {
      store.close();
    }
  });

  it('the migration is idempotent — re-opening the same file a second time neither errors nor clobbers a sender domain set in between', async () => {
    createPreMigrationDatabase();

    const first = createSqliteStore(dbPath);
    first.setSenderDomain('blog.branchleft.co.uk', 'branchleft.co.uk');
    first.close();

    const second = createSqliteStore(dbPath);
    try {
      await expect(second.verifyTenant('blog.branchleft.co.uk', 'legacy-key')).resolves.toEqual({
        domain: 'blog.branchleft.co.uk',
        senderDomain: 'branchleft.co.uk',
      });
    } finally {
      second.close();
    }
  });

  it("ensureSenderDomainColumn is a no-op against a database that already has the column (exercised directly, mirroring assertWalEnabled's own pattern)", () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE tenants (
        domain TEXT PRIMARY KEY,
        api_key_salt TEXT NOT NULL,
        api_key_hash TEXT NOT NULL,
        sender_domain TEXT
      );
    `);
    expect(() => ensureSenderDomainColumn(db)).not.toThrow();
    expect(() => ensureSenderDomainColumn(db)).not.toThrow();
    db.close();
  });

  it('propagates an ALTER failure that is not the concurrent-migrator race — a real schema problem must not be swallowed', () => {
    createPreMigrationDatabase();
    const db = new DatabaseSync(dbPath);
    const brokenDb = {
      prepare: (sql: string) => db.prepare(sql),
      exec: (sql: string) => {
        if (sql.includes('ALTER TABLE tenants ADD COLUMN sender_domain')) {
          throw new Error('disk I/O error');
        }
        db.exec(sql);
      },
    } as unknown as DatabaseSync;

    expect(() => ensureSenderDomainColumn(brokenDb)).toThrowError('disk I/O error');
    db.close();
  });

  /**
   * Two connections opening the same pre-migration file can both read
   * "column missing" before either has written it, and the loser's
   * `ALTER` then fails with sqlite's own
   * "duplicate column name: sender_domain" — mx1 runs exactly this shape
   * (the service's own container plus an operator's `docker run`/`exec`
   * CLI invocation against the same bind-mounted file). Two REAL
   * connections to the same on-disk file drive this: `racedDb` is a thin
   * wrapper around `loserConn` whose `exec` — at the exact moment the real
   * `ensureSenderDomainColumn` under test calls it for the `ALTER` —
   * opens a SEPARATE real connection, runs the real winning `ALTER` on
   * it, closes it, then lets `loserConn` attempt the identical `ALTER`
   * for real. That produces sqlite's actual error, not a fabricated one,
   * so this also proves the catch's string match is correct against real
   * sqlite behaviour, not just against a guessed message.
   */
  it("recovers when a concurrent connection adds the column between this connection's own table_info read and its own ALTER, rather than crashing startup", () => {
    createPreMigrationDatabase();
    const loserConn = new DatabaseSync(dbPath);
    loserConn.exec('PRAGMA busy_timeout = 5000');
    loserConn.exec('PRAGMA journal_mode = WAL');

    let alterAttempted = false;
    const racedDb = {
      prepare: (sql: string) => loserConn.prepare(sql),
      exec: (sql: string) => {
        if (sql.includes('ALTER TABLE tenants ADD COLUMN sender_domain') && !alterAttempted) {
          alterAttempted = true;
          const winner = new DatabaseSync(dbPath);
          winner.exec('PRAGMA busy_timeout = 5000');
          winner.exec('ALTER TABLE tenants ADD COLUMN sender_domain TEXT');
          winner.close();
        }
        loserConn.exec(sql);
      },
    } as unknown as DatabaseSync;

    expect(() => ensureSenderDomainColumn(racedDb)).not.toThrow();
    expect(alterAttempted).toBe(true);

    const columns = loserConn.prepare('PRAGMA table_info(tenants)').all() as Array<{
      name: string;
    }>;
    expect(columns.some((col) => col.name === 'sender_domain')).toBe(true);

    // The real row this cycle's other migration tests already cover
    // survived untouched — this test's own focus is the race, not
    // re-proving data survival, so a light check is enough here.
    const row = loserConn
      .prepare('SELECT domain FROM tenants WHERE domain = ?')
      .get('blog.branchleft.co.uk') as { domain: string } | undefined;
    expect(row?.domain).toBe('blog.branchleft.co.uk');

    loserConn.close();
  });

  /**
   * `node:sqlite`'s `DatabaseSync` is fully synchronous — nothing in one
   * process can genuinely interleave two of its calls on a microtask
   * boundary, so this does not reproduce true concurrency the way the
   * review's own 8-process reproduction did (that's the previous test's
   * job, driving two real connections through a hand-orchestrated
   * interleaving instead). What this proves: several real connections
   * opening — and each fully migrating — the SAME pre-migration file, one
   * after another with nothing but real sqlite state between them, never
   * throw and never leave the schema or the row in a bad state, over
   * several repetitions of the exact sequence a live host runs on every
   * restart.
   */
  it('several connections opening the same pre-migration database in turn all succeed, none throwing', () => {
    createPreMigrationDatabase();
    const OPENS = 8;

    for (let i = 0; i < OPENS; i += 1) {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA journal_mode = WAL');
      expect(() => ensureSenderDomainColumn(db)).not.toThrow();
      db.close();
    }

    const verify = new DatabaseSync(dbPath);
    const columns = verify.prepare('PRAGMA table_info(tenants)').all() as Array<{ name: string }>;
    expect(columns.some((col) => col.name === 'sender_domain')).toBe(true);
    const row = verify
      .prepare('SELECT domain FROM tenants WHERE domain = ?')
      .get('blog.branchleft.co.uk') as { domain: string } | undefined;
    expect(row?.domain).toBe('blog.branchleft.co.uk');
    verify.close();
  });
});

describe('createSqliteStore — suppressions', () => {
  let store: ShimStore;

  beforeEach(() => {
    store = createSqliteStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it.each(['bounces', 'complaints', 'unsubscribes'] as const)(
    'add/check/delete round-trip for suppression type %s',
    (type) => {
      expect(store.isSuppressed(DOMAIN, type, 'member@example.com')).toBe(false);
      store.addSuppression(DOMAIN, type, 'member@example.com');
      expect(store.isSuppressed(DOMAIN, type, 'member@example.com')).toBe(true);
      store.removeSuppression(DOMAIN, type, 'member@example.com');
      expect(store.isSuppressed(DOMAIN, type, 'member@example.com')).toBe(false);
    }
  );

  it('adding the same suppression twice does not throw (INSERT OR IGNORE)', () => {
    store.addSuppression(DOMAIN, 'bounces', 'member@example.com');
    expect(() => store.addSuppression(DOMAIN, 'bounces', 'member@example.com')).not.toThrow();
    expect(store.isSuppressed(DOMAIN, 'bounces', 'member@example.com')).toBe(true);
  });

  it('removing a suppression that was never added is a no-op, not an error', () => {
    expect(() =>
      store.removeSuppression(DOMAIN, 'bounces', 'never-added@example.com')
    ).not.toThrow();
  });

  it('suppressions are isolated per domain', () => {
    store.addSuppression(DOMAIN, 'bounces', 'member@example.com');
    expect(store.isSuppressed('other-tenant.example.com', 'bounces', 'member@example.com')).toBe(
      false
    );
  });

  it('suppressions are isolated per type — suppressing one type does not suppress another', () => {
    store.addSuppression(DOMAIN, 'bounces', 'member@example.com');
    expect(store.isSuppressed(DOMAIN, 'complaints', 'member@example.com')).toBe(false);
    expect(store.isSuppressed(DOMAIN, 'unsubscribes', 'member@example.com')).toBe(false);
  });

  it('an invalid suppression type never reaches SQL — it is rejected before the prepared statement runs', () => {
    const badType = 'not-a-real-type' as unknown as 'bounces';
    expect(() => store.addSuppression(DOMAIN, badType, 'member@example.com')).toThrow(TypeError);
    expect(() => store.isSuppressed(DOMAIN, badType, 'member@example.com')).toThrow(TypeError);
    expect(() => store.removeSuppression(DOMAIN, badType, 'member@example.com')).toThrow(TypeError);
    // Confirm the rejected add genuinely never inserted anything — checking
    // with a *valid* type for the same domain/email finds nothing, and the
    // invalid type itself can't be looked up (it always throws), so there is
    // no row this invalid call could have produced that any real caller
    // could ever observe as suppressed.
    expect(store.isSuppressed(DOMAIN, 'bounces', 'member@example.com')).toBe(false);
  });
});

describe('createSqliteStore — events', () => {
  let store: ShimStore;

  beforeEach(() => {
    store = createSqliteStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('records and lists events in insertion order', () => {
    store.recordEvent(makeEvent({ recipient: 'first@example.com' }));
    store.recordEvent(makeEvent({ recipient: 'second@example.com' }));
    store.recordEvent(makeEvent({ recipient: 'third@example.com' }));

    const { events } = store.listEvents(DOMAIN, { limit: 10, offset: 0 });
    expect(events.map((e) => e.recipient)).toEqual([
      'first@example.com',
      'second@example.com',
      'third@example.com',
    ]);
  });

  it('assigns each recorded event a unique id', () => {
    store.recordEvent(makeEvent());
    store.recordEvent(makeEvent());
    const { events } = store.listEvents(DOMAIN, { limit: 10, offset: 0 });
    expect(events[0]!.id).not.toBe(events[1]!.id);
    expect(events[0]!.id).toBeTruthy();
  });

  it('lists events scoped to their own domain only', () => {
    store.recordEvent(makeEvent({ domain: DOMAIN }));
    store.recordEvent(makeEvent({ domain: 'other-tenant.example.com' }));
    const { events } = store.listEvents(DOMAIN, { limit: 10, offset: 0 });
    expect(events).toHaveLength(1);
  });

  it('filters by eventTypes when provided', () => {
    store.recordEvent(makeEvent({ type: 'delivered' }));
    store.recordEvent(makeEvent({ type: 'failed' }));
    store.recordEvent(makeEvent({ type: 'delivered' }));
    const { events } = store.listEvents(DOMAIN, { limit: 10, offset: 0, eventTypes: ['failed'] });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('failed');
  });

  it('pagination cursor round-trips: offset+limit walks forward without gaps or repeats', () => {
    for (let i = 0; i < 5; i += 1) {
      store.recordEvent(makeEvent({ recipient: `member-${i}@example.com` }));
    }
    const seen: string[] = [];
    let offset = 0;
    for (let guard = 0; guard < 10; guard += 1) {
      const { events, nextOffset } = store.listEvents(DOMAIN, { limit: 2, offset });
      if (events.length === 0) {
        break;
      }
      seen.push(...events.map((e) => e.recipient));
      offset = nextOffset;
    }
    expect(seen).toEqual([
      'member-0@example.com',
      'member-1@example.com',
      'member-2@example.com',
      'member-3@example.com',
      'member-4@example.com',
    ]);
  });

  it('final-page behaviour: an offset past the end returns an empty page and does not advance nextOffset', () => {
    store.recordEvent(makeEvent());
    const { events, nextOffset } = store.listEvents(DOMAIN, { limit: 10, offset: 100 });
    expect(events).toEqual([]);
    expect(nextOffset).toBe(100);
  });

  it('a garbage cursor (non-numeric offset) is handled by the route layer, but the store itself tolerates offset 0', () => {
    // The route coerces a garbage cursor to 0 (Number(x) || 0) before it
    // reaches the store — this asserts the store's own contract for that
    // fallback value: it behaves like a first page, not an error.
    const { events } = store.listEvents(DOMAIN, { limit: 10, offset: 0 });
    expect(events).toEqual([]);
  });
});

describe('createSqliteStore — durability and concurrency', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-store-test-'));
    dbPath = join(dir, 'shim.sqlite');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('survives a store restart against the same file', async () => {
    const first = createSqliteStore(dbPath);
    first.registerTenant(DOMAIN, 'persisted-key', DOMAIN);
    first.addSuppression(DOMAIN, 'bounces', 'bounced@example.com');
    first.recordEvent(makeEvent({ recipient: 'member@example.com' }));
    first.close();

    const reopened = createSqliteStore(dbPath);
    await expect(reopened.verifyTenant(DOMAIN, 'persisted-key')).resolves.toEqual({
      domain: DOMAIN,
      senderDomain: DOMAIN,
    });
    expect(reopened.isSuppressed(DOMAIN, 'bounces', 'bounced@example.com')).toBe(true);
    const { events } = reopened.listEvents(DOMAIN, { limit: 10, offset: 0 });
    expect(events).toHaveLength(1);
    reopened.close();
  });

  it('a burst of interleaved writes across tenants and event types all land without loss or corruption', () => {
    const store = createSqliteStore(dbPath);
    const domains = ['tenant-a.example.com', 'tenant-b.example.com', 'tenant-c.example.com'];
    for (const domain of domains) {
      store.registerTenant(domain, `key-for-${domain}`, domain);
    }

    const writeCount = 60;
    for (let i = 0; i < writeCount; i += 1) {
      const domain = domains[i % domains.length]!;
      store.recordEvent(
        makeEvent({
          domain,
          recipient: `${randomUUID()}@example.com`,
          type: i % 2 === 0 ? 'delivered' : 'failed',
        })
      );
      store.addSuppression(domain, 'bounces', `suppressed-${i}@example.com`);
    }

    for (const domain of domains) {
      const { events } = store.listEvents(domain, { limit: writeCount, offset: 0 });
      expect(events).toHaveLength(writeCount / domains.length);
      // No cross-tenant bleed: every event belongs to the domain it was queried for.
      expect(events.every((e) => e.domain === domain)).toBe(true);
    }

    store.close();
  });
});

describe('createSqliteStore — tenant listing', () => {
  let store: ShimStore;

  beforeEach(() => {
    store = createSqliteStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('tenantExists is false until registered, true after', () => {
    expect(store.tenantExists(DOMAIN)).toBe(false);
    store.registerTenant(DOMAIN, 'a-key', DOMAIN);
    expect(store.tenantExists(DOMAIN)).toBe(true);
  });

  it('listTenants returns every registered domain and its sender domain, sorted', () => {
    store.registerTenant('b.example.com', 'key-b', 'b.example.com');
    store.registerTenant('a.example.com', 'key-a', null);
    expect(store.listTenants()).toEqual([
      { domain: 'a.example.com', senderDomain: null },
      { domain: 'b.example.com', senderDomain: 'b.example.com' },
    ]);
  });

  it('ping succeeds against an open connection and throws once closed', () => {
    expect(() => store.ping()).not.toThrow();
    store.close();
    expect(() => store.ping()).toThrow();
    // Re-open a fresh in-memory store so the shared afterEach close() doesn't double-close.
    store = createSqliteStore(':memory:');
  });
});

describe('createSqliteStore — the drain handover (claimForDrain / ackDrain)', () => {
  let store: ShimStore;

  function payload(overrides: Partial<QueueBatchPayload> = {}): QueueBatchPayload {
    return {
      from: 'noreply@tenant.example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
      text: 'hi',
      headers: {},
      recipientVariables: {},
      ...overrides,
    };
  }

  beforeEach(() => {
    store = createSqliteStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('claims recipients from the oldest batch first, in enqueue order within a batch, each under a stable id', () => {
    store.enqueueBatch({
      batchId: 'batch-old',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['old-1@example.com', 'old-2@example.com'],
      now: 100,
    });
    store.enqueueBatch({
      batchId: 'batch-new',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['new-1@example.com'],
      now: 200,
    });

    const drained = store.claimForDrain(300, 30, 10);
    expect(drained.map((r) => r.recipient)).toEqual([
      'old-1@example.com',
      'old-2@example.com',
      'new-1@example.com',
    ]);
    expect(drained.every((r) => r.drainCount === 1)).toBe(true);
    expect(new Set(drained.map((r) => r.id)).size).toBe(3);
    expect(drained[0]!.payload).toEqual(payload());
  });

  it('a limit caps how many rows a single claim returns, and the rest stay pending for the next call', () => {
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['a@example.com', 'b@example.com', 'c@example.com'],
      now: 0,
    });
    const first = store.claimForDrain(0, 30, 2);
    expect(first).toHaveLength(2);
    const second = store.claimForDrain(0, 30, 2);
    expect(second).toHaveLength(1);
    expect(second[0]!.recipient).toBe('c@example.com');
  });

  it('enqueueBatch rolls back the whole transaction when a duplicate recipient in the same call violates the primary key', () => {
    expect(() =>
      store.enqueueBatch({
        batchId: 'batch-dup',
        domain: DOMAIN,
        emailId: null,
        payload: payload(),
        recipients: ['dup@example.com', 'dup@example.com'],
        now: 0,
      })
    ).toThrow(/UNIQUE constraint/);

    // Rolled back entirely — not even the batch row (inserted first,
    // before the failing second recipient row) survived.
    expect(store.claimForDrain(1000, 30, 10)).toHaveLength(0);
    expect(store.countUndrainedRecipients()).toBe(0);
  });

  it('a claimed row is held, not claimable again, until its lease lapses — then it is re-offered under the same id with drainCount incremented', () => {
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['member@example.com'],
      now: 0,
    });
    const first = store.claimForDrain(0, 30, 10);
    expect(first).toHaveLength(1);
    const heldId = first[0]!.id;

    // Lease still live at t=10 — not re-offered.
    expect(store.claimForDrain(10, 30, 10)).toHaveLength(0);

    // Lease lapsed by t=31 — re-offered under the same id.
    const reoffered = store.claimForDrain(31, 30, 10);
    expect(reoffered).toHaveLength(1);
    expect(reoffered[0]!.id).toBe(heldId);
    expect(reoffered[0]!.drainCount).toBe(2);
  });

  it('ackDrain moves a held id to sent, and it is never offered again', () => {
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['member@example.com'],
      now: 0,
    });
    const [drained] = store.claimForDrain(0, 30, 10);
    const result = store.ackDrain([{ id: drained!.id, drainCount: drained!.drainCount }], 1);
    expect(result).toEqual({ acked: [drained!.id], alreadyHandled: [], unknown: [] });

    // Even well past the lease, an acked row is never re-offered.
    expect(store.claimForDrain(10_000, 30, 10)).toHaveLength(0);
  });

  it('acking the same id twice at the same generation reports the second ack as alreadyHandled, not an error', () => {
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['member@example.com'],
      now: 0,
    });
    const [drained] = store.claimForDrain(0, 30, 10);
    const ack = { id: drained!.id, drainCount: drained!.drainCount };
    store.ackDrain([ack], 1);
    const second = store.ackDrain([ack], 2);
    expect(second).toEqual({ acked: [], alreadyHandled: [drained!.id], unknown: [] });
  });

  it('acking an id this store has no record of at all is reported unknown, not an error', () => {
    const result = store.ackDrain([{ id: 'never-issued-id', drainCount: 1 }], 1);
    expect(result).toEqual({ acked: [], alreadyHandled: [], unknown: ['never-issued-id'] });
  });

  it('a stale ack for an id later resolved to a non-held terminal state (suppressed after its lease lapsed and was re-checked) is reported unknown, not acked', () => {
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['member@example.com'],
      now: 0,
    });
    const [drained] = store.claimForDrain(0, 30, 10);
    const staleId = drained!.id;
    const staleDrainCount = drained!.drainCount;

    // The address is suppressed after the hand-over, and the lease lapses
    // without an ack — the next claim re-checks suppression on the lapsed
    // row (it is a fresh candidate again) and resolves it in place.
    store.addSuppression(DOMAIN, 'bounces', 'member@example.com');
    const reclaimAttempt = store.claimForDrain(31, 30, 10);
    expect(reclaimAttempt).toHaveLength(0); // resolved suppressed, not re-offered

    // The original drainer's ack, arriving late, names an id that is no
    // longer 'held' — reported unknown rather than silently accepted.
    const result = store.ackDrain([{ id: staleId, drainCount: staleDrainCount }], 32);
    expect(result).toEqual({ acked: [], alreadyHandled: [], unknown: [staleId] });
  });

  it('a late ack naming a SUPERSEDED generation (the row is still held, just re-offered to a newer claim) is unknown — never credited to the wrong holder', () => {
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['member@example.com'],
      now: 0,
    });
    const [firstClaim] = store.claimForDrain(0, 30, 10);
    const firstDrainCount = firstClaim!.drainCount; // 1

    // Lease lapses with no ack; re-offered to a second claim (could be the
    // same drainer retrying, or a different one — the store can't tell,
    // and must not assume).
    const [secondClaim] = store.claimForDrain(31, 30, 10);
    expect(secondClaim!.id).toBe(firstClaim!.id);
    expect(secondClaim!.drainCount).toBe(firstDrainCount + 1); // 2

    // The FIRST drainer's ack now arrives, late, naming its own (stale)
    // generation. The row is genuinely still 'held' — but at generation 2,
    // not 1 — so this must not be accepted as that holder's success.
    const lateAck = store.ackDrain([{ id: firstClaim!.id, drainCount: firstDrainCount }], 60);
    expect(lateAck).toEqual({ acked: [], alreadyHandled: [], unknown: [firstClaim!.id] });

    // The row is untouched by the rejected ack — still held under the
    // CURRENT (second) claim's generation and lease, exactly as if the
    // late ack had never arrived.
    expect(store.claimForDrain(60, 30, 10)).toHaveLength(0); // second lease (until 61) still live

    // The second (current) holder's ack, naming the right generation,
    // succeeds.
    const currentAck = store.ackDrain(
      [{ id: secondClaim!.id, drainCount: secondClaim!.drainCount }],
      61
    );
    expect(currentAck).toEqual({ acked: [secondClaim!.id], alreadyHandled: [], unknown: [] });
  });

  it('a suppressed recipient is resolved at claim time — never handed to a drainer, no event, still consumes toward the batch completing', () => {
    store.addSuppression(DOMAIN, 'bounces', 'bounced@example.com');
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['bounced@example.com', 'ok@example.com'],
      now: 0,
    });
    const drained = store.claimForDrain(0, 30, 10);
    expect(drained.map((r) => r.recipient)).toEqual(['ok@example.com']);
    expect(store.listEvents(DOMAIN, { limit: 10, offset: 0 }).events).toHaveLength(0);
    // bounced@ resolved suppressed (terminal); ok@ is now held, awaiting
    // ack — still undrained until then.
    expect(store.countUndrainedRecipients()).toBe(1);
  });

  it('an unsafe recipient address is failed in place at claim time, never handed to a drainer, and a failed event is recorded for it', () => {
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: 'email-1',
      payload: payload(),
      recipients: ['grp:attacker@evil.com;', 'ok@example.com'],
      now: 0,
    });
    const drained = store.claimForDrain(0, 30, 10);
    expect(drained.map((r) => r.recipient)).toEqual(['ok@example.com']);
    expect(store.countUndrainedRecipients()).toBe(1); // ok@ held, awaiting ack

    const { events } = store.listEvents(DOMAIN, { limit: 10, offset: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'failed',
      severity: 'permanent',
      recipient: 'grp:attacker@evil.com;',
      emailId: 'email-1',
      errorMessage: 'Invalid recipient address',
    });
  });

  it('the throttle (canSend) stops the whole claim at the first row it refuses, leaving that row and everything after it untouched', () => {
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['a@example.com', 'b@example.com', 'c@example.com'],
      now: 0,
    });
    let tokens = 1;
    const canSend = () => {
      if (tokens > 0) {
        tokens -= 1;
        return true;
      }
      return false;
    };

    const drained = store.claimForDrain(0, 30, 10, canSend);
    expect(drained.map((r) => r.recipient)).toEqual(['a@example.com']);
    expect(store.countUndrainedRecipients()).toBe(3); // a: held: still undrained. b, c: pending.

    // b and c are still claimable in original order once tokens are available again.
    tokens = 2;
    const second = store.claimForDrain(1, 30, 10, canSend);
    expect(second.map((r) => r.recipient)).toEqual(['b@example.com', 'c@example.com']);
  });

  it('the throttle never blocks a suppressed or unsafe row from being resolved — they never consumed a send', () => {
    store.addSuppression(DOMAIN, 'bounces', 'bounced@example.com');
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['bounced@example.com', 'grp:bad;', 'ok@example.com'],
      now: 0,
    });
    const drained = store.claimForDrain(0, 30, 10, () => false);
    // Nothing sendable was let through — the throttle refused everything —
    // but the suppressed and unsafe rows were still resolved rather than
    // left pending.
    expect(drained).toHaveLength(0);
    expect(store.countUndrainedRecipients()).toBe(1); // only 'ok@example.com' remains pending
  });

  it('oldestUndrainedAgeSeconds is null with nothing outstanding, and counts a held (not just pending) row as outstanding', () => {
    expect(store.oldestUndrainedAgeSeconds(1000)).toBeNull();

    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['member@example.com'],
      now: 100,
    });
    expect(store.oldestUndrainedAgeSeconds(150)).toBe(50);

    // Claiming it (held, not acked) must not make the age metric go quiet —
    // a drainer that polls but never acks is exactly the failure mode
    // LLD-8 §03b names.
    store.claimForDrain(150, 30, 10);
    expect(store.oldestUndrainedAgeSeconds(200)).toBe(100);
  });

  it('oldestUndrainedAgeSeconds drops to null once the only outstanding row is acked', () => {
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['member@example.com'],
      now: 0,
    });
    const [drained] = store.claimForDrain(0, 30, 10);
    store.ackDrain([{ id: drained!.id, drainCount: drained!.drainCount }], 5);
    expect(store.oldestUndrainedAgeSeconds(1000)).toBeNull();
  });

  it('countUndrainedRecipients counts pending and held across every batch and domain, excluding sent/failed/suppressed', () => {
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['a@example.com', 'b@example.com'],
      now: 0,
    });
    store.enqueueBatch({
      batchId: 'batch-2',
      domain: 'other.example.com',
      emailId: null,
      payload: payload(),
      recipients: ['c@example.com'],
      now: 0,
    });
    expect(store.countUndrainedRecipients()).toBe(3);

    const [drainedA] = store.claimForDrain(0, 30, 1); // claims 'a' only (oldest-first, limit 1)
    expect(drainedA!.recipient).toBe('a@example.com');
    expect(store.countUndrainedRecipients()).toBe(3); // held still counts

    store.ackDrain([{ id: drainedA!.id, drainCount: drainedA!.drainCount }], 1);
    expect(store.countUndrainedRecipients()).toBe(2);
  });

  it('a batch completes only once every recipient reaches a terminal state (including sent via ack), and cleanup then removes it without touching events', () => {
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['a@example.com', 'b@example.com'],
      now: 0,
    });
    store.addSuppression(DOMAIN, 'bounces', 'b@example.com');

    const [drainedA] = store.claimForDrain(0, 30, 10); // 'a' claimed, 'b' resolved suppressed inline
    expect(drainedA!.recipient).toBe('a@example.com');

    // 'a' still held (not yet acked) — cleanup must not remove the batch yet.
    expect(store.cleanupCompletedBatches(Date.now() / 1000 + 10_000)).toBe(0);

    store.ackDrain([{ id: drainedA!.id, drainCount: drainedA!.drainCount }], 1);

    // Both recipients are now terminal — completed_at is set, so a
    // sufficiently-future threshold now deletes it.
    const deleted = store.cleanupCompletedBatches(Date.now() / 1000 + 10_000);
    expect(deleted).toBe(1);
  });

  it('cleanup leaves a recently-completed batch alone when the threshold is in the past', () => {
    const realNow = Date.now() / 1000;
    store.addSuppression(DOMAIN, 'bounces', 'a@example.com');
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['a@example.com'],
      now: realNow,
    });
    // Resolves the suppressed row at "now", completing the batch just now.
    store.claimForDrain(realNow, 30, 10);

    // A threshold 10,000s in the past is well before this batch's
    // completed_at (~realNow) — nothing that recent should be swept.
    expect(store.cleanupCompletedBatches(realNow - 10_000)).toBe(0);
  });

  it('survives a store restart: pending, held and sent rows are all exactly where they were left', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-store-queue-test-'));
    const dbPath = join(dir, 'shim.sqlite');
    try {
      const first = createSqliteStore(dbPath);
      first.enqueueBatch({
        batchId: 'batch-1',
        domain: DOMAIN,
        emailId: null,
        payload: payload(),
        // Enqueue order matters: claiming with limit 2 below takes the
        // first two (sent, held) and leaves 'pending' genuinely untouched.
        recipients: ['sent@example.com', 'held@example.com', 'pending@example.com'],
        now: 0,
      });
      const claimed = first.claimForDrain(0, 30, 2);
      expect(claimed.map((r) => r.recipient)).toEqual(['sent@example.com', 'held@example.com']);
      const sentRow = claimed.find((r) => r.recipient === 'sent@example.com')!;
      const heldId = claimed.find((r) => r.recipient === 'held@example.com')!.id;
      first.ackDrain([{ id: sentRow.id, drainCount: sentRow.drainCount }], 1);
      // sent -> sent (terminal); held -> held under its 30s lease;
      // pending -> never claimed at all in this session.
      first.close();

      const reopened = createSqliteStore(dbPath);
      // sent: never claimable again. held's lease (held_until=30) is still
      // live at t=5, so the only claimable row is the untouched pending one.
      const stillJustPending = reopened.claimForDrain(5, 30, 10);
      expect(stillJustPending.map((r) => r.recipient)).toEqual(['pending@example.com']);

      // Past the original lease: 'held@example.com' is re-offered under the
      // same id — 'sent' and the now-claimed 'pending' do not reappear.
      const reoffered = reopened.claimForDrain(31, 30, 10);
      expect(reoffered.map((r) => r.recipient)).toEqual(['held@example.com']);
      expect(reoffered[0]!.id).toBe(heldId);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enqueueBatch throws (and enqueues nothing at all for the batch) when the same recipient is listed twice in one call', () => {
    expect(() =>
      store.enqueueBatch({
        batchId: 'batch-dup-recipient',
        domain: DOMAIN,
        emailId: null,
        payload: payload(),
        recipients: ['dup@example.com', 'dup@example.com'],
        now: 0,
      })
    ).toThrow(/UNIQUE constraint/);
    expect(store.countUndrainedRecipients()).toBe(0);
  });
});

describe('assertWalEnabled', () => {
  it('is a no-op for :memory: regardless of the reported mode', () => {
    expect(() => assertWalEnabled(':memory:', 'memory')).not.toThrow();
    expect(() => assertWalEnabled(':memory:', undefined)).not.toThrow();
  });

  it('passes for a file-backed database that reports wal', () => {
    expect(() => assertWalEnabled('/data/shim.sqlite', 'wal')).not.toThrow();
  });

  it('throws for a file-backed database that failed to actually enable wal', () => {
    expect(() => assertWalEnabled('/data/shim.sqlite', 'delete')).toThrow(/WAL/);
    expect(() => assertWalEnabled('/data/shim.sqlite', undefined)).toThrow(/WAL/);
  });
});

describe('createSqliteStore — WAL is genuinely enabled for a file-backed database', () => {
  it('opens a file-backed store without throwing (a WAL failure on this filesystem would throw at construction)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-wal-test-'));
    const dbPath = join(dir, 'shim.sqlite');
    try {
      let store: ShimStore | undefined;
      expect(() => {
        store = createSqliteStore(dbPath);
      }).not.toThrow();
      store?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
