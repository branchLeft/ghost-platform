import { domainToASCII } from 'node:url';
// nodemailer's own address parser, not a new dependency: `mailparser`
// (already a dependency here) uses the same parser itself, and nodemailer's
// `exports` map still serves this path (its `./lib/*.js` pattern) — the
// typecheck and the unit suite fail if a release stops serving it.
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

interface Mailbox {
  name: string;
  address: string;
}

/**
 * Every mailbox a header value names, flattened out of any RFC 5322
 * group syntax. Returns null — never an empty array — for a value this
 * shim cannot get at least one real mailbox out of (missing, blank,
 * unparseable, or a group with nothing in it), so a caller's null check
 * refuses "couldn't tell" the same way it refuses "didn't belong" rather
 * than treating an unreadable sender as vacuously fine.
 */
function extractMailboxes(headerValue: string | null | undefined): Mailbox[] | null {
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
  const mailboxes: Mailbox[] = [];
  for (const entry of parsed) {
    if (entry.address) {
      mailboxes.push({ name: entry.name ?? '', address: entry.address });
    }
  }
  return mailboxes.length > 0 ? mailboxes : null;
}

function extractAddresses(headerValue: string | null | undefined): string[] | null {
  const mailboxes = extractMailboxes(headerValue);
  return mailboxes ? mailboxes.map((mailbox) => mailbox.address) : null;
}

/**
 * Exact, case-insensitive equality with the tenant's sender domain, never a
 * suffix match; every mailbox must belong; unparseable never belongs.
 * See senderAuthorization.md#senderbelongstotenant.
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

/** A display name with any control character folded to a space, so it can sit inside one quoted string. */
function cleanDisplayName(name: string): string {
  let cleaned = '';
  for (const char of name) {
    const code = char.charCodeAt(0);
    cleaned += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  return cleaned.trim();
}

/** Ghost's own shape: a present name is always double-quoted (backslash and quote escaped), an absent one leaves the bare address. */
function serialiseMailboxes(mailboxes: Mailbox[]): string {
  return mailboxes
    .map((mailbox) =>
      mailbox.name
        ? `"${mailbox.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" <${mailbox.address}>`
        : mailbox.address
    )
    .join(', ');
}

/**
 * The sender a submission may carry, as the gate itself read it: the same
 * decision as `senderBelongsToTenant`, returning the parsed mailboxes
 * re-serialised in Ghost's shape to queue, or null when they do not belong
 * (or the normal form does not read back as the same mailboxes). Queueing
 * the raw string would let a later parser read another sender out of it.
 * See senderAuthorization.md#boundsender.
 */
export function boundSender(
  headerValue: string | null | undefined,
  tenantDomain: string
): string | null {
  const parsed = extractMailboxes(headerValue);
  if (!parsed) {
    return null;
  }
  const normalizedTenantDomain = normalizeDomain(tenantDomain);
  if (!normalizedTenantDomain) {
    return null;
  }
  if (!parsed.every((mailbox) => extractDomain(mailbox.address) === normalizedTenantDomain)) {
    return null;
  }
  const mailboxes = parsed.map((mailbox) => ({
    name: cleanDisplayName(mailbox.name),
    address: mailbox.address,
  }));
  const serialised = serialiseMailboxes(mailboxes);
  const reread = extractMailboxes(serialised);
  const sameMailboxes =
    reread !== null &&
    reread.length === mailboxes.length &&
    reread.every(
      (mailbox, index) =>
        mailbox.address === mailboxes[index]!.address &&
        cleanDisplayName(mailbox.name) === mailboxes[index]!.name
    );
  return sameMailboxes ? serialised : null;
}

/** The minimal shape `resolveSenderDomain` needs — satisfied by a real `Tenant` (store.ts) without importing it here. */
export interface SenderDomainTenant {
  domain: string;
  senderDomain: string | null;
}

/**
 * The fail-closed gate both front doors call once per submission: no
 * registered sender domain is refused, never guessed from the credential key.
 * See senderAuthorization.md#resolvesenderdomain.
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
