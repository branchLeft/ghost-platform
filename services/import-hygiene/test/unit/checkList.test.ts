import { describe, expect, it } from 'vitest';
import { checkList, isSyntaxValid, type DomainLookup, type ListRow } from '../../src/checkList.js';

// Fabricated addresses at reserved domains only (example.com, example.org, .test).
const DOMAINS: Record<string, DomainLookup> = {
  'example.com': 'deliverable',
  'example.org': 'deliverable',
  'nodomain.test': 'undeliverable',
};

function fakeLookup(calls: string[] = []) {
  return async (domain: string): Promise<DomainLookup> => {
    calls.push(domain);
    if (domain === 'timeout.test') {
      throw new Error('ETIMEOUT');
    }
    return DOMAINS[domain] ?? 'undeliverable';
  };
}

function rows(addresses: string[]): ListRow[] {
  return addresses.map((address, index) => ({ row: index + 1, address }));
}

describe('isSyntaxValid', () => {
  it.each(['ada@example.com', 'first.last+tag@example.org', "o'neil@example.com"])(
    'accepts %s',
    (address) => {
      expect(isSyntaxValid(address)).toBe(true);
    }
  );

  it.each([
    'no-at-sign.example.com',
    'two@@example.com',
    '@example.com',
    'ada@',
    'ada@nodot',
    ' ada@example.com',
    'ada@example.com ',
    'a..b@example.com',
    '.a@example.com',
    'a@-bad.example.com',
    '',
  ])('rejects %j', (address) => {
    expect(isSyntaxValid(address)).toBe(false);
  });
});

describe('checkList', () => {
  it('drops a syntax failure and keeps a valid address', async () => {
    const result = await checkList(rows(['ada@example.com', 'not an address']), {
      suppressed: [],
      lookupDomain: fakeLookup(),
    });
    expect(result.kept.map((r) => r.row)).toEqual([1]);
    expect(result.dropped).toEqual([{ row: 2, reason: 'syntax' }]);
  });

  it('drops an address whose domain has no MX and no A or AAAA record', async () => {
    const result = await checkList(rows(['nobody@nodomain.test']), {
      suppressed: [],
      lookupDomain: fakeLookup(),
    });
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([{ row: 1, reason: 'no-mx-or-address' }]);
  });

  it('drops a suppressed address, comparing case-insensitively', async () => {
    const result = await checkList(rows(['Grace@Example.COM', 'ada@example.com']), {
      suppressed: ['grace@example.com'],
      lookupDomain: fakeLookup(),
    });
    expect(result.kept.map((r) => r.row)).toEqual([2]);
    expect(result.dropped).toEqual([{ row: 1, reason: 'suppressed' }]);
  });

  it('checks suppression before any DNS lookup', async () => {
    const calls: string[] = [];
    await checkList(rows(['grace@example.com']), {
      suppressed: ['grace@example.com'],
      lookupDomain: fakeLookup(calls),
    });
    expect(calls).toEqual([]);
  });

  it('keeps an address whose lookup fails transiently and counts it unknown', async () => {
    const result = await checkList(rows(['slow@timeout.test']), {
      suppressed: [],
      lookupDomain: fakeLookup(),
    });
    expect(result.kept.map((r) => r.row)).toEqual([1]);
    expect(result.dropped).toEqual([]);
    expect(result.unknownRows).toEqual([1]);
  });

  it('keeps an address whose lookup function rejects with any error', async () => {
    const result = await checkList(rows(['ada@example.com']), {
      suppressed: [],
      lookupDomain: async () => {
        throw new Error('SERVFAIL');
      },
    });
    expect(result.kept.map((r) => r.row)).toEqual([1]);
    expect(result.unknownRows).toEqual([1]);
  });

  it('looks up each domain once', async () => {
    const calls: string[] = [];
    await checkList(rows(['a@example.com', 'b@example.com', 'c@example.org']), {
      suppressed: [],
      lookupDomain: fakeLookup(calls),
    });
    expect(calls).toEqual(['example.com', 'example.org']);
  });
});
