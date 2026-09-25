import { domainToASCII } from 'node:url';
// nodemailer's own address parser, not a new dependency: `mailparser`
// (already a dependency here) requires this exact internal path itself
// (node_modules/mailparser/lib/mail-parser.js does
// `require('nodemailer/lib/addressparser')`), and nodemailer ships no
// `exports` map restricting it — verified against the installed package.
// It restores quoting a bare split would lose (`_recoverAddrSpec`), so a
// quoted local part containing '@' or ',' can't be misread as a second
// address or a different domain. No published types for this internal
// path — declared below, same pattern smtpFrontDoor.ts uses to type
// smtp-server's own undocumented internals.
import addressparser from 'nodemailer/lib/addressparser/index.js';
import type { Logger } from './log.js';

interface ParsedAddress {
  name?: string;
  address?: string;
  group?: ParsedAddress[];
}

declare module 'nodemailer/lib/addressparser/index.js' {
  export default function addressparser(
    input: string,
    options?: { flatten?: boolean }
  ): ParsedAddress[];
}

/**
 * ASCII/punycode + lowercase + no trailing root dot. `domainToASCII`
 * already lowercases and IDN-normalises (verified: 'Tenant-A.Example.COM'
 * -> 'tenant-a.example.com', 'straße.example' -> 'xn--strae-oqa.example')
 * and returns '' for anything it can't parse as a domain — but it does
 * NOT strip a trailing '.' (verified: 'tenant-a.example.com.' round-trips
 * with the dot still on), so that has to happen first or "tenant.com."
 * would compare unequal to "tenant.com".
 */
function normalizeDomain(rawDomain: string): string | null {
  // Trailing dots stripped by scanning for the cut point and slicing once,
  // rather than a `\.+$/` regex or a slice-in-a-loop: the input is
  // attacker-controlled (a header value with no length cap enforced
  // upstream of this function). A trailing-anchored `+` quantifier is
  // exactly the shape static analysis flags for ReDoS, and repeatedly
  // slicing one character off a string of `k` trailing dots is its own
  // O(n*k) trap — this single scan-then-slice is O(n) regardless of how
  // many trailing dots the input carries.
  const beforeTrim = rawDomain.trim();
  let end = beforeTrim.length;
  while (end > 0 && beforeTrim.charCodeAt(end - 1) === 46 /* '.' */) {
    end--;
  }
  const trimmed = beforeTrim.slice(0, end);
  if (!trimmed) {
    return null;
  }
  const ascii = domainToASCII(trimmed);
  return ascii ? ascii : null;
}

/**
 * Everything after the LAST unquoted '@' — safe only because
 * `addressparser` has already restored quoting on the local part
 * (`_recoverAddrSpec`), so an '@' that was inside a quoted local part in
 * the original header is quoted here too and this `lastIndexOf` can't
 * land inside it.
 */
function extractDomain(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at === -1 || at === address.length - 1) {
    return null;
  }
  return normalizeDomain(address.slice(at + 1));
}

/**
 * Every mailbox address a header value names, flattened out of any RFC
 * 5322 group syntax. Returns null — never an empty array — for a value
 * this shim cannot get at least one real mailbox out of (missing, blank,
 * unparseable, or a group with nothing in it), so a caller's `!addresses`
 * check refuses "couldn't tell" the same way it refuses "didn't belong"
 * rather than treating an unreadable sender as vacuously fine.
 */
function extractAddresses(headerValue: string | null | undefined): string[] | null {
  if (headerValue === null || headerValue === undefined) {
    return null;
  }
  const trimmed = headerValue.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: ParsedAddress[];
  try {
    parsed = addressparser(trimmed, { flatten: true });
  } catch {
    return null;
  }
  const addresses = parsed.map((entry) => entry.address).filter((a): a is string => Boolean(a));
  return addresses.length > 0 ? addresses : null;
}

/**
 * The one check both the HTTP route (`routes/messages.ts`, the `from`
 * field) and the SMTP front door (`smtpFrontDoor.ts`, envelope MAIL FROM,
 * header From, header Sender) use to decide whether a claimed sender
 * belongs to a tenant. `tenantDomain` must be the tenant's registered
 * *sending* domain (`Tenant.senderDomain`), never its credential lookup
 * key (`Tenant.domain`) — the two are not guaranteed equal (tenant zero's
 * credential key is `blog.branchleft.co.uk`, its real From is
 * `branchleft.co.uk`), and passing the wrong one here refuses every
 * legitimate send instead of every spoofed one.
 *
 * Exact, case-insensitive equality on the normalised domain — never a
 * suffix or `endsWith` check. A suffix match would let
 * "attacker-tenant.com" through against a stored domain "tenant.com"
 * (it ends with "tenant.com" the wrong way) and would also have to be
 * anchored on a label boundary to avoid the opposite mistake
 * ("tenant.com.evil.com" ends with "evil.com", not "tenant.com", so that
 * particular pair is safe either way — but a same-registrable-suffix
 * design generally needs a public-suffix list to be safe at all). Equality
 * alone defeats every look-alike without one, whatever granularity a
 * tenant's sender domain was registered at (a bare apex, or a subdomain
 * carved out for one sending purpose).
 *
 * A header naming more than one mailbox (a From with several addresses)
 * must have ALL of them belong, not just one — Ghost never legitimately
 * sends a multi-address From, and a mix of a real address with a spoofed
 * one is exactly the shape that would otherwise slip through.
 *
 * An empty, null, or unparseable value never belongs to anything — there
 * is no address to have been provisioned for a tenant, so "couldn't
 * parse" is refused exactly like "parsed to something foreign", not
 * treated as harmless because nothing definite was found.
 */
export function senderBelongsToTenant(
  headerValue: string | null | undefined,
  tenantDomain: string
): boolean {
  const addresses = extractAddresses(headerValue);
  if (!addresses) {
    return false;
  }
  const normalizedTenantDomain = normalizeDomain(tenantDomain);
  if (!normalizedTenantDomain) {
    return false;
  }
  return addresses.every((address) => extractDomain(address) === normalizedTenantDomain);
}

/** The minimal shape `resolveSenderDomain` needs — satisfied by a real `Tenant` (store.ts) without importing it here. */
export interface SenderDomainTenant {
  domain: string;
  senderDomain: string | null;
}

/**
 * The single fail-closed gate both front doors call, exactly once per
 * submission, before any `senderBelongsToTenant` check runs. A tenant
 * with no registered sender domain — every row that predates this field,
 * until an operator runs the CLI's `set-sender-domain` — is refused here
 * rather than silently falling back to `tenant.domain` (the credential
 * key): the two are not guaranteed equal (see `Tenant.senderDomain`'s own
 * doc comment), and guessing one back in for a legacy row would
 * reintroduce that mismatch, one row at a time, as new tenants migrate in
 * unset.
 */
export function resolveSenderDomain(
  tenant: SenderDomainTenant,
  log: Logger,
  route: 'http' | 'smtp'
): string | null {
  if (tenant.senderDomain) {
    return tenant.senderDomain;
  }
  log.error('sender_domain_not_registered', { domain: tenant.domain, route });
  return null;
}
