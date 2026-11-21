import type { demoExtensionRequest } from './schema.js';
import {
  CURATED_AUDIENCE_SIZES,
  CURATED_MOVE_WHEN,
  isListed,
  type CuratedChoice,
} from './curatedLists.js';
import { SLUG_PATTERN, WORDING_MAX } from './demoRequest.js';

/**
 * The prospect's request to extend a running demo: what they are still
 * evaluating, what is missing, how large their audience is, whether they
 * charge readers, when they would move, and their consent to be contacted
 * about it, with the wording they were shown and the database's own time.
 * The shapes the `demo_extension_request` table enforces are held once here,
 * so the table's checks and the code's parsing cannot drift apart.
 *
 * Consent is not a flag that could be left false: a request that carries no
 * consent is refused before a statement is spent, and the table refuses a row
 * with no wording, so the consent and the request are one record or neither
 * exists.
 */
export const EVALUATING_MAX = 500;
export const MISSING_MAX = 500;
export { SLUG_PATTERN, WORDING_MAX };

/** What a prospect submits with the extension form, after the identity service has verified them. */
export interface DemoExtensionInput {
  /** What they are still evaluating. */
  stillEvaluating: string;
  /** What is missing for them; absent when nothing is. */
  whatIsMissing?: string | undefined;
  /** A slug from the curated audience-size list. */
  audienceSize: string;
  chargesReaders: boolean;
  /** A slug from the curated when-would-you-move list. */
  moveWhen: string;
  /** The consent given: must be exactly `true`; anything else is refused. */
  consent: boolean;
  /** The consent wording exactly as it was shown; the server's, never the browser's. */
  consentWording: string;
}

/** The recorded request, as the lifecycle worker and the owner side read it. */
export interface DemoExtensionView {
  demoId: string;
  stillEvaluating: string;
  whatIsMissing: string | null;
  audienceSize: string;
  chargesReaders: boolean;
  moveWhen: string;
  consentWording: string;
  consentedAt: Date;
}

export function deriveExtensionView(
  row: typeof demoExtensionRequest.$inferSelect
): DemoExtensionView {
  return {
    demoId: row.demoId,
    stillEvaluating: row.stillEvaluating,
    whatIsMissing: row.whatIsMissing,
    audienceSize: row.audienceSize,
    chargesReaders: row.chargesReaders,
    moveWhen: row.moveWhen,
    consentWording: row.consentWording,
    consentedAt: row.consentedAt,
  };
}

/** A request the table would refuse, caught first. The message names the field and never the value. */
export class InvalidDemoExtensionError extends Error {
  constructor(readonly field: string) {
    super(`demo extension request: ${field} is missing or malformed`);
    this.name = 'InvalidDemoExtensionError';
  }
}

/** The demo already has an extension request: one per demo, enforced by the table. */
export class DemoExtensionExistsError extends Error {
  constructor() {
    super('an extension request already exists for this demo');
    this.name = 'DemoExtensionExistsError';
  }
}

/** The verified address has no demo request, so there is no demo to extend. */
export class NoDemoToExtendError extends Error {
  constructor() {
    super('no demo request is recorded for this verified address');
    this.name = 'NoDemoToExtendError';
  }
}

/** The row the table takes, with every optional field resolved to a value or null. */
export type NewDemoExtension = Omit<
  typeof demoExtensionRequest.$inferInsert,
  'demoId' | 'consentedAt'
>;

function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** A block of free text: kept as typed, no control character other than a line break or a tab. */
function block(field: string, value: unknown, max: number, required: boolean): string | null {
  if (value === undefined || value === null) {
    if (required) throw new InvalidDemoExtensionError(field);
    return null;
  }
  if (typeof value !== 'string') throw new InvalidDemoExtensionError(field);
  if (value.length < 1 || [...value].length > max || hasControl(value)) {
    throw new InvalidDemoExtensionError(field);
  }
  return value;
}

const SLUG = new RegExp(SLUG_PATTERN);

function listed(field: string, value: unknown, list: readonly CuratedChoice[]): string {
  const shaped = typeof value === 'string' && SLUG.test(value);
  if (!shaped || !isListed(list, value)) throw new InvalidDemoExtensionError(field);
  return value;
}

/**
 * Parses a submission into the row the table takes, or refuses it naming the
 * first field at fault. Consent is checked first: a request with no consent is
 * refused whatever else it holds, and nothing past this point runs.
 */
export function parseDemoExtension(input: DemoExtensionInput): NewDemoExtension {
  if (input.consent !== true) throw new InvalidDemoExtensionError('consent');
  const wording = block('consentWording', input.consentWording, WORDING_MAX, true)!;
  if (typeof input.chargesReaders !== 'boolean') {
    throw new InvalidDemoExtensionError('chargesReaders');
  }
  return {
    stillEvaluating: block('stillEvaluating', input.stillEvaluating, EVALUATING_MAX, true)!,
    whatIsMissing: block('whatIsMissing', input.whatIsMissing, MISSING_MAX, false),
    audienceSize: listed('audienceSize', input.audienceSize, CURATED_AUDIENCE_SIZES),
    chargesReaders: input.chargesReaders,
    moveWhen: listed('moveWhen', input.moveWhen, CURATED_MOVE_WHEN),
    consentWording: wording,
  };
}
