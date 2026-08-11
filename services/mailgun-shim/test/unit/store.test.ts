import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteStore, type ShimStore, type StoredEvent } from '../../src/store.js';

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
