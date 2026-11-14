// The DNS side of the free list check. The resolver is injected, so tests use a
// fake and the CLI passes Node's dns resolver.
import type { DomainLookup, DomainLookupFn } from './checkList.js';

export interface DnsResolverLike {
  resolveMx(domain: string): Promise<readonly unknown[]>;
  resolve4(domain: string): Promise<readonly unknown[]>;
  resolve6(domain: string): Promise<readonly unknown[]>;
}

// "No such record" answers. Anything else (timeout, SERVFAIL, refused) is unknown.
const NO_RECORDS = new Set(['ENODATA', 'ENOTFOUND']);

type Attempt = 'records' | 'empty' | 'error';

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code: unknown }).code
    : undefined;
}

async function attempt(query: () => Promise<readonly unknown[]>): Promise<Attempt> {
  try {
    return (await query()).length > 0 ? 'records' : 'empty';
  } catch (error) {
    const code = codeOf(error);
    return typeof code === 'string' && NO_RECORDS.has(code) ? 'empty' : 'error';
  }
}

// A domain with no MX falls back to its A or AAAA record (implicit MX), so MX
// absence alone does not make a domain undeliverable.
export function domainLookupWith(resolver: DnsResolverLike): DomainLookupFn {
  return async (domain: string): Promise<DomainLookup> => {
    const mx = await attempt(() => resolver.resolveMx(domain));
    if (mx === 'error') {
      return 'unknown';
    }
    if (mx === 'records') {
      return 'deliverable';
    }
    const a = await attempt(() => resolver.resolve4(domain));
    if (a === 'error') {
      return 'unknown';
    }
    if (a === 'records') {
      return 'deliverable';
    }
    const aaaa = await attempt(() => resolver.resolve6(domain));
    if (aaaa === 'error') {
      return 'unknown';
    }
    return aaaa === 'records' ? 'deliverable' : 'undeliverable';
  };
}
