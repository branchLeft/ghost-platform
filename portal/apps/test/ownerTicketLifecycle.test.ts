import { describe, expect, it } from 'vitest';
import {
  canMoveTicket,
  TICKET_STATES as CONTROLLER_STATES,
} from '../../../services/provisioning-controller/src/service/ticketLifecycle.js';
import { TICKET_MOVES, TICKET_STATES } from '../src/console/ticketsScreen.js';

/**
 * The console shows a button for each move its own table allows; the API holds
 * the lifecycle. The two must name the same moves, pair by pair.
 */
describe('the console shows exactly the moves the provisioning API allows', () => {
  it('knows the same states, in the same order', () => {
    expect(TICKET_STATES).toEqual(CONTROLLER_STATES);
  });

  it('allows the same move for every pair of states', () => {
    for (const from of CONTROLLER_STATES) {
      for (const to of CONTROLLER_STATES) {
        expect(TICKET_MOVES[from].includes(to), `${from} -> ${to}`).toBe(canMoveTicket(from, to));
      }
    }
  });
});
