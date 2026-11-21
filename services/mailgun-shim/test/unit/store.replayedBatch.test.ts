import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteStore, type QueueBatchPayload, type ShimStore } from '../../src/store.js';

const DOMAIN = 'tenant.example.com';
const EMAIL_ID = 'newsletter-1';

const PAYLOAD: QueueBatchPayload = {
  from: 'noreply@tenant.example.com',
  subject: 'Hi',
  html: '<p>hi</p>',
  text: 'hi',
  headers: {},
  recipientVariables: {},
};

describe('createSqliteStore — a replayed newsletter batch is refused (enqueueBatch)', () => {
  let store: ShimStore;

  function enqueue(
    batchId: string,
    recipients: string[],
    overrides: { domain?: string; emailId?: string | null } = {}
  ): void {
    store.enqueueBatch({
      batchId,
      domain: overrides.domain ?? DOMAIN,
      emailId: overrides.emailId === undefined ? EMAIL_ID : overrides.emailId,
      payload: PAYLOAD,
      recipients,
      now: 100,
    });
  }

  function drainedRecipients(): string[] {
    return store.claimForDrain(200, 30, 100).map((r) => r.recipient);
  }

  beforeEach(() => {
    store = createSqliteStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('refuses a recipient already queued for the same domain and email id', () => {
    enqueue('first', ['a@example.com', 'b@example.com']);
    enqueue('replay', ['a@example.com', 'b@example.com']);
    expect(drainedRecipients()).toEqual(['a@example.com', 'b@example.com']);
  });

  it('queues only the recipients not already queued when a batch is partly replayed', () => {
    enqueue('first', ['a@example.com']);
    enqueue('second', ['a@example.com', 'c@example.com']);
    expect(drainedRecipients()).toEqual(['a@example.com', 'c@example.com']);
  });

  it('refuses a recipient whose earlier copy was already sent', () => {
    enqueue('first', ['a@example.com']);
    const [row] = store.claimForDrain(150, 30, 10);
    store.ackDrain([{ id: row!.id, drainCount: row!.drainCount }], 160);
    enqueue('replay', ['a@example.com']);
    expect(store.countUndrainedRecipients()).toBe(0);
  });

  it('refuses a recipient whose earlier copy was delivered', () => {
    enqueue('first', ['a@example.com']);
    const [row] = store.claimForDrain(150, 30, 10);
    store.ackDrain([{ id: row!.id, drainCount: row!.drainCount }], 160);
    store.recordOutcomes([{ id: row!.id, drainCount: row!.drainCount, outcome: 'delivered' }], 170);
    enqueue('replay', ['a@example.com']);
    expect(store.countUndrainedRecipients()).toBe(0);
  });

  it('lets the same recipient through for another email id, another domain, or no email id', () => {
    enqueue('first', ['a@example.com']);
    enqueue('other-email', ['a@example.com'], { emailId: 'newsletter-2' });
    enqueue('other-domain', ['a@example.com'], { domain: 'other.example.com' });
    enqueue('no-email-id-1', ['a@example.com'], { emailId: null });
    enqueue('no-email-id-2', ['a@example.com'], { emailId: null });
    expect(store.countUndrainedRecipients()).toBe(5);
  });

  it('lets a recipient through again when the earlier copy failed', () => {
    enqueue('first', ['a@example.com']);
    const [row] = store.claimForDrain(150, 30, 10);
    store.ackDrain([{ id: row!.id, drainCount: row!.drainCount }], 160);
    store.recordOutcomes(
      [
        {
          id: row!.id,
          drainCount: row!.drainCount,
          outcome: 'failed',
          severity: 'permanent',
          code: 550,
          message: 'No such user',
        },
      ],
      170
    );
    store.removeSuppression(DOMAIN, 'bounces', 'a@example.com');
    enqueue('retry', ['a@example.com']);
    expect(drainedRecipients()).toEqual(['a@example.com']);
  });

  it('writes no batch row when every recipient was already queued', () => {
    enqueue('first', ['a@example.com']);
    enqueue('replay', ['a@example.com']);
    expect(store.claimForDrain(200, 30, 100).map((r) => r.batchId)).toEqual(['first']);
  });
});
