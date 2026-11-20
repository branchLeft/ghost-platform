import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteStore, type ShimStore } from '../../src/store.js';

/**
 * What the mail collector's newsletter-lane caps rely on, recorded against the
 * real store: a drainer that leaves rows unacked (the collector does, for a
 * newsletter over its day's cap) is offered those same rows again once each
 * lease lapses, oldest batch first, so with a batch limit a held backlog fills
 * every claim and a later newsletter is not offered until the backlog is acked.
 * Sign-in mail is claimed ahead of all bulk and is not crowded out.
 */

const DOMAIN = 'tenant.example.com';
const LEASE_SECONDS = 30;
const BATCH_LIMIT = 25;

function enqueue(
  store: ShimStore,
  batchId: string,
  emailId: string | null,
  recipients: string[],
  now: number
): void {
  store.enqueueBatch({
    batchId,
    domain: DOMAIN,
    emailId,
    payload: {
      from: 'noreply@tenant.example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
      text: 'hi',
      headers: {},
      recipientVariables: {},
    },
    recipients,
    now,
  });
}

describe('unacked bulk rows and the drain batch limit', () => {
  let store: ShimStore;

  beforeEach(() => {
    store = createSqliteStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('re-offers a full batch of unacked older rows ahead of a later newsletter, every time', () => {
    const backlog = Array.from({ length: BATCH_LIMIT }, (_, i) => `old${i}@example.com`);
    enqueue(store, 'older', 'email-older', backlog, 0);
    enqueue(store, 'later', 'email-later', ['later@example.com'], 10);

    const firstClaim = store.claimForDrain(100, LEASE_SECONDS, BATCH_LIMIT);
    expect(firstClaim.map((r) => r.recipient)).toEqual(backlog);

    // Nothing acked. Each lease lapses and the same rows come back, ahead of the later batch.
    for (let round = 1; round <= 3; round += 1) {
      const claim = store.claimForDrain(100 + round * 31, LEASE_SECONDS, BATCH_LIMIT);
      expect(claim.map((r) => r.recipient)).toEqual(backlog);
      expect(claim.map((r) => r.drainCount)).toEqual(backlog.map(() => round + 1));
    }

    // Acked, the backlog gives way and the later newsletter is offered.
    const claim = store.claimForDrain(300, LEASE_SECONDS, BATCH_LIMIT);
    store.ackDrain(
      claim.map((r) => ({ id: r.id, drainCount: r.drainCount })),
      301
    );
    expect(store.claimForDrain(302, LEASE_SECONDS, BATCH_LIMIT).map((r) => r.recipient)).toEqual([
      'later@example.com',
    ]);
  });

  it('offers a fewer-than-limit held backlog beside the later newsletter', () => {
    enqueue(store, 'older', 'email-older', ['old0@example.com', 'old1@example.com'], 0);
    enqueue(store, 'later', 'email-later', ['later@example.com'], 10);
    store.claimForDrain(100, LEASE_SECONDS, BATCH_LIMIT);
    expect(store.claimForDrain(131, LEASE_SECONDS, BATCH_LIMIT).map((r) => r.recipient)).toEqual([
      'old0@example.com',
      'old1@example.com',
      'later@example.com',
    ]);
  });

  it('claims sign-in mail ahead of a held bulk backlog', () => {
    const backlog = Array.from({ length: BATCH_LIMIT }, (_, i) => `old${i}@example.com`);
    enqueue(store, 'older', 'email-older', backlog, 0);
    store.claimForDrain(100, LEASE_SECONDS, BATCH_LIMIT);
    enqueue(store, 'login', null, ['member@example.com'], 120);
    const claim = store.claimForDrain(131, LEASE_SECONDS, BATCH_LIMIT);
    expect(claim[0]!.recipient).toBe('member@example.com');
    expect(claim).toHaveLength(BATCH_LIMIT);
  });
});
