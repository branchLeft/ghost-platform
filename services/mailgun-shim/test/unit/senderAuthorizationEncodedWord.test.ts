import { describe, expect, it } from 'vitest';
import {
  boundSender,
  rawFromHeaderValue,
  refusesEncodedWord,
  senderBelongsToTenant,
} from '../../src/senderAuthorization.js';
import {
  acceptedEncodedWordRows,
  literalDomainRows,
  refusedEncodedWordRows,
} from './helpers/encodedWordRows.js';

const DOMAIN = 'tenant-a.example.com';

describe('the sender gate over the encoded-word rows', () => {
  it.each(refusedEncodedWordRows(DOMAIN).map((row) => [row.id, row] as const))(
    'refuses %s',
    (_id, row) => {
      expect(boundSender(row.submitted, DOMAIN)).toBeNull();
      expect(senderBelongsToTenant(row.submitted, DOMAIN)).toBe(false);
      expect(refusesEncodedWord(row.submitted)).toBe(true);
    }
  );

  // The SMTP route hands the gate the decoded text and the header as written.
  // A decoded text that looks fine must not hide a word in the written header.
  it.each(refusedEncodedWordRows(DOMAIN).map((row) => [row.id, row] as const))(
    'refuses a decoded sender when the header as written holds %s',
    (_id, row) => {
      expect(boundSender(`alice@${DOMAIN}`, DOMAIN, row.submitted)).toBeNull();
    }
  );

  it.each(literalDomainRows(DOMAIN).map((row) => [row.id, row] as const))(
    'refuses %s',
    (_id, row) => {
      expect(boundSender(row.submitted, DOMAIN)).toBeNull();
    }
  );

  it.each(acceptedEncodedWordRows(DOMAIN).map((row) => [row.id, row] as const))(
    'binds %s to its normal form',
    (_id, row) => {
      expect(boundSender(row.submitted, DOMAIN)).toBe(row.queued);
      expect(senderBelongsToTenant(row.submitted, DOMAIN)).toBe(true);
      expect(refusesEncodedWord(row.submitted)).toBe(false);
      expect(boundSender(row.queuedSmtp, DOMAIN, row.submitted)).toBe(row.queuedSmtp);
    }
  );

  it('reads a long run of openers in linear time', () => {
    const started = Date.now();
    expect(refusesEncodedWord('=?a?q?'.repeat(20000) + `@${DOMAIN}`)).toBe(true);
    expect(refusesEncodedWord('=?'.repeat(40000))).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('rawFromHeaderValue', () => {
  it('returns the header after its name, unfolded', () => {
    expect(
      rawFromHeaderValue([
        { key: 'subject', line: 'Subject: PLACEHOLDER' },
        { key: 'from', line: 'From: NAME_PLACEHOLDER\r\n <alice@tenant-a.example.com>' },
      ])
    ).toBe(' NAME_PLACEHOLDER <alice@tenant-a.example.com>');
  });

  it('joins every From line, so a second one is read too', () => {
    expect(
      rawFromHeaderValue([
        { key: 'from', line: 'From: a@tenant-a.example.com' },
        { key: 'from', line: 'From: b@tenant-a.example.com' },
      ])
    ).toBe(' a@tenant-a.example.com,  b@tenant-a.example.com');
  });

  it('returns undefined when there is no From line', () => {
    expect(rawFromHeaderValue([{ key: 'subject', line: 'Subject: PLACEHOLDER' }])).toBeUndefined();
  });
});
