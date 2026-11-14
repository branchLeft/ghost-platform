import type { demoRequest } from './schema.js';
import {
  CURATED_FONTS,
  CURATED_OUTLET_TYPES,
  CURATED_THEMES,
  isListed,
  type CuratedChoice,
} from './curatedLists.js';

/**
 * The shapes the `demo_request` table enforces, held once so the table's
 * checks and the code's parsing cannot drift apart. A pattern here is a
 * PostgreSQL regular expression and a JavaScript one at the same time, so it
 * uses only syntax both read the same way.
 */
export const ADDRESS_PATTERN = '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$';
export const ADDRESS_MAX = 254;
export const SUBJECT_MAX = 255;
export const NAME_MAX = 100;
export const DESCRIPTION_MAX = 500;
export const IMPORT_SOURCE_MAX = 100;
export const WORDING_MAX = 2000;
/** A choice from a curated list is held as its slug; the list itself is the application's. */
export const SLUG_PATTERN = '^[a-z0-9-]{1,40}$';
export const COLOUR_PATTERN = '^#[0-9a-f]{6}$';
/** A 256-bit hash, lower-case hexadecimal: the form the safety service is asked about. */
export const LOGO_HASH_PATTERN = '^[0-9a-f]{64}$';

const ADDRESS = /^[^@\s]+@[^@\s]+[.][^@\s]+$/;
const SLUG = /^[a-z0-9-]{1,40}$/;
const COLOUR = /^#[0-9a-f]{6}$/;
const LOGO_HASH = /^[0-9a-f]{64}$/;

/** What a prospect submits at the front door, after the identity service has verified them. */
export interface DemoRequestInput {
  /** The identity service's subject for the signed-in prospect. */
  verifiedSubject: string;
  /** The address the identity service verified. Stored lower-case. */
  verifiedAddress: string;
  publicationName: string;
  description?: string | undefined;
  accentColour?: string | undefined;
  theme?: string | undefined;
  font?: string | undefined;
  newToGhost: boolean;
  /** Where the prospect is importing from; absent when nothing is. */
  importSource?: string | undefined;
  outletType: string;
  /** The hash of a logo the safety service has passed; absent when there is none. */
  logoHash?: string | undefined;
  /** The consent wording exactly as it was shown. */
  consentWording: string;
  /** The sign-in limitation explainer exactly as it was shown. */
  explainerWording: string;
}

/** The recorded request, as the owner side reads it. */
export interface DemoRequestView {
  demoId: string;
  verifiedSubject: string;
  verifiedAddress: string;
  publicationName: string;
  description: string | null;
  accentColour: string | null;
  theme: string | null;
  font: string | null;
  newToGhost: boolean;
  importSource: string | null;
  outletType: string;
  logoHash: string | null;
  consentWording: string;
  explainerWording: string;
  submittedAt: Date;
}

export function deriveRequestView(row: typeof demoRequest.$inferSelect): DemoRequestView {
  return {
    demoId: row.demoId,
    verifiedSubject: row.verifiedSubject,
    verifiedAddress: row.verifiedAddress,
    publicationName: row.publicationName,
    description: row.description,
    accentColour: row.accentColour,
    theme: row.theme,
    font: row.font,
    newToGhost: row.newToGhost,
    importSource: row.importSource,
    outletType: row.outletType,
    logoHash: row.logoHash,
    consentWording: row.consentWording,
    explainerWording: row.explainerWording,
    submittedAt: row.submittedAt,
  };
}

/** A request the table would refuse, caught first. The message names the field and never the value. */
export class InvalidDemoRequestError extends Error {
  constructor(readonly field: string) {
    super(`demo request: ${field} is missing or malformed`);
    this.name = 'InvalidDemoRequestError';
  }
}

/** The address already has a request: one request per verified address, enforced by the table. */
export class DemoRequestExistsError extends Error {
  constructor() {
    super('a demo request already exists for this verified address');
    this.name = 'DemoRequestExistsError';
  }
}

/** The demo id is already taken by another request. */
export class DemoRequestIdTakenError extends Error {
  constructor() {
    super('a demo request already exists under this demo id');
    this.name = 'DemoRequestIdTakenError';
  }
}

/** The row the table takes, with every optional field resolved to a value or null. */
export type NewDemoRequest = Omit<typeof demoRequest.$inferInsert, 'demoId' | 'submittedAt'>;

/** A control character is never wanted; a block of text may also hold line breaks and tabs. */
function hasControl(value: string, block: boolean): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (block && (code === 9 || code === 10 || code === 13)) continue;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function text(
  field: string,
  value: unknown,
  max: number,
  required: boolean,
  block = false
): string | null {
  if (value === undefined || value === null) {
    if (required) throw new InvalidDemoRequestError(field);
    return null;
  }
  if (typeof value !== 'string') throw new InvalidDemoRequestError(field);
  if (value.length < 1 || [...value].length > max || hasControl(value, block)) {
    throw new InvalidDemoRequestError(field);
  }
  // A single-line field carries no surrounding space; a block is kept as it was shown.
  if (!block && value !== value.trim()) throw new InvalidDemoRequestError(field);
  return value;
}

function shaped(field: string, value: unknown, pattern: RegExp, required: boolean): string | null {
  const found = text(field, value, 255, required);
  if (found !== null && !pattern.test(found)) throw new InvalidDemoRequestError(field);
  return found;
}

/** A slug from a curated list: the right shape and a member of that list, nothing else. */
function listed(
  field: string,
  value: unknown,
  list: readonly CuratedChoice[],
  required: boolean
): string | null {
  const found = shaped(field, value, SLUG, required);
  if (found !== null && !isListed(list, found)) throw new InvalidDemoRequestError(field);
  return found;
}

/**
 * Parses a submission into the row the table takes, or refuses it naming the
 * first field at fault. The table repeats every rule as a check, so a caller
 * that skips this is refused by the database; this gives the application a
 * typed error before a statement is spent.
 */
export function parseDemoRequest(input: DemoRequestInput): NewDemoRequest {
  const address = text('verifiedAddress', input.verifiedAddress, ADDRESS_MAX, true)!;
  if (address !== address.toLowerCase() || !ADDRESS.test(address)) {
    throw new InvalidDemoRequestError('verifiedAddress');
  }
  if (typeof input.newToGhost !== 'boolean') throw new InvalidDemoRequestError('newToGhost');
  const consent = text('consentWording', input.consentWording, WORDING_MAX, true, true)!;
  const explainer = text('explainerWording', input.explainerWording, WORDING_MAX, true, true)!;
  return {
    verifiedSubject: text('verifiedSubject', input.verifiedSubject, SUBJECT_MAX, true)!,
    verifiedAddress: address,
    publicationName: text('publicationName', input.publicationName, NAME_MAX, true)!,
    description: text('description', input.description, DESCRIPTION_MAX, false),
    accentColour: shaped('accentColour', input.accentColour, COLOUR, false),
    theme: listed('theme', input.theme, CURATED_THEMES, false),
    font: listed('font', input.font, CURATED_FONTS, false),
    newToGhost: input.newToGhost,
    importSource: text('importSource', input.importSource, IMPORT_SOURCE_MAX, false),
    outletType: listed('outletType', input.outletType, CURATED_OUTLET_TYPES, true)!,
    logoHash: shaped('logoHash', input.logoHash, LOGO_HASH, false),
    consentWording: consent,
    explainerWording: explainer,
  };
}
