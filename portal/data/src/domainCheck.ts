import { isIP } from 'node:net';
import { verificationRecordName, verificationRecordValue } from './customDomain.js';

/**
 * The lookups the check needs, as a seam: the portal gives it a real
 * resolver, a test gives it a fake. A name with no record of the type must
 * resolve to an empty list (or reject with a code `isNoRecord` recognises);
 * any other failure rejects and the check is inconclusive, never a pass.
 */
export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
  resolveCname(name: string): Promise<string[]>;
}

/** Where the edge answers: the addresses a domain may point at, and the name a CNAME may point at. */
export interface EdgeTarget {
  readonly addresses: readonly string[];
  readonly cname: string | null;
}

/** The lookup itself failed (a timeout, a refused or failed server): neither a pass nor a "no". */
export class DnsLookupFailedError extends Error {
  constructor(options?: { cause: unknown }) {
    super('the domain could not be looked up just now', options);
    this.name = 'DnsLookupFailedError';
  }
}

/** The edge target names nothing a domain could point at, or an address that is not one. */
export class InvalidEdgeTargetError extends Error {
  constructor() {
    super('the edge target must name at least one address or a name, and only valid ones');
    this.name = 'InvalidEdgeTargetError';
  }
}

/** Resolver error codes that mean "no record of this type", which is an answer, not a failure. */
const NO_RECORD_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENOENT']);

export function isNoRecord(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && NO_RECORD_CODES.has(code);
}

async function lookup<T>(attempt: () => Promise<T[]>): Promise<T[]> {
  try {
    return await attempt();
  } catch (error) {
    if (isNoRecord(error)) return [];
    throw new DnsLookupFailedError({ cause: error });
  }
}

const mint = Symbol('mint a domain proof');
const issued = new WeakSet<object>();

/**
 * The evidence that a domain resolved to the edge and carried its
 * verification record when it was checked. It has no public constructor and
 * `checkCustomDomain` is the only way to make one, so the call that connects a
 * domain cannot be made without a passing check: a domain that does not point
 * at the edge, or lacks its record, has no proof to present.
 */
export class DomainProof {
  readonly #fqdn: string;
  readonly #token: string;
  readonly #checkedAt: Date;

  constructor(key: symbol, fqdn: string, token: string, checkedAt: Date) {
    if (key !== mint) throw new TypeError('a DomainProof is made by checkCustomDomain');
    this.#fqdn = fqdn;
    this.#token = token;
    this.#checkedAt = checkedAt;
    issued.add(this);
  }

  get fqdn(): string {
    return this.#fqdn;
  }
  get token(): string {
    return this.#token;
  }
  get checkedAt(): Date {
    return this.#checkedAt;
  }
}

/** Whether `proof` was issued by `checkCustomDomain` in this process (not a look-alike object). */
export function isIssuedProof(proof: unknown): proof is DomainProof {
  return typeof proof === 'object' && proof !== null && issued.has(proof);
}

/** How long a passing check may be presented for: long enough for a request, too short to hoard. */
export const PROOF_MAX_AGE_MS = 10 * 60 * 1000;

/** The proof is not one `checkCustomDomain` issued, is dated in the future, or is too old. */
export class DomainProofInvalidError extends Error {
  constructor() {
    super('the domain check is missing or out of date');
    this.name = 'DomainProofInvalidError';
  }
}

export function isFreshProof(proof: DomainProof, now: Date): boolean {
  const age = now.getTime() - proof.checkedAt.getTime();
  return age >= 0 && age <= PROOF_MAX_AGE_MS;
}

/** Why a domain was not connected. Neither reason names the tenant's records. */
export type DomainRefusal = 'not_pointed' | 'record_missing';

export type DomainCheckResult =
  | { readonly ok: true; readonly proof: DomainProof }
  | { readonly ok: false; readonly reason: DomainRefusal };

function normaliseName(name: string): string {
  return name.trim().toLowerCase().replace(/[.]$/, '');
}

/** Checks the target once and returns it in a form the check can compare against. */
export function readEdgeTarget(target: EdgeTarget): {
  addresses: Set<string>;
  cname: string | null;
} {
  const addresses = new Set<string>();
  for (const address of target.addresses) {
    if (isIP(address) === 0) throw new InvalidEdgeTargetError();
    addresses.add(address.toLowerCase());
  }
  const cname = target.cname === null ? null : normaliseName(target.cname);
  if (cname === '') throw new InvalidEdgeTargetError();
  if (addresses.size === 0 && cname === null) throw new InvalidEdgeTargetError();
  return { addresses, cname };
}

/**
 * Whether the domain points at the edge. Every address it resolves to must be
 * one of the edge's: a domain that also answers at an address the edge does not
 * hold is not pointed at it. A name that is a CNAME to the edge's name counts as
 * pointed even when the edge publishes addresses only through that name.
 */
async function pointsAtEdge(
  resolver: DnsResolver,
  fqdn: string,
  edge: { addresses: Set<string>; cname: string | null }
): Promise<boolean> {
  const [v4, v6, cnames] = await Promise.all([
    lookup(() => resolver.resolve4(fqdn)),
    lookup(() => resolver.resolve6(fqdn)),
    lookup(() => resolver.resolveCname(fqdn)),
  ]);
  const resolved = [...v4, ...v6].map((address) => address.toLowerCase());
  if (resolved.length > 0 && edge.addresses.size > 0) {
    return resolved.every((address) => edge.addresses.has(address));
  }
  if (edge.cname !== null && cnames.length > 0) {
    return cnames.every((name) => normaliseName(name) === edge.cname);
  }
  return false;
}

/**
 * Checks that `fqdn` points at the edge and carries the one-time verification
 * record for `token`. The pointing is checked first, so a domain that is not
 * aimed at us is reported as such whatever TXT records it holds. A lookup that
 * fails for any reason other than "no such record" throws
 * `DnsLookupFailedError`: the check never passes on a failed lookup.
 *
 * @throws DnsLookupFailedError, InvalidEdgeTargetError
 */
export async function checkCustomDomain(
  resolver: DnsResolver,
  target: EdgeTarget,
  domain: { fqdn: string; token: string },
  now: Date
): Promise<DomainCheckResult> {
  const edge = readEdgeTarget(target);
  if (!(await pointsAtEdge(resolver, domain.fqdn, edge))) {
    return { ok: false, reason: 'not_pointed' };
  }
  const wanted = verificationRecordValue(domain.token);
  const records = await lookup(() => resolver.resolveTxt(verificationRecordName(domain.fqdn)));
  // A TXT record can be split into strings; the record's value is their concatenation.
  const present = records.some((strings) => strings.join('') === wanted);
  if (!present) return { ok: false, reason: 'record_missing' };
  return { ok: true, proof: new DomainProof(mint, domain.fqdn, domain.token, now) };
}
