import { describe, expect, it } from 'vitest';
import { domainLookupWith, type DnsResolverLike } from '../../src/dnsLookup.js';

function dnsError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

// A resolver whose answer per record type is a list, an error, or absent (no records).
function resolverWith(answers: {
  mx?: unknown[] | Error;
  a?: unknown[] | Error;
  aaaa?: unknown[] | Error;
}): DnsResolverLike {
  const answer = (value: unknown[] | Error | undefined) => async () => {
    if (value instanceof Error) {
      throw value;
    }
    if (value === undefined) {
      throw dnsError('ENODATA');
    }
    return value;
  };
  return {
    resolveMx: answer(answers.mx),
    resolve4: answer(answers.a),
    resolve6: answer(answers.aaaa),
  };
}

describe('domainLookupWith', () => {
  it('reports a domain with MX records as deliverable', async () => {
    const lookup = domainLookupWith(resolverWith({ mx: [{ exchange: 'mx.example.com' }] }));
    await expect(lookup('example.com')).resolves.toBe('deliverable');
  });

  it('treats a domain with no MX but an A record as deliverable (implicit MX)', async () => {
    const lookup = domainLookupWith(resolverWith({ a: ['192.0.2.10'] }));
    await expect(lookup('example.com')).resolves.toBe('deliverable');
  });

  it('treats a domain with no MX but an AAAA record as deliverable (implicit MX)', async () => {
    const lookup = domainLookupWith(resolverWith({ aaaa: ['2001:db8::10'] }));
    await expect(lookup('example.com')).resolves.toBe('deliverable');
  });

  it('reports a domain with no MX, A or AAAA as undeliverable', async () => {
    const lookup = domainLookupWith(resolverWith({}));
    await expect(lookup('nodomain.test')).resolves.toBe('undeliverable');
  });

  it('reports NXDOMAIN as undeliverable', async () => {
    const lookup = domainLookupWith(
      resolverWith({
        mx: dnsError('ENOTFOUND'),
        a: dnsError('ENOTFOUND'),
        aaaa: dnsError('ENOTFOUND'),
      })
    );
    await expect(lookup('nodomain.test')).resolves.toBe('undeliverable');
  });

  it('reports a timeout or SERVFAIL as unknown, never undeliverable', async () => {
    await expect(
      domainLookupWith(resolverWith({ mx: dnsError('ETIMEOUT') }))('slow.test')
    ).resolves.toBe('unknown');
    await expect(
      domainLookupWith(resolverWith({ mx: dnsError('ESERVFAIL') }))('broken.test')
    ).resolves.toBe('unknown');
  });

  it('reports an error on the address fallback as unknown', async () => {
    const lookup = domainLookupWith(resolverWith({ a: dnsError('ECONNREFUSED') }));
    await expect(lookup('example.com')).resolves.toBe('unknown');
  });
});
