import { describe, expect, it } from 'vitest';
import type { TicketState } from '../../src/generated/index.js';
import {
  canMoveTicket,
  OPEN_TICKET_LIMIT,
  TICKET_STATES,
  TICKET_TRANSITIONS,
} from '../../src/service/ticketLifecycle.js';

/** The lifecycle as the contract states it, written out pair by pair and not derived from the table. */
const ALLOWED: readonly (readonly [TicketState, TicketState])[] = [
  ['new', 'open'],
  ['new', 'replied'],
  ['new', 'closed'],
  ['open', 'replied'],
  ['open', 'closed'],
  ['replied', 'open'],
  ['replied', 'closed'],
  ['closed', 'open'],
];

describe('the ticket lifecycle', () => {
  it('has the four states, in the order a ticket first meets them', () => {
    expect(TICKET_STATES).toEqual(['new', 'open', 'replied', 'closed']);
  });

  it('allows exactly the eight moves the contract names', () => {
    for (const from of TICKET_STATES) {
      for (const to of TICKET_STATES) {
        const allowed = ALLOWED.some(([a, b]) => a === from && b === to);
        expect(canMoveTicket(from, to), `${from} -> ${to}`).toBe(allowed);
      }
    }
  });

  it('never moves a ticket back to new', () => {
    for (const from of TICKET_STATES) expect(canMoveTicket(from, 'new'), from).toBe(false);
  });

  it('never counts staying in a state as a move', () => {
    for (const state of TICKET_STATES) expect(canMoveTicket(state, state), state).toBe(false);
  });

  it('lets a closed ticket be reopened and nothing else', () => {
    expect(TICKET_TRANSITIONS.closed).toEqual(['open']);
  });

  it('leaves no state a ticket can enter and never leave', () => {
    for (const from of TICKET_STATES)
      expect(TICKET_TRANSITIONS[from].length, from).toBeGreaterThan(0);
  });

  it('limits a tenant to fifty tickets that are not closed', () => {
    expect(OPEN_TICKET_LIMIT).toBe(50);
  });
});
