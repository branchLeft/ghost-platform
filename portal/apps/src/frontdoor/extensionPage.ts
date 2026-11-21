import { escapeHtml } from '../shell/html.js';
import { parseProspectContact, type ProspectContact } from './provisionPage.js';

/**
 * The demo extension request form: moment 2 of the prospect's path. Structure
 * and routing only: every word is an ALL_CAPS placeholder for the owner's
 * copy, and the consent wording above all is the owner's.
 *
 * The form asks what the prospect is still evaluating, what is missing, how
 * large their audience is, whether they charge readers and when they would
 * move, then asks for consent to be contacted. The page offers a bookable call
 * and the contact address beside it, never one without the other: the offer is
 * a prompt to talk about a real instance.
 */

/**
 * The consent wording as it is shown, and as it is stored with the request.
 * It is the server's constant and never a browser field, so what is recorded
 * is what was shown. A PLACEHOLDER until the owner authorises the wording.
 */
export const EXTENSION_CONSENT_WORDING = 'EXTENSION_CONSENT_WORDING';

/** The form's field names. */
export const FIELDS = {
  stillEvaluating: 'still_evaluating',
  whatIsMissing: 'what_is_missing',
  audienceSize: 'audience_size',
  chargesReaders: 'charges_readers',
  moveWhen: 'move_when',
  consent: 'consent',
} as const;

/** One choice of a list: a slug the record holds and an ALL_CAPS placeholder label. */
export interface Choice {
  readonly slug: string;
  readonly label: string;
}

/** What the form offers; the page and the record must agree on the slugs. */
export interface ExtensionChoices {
  readonly audienceSizes: readonly Choice[];
  readonly moveWhen: readonly Choice[];
}

/** The answers read from a posted form, in the shape the data layer takes. */
export interface ExtensionAnswers {
  readonly stillEvaluating: string;
  readonly whatIsMissing: string | undefined;
  readonly audienceSize: string;
  readonly chargesReaders: boolean;
  readonly moveWhen: string;
  readonly consent: boolean;
}

export type ExtensionFormResult =
  | { readonly ok: true; readonly answers: ExtensionAnswers }
  | { readonly ok: false; readonly field: keyof typeof FIELDS };

type Posted = Readonly<Record<string, string | undefined>>;

/**
 * Reads a posted form. Consent is looked at first, and only the value `yes`
 * is consent: a missing box, an empty one or any other value is not, and the
 * result names `consent` whatever else is wrong with the form.
 */
export function parseExtensionForm(posted: Posted): ExtensionFormResult {
  if (posted[FIELDS.consent] !== 'yes') return { ok: false, field: 'consent' };
  const charges = posted[FIELDS.chargesReaders];
  if (charges !== 'yes' && charges !== 'no') return { ok: false, field: 'chargesReaders' };
  const evaluating = posted[FIELDS.stillEvaluating];
  if (evaluating === undefined || evaluating.trim() === '') {
    return { ok: false, field: 'stillEvaluating' };
  }
  const missing = posted[FIELDS.whatIsMissing];
  return {
    ok: true,
    answers: {
      stillEvaluating: evaluating,
      whatIsMissing: missing === undefined || missing.trim() === '' ? undefined : missing,
      audienceSize: posted[FIELDS.audienceSize] ?? '',
      chargesReaders: charges === 'yes',
      moveWhen: posted[FIELDS.moveWhen] ?? '',
      consent: true,
    },
  };
}

function options(choices: readonly Choice[]): string {
  return choices
    .map(
      (choice) => `<option value="${escapeHtml(choice.slug)}">${escapeHtml(choice.label)}</option>`
    )
    .join('');
}

/** The contact block: the bookable call and the address together. */
export function renderContactBlock(contact: ProspectContact): string {
  const checked = parseProspectContact(contact);
  return (
    `<p>EXTENSION_BOOK_CALL_PROMPT <a href="${escapeHtml(checked.bookingUrl)}">` +
    'EXTENSION_BOOK_CALL_LABEL</a></p>' +
    `<p>EXTENSION_ADDRESS_LABEL <a href="mailto:${escapeHtml(checked.address)}">` +
    `${escapeHtml(checked.address)}</a></p>`
  );
}

/**
 * The extension request form. `refused` names a field the last submission was
 * refused for; the page says so with a placeholder and shows no value back.
 */
export function renderExtensionForm(
  contact: ProspectContact,
  choices: ExtensionChoices,
  refused?: keyof typeof FIELDS
): string {
  const refusal =
    refused === undefined
      ? ''
      : refused === 'consent'
        ? '<p role="alert">EXTENSION_CONSENT_REQUIRED_MESSAGE</p>'
        : '<p role="alert">EXTENSION_FIELD_REFUSED_MESSAGE</p>';
  return (
    '<h1>EXTENSION_HEADING</h1><p>EXTENSION_BODY</p>' +
    refusal +
    '<form method="post" action="/extension">' +
    `<label>EXTENSION_EVALUATING_LABEL <textarea name="${FIELDS.stillEvaluating}" required maxlength="500"></textarea></label>` +
    `<label>EXTENSION_MISSING_LABEL <textarea name="${FIELDS.whatIsMissing}" maxlength="500"></textarea></label>` +
    `<label>EXTENSION_AUDIENCE_LABEL <select name="${FIELDS.audienceSize}" required>${options(choices.audienceSizes)}</select></label>` +
    `<fieldset><legend>EXTENSION_CHARGES_LABEL</legend>` +
    `<label><input type="radio" name="${FIELDS.chargesReaders}" value="yes" required> EXTENSION_CHARGES_YES_LABEL</label>` +
    `<label><input type="radio" name="${FIELDS.chargesReaders}" value="no"> EXTENSION_CHARGES_NO_LABEL</label></fieldset>` +
    `<label>EXTENSION_MOVE_LABEL <select name="${FIELDS.moveWhen}" required>${options(choices.moveWhen)}</select></label>` +
    `<label><input type="checkbox" name="${FIELDS.consent}" value="yes"> ${escapeHtml(EXTENSION_CONSENT_WORDING)}</label>` +
    '<button type="submit">EXTENSION_SUBMIT_LABEL</button></form>' +
    renderContactBlock(contact)
  );
}

/** The page after an extension was granted. */
export function renderExtensionGranted(contact: ProspectContact): string {
  return (
    '<h1>EXTENSION_GRANTED_HEADING</h1><p>EXTENSION_GRANTED_BODY</p>' + renderContactBlock(contact)
  );
}

/** The page when the request is recorded and no extension was given (spent, or the demo is not running). */
export function renderExtensionNotGiven(contact: ProspectContact): string {
  return (
    '<h1>EXTENSION_NOT_GIVEN_HEADING</h1><p>EXTENSION_NOT_GIVEN_BODY</p>' +
    renderContactBlock(contact)
  );
}

/** The page when this demo already has an extension request. */
export function renderExtensionAlreadyAsked(contact: ProspectContact): string {
  return (
    '<h1>EXTENSION_ALREADY_HEADING</h1><p>EXTENSION_ALREADY_BODY</p>' + renderContactBlock(contact)
  );
}

/** The page when the signed-in address has no demo to extend. */
export function renderNoDemo(contact: ProspectContact): string {
  return (
    '<h1>EXTENSION_NO_DEMO_HEADING</h1><p>EXTENSION_NO_DEMO_BODY</p>' + renderContactBlock(contact)
  );
}
