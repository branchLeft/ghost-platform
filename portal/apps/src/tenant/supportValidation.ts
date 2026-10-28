import { SupportTicketError } from './supportTicketError.js';

/** The longest address the mail standards allow. */
export const MAX_CONTACT_LENGTH = 254;

/**
 * The shell refuses a form body over 4096 bytes. Written form-encoded, one
 * ASCII character takes at most three bytes, so 1000 characters of message
 * plus the longest contact address and the field names stay under that limit.
 * Text outside ASCII takes more and is refused by the shell before it gets here.
 */
export const MAX_MESSAGE_CHARACTERS = 1000;

// CR and LF end a header line; NUL truncates one; U+0085, U+2028 and U+2029 are
// line ends to some mail software and Unicode-aware parsers.
const LINE_BREAK_OR_NUL = /[\r\n\0\u0085\u2028\u2029]/;
const NOT_IN_AN_ADDRESS = /[\s,;<>"\\]/;

/**
 * A single plausible address: one `@`, a local part and a domain, no
 * whitespace, no list separators, no angle brackets. Line breaks and NUL are
 * checked on the raw value, so trimming cannot hide a trailing CRLF.
 *
 * @throws {SupportTicketError} INVALID_CONTACT for anything else.
 */
export function validateContact(raw: string): string {
  if (LINE_BREAK_OR_NUL.test(raw)) throw new SupportTicketError('INVALID_CONTACT');
  const contact = raw.trim();
  const [local, domain, ...rest] = contact.split('@');
  const plausible =
    contact.length > 0 &&
    contact.length <= MAX_CONTACT_LENGTH &&
    rest.length === 0 &&
    local !== undefined &&
    local !== '' &&
    domain !== undefined &&
    domain !== '' &&
    !NOT_IN_AN_ADDRESS.test(contact);
  if (!plausible) throw new SupportTicketError('INVALID_CONTACT');
  return contact;
}

/**
 * The trimmed message, bounded and not empty. Line breaks stay: it goes in
 * the body, never a header.
 *
 * @throws {SupportTicketError} EMPTY_MESSAGE, MESSAGE_TOO_LONG or INVALID_MESSAGE (a NUL).
 */
export function validateMessage(raw: string): string {
  if (raw.includes('\0')) throw new SupportTicketError('INVALID_MESSAGE');
  const message = raw.trim();
  if (message === '') throw new SupportTicketError('EMPTY_MESSAGE');
  if (message.length > MAX_MESSAGE_CHARACTERS) throw new SupportTicketError('MESSAGE_TOO_LONG');
  return message;
}

/**
 * A mail header value must be one non-empty line.
 *
 * @throws {SupportTicketError} INVALID_HEADER_VALUE for an empty value, a line break or a NUL.
 */
export function assertHeaderValue(value: string): void {
  if (value === '' || LINE_BREAK_OR_NUL.test(value)) {
    throw new SupportTicketError('INVALID_HEADER_VALUE');
  }
}
