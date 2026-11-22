import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteStore, type QueueBatchPayload, type ShimStore } from '../../src/store.js';

// A recycled demo slot purges the unsent mail of the lease it held, keyed on
// the lease id and on nothing else. See store.md#purging-a-lease. Every key
// and address here is a test value.

const SENDER = 'demo-mail.example.test';
const SLOT_A = `slot-30001.${SENDER}`;
const SLOT_B = `slot-30002.${SENDER}`;
// 26-character Crockford ULIDs, the shape render-core issues.
const LEASE_A1 = '01J9F4Q7ZC3M8V2K6X0R5T1B9D';
const LEASE_A2 = '01J9F4Q7ZC3M8V2K6X0R5T1B9E';
const LEASE_B1 = '01J9F4Q7ZC3M8V2K6X0R5T1B9F';

const PAYLOAD: QueueBatchPayload = {
  from: `demo@${SENDER}`,
  subject: 'a newsletter',
  html: '<p>x</p>',
  text: 'x',
  headers: {},
  recipientVariables: {},
};

let store: ShimStore;

beforeEach(() => {
  store = createSqliteStore(':memory:');
});

afterEach(() => {
  store.close();
});

let batchCounter = 0;

function submit(domain: string, ...recipients: string[]): void {
  batchCounter += 1;
  store.enqueueBatch({
    batchId: `batch-${batchCounter}`,
    domain,
    emailId: null,
    payload: PAYLOAD,
    recipients,
    now: 100 + batchCounter,
  });
}

/** Every recipient still waiting for the drainer, read the way the drainer reads. */
function waiting(): string[] {
  return store
    .claimForDrain(10_000, 30, 1000)
    .map((row) => row.recipient)
    .sort();
}

describe('purgeLease', () => {
  it("removes every message of the recycled lease and none of another slot's", () => {
    store.registerTenant(SLOT_A, 'key-a', SENDER, 'demo-1', LEASE_A1);
    store.registerTenant(SLOT_B, 'key-b', SENDER, 'demo-2', LEASE_B1);
    submit(SLOT_A, 'a1@example.test', 'a2@example.test');
    submit(SLOT_A, 'a3@example.test');
    submit(SLOT_B, 'b1@example.test', 'b2@example.test');

    const purged = store.purgeLease(LEASE_A1);

    expect(purged).toEqual({ recipients: 3, batches: 2 });
    expect(waiting()).toEqual(['b1@example.test', 'b2@example.test']);
  });

  it('keeps a message the slot is sent under its next lease, even when it was queued before the purge ran', () => {
    store.registerTenant(SLOT_A, 'key-a', SENDER, 'demo-1', LEASE_A1);
    submit(SLOT_A, 'old-visitor@example.test');
    // The slot is handed on: its credential now serves the next lease, and
    // the next visitor's first message is queued before the old lease's
    // purge gets to run.
    expect(store.setTenantLease(SLOT_A, LEASE_A2)).toBe(true);
    submit(SLOT_A, 'new-visitor@example.test');

    store.purgeLease(LEASE_A1);

    expect(waiting()).toEqual(['new-visitor@example.test']);
  });

  it('stamps a batch with the lease its credential served at enqueue, not the lease it serves later', () => {
    store.registerTenant(SLOT_A, 'key-a', SENDER, 'demo-1', LEASE_A1);
    submit(SLOT_A, 'first@example.test');
    store.setTenantLease(SLOT_A, LEASE_A2);

    // The credential has moved on to LEASE_A2; the queued batch has not.
    expect(store.purgeLease(LEASE_A2)).toEqual({ recipients: 0, batches: 0 });
    expect(waiting()).toEqual(['first@example.test']);
  });

  it('purges mail the drainer has taken but not acknowledged, and keeps what was sent', () => {
    store.registerTenant(SLOT_A, 'key-a', SENDER, 'demo-1', LEASE_A1);
    submit(SLOT_A, 'sent@example.test', 'held@example.test', 'pending@example.test');
    const [sent, held] = store.claimForDrain(200, 30, 2);
    expect(sent && held).toBeTruthy();
    store.ackDrain([{ id: sent!.id, drainCount: sent!.drainCount }], 201);

    const purged = store.purgeLease(LEASE_A1);

    // The held and the pending recipient go; the sent one is the record of a
    // message that already left, and stays with its batch.
    expect(purged).toEqual({ recipients: 2, batches: 0 });
    expect(store.countUndrainedRecipients()).toBe(0);
    expect(waiting()).toEqual([]);
  });

  it('is a no-op for a lease nothing was submitted under', () => {
    store.registerTenant(SLOT_B, 'key-b', SENDER, 'demo-2', LEASE_B1);
    submit(SLOT_B, 'b1@example.test');

    expect(store.purgeLease(LEASE_A1)).toEqual({ recipients: 0, batches: 0 });
    expect(waiting()).toEqual(['b1@example.test']);
  });

  it('never matches a batch from a credential that serves no lease', () => {
    store.registerTenant(SLOT_A, 'key-a', SENDER, 'demo-1');
    submit(SLOT_A, 'unleased@example.test');

    store.purgeLease(LEASE_A1);

    expect(waiting()).toEqual(['unleased@example.test']);
  });

  it.each(['', 'not-a-lease', LEASE_A1.toLowerCase(), `${LEASE_A1}0`, '*'])(
    'refuses %j as a lease id and removes nothing',
    (bad) => {
      store.registerTenant(SLOT_A, 'key-a', SENDER, 'demo-1', LEASE_A1);
      submit(SLOT_A, 'a1@example.test');

      expect(() => store.purgeLease(bad)).toThrow(TypeError);
      expect(waiting()).toEqual(['a1@example.test']);
    }
  );
});

describe('the lease a credential serves', () => {
  it('is set at registration, and a re-registration that names none leaves it alone', () => {
    store.registerTenant(SLOT_A, 'key-a', SENDER, 'demo-1', LEASE_A1);
    expect(store.tenantLease(SLOT_A)).toBe(LEASE_A1);

    store.registerTenant(SLOT_A, 'key-a2', SENDER, 'demo-1');
    expect(store.tenantLease(SLOT_A)).toBe(LEASE_A1);
  });

  it('is cleared by an explicit null and replaced by a later one', () => {
    store.registerTenant(SLOT_A, 'key-a', SENDER, 'demo-1', LEASE_A1);
    store.registerTenant(SLOT_A, 'key-a2', SENDER, 'demo-1', null);
    expect(store.tenantLease(SLOT_A)).toBeNull();

    store.registerTenant(SLOT_A, 'key-a3', SENDER, 'demo-1', LEASE_A2);
    expect(store.tenantLease(SLOT_A)).toBe(LEASE_A2);
  });

  it('is null for a credential that was never registered, and setting it there reports false', () => {
    expect(store.tenantLease(SLOT_A)).toBeNull();
    expect(store.setTenantLease(SLOT_A, LEASE_A1)).toBe(false);
  });

  it('refuses a malformed lease at registration and writes nothing', () => {
    expect(() => store.registerTenant(SLOT_A, 'key-a', SENDER, 'demo-1', 'nope')).toThrow(
      TypeError
    );
    expect(store.tenantExists(SLOT_A)).toBe(false);
    expect(() => store.setTenantLease(SLOT_A, 'nope')).toThrow(TypeError);
  });

  it('survives the credential being removed and registered again for the next lease', () => {
    store.registerTenant(SLOT_A, 'key-a', SENDER, 'demo-1', LEASE_A1);
    submit(SLOT_A, 'old@example.test');
    store.purgeLease(LEASE_A1);
    expect(store.removeTenant(SLOT_A)).toBe(true);

    store.registerTenant(SLOT_A, 'key-a-next', SENDER, 'demo-1', LEASE_A2);
    submit(SLOT_A, 'new@example.test');

    expect(waiting()).toEqual(['new@example.test']);
  });
});
