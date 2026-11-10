import { escapeHtml } from './html.js';

/** The reading the tenant page shows; the storage layer's own view satisfies it. */
export interface SupportAccessShown {
  readonly state: string;
  readonly deadline: Date | null;
}

/** A request the tenant has made; the storage layer's own view satisfies it. */
export interface SupportRequestShown {
  readonly requestedAt: Date;
  readonly status: string;
}

const time = (value: Date): string =>
  `<time datetime="${value.toISOString()}">${value.toISOString()}</time>`;

/**
 * The words for a state. Anything that is not exactly `open` or `closed` is
 * `unknown`: there is no path from a state the page does not recognise to the
 * word `closed`. The words are placeholders; the owner supplies the copy.
 */
function stateLabel(state: string): string {
  if (state === 'open') return 'SUPPORT_ACCESS_STATE_OPEN';
  if (state === 'closed') return 'SUPPORT_ACCESS_STATE_CLOSED';
  return 'SUPPORT_ACCESS_STATE_UNKNOWN';
}

/**
 * The words for a request's status. Anything that is not exactly `open` or
 * `dealt_with` is `unknown`, so no unrecognised value reads as dealt with.
 */
function statusLabel(status: string): string {
  if (status === 'open') return 'SUPPORT_REQUEST_STATUS_OPEN';
  if (status === 'dealt_with') return 'SUPPORT_REQUEST_STATUS_DEALT_WITH';
  return 'SUPPORT_REQUEST_STATUS_UNKNOWN';
}

/**
 * The tenant's support-access page: the state, the deadline while it is open,
 * the two placeholder lines saying who closes access and how the tenant stops
 * it at once, and either the one button that asks or the status word of the
 * request already made, with no time. The button posts nothing: it carries no
 * field, so no text and no tenant id can travel with it.
 */
export function renderSupportAccess(
  access: SupportAccessShown,
  request: SupportRequestShown | null
): string {
  const label = stateLabel(access.state);
  const deadline =
    label !== 'SUPPORT_ACCESS_STATE_OPEN'
      ? ''
      : access.deadline === null
        ? '<dt>SUPPORT_ACCESS_DEADLINE</dt><dd>SUPPORT_ACCESS_DEADLINE_UNKNOWN</dd>'
        : `<dt>SUPPORT_ACCESS_DEADLINE</dt><dd>${time(access.deadline)}</dd>`;
  const asked =
    request === null
      ? '<form method="post" action="/site-access/request"><button type="submit">SUPPORT_ACCESS_REQUEST_BUTTON</button></form>'
      : `<p>SUPPORT_ACCESS_REQUEST_SENT ${statusLabel(request.status)}</p>`;
  return (
    '<h1>SUPPORT_ACCESS_HEADING</h1><p>SUPPORT_ACCESS_INTRO</p>' +
    `<dl><dt>SUPPORT_ACCESS_STATE</dt><dd>${label}</dd>${deadline}</dl>` +
    '<p>SUPPORT_ACCESS_OWNER_CLOSES</p><p>SUPPORT_ACCESS_STOP_NOW</p>' +
    asked
  );
}

/**
 * The owner console's queue: every request on one page, in the order given
 * (open first, oldest first). Each open request carries one form that marks it
 * dealt with, naming its tenant; a request dealt with carries none, and
 * nothing here removes a row.
 */
export function renderSupportQueue(
  requests: ReadonlyArray<SupportRequestShown & { readonly tenantId: string }>
): string {
  const rows = requests
    .map((r) => {
      const mark =
        r.status === 'open'
          ? `<form method="post" action="/support-requests/dealt-with"><input type="hidden" name="tenant" value="${escapeHtml(r.tenantId)}"><button type="submit">SUPPORT_REQUEST_MARK_DEALT_WITH</button></form>`
          : '';
      return `<li><code>${escapeHtml(r.tenantId)}</code> ${time(r.requestedAt)} ${statusLabel(r.status)}${mark}</li>`;
    })
    .join('');
  const pending = requests.filter((r) => r.status === 'open').length;
  return `<h2>SUPPORT_REQUESTS_HEADING</h2><p>SUPPORT_REQUESTS_PENDING ${pending}</p><ul>${rows}</ul>`;
}
