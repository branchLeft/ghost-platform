import { randomBytes } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { LABEL_ALPHABET, LABEL_LETTER_MASK } from './demoStates.js';

/**
 * A custom domain's stored form: lower-case ASCII (an internationalised name
 * arrives as punycode), two or more labels, each 1-63 characters of letters,
 * digits and inner hyphens, the last starting with a letter so an address
 * literal is never a name. No wildcard, port, path or trailing dot. The same
 * shape is a database check, so a statement that skips the code is refused.
 */
export const CUSTOM_DOMAIN_FQDN_PATTERN =
  '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$';

/** The longest name DNS allows, in the presentation form without a trailing dot. */
export const CUSTOM_DOMAIN_MAX_LENGTH = 253;

/** The one-time token: 32 characters of lower-case base32, 160 bits. Also a database check. */
export const VERIFICATION_TOKEN_PATTERN = '^[a-z2-7]{32}$';
export const VERIFICATION_TOKEN_LENGTH = 32;

const FQDN = new RegExp(CUSTOM_DOMAIN_FQDN_PATTERN);

/** Letters and digits in any script, hyphens and dots: nothing a URL parser would read as syntax. */
const PLAIN_CHARACTERS = /^[\p{L}\p{N}.-]+$/u;

/** The label a tenant adds in front of its domain to hold the verification record. */
export const VERIFICATION_LABEL = '_publicpress-verify';

/** The name the verification TXT record is set at. */
export function verificationRecordName(fqdn: string): string {
  return `${VERIFICATION_LABEL}.${fqdn}`;
}

/** The value the verification TXT record must hold. */
export function verificationRecordValue(token: string): string {
  return `publicpress-verify=${token}`;
}

/** The text is not a domain name this service accepts. It is not echoed: a domain is a customer's. */
export class InvalidCustomDomainError extends Error {
  constructor() {
    super('that is not a domain name a site can be connected to');
    this.name = 'InvalidCustomDomainError';
  }
}

/** The domain is one the platform owns, or a name under one: a custom domain is outside them all. */
export class CustomDomainOwnedError extends Error {
  constructor() {
    super('that domain belongs to the platform and cannot be connected');
    this.name = 'CustomDomainOwnedError';
  }
}

/**
 * The stored form of a custom domain: trimmed, lower-cased, an internationalised
 * name turned to punycode, one trailing dot dropped. Anything that is not then a
 * plain domain name is refused, never repaired: a URL, a wildcard, an address, a
 * name with a port or a path.
 */
export function normaliseCustomDomain(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidCustomDomainError();
  let text = value.trim().toLowerCase();
  if (text.endsWith('.')) text = text.slice(0, -1);
  if (text === '' || text.length > CUSTOM_DOMAIN_MAX_LENGTH * 4)
    throw new InvalidCustomDomainError();
  // The URL parser behind `domainToASCII` stops at a slash, query or fragment and
  // drops tabs and newlines, so a name is checked for its plain characters first.
  if (!PLAIN_CHARACTERS.test(text)) throw new InvalidCustomDomainError();
  const ascii = domainToASCII(text);
  if (ascii === '' || ascii.length > CUSTOM_DOMAIN_MAX_LENGTH || !FQDN.test(ascii)) {
    throw new InvalidCustomDomainError();
  }
  return ascii;
}

/**
 * Refuses a domain that is, or is under, any domain the platform owns. The
 * owned list is the edge's own (`OWNED_DOMAINS`), so a tenant cannot be handed a
 * name the platform serves for itself.
 *
 * @throws CustomDomainOwnedError
 */
export function assertOutsideOwnedDomains(fqdn: string, ownedDomains: readonly string[]): void {
  for (const owned of ownedDomains) {
    const own = owned.trim().toLowerCase().replace(/[.]$/, '');
    if (own !== '' && (fqdn === own || fqdn.endsWith(`.${own}`))) {
      throw new CustomDomainOwnedError();
    }
  }
}

/**
 * A new one-time verification token from the operating system's random source.
 * `random` is the seam for a test. It takes nothing from the tenant or the domain.
 */
export function newVerificationToken(random: (size: number) => Uint8Array = randomBytes): string {
  const bytes = random(VERIFICATION_TOKEN_LENGTH);
  let token = '';
  for (const byte of bytes) token += LABEL_ALPHABET.charAt(byte & LABEL_LETTER_MASK);
  return token;
}

/** A requested domain, not yet proven: the record the tenant is asked to set. Nothing is served. */
export interface PendingDomainView {
  state: 'pending';
  fqdn: string;
  /** The one-time token the verification record carries. */
  verificationToken: string;
  /** Where to set the verification record. */
  recordName: string;
  /** What the verification record must hold. */
  recordValue: string;
  requestedAt: Date;
}

/** A domain that was checked and connected: the edge may serve it. */
export interface ConnectedDomainView {
  state: 'connected';
  fqdn: string;
  connectedAt: Date;
}

/** A tenant's custom domain as the portal shows it. */
export type CustomDomainView = PendingDomainView | ConnectedDomainView;

/** Only a real tenant has a custom domain; a demo slot never does. */
export class CustomDomainNotAllowedError extends Error {
  constructor() {
    super('this tenant cannot connect a custom domain');
    this.name = 'CustomDomainNotAllowedError';
  }
}

/** No request for this domain was made by this tenant, or its token is not the proof's. */
export class CustomDomainNotRequestedError extends Error {
  constructor() {
    super('that domain was not requested by this tenant');
    this.name = 'CustomDomainNotRequestedError';
  }
}

/** The domain is already connected to another tenant. It carries no name and no tenant. */
export class CustomDomainTakenError extends Error {
  constructor() {
    super('that domain is already connected');
    this.name = 'CustomDomainTakenError';
  }
}
