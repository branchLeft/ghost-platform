import { describe, expect, it } from 'vitest';
import { boundSender } from '../../src/senderAuthorization.js';
import {
  FALLBACK_REFUSED,
  acceptedRows,
  fallbackAcceptedRows,
  refusedRows,
} from './helpers/boundSenderRows.js';

const DOMAIN = 'tenant-a.example.com';

describe('boundSender over the shared rows', () => {
  it.each(acceptedRows(DOMAIN).map((row) => [row.id, row] as const))(
    'binds %s to its normal form',
    (_id, row) => {
      expect(boundSender(row.submitted, DOMAIN)).toBe(row.queued);
    }
  );

  it.each(refusedRows(DOMAIN).map((row) => [row.id, row] as const))('refuses %s', (_id, row) => {
    expect(boundSender(row.submitted, DOMAIN)).toBeNull();
  });

  it.each(fallbackAcceptedRows(DOMAIN).map((row) => [row.id, row] as const))(
    'binds the envelope address %s',
    (_id, row) => {
      expect(boundSender(row.submitted, DOMAIN)).toBe(row.queued);
    }
  );

  it('refuses the envelope value that is not a plain mailbox', () => {
    expect(boundSender(FALLBACK_REFUSED.submitted, FALLBACK_REFUSED.domain)).toBeNull();
  });

  it('queues every accepted row with the domain exactly as compared', () => {
    for (const row of acceptedRows(DOMAIN)) {
      const queued = boundSender(row.submitted, DOMAIN)!;
      expect(queued.endsWith(`@${DOMAIN}`) || queued.endsWith(`@${DOMAIN}>`)).toBe(true);
    }
  });
});
