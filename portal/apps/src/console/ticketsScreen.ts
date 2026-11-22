import {
  listTickets,
  moveTicket,
  type Ticket,
  type TicketKind,
  type TicketState,
} from 'ghost-platform-provisioning-controller/provisioning-api';
import type { Signed } from '../shell/app.js';
import { escapeHtml, type NavItem } from '../shell/html.js';
import { ProvisioningError, QUEUE_PATH, type ProvisioningOptions } from './requestsScreen.js';

type Page = (bound: true, identity: Signed) => Promise<string>;
type Action = (bound: true, identity: Signed, form: URLSearchParams) => Promise<string>;

export interface TicketsScreen {
  readonly nav: readonly NavItem[];
  readonly pages: Readonly<Record<string, Page>>;
  readonly actions: Readonly<Record<string, Action>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CALL_TIMEOUT_MS = 5000;

export const TICKETS_PATH = '/tickets';
export const MOVE_PATH = '/tickets/move';
export const TICKET_NOT_FOUND_PATH = '/tickets/not-found';
export const TICKET_MOVE_REFUSED_PATH = '/tickets/move-refused';

/** The list for each state, one path each, so the filter is a link and never a query read from the request. */
const STATE_PATH: Readonly<Record<TicketState, string>> = {
  new: '/tickets/new',
  open: '/tickets/open',
  replied: '/tickets/replied',
  closed: '/tickets/closed',
};

/** Where an action may send the owner back to: the lists, and nothing a form field invents. */
const LIST_PATHS: ReadonlySet<string> = new Set([TICKETS_PATH, ...Object.values(STATE_PATH)]);

const KIND_LABEL: Readonly<Record<TicketKind, string>> = {
  essentials: 'TICKET_KIND_ESSENTIALS',
  'professional-enquiry': 'TICKET_KIND_PROFESSIONAL_ENQUIRY',
  support: 'TICKET_KIND_SUPPORT',
};

const STATE_LABEL: Readonly<Record<TicketState, string>> = {
  new: 'TICKET_STATE_NEW',
  open: 'TICKET_STATE_OPEN',
  replied: 'TICKET_STATE_REPLIED',
  closed: 'TICKET_STATE_CLOSED',
};

const MOVE_LABEL: Readonly<Record<TicketState, string>> = {
  new: 'TICKET_MOVE_NEW',
  open: 'TICKET_MOVE_OPEN',
  replied: 'TICKET_MOVE_REPLIED',
  closed: 'TICKET_MOVE_CLOSED',
};

/** The four states, in the order a ticket first meets them. */
export const TICKET_STATES: readonly TicketState[] = ['new', 'open', 'replied', 'closed'];

/**
 * The moves a button is shown for: the lifecycle the provisioning API holds
 * (`moveTicket` in its contract), written out here because the controller does
 * not export it. The API stays the authority: a move it refuses lands on a
 * placeholder page, and a test compares this table with the controller's own so
 * the two cannot drift.
 */
export const TICKET_MOVES: Readonly<Record<TicketState, readonly TicketState[]>> = {
  new: ['open', 'replied', 'closed'],
  open: ['replied', 'closed'],
  replied: ['open', 'closed'],
  closed: ['open'],
};

const NONE: TicketsScreen = { nav: [], pages: {}, actions: {} };

function isState(value: string): value is TicketState {
  return (TICKET_STATES as readonly string[]).includes(value);
}

/**
 * The owner console's ticket list and the one thing the owner does to a ticket:
 * move it to another state. Every contact request at every tier is a row, whether
 * it came from the support form, the Professional enquiry or an Essentials
 * request, and the list is filtered by state through one path per state.
 *
 * With no provisioning configuration there is no page, no action and no nav
 * entry. Every call goes through the generated client with the owner credential.
 * The move runs only for a session whose organisation is the owner's: the
 * console's verifier already admits only that organisation holding the owner
 * role, and this checks again before any move is sent. Whether a move is
 * allowed is the API's to say; a button is shown only for the moves it allows,
 * and a move it refuses lands on a placeholder page and changes nothing.
 */
export function createTicketsScreen(
  provisioning: ProvisioningOptions | undefined,
  ownerOrgId: string
): TicketsScreen {
  if (provisioning === undefined) return NONE;

  const call = () => ({
    baseUrl: provisioning.baseUrl,
    auth: provisioning.ownerCredential,
    throwOnError: false as const,
    redirect: 'error' as const,
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });

  async function list(state: TicketState | undefined): Promise<readonly Ticket[]> {
    const result = await listTickets({
      ...call(),
      ...(state === undefined ? {} : { query: { state } }),
    });
    if (result.data === undefined) throw new ProvisioningError('list-tickets');
    return result.data.items;
  }

  function listPage(state: TicketState | undefined): Page {
    const here = state === undefined ? TICKETS_PATH : STATE_PATH[state];
    return async () => {
      const tickets = await list(state);
      const body =
        tickets.length === 0
          ? '<p>TICKETS_EMPTY</p>'
          : `<table><thead><tr><th>TICKET_ID</th><th>TICKET_KIND</th><th>TICKET_TENANT</th><th>TICKET_STATE</th><th>TICKET_RAISED_AT</th><th>TICKET_CONTACT</th><th>TICKET_MESSAGE</th><th>TICKET_HISTORY</th><th></th></tr></thead><tbody>${tickets
              .map((ticket) => row(ticket, here))
              .join('')}</tbody></table>`;
      return `<h1>TICKETS_HEADING</h1>${filters(state)}${body}`;
    };
  }

  /** The path to send the owner to once a move has been tried. */
  async function move(ticketId: string, to: string, back: string): Promise<string> {
    if (!UUID.test(ticketId)) return TICKET_NOT_FOUND_PATH;
    // A state the contract does not name is not sent: it would only be a 400.
    if (!isState(to)) return TICKET_MOVE_REFUSED_PATH;
    const result = await moveTicket({ ...call(), path: { id: ticketId }, body: { state: to } });
    if (result.data !== undefined) return LIST_PATHS.has(back) ? back : TICKETS_PATH;
    // A network failure leaves no response at all.
    const status = (result.response as Response | undefined)?.status;
    if (status === 404) return TICKET_NOT_FOUND_PATH;
    if (status === 409) return TICKET_MOVE_REFUSED_PATH;
    throw new ProvisioningError('move-ticket');
  }

  const moveAction: Action = async (_bound, identity, form) => {
    if (identity.orgId !== ownerOrgId) throw new ProvisioningError('not-owner');
    return move(form.get('ticket_id') ?? '', form.get('state') ?? '', form.get('from') ?? '');
  };

  const outcome =
    (line: string): Page =>
    () =>
      Promise.resolve(`<p>${line}</p><p><a href="${TICKETS_PATH}">BACK_TO_TICKETS</a></p>`);

  const pages: Record<string, Page> = {
    [TICKETS_PATH]: listPage(undefined),
    [TICKET_NOT_FOUND_PATH]: outcome('TICKET_NOT_FOUND'),
    [TICKET_MOVE_REFUSED_PATH]: outcome('TICKET_MOVE_NOT_ALLOWED'),
  };
  for (const state of TICKET_STATES) pages[STATE_PATH[state]] = listPage(state);

  return {
    nav: [{ label: 'NAV_TICKETS', href: TICKETS_PATH }],
    pages,
    actions: { [MOVE_PATH]: moveAction },
  };
}

/** The filter links: every ticket, then one per state; the one being shown is not a link. */
function filters(current: TicketState | undefined): string {
  const entry = (state: TicketState | undefined, label: string): string => {
    const href = state === undefined ? TICKETS_PATH : STATE_PATH[state];
    return state === current
      ? `<li><strong>${label}</strong></li>`
      : `<li><a href="${href}">${label}</a></li>`;
  };
  return `<ul>${entry(undefined, 'TICKET_FILTER_ALL')}${TICKET_STATES.map((state) =>
    entry(state, STATE_LABEL[state])
  ).join('')}</ul>`;
}

function row(ticket: Ticket, here: string): string {
  const request =
    ticket.request_id === null
      ? ''
      : `<p>TICKET_REQUEST <a href="${QUEUE_PATH}"><code>${escapeHtml(ticket.request_id)}</code></a></p>`;
  const history = ticket.history
    .map((change) => `<li>${STATE_LABEL[change.state]} ${escapeHtml(change.at)}</li>`)
    .join('');
  const moves = TICKET_MOVES[ticket.state]
    .map(
      (to) =>
        `<form method="post" action="${MOVE_PATH}"><input type="hidden" name="ticket_id" value="${escapeHtml(ticket.ticket_id)}"><input type="hidden" name="state" value="${to}"><input type="hidden" name="from" value="${escapeHtml(here)}"><button type="submit">${MOVE_LABEL[to]}</button></form>`
    )
    .join('');
  return (
    `<tr><td><code>${escapeHtml(ticket.ticket_id)}</code>${request}</td>` +
    `<td>${KIND_LABEL[ticket.kind]}</td>` +
    `<td><code>${escapeHtml(ticket.tenant_id)}</code></td>` +
    `<td>${STATE_LABEL[ticket.state]}</td>` +
    `<td>${escapeHtml(ticket.created_at)}</td>` +
    `<td>${ticket.contact === null ? '' : escapeHtml(ticket.contact)}</td>` +
    `<td><pre>${ticket.message === null ? '' : escapeHtml(ticket.message)}</pre></td>` +
    `<td><ol>${history}</ol></td>` +
    `<td>${moves}</td></tr>`
  );
}
