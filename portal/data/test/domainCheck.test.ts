import { describe, expect, it } from 'vitest';
import {
  DnsLookupFailedError,
  DomainProof,
  InvalidEdgeTargetError,
  checkCustomDomain,
  isIssuedProof,
  isNoRecord,
  readEdgeTarget,
  type DnsResolver,
  type EdgeTarget,
} from '../src/domainCheck.js';
import { verificationRecordName, verificationRecordValue } from '../src/customDomain.js';

const NOW = new Date('2026-11-10T12:00:00Z');
const FQDN = 'blog.example.com';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz234567';
const OTHER_TOKEN = 'zyxwvutsrqponmlkjihgfedcba765432';
const EDGE: EdgeTarget = { addresses: ['192.0.2.10', '2001:db8::10'], cname: 'edge.platform.test' };
const DOMAIN = { fqdn: FQDN, token: TOKEN };

const noRecord = Object.assign(new Error('no such record'), { code: 'ENODATA' });

interface Zone {
  a?: string[];
  aaaa?: string[];
  cname?: string[];
  txt?: Record<string, string[][]>;
  failOn?: 'a' | 'aaaa' | 'cname' | 'txt';
}

/** A resolver over a made-up zone: a name with no record of a type answers with the library's own code. */
function zone(z: Zone): DnsResolver {
  const answer = <T>(kind: Zone['failOn'], records: T[] | undefined): Promise<T[]> => {
    if (z.failOn === kind) {
      return Promise.reject(Object.assign(new Error('server failed'), { code: 'ESERVFAIL' }));
    }
    return records === undefined || records.length === 0
      ? Promise.reject(noRecord)
      : Promise.resolve(records);
  };
  return {
    resolve4: () => answer('a', z.a),
    resolve6: () => answer('aaaa', z.aaaa),
    resolveCname: () => answer('cname', z.cname),
    resolveTxt: (name) => answer('txt', z.txt?.[name]),
  };
}

const record = (token = TOKEN): Record<string, string[][]> => ({
  [verificationRecordName(FQDN)]: [[verificationRecordValue(token)]],
});

describe('a domain that points at the edge and carries its record', () => {
  it('passes when it resolves to the edge addresses', async () => {
    const result = await checkCustomDomain(
      zone({ a: ['192.0.2.10'], txt: record() }),
      EDGE,
      DOMAIN,
      NOW
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proof.fqdn).toBe(FQDN);
    expect(result.proof.token).toBe(TOKEN);
    expect(result.proof.checkedAt).toEqual(NOW);
    expect(isIssuedProof(result.proof)).toBe(true);
  });

  it('passes on an IPv6 address alone, in any letter case', async () => {
    const result = await checkCustomDomain(
      zone({ aaaa: ['2001:DB8::10'], txt: record() }),
      EDGE,
      DOMAIN,
      NOW
    );
    expect(result.ok).toBe(true);
  });

  it('passes when it is a CNAME to the edge name and the edge publishes no address', async () => {
    const result = await checkCustomDomain(
      zone({ cname: ['Edge.Platform.Test.'], txt: record() }),
      { addresses: [], cname: 'edge.platform.test' },
      DOMAIN,
      NOW
    );
    expect(result.ok).toBe(true);
  });

  it('reads a record that was split into several strings as one value', async () => {
    const value = verificationRecordValue(TOKEN);
    const result = await checkCustomDomain(
      zone({
        a: ['192.0.2.10'],
        txt: {
          [verificationRecordName(FQDN)]: [['unrelated'], [value.slice(0, 10), value.slice(10)]],
        },
      }),
      EDGE,
      DOMAIN,
      NOW
    );
    expect(result.ok).toBe(true);
  });
});

describe('a domain that is never connected (the control cases)', () => {
  it('is refused as not pointed when it resolves to nothing, whatever record it holds', async () => {
    const result = await checkCustomDomain(zone({ txt: record() }), EDGE, DOMAIN, NOW);
    expect(result).toEqual({ ok: false, reason: 'not_pointed' });
  });

  it('is refused as not pointed when it resolves to an address that is not the edge', async () => {
    const result = await checkCustomDomain(
      zone({ a: ['198.51.100.7'], txt: record() }),
      EDGE,
      DOMAIN,
      NOW
    );
    expect(result).toEqual({ ok: false, reason: 'not_pointed' });
  });

  it('is refused as not pointed when it also answers at an address the edge does not hold', async () => {
    const result = await checkCustomDomain(
      zone({ a: ['192.0.2.10', '198.51.100.7'], txt: record() }),
      EDGE,
      DOMAIN,
      NOW
    );
    expect(result).toEqual({ ok: false, reason: 'not_pointed' });
  });

  it('is refused as not pointed when it is a CNAME to some other name', async () => {
    const result = await checkCustomDomain(
      zone({ cname: ['elsewhere.example.net'], txt: record() }),
      { addresses: [], cname: 'edge.platform.test' },
      DOMAIN,
      NOW
    );
    expect(result).toEqual({ ok: false, reason: 'not_pointed' });
  });

  it('is refused for a missing record when it points at the edge but holds no verification record', async () => {
    const result = await checkCustomDomain(zone({ a: ['192.0.2.10'] }), EDGE, DOMAIN, NOW);
    expect(result).toEqual({ ok: false, reason: 'record_missing' });
  });

  it('is refused for a missing record when the record carries another token', async () => {
    const result = await checkCustomDomain(
      zone({ a: ['192.0.2.10'], txt: record(OTHER_TOKEN) }),
      EDGE,
      DOMAIN,
      NOW
    );
    expect(result).toEqual({ ok: false, reason: 'record_missing' });
  });

  it('is refused for a missing record when the token sits at another name, or is only a prefix', async () => {
    const elsewhere = { [FQDN]: [[verificationRecordValue(TOKEN)]] };
    const prefixed = { [verificationRecordName(FQDN)]: [[`${verificationRecordValue(TOKEN)}x`]] };
    for (const txt of [elsewhere, prefixed]) {
      const result = await checkCustomDomain(zone({ a: ['192.0.2.10'], txt }), EDGE, DOMAIN, NOW);
      expect(result).toEqual({ ok: false, reason: 'record_missing' });
    }
  });
});

describe('a lookup that fails', () => {
  it.each(['a', 'aaaa', 'cname', 'txt'] as const)(
    'is inconclusive, never a pass, when the %s lookup fails',
    async (failOn) => {
      await expect(
        checkCustomDomain(zone({ a: ['192.0.2.10'], txt: record(), failOn }), EDGE, DOMAIN, NOW)
      ).rejects.toBeInstanceOf(DnsLookupFailedError);
    }
  );

  it('keeps the failure as the cause', async () => {
    const error = await checkCustomDomain(
      zone({ a: ['192.0.2.10'], failOn: 'txt' }),
      EDGE,
      DOMAIN,
      NOW
    ).catch((caught: unknown) => caught);
    expect((error as Error).cause).toMatchObject({ code: 'ESERVFAIL' });
  });

  it('treats the library codes for an absent record as an answer', () => {
    for (const code of ['ENOTFOUND', 'ENODATA', 'NXDOMAIN']) {
      expect(isNoRecord(Object.assign(new Error('x'), { code }))).toBe(true);
    }
    for (const code of ['ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', undefined]) {
      expect(isNoRecord(Object.assign(new Error('x'), { code }))).toBe(false);
    }
    expect(isNoRecord(null)).toBe(false);
  });
});

describe('the edge target', () => {
  it.each([
    { addresses: [], cname: null },
    { addresses: ['not-an-address'], cname: null },
    { addresses: [], cname: '  .' },
  ])('is refused when it names nothing usable: %j', async (target) => {
    expect(() => readEdgeTarget(target)).toThrow(InvalidEdgeTargetError);
    await expect(
      checkCustomDomain(zone({ a: ['192.0.2.10'], txt: record() }), target, DOMAIN, NOW)
    ).rejects.toBeInstanceOf(InvalidEdgeTargetError);
  });
});

describe('the proof of a passing check', () => {
  it('cannot be made without the check', () => {
    expect(() => new DomainProof(Symbol('guess'), FQDN, TOKEN, NOW)).toThrow(TypeError);
  });

  it('is not matched by an object that merely looks like one', () => {
    const lookAlike = { fqdn: FQDN, token: TOKEN, checkedAt: NOW };
    expect(isIssuedProof(lookAlike)).toBe(false);
    expect(isIssuedProof(Object.create(DomainProof.prototype))).toBe(false);
    expect(isIssuedProof(null)).toBe(false);
    expect(isIssuedProof('proof')).toBe(false);
  });
});
