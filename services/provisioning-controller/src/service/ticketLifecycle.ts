import type { TicketState } from '../generated/index.js';

/**
 * The lifecycle of a ticket, held once. A ticket is born `new` and the owner
 * moves it from there; nothing moves a ticket back to `new`, and a move to the
 * state it is already in is not a move. The contract (openapi.yaml, `moveTicket`)
 * states the same table in words.
 */
export const TICKET_STATES: readonly TicketState[] = ['new', 'open', 'replied', 'closed'];

/** The states each state may move to. */
export const TICKET_TRANSITIONS: Readonly<Record<TicketState, readonly TicketState[]>> = {
  // The owner may answer or dismiss a ticket without opening it first.
  new: ['open', 'replied', 'closed'],
  open: ['replied', 'closed'],
  // The customer wrote again, or the owner is done.
  replied: ['open', 'closed'],
  // Reopened.
  closed: ['open'],
};

/** Whether the lifecycle allows a ticket in `from` to move to `to`. */
export function canMoveTicket(from: TicketState, to: TicketState): boolean {
  return TICKET_TRANSITIONS[from].includes(to);
}

/** The most tickets one tenant may hold that are not closed. */
export const OPEN_TICKET_LIMIT = 50;
