import { domainToASCII } from 'node:url';
// nodemailer's own address parser: the parser that builds the header the SMTP
// clients send, so the address read here is the address that is sent. Its
// `exports` map serves this path; no published types, so declared below.
import addressparser from 'nodemailer/lib/addressparser/index.js';
import type { WireMessage } from './drainClient.js';
import type { HeaderFromFailureReason } from './sweegoFailure.js';

interface ParsedAddress {
  name?: string;
  address?: string;
  group?: ParsedAddress[];
}

declare module 'nodemailer/lib/addressparser/index.js' {
  export default function addressparser(input: string): ParsedAddress[];
}

/**
 * Why a message's header From was not accepted. Labels only: no address, name
 * or domain is ever part of one. `from-out-of-scope`: exactly one mailbox was
 * read and its domain is not the target's sending domain. `from-unreadable`:
 * the sender cannot be established (missing, unparseable, more than one
 * mailbox, a control character, or a competing identity header).
 * `from-scope-unknown`: the target has no sending domain to compare against.
 */
export type HeaderFromVerdict =
  { readonly ok: true } | { readonly ok: false; readonly reason: HeaderFromFailureReason };

const MAX_FROM_LENGTH = 998;

/**
 * Custom headers that name a sender other than the From header. The spool
 * never forwards Sender (it sends it as a field of its own), so one here was
 * not made by the spool. Matched case-insensitively.
 */
const COMPETING_IDENTITY_HEADERS: ReadonlySet<string> = new Set([
  'from',
  'sender',
  'return-path',
  'resent-from',
  'resent-sender',
]);

/**
 * ASCII/punycode, lowercase, trailing dots dropped; null for anything that is
 * not a plain hostname once converted. Trailing dots are cut by one scan and
 * one slice (no trailing-anchored quantifier on attacker-controlled text).
 */
function normalizeDomain(raw: string): string | null {
  let end = raw.length;
  while (end > 0 && raw.charCodeAt(end - 1) === 46 /* '.' */) {
    end--;
  }
  const trimmed = raw.slice(0, end);
  if (trimmed === '') {
    return null;
  }
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
  return ascii !== '' && /^[a-z0-9._-]+$/.test(ascii) ? ascii : null;
}

/** True when the text holds a C0 or C1 control character, or a space. */
function holdsControlOrSpace(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/** True when an encoded-word delimiter sits in the text once quoting is read away. */
function holdsEncodedWordDelimiter(text: string): boolean {
  const plain = text.replace(/\\([\s\S])/g, '$1').replace(/"/g, '');
  return plain.includes('=?') || plain.includes('?=');
}

/**
 * The single addr-spec the From value names, or null when it does not name
 * exactly one readable mailbox. Group syntax is refused, not flattened: the
 * header is sent as written and a group is read differently by different readers.
 */
function singleAddress(from: string): string | null {
  let parsed: ParsedAddress[];
  try {
    parsed = addressparser(from);
  } catch {
    return null;
  }
  if (parsed.length !== 1) {
    return null;
  }
  const only = parsed[0];
  if (only === undefined || only.group !== undefined) {
    return null;
  }
  const address = only.address;
  if (typeof address !== 'string' || address === '') {
    return null;
  }
  return address;
}

/** Whether `from` names exactly one mailbox, in the (already normalised) `scopeDomain`. */
function fromVerdict(from: unknown, scopeDomain: string): HeaderFromVerdict {
  if (typeof from !== 'string' || from.trim() === '' || from.length > MAX_FROM_LENGTH) {
    return { ok: false, reason: 'from-unreadable' };
  }
  // A line break would let a later line be read as the header: the parser
  // reads the second line of such a value, so it is refused before parsing.
  for (const char of from) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return { ok: false, reason: 'from-unreadable' };
    }
  }
  const address = singleAddress(from);
  if (address === null || holdsEncodedWordDelimiter(address)) {
    return { ok: false, reason: 'from-unreadable' };
  }
  const at = address.lastIndexOf('@');
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  // An '@' left in the local part, or a local part holding a space or control
  // character, is read differently by different parsers: refused.
  if (at <= 0 || local.includes('@') || holdsControlOrSpace(local)) {
    return { ok: false, reason: 'from-unreadable' };
  }
  const normalised = normalizeDomain(domain);
  if (normalised === null) {
    return { ok: false, reason: 'from-unreadable' };
  }
  return normalised === scopeDomain ? { ok: true } : { ok: false, reason: 'from-out-of-scope' };
}

/**
 * A header key folded the way nodemailer's _normalizeHeaderKey folds it: every
 * whitespace character, C0 control, DEL and colon is dropped from anywhere in
 * the key, then the key is lower-cased. Written as a character loop so that no
 * control character sits in a regular expression (no-control-regex).
 */
function foldHeaderKey(name: string): string {
  let folded = '';
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    const dropped = code <= 0x20 || code === 0x7f || char === ':' || /\s/.test(char);
    if (!dropped) {
      folded += char;
    }
  }
  return folded.toLowerCase();
}

/**
 * Whether a drained message may be submitted for a target whose sending domain
 * is `sendingDomain`: the header From names exactly one mailbox and its domain
 * is that domain exactly (case, trailing dot and internationalised spelling
 * aside; never a subdomain). Fails closed on everything else, including a
 * sending domain that is missing or is not a hostname.
 * See ../README.md#header-from-scope.
 */
export function checkHeaderFrom(
  message: Pick<WireMessage, 'from' | 'headers'>,
  sendingDomain: string | undefined
): HeaderFromVerdict {
  const scope = sendingDomain === undefined ? null : normalizeDomain(sendingDomain);
  if (scope === null) {
    return { ok: false, reason: 'from-scope-unknown' };
  }
  for (const name of Object.keys(message.headers ?? {})) {
    // Stripped and case-folded the way nodemailer's _normalizeHeaderKey folds a key:
    // it removes whitespace, C0 controls, DEL and colons anywhere in the key, then
    // lower-cases it. Any spelling that reaches the wire as a competing name is refused.
    if (COMPETING_IDENTITY_HEADERS.has(foldHeaderKey(name))) {
      return { ok: false, reason: 'from-unreadable' };
    }
  }
  return fromVerdict(message.from, scope);
}
