import { escapeHtml } from './html.js';

/**
 * A tenant's erasure request as the page may show it; the storage layer's own
 * view satisfies it. The residual window arrives with the view, so no page can
 * state one for a request whose key has not been recorded as destroyed.
 */
export type ErasureShown =
  | { readonly state: 'none' }
  | { readonly state: 'requested'; readonly requestedAt: Date }
  | {
      readonly state: 'key_destroyed';
      readonly requestedAt: Date;
      readonly keyDestroyedAt: Date;
      readonly residual: {
        readonly aroundDays: number;
        readonly upperBoundDays: null;
        readonly reason: string;
      };
    };

const time = (value: Date): string =>
  `<time datetime="${value.toISOString()}">${value.toISOString()}</time>`;

const REQUEST_PATH = '/erasure/request';

/** The words for a reason code; anything not recognised is not worded as a reason. */
function reasonLabel(reason: string): string {
  return reason === 'ANCHOR_DUMP_NEVER_PRUNED'
    ? 'ERASURE_RESIDUAL_REASON_ANCHOR_DUMP_NEVER_PRUNED'
    : 'ERASURE_RESIDUAL_REASON_UNKNOWN';
}

/**
 * What the page says once the key is recorded as destroyed, and only then. It
 * is the honest figure, not a promise: around `aroundDays` days counted from the
 * moment the key was destroyed, with no upper bound and the reason there is
 * none. It prints no date on which the data is gone, because no such date is
 * known, and it never uses a word for the data being gone or deleted.
 */
function residualWindow(view: Extract<ErasureShown, { state: 'key_destroyed' }>): string {
  return (
    '<h2>ERASURE_RESIDUAL_HEADING</h2>' +
    `<dl><dt>ERASURE_KEY_DESTROYED_AT</dt><dd>${time(view.keyDestroyedAt)}</dd>` +
    `<dt>ERASURE_RESIDUAL_AROUND_DAYS</dt><dd>${view.residual.aroundDays}</dd></dl>` +
    '<p>ERASURE_RESIDUAL_NO_UPPER_BOUND</p>' +
    `<p>${reasonLabel(view.residual.reason)}</p>`
  );
}

/**
 * The tenant's erasure page. It is about the tenant's own whole site and says
 * so; a member's request goes to the tenant and is not made here. With no
 * request there is one button, which carries no field. With a request whose key
 * has not been recorded as destroyed, the page says a request was made and that
 * nothing has been erased, and states no residual window. Only a request
 * recorded as having its key destroyed shows the residual window.
 */
export function renderErasure(view: ErasureShown): string {
  const head =
    '<h1>ERASURE_HEADING</h1><p>ERASURE_SCOPE_WHOLE_SITE</p><p>ERASURE_NOT_A_MEMBER_REQUEST</p>';
  if (view.state === 'none') {
    return (
      head +
      `<form method="post" action="${REQUEST_PATH}"><button type="submit">ERASURE_REQUEST_BUTTON</button></form>`
    );
  }
  if (view.state === 'requested') {
    return (
      head +
      `<dl><dt>ERASURE_REQUESTED_AT</dt><dd>${time(view.requestedAt)}</dd></dl>` +
      '<p>ERASURE_STATUS_REQUESTED</p><p>ERASURE_NOTHING_ERASED_YET</p>'
    );
  }
  return (
    head +
    `<dl><dt>ERASURE_REQUESTED_AT</dt><dd>${time(view.requestedAt)}</dd></dl>` +
    '<p>ERASURE_STATUS_KEY_DESTROYED</p>' +
    residualWindow(view)
  );
}

/**
 * The owner console's erasure list: one line per request, each with its status
 * word and, for a recorded key, the moment. It carries no button: the key is
 * destroyed on the control host and recorded from that command's proof.
 */
export function renderErasureQueue(
  requests: ReadonlyArray<{ readonly tenantId: string; readonly view: ErasureShown }>
): string {
  const rows = requests
    .map((r) => {
      if (r.view.state === 'none') return '';
      const word =
        r.view.state === 'key_destroyed'
          ? `ERASURE_STATUS_KEY_DESTROYED ${time(r.view.keyDestroyedAt)}`
          : 'ERASURE_STATUS_REQUESTED';
      return `<li><code>${escapeHtml(r.tenantId)}</code> ${time(r.view.requestedAt)} ${word}</li>`;
    })
    .join('');
  const waiting = requests.filter((r) => r.view.state === 'requested').length;
  return `<h2>ERASURE_REQUESTS_HEADING</h2><p>ERASURE_REQUESTS_WAITING ${waiting}</p><ul>${rows}</ul>`;
}
