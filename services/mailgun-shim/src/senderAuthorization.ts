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
  const beforeTrim = rawDomain;
  let end = beforeTrim.length;
  while (end > 0 && beforeTrim.charCodeAt(end - 1) === 46 /* '.' */) {
    end--;
  }
  const trimmed = beforeTrim.slice(0, end);
  if (!trimmed) {
    return null;
  }
  // The domain is compared as a hostname: an ASCII character a hostname
  // cannot hold refuses the whole value, before `domainToASCII` (a URL host
  // parser) sees it.
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    const hostnameChar =
      code >= 0x80 ||
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      code === 0x2d /* '-' */ ||
      code === 0x2e /* '.' */ ||
      code === 0x5f; /* '_' */
    if (!hostnameChar) {
      return null;
    }
  }
  const ascii = domainToASCII(trimmed);
  // What was compared must itself be a plain hostname.
  return ascii && /^[a-z0-9._-]+$/.test(ascii) ? ascii : null;
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

/** Spans of text shaped like an encoded word: `=?`, a charset, a `q` or `b` marker, then text up to the next `?=`. */
function encodedWordSpans(text: string): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  let from = 0;
  // Each pass either consumes a span or moves one character on, and a charset
  // scan stops at the next '?', so the whole scan is linear in the input.
  for (;;) {
    const open = text.indexOf('=?', from);
    if (open < 0) {
      break;
    }
    let charsetEnd = open + 2;
    while (
      charsetEnd < text.length &&
      text.charAt(charsetEnd) !== '?' &&
      !/\s/.test(text.charAt(charsetEnd))
    ) {
      charsetEnd++;
    }
    const marker = text.charAt(charsetEnd + 1);
    const shaped =
      charsetEnd > open + 2 &&
      text.charAt(charsetEnd) === '?' &&
      (marker === 'q' || marker === 'Q' || marker === 'b' || marker === 'B') &&
      text.charAt(charsetEnd + 2) === '?';
    if (!shaped) {
      from = open + 1;
      continue;
    }
    const close = text.indexOf('?=', charsetEnd + 3);
    if (close < 0) {
      break;
    }
    spans.push([open, close + 2]);
    from = close + 2;
  }
  return spans;
}

/** The mailbox and group layout of a parse, with each address and none of the names. */
function layoutOf(entries: ParsedAddress[]): string {
  return entries
    .map((entry) =>
      entry.group
        ? `g(${layoutOf(entry.group)})`
        : entry.address
          ? JSON.stringify(entry.address)
          : 'n'
    )
    .join(',');
}

/** True when `=?` or `?=` sits in an address, in a group name, or in a name with no address. */
function delimiterOutsideDisplayName(entries: ParsedAddress[]): boolean {
  const holdsDelimiter = (text: string | undefined) =>
    text !== undefined && (text.includes('=?') || text.includes('?='));
  return entries.some((entry) => {
    if (entry.group) {
      return holdsDelimiter(entry.name) || delimiterOutsideDisplayName(entry.group);
    }
    return holdsDelimiter(entry.address ? entry.address : entry.name);
  });
}

/**
 * True when the text holds encoded-word syntax anywhere but in a display
 * name: in an address, in a group name, or in a way that changes how the text
 * splits into mailboxes. Refused, never decoded. See
 * senderAuthorization.md#encoded-words.
 */
export function refusesEncodedWord(text: string): boolean {
  if (!text.includes('=?') && !text.includes('?=')) {
    return false;
  }
  // Each encoded word read as one opaque atom, the way a MIME reader splits it.
  let masked = '';
  let at = 0;
  for (const [start, end] of encodedWordSpans(text)) {
    masked += `${text.slice(at, start)}eword`;
    at = end;
  }
  masked += text.slice(at);
  try {
    const asWritten = addressparser(text);
    return (
      layoutOf(asWritten) !== layoutOf(addressparser(masked)) ||
      delimiterOutsideDisplayName(asWritten)
    );
  } catch {
    return true;
  }
}

/** The From header as it was written, unfolded: every From line of a parsed message, or undefined when it has none. See senderAuthorization.md#encoded-words. */
export function rawFromHeaderValue(
  headerLines: ReadonlyArray<{ key: string; line: string }>
): string | undefined {
  const values = headerLines
    .filter((header) => header.key === 'from')
    .map((header) =>
      header.line.slice(header.line.indexOf(':') + 1).replace(/\r?\n(?=[ \t])/g, '')
    );
  return values.length > 0 ? values.join(', ') : undefined;
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
  if (typeof headerValue === 'string' && refusesEncodedWord(headerValue)) {
    return false;
  }
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

/** A display name with any control character folded to a space and a trailing backslash or whitespace dropped, so it sits inside one quoted string. */
function cleanDisplayName(name: string): string {
  let cleaned = '';
  for (const char of name) {
    const code = char.charCodeAt(0);
    cleaned += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  // A backslash (or whitespace) at the very end is dropped: serialised it would sit
  // immediately before the closing quote as an escaped backslash, which older address
  // parsers read as an escaped quote. Scan-then-slice, not a trailing-anchored regex.
  let end = cleaned.length;
  while (end > 0 && (cleaned.charCodeAt(end - 1) === 0x5c || /\s/.test(cleaned.charAt(end - 1)))) {
    end--;
  }
  return cleaned.slice(0, end).trim();
}

/** True when the text holds whitespace (any the regular-expression engine counts) or a C0 or C1 control character. */
function holdsWhitespaceOrControl(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || /\s/.test(char)) {
      return true;
    }
  }
  return false;
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
 * See senderAuthorization.md#boundsender and #encoded-words.
 */
export function boundSender(
  headerValue: string | null | undefined,
  tenantDomain: string,
  rawHeaderValue?: string
): string | null {
  if (typeof headerValue === 'string' && refusesEncodedWord(headerValue)) {
    return null;
  }
  if (rawHeaderValue !== undefined && refusesEncodedWord(rawHeaderValue)) {
    return null;
  }
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
  // The local part is compared and queued as the parser read it, but the domain
  // is queued as the normal form that was compared (never the spelling that was
  // submitted: trailing dots, case, IDN mappings), and a local part holding
  // whitespace is refused (a long header line is folded at whitespace).
  const mailboxes: Mailbox[] = [];
  for (const mailbox of parsed) {
    const at = mailbox.address.lastIndexOf('@');
    const local = mailbox.address.slice(0, at);
    if (at < 0 || holdsWhitespaceOrControl(local)) {
      return null;
    }
    mailboxes.push({
      name: cleanDisplayName(mailbox.name),
      address: `${local}@${normalizedTenantDomain}`,
    });
  }
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
