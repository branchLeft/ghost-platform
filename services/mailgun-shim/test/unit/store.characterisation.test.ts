import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteStore, type QueueBatchPayload, type ShimStore } from '../../src/store.js';

// Pins edges of the store's observable behaviour through its public API
// only, so the same assertions hold whichever driver sits underneath.

const DOMAIN = 'tenant.example.com';

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

function enqueue(store: ShimStore, batchId: string, recipients: string[], now: number): void {
  store.enqueueBatch({
    batchId,
    domain: DOMAIN,
    emailId: null,
    payload: payload(),
    recipients,
    now,
  });
}

describe('store characterisation — events', () => {
  let store: ShimStore;

  beforeEach(() => {
    store = createSqliteStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('filters by type after the page is cut, and nextOffset counts the unfiltered page', () => {
    for (const type of ['delivered', 'failed', 'delivered']) {
      store.recordEvent({
        domain: DOMAIN,
        type,
        severity: null,
        recipient: `${type}@example.com`,
        emailId: null,
        providerMessageId: null,
        timestamp: 1,
        errorCode: null,
        errorMessage: null,
      });
    }

    const page = store.listEvents(DOMAIN, { limit: 2, offset: 0, eventTypes: ['delivered'] });
    expect(page.events.map((e) => e.type)).toEqual(['delivered']);
    expect(page.nextOffset).toBe(2);

    const next = store.listEvents(DOMAIN, { limit: 2, offset: 2, eventTypes: ['delivered'] });
    expect(next.events.map((e) => e.type)).toEqual(['delivered']);
    expect(next.nextOffset).toBe(3);
  });

  it('round-trips every event field exactly, fractional timestamps included', () => {
    const event = {
      domain: DOMAIN,
      type: 'failed',
      severity: 'permanent',
      recipient: 'member@example.com',
      emailId: 'email-1',
      providerMessageId: '<abc@mx.example.com>',
      timestamp: 1_700_000_000.123456,
      errorCode: 550,
      errorMessage: 'mailbox unavailable — ünïcödé',
    };
    store.recordEvent(event);

    const [stored] = store.listEvents(DOMAIN, { limit: 1, offset: 0 }).events;
    expect(stored).toEqual({ id: stored!.id, ...event });
    expect(typeof stored!.id).toBe('string');
  });

  it('a zero limit returns an empty page without advancing the cursor', () => {
    store.recordEvent({
      domain: DOMAIN,
      type: 'delivered',
      severity: null,
      recipient: 'member@example.com',
      emailId: null,
      providerMessageId: null,
      timestamp: 1,
      errorCode: null,
      errorMessage: null,
    });
    expect(store.listEvents(DOMAIN, { limit: 0, offset: 0 })).toEqual({
      events: [],
      nextOffset: 0,
    });
  });
});

describe('store characterisation — tenants', () => {
  let store: ShimStore;

  beforeEach(() => {
    store = createSqliteStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('matches domains byte-for-byte: a different case is a different tenant', () => {
    store.registerTenant(DOMAIN, 'key', DOMAIN);
    expect(store.tenantExists('TENANT.example.com')).toBe(false);
  });

  it('sorts listTenants in binary order, so upper case sorts before lower case', () => {
    store.registerTenant('b.example.com', 'key-b', null);
    store.registerTenant('B.example.com', 'key-B', null);
    store.registerTenant('a.example.com', 'key-a', null);
    expect(store.listTenants().map((t) => t.domain)).toEqual([
      'B.example.com',
      'a.example.com',
      'b.example.com',
    ]);
  });

  it('setSenderDomain reports true for a registered tenant even when the value is unchanged', () => {
    store.registerTenant(DOMAIN, 'key', 'sender.example.com');
    expect(store.setSenderDomain(DOMAIN, 'sender.example.com')).toBe(true);
    expect(store.setSenderDomain(DOMAIN, 'sender.example.com')).toBe(true);
  });

  it('re-registering replaces the sender domain along with the key', async () => {
    store.registerTenant(DOMAIN, 'old-key', 'old.example.com');
    store.registerTenant(DOMAIN, 'new-key', null);
    await expect(store.verifyTenant(DOMAIN, 'new-key')).resolves.toEqual({
      domain: DOMAIN,
      senderDomain: null,
    });
    expect(store.listTenants()).toEqual([{ domain: DOMAIN, senderDomain: null }]);
  });
});

describe('store characterisation — the queue', () => {
  let store: ShimStore;

  beforeEach(() => {
    store = createSqliteStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('breaks a created_at tie by enqueue order, not by batch id', () => {
    enqueue(store, 'batch-z', ['z@example.com'], 100);
    enqueue(store, 'batch-a', ['a@example.com'], 100);
    expect(store.claimForDrain(100, 30, 10).map((r) => r.recipient)).toEqual([
      'z@example.com',
      'a@example.com',
    ]);
  });

  it('a row enqueued at t is claimable at exactly t and not before', () => {
    enqueue(store, 'batch-1', ['member@example.com'], 100);
    expect(store.claimForDrain(99.999, 30, 10)).toHaveLength(0);
    expect(store.claimForDrain(100, 30, 10)).toHaveLength(1);
  });

  it('a lease lapses at exactly its held_until, not after', () => {
    enqueue(store, 'batch-1', ['member@example.com'], 0);
    store.claimForDrain(0, 30, 10);
    expect(store.claimForDrain(29.999, 30, 10)).toHaveLength(0);
    expect(store.claimForDrain(30, 30, 10)).toHaveLength(1);
  });

  it('a lapsed lease refused by the throttle stays held at its old generation, which can still ack', () => {
    enqueue(store, 'batch-1', ['member@example.com'], 0);
    const [first] = store.claimForDrain(0, 30, 10);
    expect(store.claimForDrain(31, 30, 10, () => false)).toHaveLength(0);
    expect(store.ackDrain([{ id: first!.id, drainCount: first!.drainCount }], 32)).toEqual({
      acked: [first!.id],
      alreadyHandled: [],
      unknown: [],
    });
  });

  it('answers a mixed ack list in input order, and a repeated id in one call as already handled', () => {
    enqueue(store, 'batch-1', ['a@example.com', 'b@example.com'], 0);
    const [a, b] = store.claimForDrain(0, 30, 10);
    const result = store.ackDrain(
      [
        { id: b!.id, drainCount: b!.drainCount },
        { id: 'nope', drainCount: 1 },
        { id: a!.id, drainCount: a!.drainCount },
        { id: b!.id, drainCount: b!.drainCount },
      ],
      1
    );
    expect(result).toEqual({ acked: [b!.id, a!.id], alreadyHandled: [b!.id], unknown: ['nope'] });
  });

  it('resolves every suppression type at claim time, and only for the suppressing domain', () => {
    store.addSuppression(DOMAIN, 'unsubscribes', 'unsub@example.com');
    store.addSuppression(DOMAIN, 'complaints', 'complained@example.com');
    store.addSuppression('other.example.com', 'bounces', 'elsewhere@example.com');
    enqueue(
      store,
      'batch-1',
      ['unsub@example.com', 'complained@example.com', 'elsewhere@example.com'],
      0
    );
    expect(store.claimForDrain(0, 30, 10).map((r) => r.recipient)).toEqual([
      'elsewhere@example.com',
    ]);
  });

  it('round-trips a payload with headers, recipient variables and non-ASCII text exactly', () => {
    const rich = payload({
      subject: 'Grüße — 你好',
      headers: { 'X-Mailgun-Tag': 'newsletter', 'List-Unsubscribe': '<https://x/u>' },
      recipientVariables: { 'member@example.com': { name: 'Zoë', uuid: 'u-1' } },
    });
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: 'email-9',
      payload: rich,
      recipients: ['member@example.com'],
      now: 0,
    });
    const [drained] = store.claimForDrain(0, 30, 10);
    expect(drained).toMatchObject({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: 'email-9',
      recipient: 'member@example.com',
      drainCount: 1,
      payload: rich,
    });
  });

  it('refuses a second batch under an id already enqueued, keeping the first intact', () => {
    enqueue(store, 'batch-1', ['a@example.com'], 0);
    expect(() => enqueue(store, 'batch-1', ['b@example.com'], 1)).toThrow(/UNIQUE constraint/);
    expect(store.claimForDrain(10, 30, 10).map((r) => r.recipient)).toEqual(['a@example.com']);
  });

  it('stamps completion with the caller-supplied time, and cleanup removes strictly older batches only', () => {
    enqueue(store, 'batch-1', ['member@example.com'], 0);
    const [drained] = store.claimForDrain(0, 30, 10);
    store.ackDrain([{ id: drained!.id, drainCount: drained!.drainCount }], 100);
    expect(store.cleanupCompletedBatches(100)).toBe(0);
    expect(store.cleanupCompletedBatches(100.001)).toBe(1);
  });

  it('cleanup removes the recipients with their batch, so the batch id can be used again', () => {
    store.addSuppression(DOMAIN, 'bounces', 'member@example.com');
    enqueue(store, 'batch-1', ['member@example.com'], 0);
    store.claimForDrain(0, 30, 10);
    expect(store.cleanupCompletedBatches(1)).toBe(1);
    expect(() => enqueue(store, 'batch-1', ['member@example.com'], 2)).not.toThrow();
    expect(store.countUndrainedRecipients()).toBe(1);
  });

  it('never cleans up a batch with a recipient still outstanding, however old', () => {
    enqueue(store, 'batch-1', ['a@example.com', 'b@example.com'], 0);
    const [a] = store.claimForDrain(0, 30, 1);
    store.ackDrain([{ id: a!.id, drainCount: a!.drainCount }], 1);
    expect(store.cleanupCompletedBatches(1_000_000)).toBe(0);
  });

  it('a batch enqueued with no recipients never completes, so cleanup never removes it', () => {
    enqueue(store, 'batch-empty', [], 0);
    expect(store.countUndrainedRecipients()).toBe(0);
    expect(store.oldestUndrainedAgeSeconds(10)).toBeNull();
    expect(store.cleanupCompletedBatches(1_000_000)).toBe(0);
    expect(() => enqueue(store, 'batch-empty', [], 1)).toThrow(/UNIQUE constraint/);
  });

  it('measures the oldest outstanding age from the earliest batch, fractional times included', () => {
    enqueue(store, 'batch-late', ['late@example.com'], 200.5);
    enqueue(store, 'batch-early', ['early@example.com'], 100.25);
    expect(store.oldestUndrainedAgeSeconds(300)).toBeCloseTo(199.75, 6);
  });
});

describe('store characterisation — a file-backed store', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-characterisation-'));
    dbPath = join(dir, 'shim.sqlite');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes through a write-ahead log beside the database file', () => {
    const store = createSqliteStore(dbPath);
    try {
      store.registerTenant(DOMAIN, 'key', DOMAIN);
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
    } finally {
      store.close();
    }
  });

  it('a second open store on the same file sees the first one’s writes at once', () => {
    const writer = createSqliteStore(dbPath);
    const reader = createSqliteStore(dbPath);
    try {
      enqueue(writer, 'batch-1', ['member@example.com'], 0);
      const [drained] = reader.claimForDrain(0, 30, 10);
      expect(drained!.recipient).toBe('member@example.com');
      expect(writer.claimForDrain(1, 30, 10)).toHaveLength(0);
      expect(writer.ackDrain([{ id: drained!.id, drainCount: 1 }], 2).acked).toEqual([drained!.id]);
    } finally {
      reader.close();
      writer.close();
    }
  });

  it('every call after close throws', () => {
    const store = createSqliteStore(dbPath);
    store.close();
    expect(() => store.tenantExists(DOMAIN)).toThrow();
    expect(() => store.countUndrainedRecipients()).toThrow();
  });
});
