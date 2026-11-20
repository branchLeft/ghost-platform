import { escapeHtml } from '../shell/html.js';

/**
 * What a prospect sees while their demo is being made and after: the
 * provisioning outcome's page. Structure and routing only: every word is an
 * ALL_CAPS placeholder for the owner's copy. The page is a pure function of
 * the demo's state, so a demo that has failed shows the failure and a demo
 * that is still being made shows progress that stops asking the moment the
 * state is terminal: there is no state in which the page waits for ever.
 *
 * The failure page carries a real address and the bookable call together,
 * never one without the other, and nothing of why it failed: no error, host,
 * slot or hostname detail reaches it.
 */

export interface ProspectContact {
  /** A real, monitored address a person can write to. */
  readonly address: string;
  /** The owner's own booking page. */
  readonly bookingUrl: string;
}

/** The contact configuration is not a usable address and booking link: the failure page would not be honest, so it is not built. */
export class ContactConfigError extends Error {
  constructor(readonly field: 'address' | 'bookingUrl') {
    super(`the prospect contact ${field} is missing or malformed`);
    this.name = 'ContactConfigError';
  }
}

const ADDRESS = /^[^@\s<>"']+@[^@\s<>"']+[.][^@\s<>"']+$/;

export function parseProspectContact(input: ProspectContact): ProspectContact {
  if (!ADDRESS.test(input.address)) throw new ContactConfigError('address');
  let url: URL;
  try {
    url = new URL(input.bookingUrl);
  } catch {
    throw new ContactConfigError('bookingUrl');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new ContactConfigError('bookingUrl');
  }
  return { address: input.address, bookingUrl: url.toString() };
}

export interface ProspectDemoPage {
  /** Already-escaped markup. */
  readonly body: string;
  /** Seconds until the page should ask again; null when the state is final and it must not. */
  readonly refreshSeconds: number | null;
}

/** How often a page that is still waiting asks again. */
export const PROGRESS_REFRESH_SECONDS = 5;

/** The states in which a demo is still being made. */
const IN_PROGRESS: readonly string[] = ['CLAIMED', 'PROVISIONING'];

/**
 * The page for a demo's provisioning outcome, or undefined for a state this
 * page does not speak to (the caller routes it elsewhere). `address` is the
 * demo's own hostname, shown only once it is LIVE.
 */
export function renderProvisioningPage(
  state: string,
  contact: ProspectContact,
  address: string | null
): ProspectDemoPage | undefined {
  if (state === 'FAILED')
    return { body: renderFailed(parseProspectContact(contact)), refreshSeconds: null };
  if (IN_PROGRESS.includes(state)) {
    return {
      body: '<h1>PROVISIONING_HEADING</h1><p>PROVISIONING_BODY</p>',
      refreshSeconds: PROGRESS_REFRESH_SECONDS,
    };
  }
  if (state === 'LIVE') {
    const where =
      address === null
        ? 'DEMO_NO_ADDRESS_YET'
        : `<a href="https://${escapeHtml(address)}/">${escapeHtml(address)}</a>`;
    return {
      body: `<h1>DEMO_READY_HEADING</h1><p>DEMO_READY_BODY</p><p>${where}</p>`,
      refreshSeconds: null,
    };
  }
  return undefined;
}

function renderFailed(contact: ProspectContact): string {
  return (
    '<h1>PROVISION_FAILED_HEADING</h1><p>PROVISION_FAILED_BODY</p>' +
    `<p>PROVISION_FAILED_ADDRESS_LABEL <a href="mailto:${escapeHtml(contact.address)}">` +
    `${escapeHtml(contact.address)}</a></p>` +
    `<p><a href="${escapeHtml(contact.bookingUrl)}">PROVISION_FAILED_BOOK_CALL_LABEL</a></p>`
  );
}
