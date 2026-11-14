import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mailClassOf, type MailClass } from '../../src/mailClass.js';
import { createSqliteStore, type QueueBatchPayload, type ShimStore } from '../../src/store.js';

/**
 * The same cases the mail collector pins for its own `mailClassOf`
 * (services/mail-collector/test/unit/classifier.test.ts). The shim orders its
 * claims by SQL that restates the rule, so each case is asked of both the
 * function and the claim order.
 */
const CASES: ReadonlyArray<{ name: string; emailId: string | null; mailClass: MailClass }> = [
  { name: 'null', emailId: null, mailClass: 'transactional' },
  { name: 'empty string', emailId: '', mailClass: 'transactional' },
  { name: 'a campaign id', emailId: 'campaign-1', mailClass: 'bulk' },
  { name: 'a lone space is still an id', emailId: ' ', mailClass: 'bulk' },
  { name: 'the string "null" is an id', emailId: 'null', mailClass: 'bulk' },
];

const PAYLOAD: QueueBatchPayload = {
  from: 'a@tenant.example.com',
  subject: 's',
  html: '',
  text: '',
  headers: {},
  recipientVariables: {},
};

describe('mailClassOf', () => {
  it.each(CASES)('$name is $mailClass', (c) => {
    expect(mailClassOf(c.emailId)).toBe(c.mailClass);
  });

  it('treats a missing id as sign-in mail', () => {
    expect(mailClassOf(undefined)).toBe('transactional');
  });
});

describe('the claim order restates mailClassOf', () => {
  let store: ShimStore;
  beforeEach(() => {
    store = createSqliteStore(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  it.each(CASES)('$name: claimed first exactly when transactional', (c) => {
    // The bulk probe is older, so only the class can put the case ahead of it.
    store.enqueueBatch({
      batchId: 'probe-bulk',
      domain: 'tenant.example.com',
      emailId: 'probe-campaign',
      payload: PAYLOAD,
      recipients: ['probe@example.com'],
      now: 1,
    });
    store.enqueueBatch({
      batchId: 'case',
      domain: 'tenant.example.com',
      emailId: c.emailId,
      payload: PAYLOAD,
      recipients: ['case@example.com'],
      now: 2,
    });
    const order = store.claimForDrain(3, 30, 10).map((r) => r.recipient);
    expect(order[0] === 'case@example.com').toBe(c.mailClass === 'transactional');
  });
});
