import {
  approvePromotionRequest,
  listPromotionRequests,
  type PromotionRequest,
  type PromotionRequestState,
  type PromotionTier,
} from 'ghost-platform-provisioning-controller/provisioning-api';
import type { Signed } from '../shell/app.js';
import { escapeHtml, type NavItem } from '../shell/html.js';

/**
 * Where the owner console reaches the provisioning API, and the credential it
 * presents there. The console's own: the tenant portal's credential is never
 * given to this application.
 */
export interface ProvisioningOptions {
  /** The API's origin, from `CONSOLE_PROVISIONING_URL`. */
  readonly baseUrl: string;
  /** The owner credential, read from a file; never a literal. */
  readonly ownerCredential: string;
}

type Page = (bound: true, identity: Signed) => Promise<string>;
type Action = (bound: true, identity: Signed, form: URLSearchParams) => Promise<string>;

export interface RequestsScreen {
  readonly nav: readonly NavItem[];
  readonly pages: Readonly<Record<string, Page>>;
  readonly actions: Readonly<Record<string, Action>>;
}

/** What the shell logs when a call fails: the name, never the message. */
export class ProvisioningError extends Error {
  constructor(step: string) {
    super(step);
    this.name = 'ProvisioningError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CALL_TIMEOUT_MS = 5000;
/** The most recent approvals shown under the queue. */
const APPROVED_SHOWN = 20;

export const QUEUE_PATH = '/requests';
export const APPROVE_PATH = '/requests/approve';
export const NOT_FOUND_PATH = '/requests/not-found';
export const NOT_APPROVABLE_PATH = '/requests/not-approvable';

const TIER_LABEL: Readonly<Record<PromotionTier, string>> = {
  essentials: 'TIER_ESSENTIALS',
  'professional-enquiry': 'TIER_PROFESSIONAL_ENQUIRY',
};

const NONE: RequestsScreen = { nav: [], pages: {}, actions: {} };

/**
 * The owner console's request queue and its one Approve action. With no
 * provisioning configuration there is no page, no action and no nav entry.
 *
 * Every call goes through the generated client. The action runs only for a
 * session whose organisation is the owner's: the console's verifier already
 * admits only that organisation holding the owner role, and this checks again
 * before any approval is sent, so a session that reached the action by any
 * other road still approves nothing.
 */
export function createRequestsScreen(
  provisioning: ProvisioningOptions | undefined,
  ownerOrgId: string
): RequestsScreen {
  if (provisioning === undefined) return NONE;

  const call = () => ({
    baseUrl: provisioning.baseUrl,
    auth: provisioning.ownerCredential,
    throwOnError: false as const,
    redirect: 'error' as const,
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });

  async function list(state: PromotionRequestState): Promise<readonly PromotionRequest[]> {
    const result = await listPromotionRequests({ ...call(), query: { state } });
    if (result.data === undefined) throw new ProvisioningError('list');
    return result.data.items;
  }

  /** The path to send the owner to once an approval has been tried. */
  async function approve(requestId: string): Promise<string> {
    if (!UUID.test(requestId)) return NOT_FOUND_PATH;
    const result = await approvePromotionRequest({ ...call(), path: { id: requestId } });
    if (result.data !== undefined) return QUEUE_PATH;
    // A network failure leaves no response at all.
    const status = (result.response as Response | undefined)?.status;
    if (status === 404) return NOT_FOUND_PATH;
    if (status === 409) return NOT_APPROVABLE_PATH;
    throw new ProvisioningError('approve');
  }

  const queue: Page = async () => {
    const [pending, approved] = await Promise.all([list('pending'), list('approved')]);
    const waiting =
      pending.length === 0
        ? '<p>REQUESTS_EMPTY</p>'
        : `<table><thead><tr><th>REQUEST_ID</th><th>REQUEST_TIER</th><th>REQUEST_MADE_AT</th><th></th></tr></thead><tbody>${pending
            .map(pendingRow)
            .join('')}</tbody></table>`;
    const done =
      approved.length === 0
        ? ''
        : `<h2>REQUESTS_APPROVED_HEADING</h2><ul>${approved
            .slice(-APPROVED_SHOWN)
            .reverse()
            .map(approvedItem)
            .join('')}</ul>`;
    return `<h1>REQUESTS_HEADING</h1>${waiting}${done}`;
  };

  const outcome =
    (line: string): Page =>
    () =>
      Promise.resolve(`<p>${line}</p><p><a href="${QUEUE_PATH}">BACK_TO_REQUESTS</a></p>`);

  const approveAction: Action = async (_bound, identity, form) => {
    if (identity.orgId !== ownerOrgId) throw new ProvisioningError('not-owner');
    return approve(form.get('request_id') ?? '');
  };

  return {
    nav: [{ label: 'NAV_REQUESTS', href: QUEUE_PATH }],
    pages: {
      [QUEUE_PATH]: queue,
      [NOT_FOUND_PATH]: outcome('REQUEST_NOT_FOUND'),
      [NOT_APPROVABLE_PATH]: outcome('REQUEST_NOT_APPROVABLE'),
    },
    actions: { [APPROVE_PATH]: approveAction },
  };
}

function pendingRow(request: PromotionRequest): string {
  // A professional enquiry is recorded and listed, but the contract refuses to
  // approve one, so it carries no button.
  const button =
    request.tier === 'essentials'
      ? `<form method="post" action="${APPROVE_PATH}"><input type="hidden" name="request_id" value="${escapeHtml(request.request_id)}"><button type="submit">APPROVE</button></form>`
      : '';
  return `<tr><td><code>${escapeHtml(request.request_id)}</code></td><td>${TIER_LABEL[request.tier]}</td><td>${escapeHtml(request.requested_at)}</td><td>${button}</td></tr>`;
}

function approvedItem(request: PromotionRequest): string {
  const at = request.approval === null ? '' : escapeHtml(request.approval.approved_at);
  return `<li><code>${escapeHtml(request.request_id)}</code> ${TIER_LABEL[request.tier]} REQUEST_APPROVED_AT ${at}</li>`;
}
