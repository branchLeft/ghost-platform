import { escapeHtml } from '../shell/html.js';

/**
 * What a prospect sees while their demo is being made and after: the
 * provisioning outcome's page. Structure and routing only: every word is an
 * ALL_CAPS placeholder for the owner's copy. The page is a pure function of
 * the demo's state and of the content position the prospect has asked for,
 * so a demo that has failed shows the failure and a demo that is still being
 * made shows progress that stops asking the moment the state is terminal:
 * there is no state in which the page waits for ever.
 *
 * Progress and content are independent. The content position moves only when
 * the prospect asks for the next panel; a provision that finishes at once does
 * not move it. The completion screen restates the expectations whatever the
 * position is.
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
 * The named, non-technical steps a prospect sees, in order. Each is an
 * ALL_CAPS placeholder. Index 0 is the step a CLAIMED demo is on; index 1 is
 * the step a PROVISIONING demo is on. Once LIVE, every step is done.
 */
export const PROGRESS_STEPS: readonly string[] = [
  'STEP_RECEIVED_LABEL',
  'STEP_MAKING_LABEL',
  'STEP_CHECKING_LABEL',
];

/**
 * The content panels a prospect pages through at their own pace. Each is an
 * ALL_CAPS placeholder: a heading and body pair per panel. The count is fixed
 * by this list.
 */
export const CONTENT_PANELS: readonly { readonly heading: string; readonly body: string }[] = [
  { heading: 'PANEL_ONE_HEADING', body: 'PANEL_ONE_BODY' },
  { heading: 'PANEL_TWO_HEADING', body: 'PANEL_TWO_BODY' },
  { heading: 'PANEL_THREE_HEADING', body: 'PANEL_THREE_BODY' },
];

/**
 * The expectations restated on the completion screen, whatever the content
 * position is. Each is an ALL_CAPS placeholder.
 */
export const RESTATED_EXPECTATIONS: readonly string[] = [
  'EXPECTATION_MAIL_SPAM',
  'EXPECTATION_PASSPHRASE_GATED',
  'EXPECTATION_DEMO_ISOLATED',
];

/**
 * Clamps a requested content position into the panel range. Anything that is
 * not a whole number from zero to the last panel is the first panel, so a
 * malformed position never leaves the prospect on an empty screen.
 */
export function clampPanel(requested: number): number {
  if (!Number.isInteger(requested) || requested < 0) return 0;
  return Math.min(requested, CONTENT_PANELS.length - 1);
}

/**
 * The page for a demo's provisioning outcome, or undefined for a state this
 * page does not speak to (the caller routes it elsewhere). `address` is the
 * demo's own hostname, shown only once it is LIVE. `panel` is the content
 * position the prospect asked for; it is clamped, and no state changes it.
 */
export function renderProvisioningPage(
  state: string,
  contact: ProspectContact,
  address: string | null,
  panel = 0
): ProspectDemoPage | undefined {
  if (state === 'FAILED')
    return { body: renderFailed(parseProspectContact(contact)), refreshSeconds: null };
  if (IN_PROGRESS.includes(state)) {
    const active = state === 'CLAIMED' ? 0 : 1;
    return {
      body: renderInProgress(active, clampPanel(panel)),
      refreshSeconds: PROGRESS_REFRESH_SECONDS,
    };
  }
  if (state === 'LIVE') {
    const where =
      address === null
        ? 'DEMO_NO_ADDRESS_YET'
        : `<a href="https://${escapeHtml(address)}/">${escapeHtml(address)}</a>`;
    const restated = RESTATED_EXPECTATIONS.map((text) => `<li>${text}</li>`).join('');
    return {
      body:
        `<h1>DEMO_READY_HEADING</h1><p>DEMO_READY_BODY</p><p>${where}</p>` +
        `<h2>EXPECTATIONS_HEADING</h2><ul>${restated}</ul>`,
      refreshSeconds: null,
    };
  }
  return undefined;
}

function renderInProgress(activeStep: number, position: number): string {
  const steps = PROGRESS_STEPS.map((label, index) => {
    const mark = index < activeStep ? 'DONE' : index === activeStep ? 'ACTIVE' : 'TODO';
    return `<li data-step="${mark}">${label}</li>`;
  }).join('');
  const panel = CONTENT_PANELS[position]!;
  const isLast = position === CONTENT_PANELS.length - 1;
  // A next link only when there is a next panel. The refresh of this page
  // keeps the same position, because the position is in the URL.
  const next = isLast ? '' : `<p><a href="?panel=${position + 1}">NEXT_PANEL_LABEL</a></p>`;
  return (
    '<h1>PROVISIONING_HEADING</h1><p>PROVISIONING_BODY</p>' +
    `<ol>${steps}</ol>` +
    `<h2>${panel.heading}</h2><p>${panel.body}</p>` +
    next
  );
}

function renderFailed(contact: ProspectContact): string {
  return (
    '<h1>PROVISION_FAILED_HEADING</h1><p>PROVISION_FAILED_BODY</p>' +
    `<p>PROVISION_FAILED_ADDRESS_LABEL <a href="mailto:${escapeHtml(contact.address)}">` +
    `${escapeHtml(contact.address)}</a></p>` +
    `<p><a href="${escapeHtml(contact.bookingUrl)}">PROVISION_FAILED_BOOK_CALL_LABEL</a></p>`
  );
}
