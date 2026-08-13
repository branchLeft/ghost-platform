import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertWalEnabled,
  createSqliteStore,
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

  it('registers a tenant and verifies its own key against its own domain', () => {
    store.registerTenant(DOMAIN, 'the-secret-key');
    expect(store.verifyTenant(DOMAIN, 'the-secret-key')).toEqual({ domain: DOMAIN });
  });

  it('returns null for an unknown domain', () => {
    expect(store.verifyTenant('never-registered.example.com', 'anything')).toBeNull();
  });

  it('returns null for a known domain with the wrong key', () => {
    store.registerTenant(DOMAIN, 'the-secret-key');
    expect(store.verifyTenant(DOMAIN, 'wrong-key')).toBeNull();
  });

  it('re-registering a domain (INSERT OR REPLACE) replaces its key rather than erroring', () => {
    store.registerTenant(DOMAIN, 'old-key');
    store.registerTenant(DOMAIN, 'new-key');
    expect(store.verifyTenant(DOMAIN, 'old-key')).toBeNull();
    expect(store.verifyTenant(DOMAIN, 'new-key')).toEqual({ domain: DOMAIN });
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

  it('survives a store restart against the same file', () => {
    const first = createSqliteStore(dbPath);
    first.registerTenant(DOMAIN, 'persisted-key');
    first.addSuppression(DOMAIN, 'bounces', 'bounced@example.com');
    first.recordEvent(makeEvent({ recipient: 'member@example.com' }));
    first.close();

    const reopened = createSqliteStore(dbPath);
    expect(reopened.verifyTenant(DOMAIN, 'persisted-key')).toEqual({ domain: DOMAIN });
    expect(reopened.isSuppressed(DOMAIN, 'bounces', 'bounced@example.com')).toBe(true);
    const { events } = reopened.listEvents(DOMAIN, { limit: 10, offset: 0 });
    expect(events).toHaveLength(1);
    reopened.close();
  });

  it('a burst of interleaved writes across tenants and event types all land without loss or corruption', () => {
    const store = createSqliteStore(dbPath);
    const domains = ['tenant-a.example.com', 'tenant-b.example.com', 'tenant-c.example.com'];
    for (const domain of domains) {
      store.registerTenant(domain, `key-for-${domain}`);
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
    store.registerTenant(DOMAIN, 'a-key');
    expect(store.tenantExists(DOMAIN)).toBe(true);
  });

  it('listTenants returns every registered domain, sorted', () => {
    store.registerTenant('b.example.com', 'key-b');
    store.registerTenant('a.example.com', 'key-a');
    expect(store.listTenants()).toEqual(['a.example.com', 'b.example.com']);
  });

  it('ping succeeds against an open connection and throws once closed', () => {
    expect(() => store.ping()).not.toThrow();
    store.close();
    expect(() => store.ping()).toThrow();
    // Re-open a fresh in-memory store so the shared afterEach close() doesn't double-close.
    store = createSqliteStore(':memory:');
  });
});

describe('createSqliteStore — durable queue', () => {
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

  it('claims recipients from the oldest batch first, in enqueue order within a batch', () => {
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

    const due = store.claimDueRecipients(300, 10);
    expect(due.map((r) => r.recipient)).toEqual([
      'old-1@example.com',
      'old-2@example.com',
      'new-1@example.com',
    ]);
    expect(due.every((r) => r.attempts === 0)).toBe(true);
    expect(due[0]!.payload).toEqual(payload());
  });

  it('does not claim a recipient whose next_attempt_at is still in the future', () => {
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['member@example.com'],
      now: 1000,
    });
    expect(store.claimDueRecipients(500, 10)).toHaveLength(0);
    expect(store.claimDueRecipients(1000, 10)).toHaveLength(1);
  });

  it('a limit caps how many rows a single claim returns', () => {
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['a@example.com', 'b@example.com', 'c@example.com'],
      now: 0,
    });
    expect(store.claimDueRecipients(0, 2)).toHaveLength(2);
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
    ).toThrow();

    // Rolled back entirely — not even the batch row (inserted first,
    // before the failing second recipient row) survived.
    expect(store.claimDueRecipients(1000, 10)).toHaveLength(0);
    expect(store.countPendingRecipients()).toBe(0);
  });

  it('recordRecipientSent marks the row sent, records the event, and the row is never claimed again', () => {
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: 'email-1',
      payload: payload(),
      recipients: ['member@example.com'],
      now: 0,
    });
    store.recordRecipientSent('batch-1', 'member@example.com', {
      domain: DOMAIN,
      type: 'delivered',
      severity: null,
      recipient: 'member@example.com',
      emailId: 'email-1',
      providerMessageId: '<msg@tenant.example.com>',
      timestamp: 0,
      errorCode: null,
      errorMessage: null,
    });

    expect(store.claimDueRecipients(1000, 10)).toHaveLength(0);
    const { events } = store.listEvents(DOMAIN, { limit: 10, offset: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('delivered');
  });

  it('recordRecipientSuppressed marks the row suppressed and records no event', () => {
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['member@example.com'],
      now: 0,
    });
    store.recordRecipientSuppressed('batch-1', 'member@example.com');

    expect(store.claimDueRecipients(1000, 10)).toHaveLength(0);
    expect(store.listEvents(DOMAIN, { limit: 10, offset: 0 }).events).toHaveLength(0);
  });

  it('scheduleRecipientRetry keeps the row pending and reschedules it, without recording an event', () => {
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['member@example.com'],
      now: 0,
    });
    store.scheduleRecipientRetry('batch-1', 'member@example.com', 1, 500, 'connection reset');

    expect(store.claimDueRecipients(100, 10)).toHaveLength(0);
    const due = store.claimDueRecipients(500, 10);
    expect(due).toHaveLength(1);
    expect(due[0]!.attempts).toBe(1);
    expect(store.listEvents(DOMAIN, { limit: 10, offset: 0 }).events).toHaveLength(0);
  });

  it('recordRecipientFailed marks the row failed, records a failed event, and stops it being claimed', () => {
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['member@example.com'],
      now: 0,
    });
    store.recordRecipientFailed('batch-1', 'member@example.com', 6, 'mailbox unavailable', {
      domain: DOMAIN,
      type: 'failed',
      severity: 'permanent',
      recipient: 'member@example.com',
      emailId: null,
      providerMessageId: null,
      timestamp: 0,
      errorCode: 550,
      errorMessage: 'mailbox unavailable',
    });

    expect(store.claimDueRecipients(1000, 10)).toHaveLength(0);
    const { events } = store.listEvents(DOMAIN, { limit: 10, offset: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe('permanent');
  });

  it('countPendingRecipients counts across every batch and domain', () => {
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
    expect(store.countPendingRecipients()).toBe(3);

    store.recordRecipientSuppressed('batch-1', 'a@example.com');
    expect(store.countPendingRecipients()).toBe(2);
  });

  it('a batch completes only once every recipient reaches a terminal state, and cleanup then removes it without touching events', () => {
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['a@example.com', 'b@example.com'],
      now: 0,
    });
    store.recordRecipientSent('batch-1', 'a@example.com', {
      domain: DOMAIN,
      type: 'delivered',
      severity: null,
      recipient: 'a@example.com',
      emailId: null,
      providerMessageId: null,
      timestamp: 0,
      errorCode: null,
      errorMessage: null,
    });

    // One recipient still pending — cleanup must not remove the batch yet,
    // regardless of how far in the future the threshold is.
    expect(store.cleanupCompletedBatches(Date.now() / 1000 + 10_000)).toBe(0);

    store.recordRecipientSuppressed('batch-1', 'b@example.com');

    // Both recipients are now terminal — completed_at is set, so a
    // sufficiently-future threshold now deletes it.
    const deleted = store.cleanupCompletedBatches(Date.now() / 1000 + 10_000);
    expect(deleted).toBe(1);

    // The events table is untouched by cleanup — Ghost still pages it by offset.
    expect(store.listEvents(DOMAIN, { limit: 10, offset: 0 }).events).toHaveLength(1);
  });

  it('cleanup leaves a recently-completed batch alone when the threshold is in the past', () => {
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['a@example.com'],
      now: 0,
    });
    store.recordRecipientSuppressed('batch-1', 'a@example.com');

    expect(store.cleanupCompletedBatches(Date.now() / 1000 - 10_000)).toBe(0);
  });

  it('survives a store restart: pending, sent and retry-scheduled rows are all exactly where they were left', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-store-queue-test-'));
    const dbPath = join(dir, 'shim.sqlite');
    try {
      const first = createSqliteStore(dbPath);
      first.enqueueBatch({
        batchId: 'batch-1',
        domain: DOMAIN,
        emailId: null,
        payload: payload(),
        recipients: ['sent@example.com', 'pending@example.com', 'retry@example.com'],
        now: 0,
      });
      first.recordRecipientSent('batch-1', 'sent@example.com', {
        domain: DOMAIN,
        type: 'delivered',
        severity: null,
        recipient: 'sent@example.com',
        emailId: null,
        providerMessageId: null,
        timestamp: 0,
        errorCode: null,
        errorMessage: null,
      });
      first.scheduleRecipientRetry('batch-1', 'retry@example.com', 1, 9999, 'connection reset');
      first.close();

      const reopened = createSqliteStore(dbPath);
      const due = reopened.claimDueRecipients(0, 10);
      expect(due.map((r) => r.recipient)).toEqual(['pending@example.com']);
      expect(
        reopened
          .claimDueRecipients(9999, 10)
          .map((r) => r.recipient)
          .sort()
      ).toEqual(['pending@example.com', 'retry@example.com']);
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
    expect(store.countPendingRecipients()).toBe(0);
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
