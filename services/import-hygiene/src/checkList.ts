// The free list check: drops syntax failures, suppressed addresses and domains
// that cannot receive mail. A lookup that fails transiently keeps the address
// and counts it as unknown; a transient failure is never a reason to drop.

export type DomainLookup = 'deliverable' | 'undeliverable' | 'unknown';

export type DomainLookupFn = (domain: string) => Promise<DomainLookup>;

export interface ListRow {
  readonly row: number;
  readonly address: string;
}

export type DropReason = 'syntax' | 'suppressed' | 'no-mx-or-address';

export interface CheckOptions {
  readonly suppressed: Iterable<string>;
  readonly lookupDomain: DomainLookupFn;
}

export interface CheckResult {
  readonly kept: readonly ListRow[];
  readonly dropped: ReadonlyArray<{ readonly row: number; readonly reason: DropReason }>;
  readonly unknownRows: readonly number[];
}

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

// Syntax only: one @, a dot-atom local part, and a dotted domain of valid
// labels. No whitespace is accepted, so a padded address is a syntax failure.
export function isSyntaxValid(address: string): boolean {
  if (address.length > 254) {
    return false;
  }
  const parts = address.split('@');
  if (parts.length !== 2) {
    return false;
  }
  const [local, domain] = parts;
  if (local === undefined || domain === undefined || !LOCAL_PART.test(local)) {
    return false;
  }
  if (domain.length > 253) {
    return false;
  }
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every((label) => DOMAIN_LABEL.test(label));
}

function normalise(address: string): string {
  return address.toLowerCase();
}

async function lookupSafely(lookupDomain: DomainLookupFn, domain: string): Promise<DomainLookup> {
  try {
    return await lookupDomain(domain);
  } catch {
    return 'unknown';
  }
}

export async function checkList(
  rows: readonly ListRow[],
  options: CheckOptions
): Promise<CheckResult> {
  const suppressed = new Set<string>();
  for (const address of options.suppressed) {
    suppressed.add(normalise(address));
  }
  const lookups = new Map<string, Promise<DomainLookup>>();
  const kept: ListRow[] = [];
  const dropped: Array<{ row: number; reason: DropReason }> = [];
  const unknownRows: number[] = [];

  for (const { row, address } of rows) {
    if (!isSyntaxValid(address)) {
      dropped.push({ row, reason: 'syntax' });
      continue;
    }
    const normalised = normalise(address);
    if (suppressed.has(normalised)) {
      dropped.push({ row, reason: 'suppressed' });
      continue;
    }
    const domain = normalised.slice(normalised.indexOf('@') + 1);
    let pending = lookups.get(domain);
    if (pending === undefined) {
      pending = lookupSafely(options.lookupDomain, domain);
      lookups.set(domain, pending);
    }
    const verdict = await pending;
    if (verdict === 'undeliverable') {
      dropped.push({ row, reason: 'no-mx-or-address' });
      continue;
    }
    kept.push({ row, address });
    if (verdict === 'unknown') {
      unknownRows.push(row);
    }
  }
  return { kept, dropped, unknownRows };
}
