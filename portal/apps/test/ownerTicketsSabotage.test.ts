import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  OWNER_CREDENTIAL,
  startRig,
  TENANT_ORG,
  TENANT_TWO,
  type Rig,
} from './ownerRequestsRig.js';
import { clearMutants, importSabotaged, TICKETS } from './sourceSabotage.js';
import { OWNER_ORG } from './idp.js';
import { createTicketsScreen } from '../src/console/ticketsScreen.js';

interface TicketsModule {
  readonly createTicketsScreen: typeof createTicketsScreen;
}

let rig: Rig | undefined;
beforeAll(clearMutants);
afterAll(clearMutants);
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const CONTACT = 'tenant@example.test';

async function raise(r: Rig): Promise<string> {
  const made = r.mock.store.createTicket(TENANT_TWO, 'support', {
    contact: CONTACT,
    message: 'MESSAGE_TEXT',
  });
  if (made.kind !== 'recorded') throw new Error('the ticket was not recorded');
  return made.ticket.ticket_id;
}

describe('sabotage: a move checks the organisation itself', () => {
  const reach = async (make: typeof createTicketsScreen) => {
    rig = await startRig();
    const id = await raise(rig);
    const screen = make({ baseUrl: rig.api.baseUrl, ownerCredential: OWNER_CREDENTIAL }, OWNER_ORG);
    const action = screen.actions['/tickets/move'];
    const form = new URLSearchParams({ ticket_id: id, state: 'closed' });
    let outcome: string;
    try {
      outcome = (await action?.(true, { subject: 'user-1', orgId: TENANT_ORG }, form)) ?? 'none';
    } catch (error) {
      outcome = error instanceof Error ? error.name : 'threw';
    }
    return { outcome, closed: rig.mock.store.listTickets('closed', undefined).length };
  };

  it('RED: without the check a tenant organisation session moves a ticket, GREEN: the real action throws and moves nothing', async () => {
    const broken = await importSabotaged<TicketsModule>(
      'tickets-no-owner-check',
      "if (identity.orgId !== ownerOrgId) throw new ProvisioningError('not-owner');",
      '',
      TICKETS
    );
    expect(await reach(broken.createTicketsScreen)).toEqual({ outcome: '/tickets', closed: 1 });
    await rig?.close();
    rig = undefined;

    expect(await reach(createTicketsScreen)).toEqual({ outcome: 'ProvisioningError', closed: 0 });
  });
});

describe('sabotage: a move returns only to one of the lists', () => {
  const returnsTo = async (make: typeof createTicketsScreen, from: string): Promise<string> => {
    rig = await startRig();
    const id = await raise(rig);
    const screen = make({ baseUrl: rig.api.baseUrl, ownerCredential: OWNER_CREDENTIAL }, OWNER_ORG);
    const form = new URLSearchParams({ ticket_id: id, state: 'open', from });
    const outcome = await screen.actions['/tickets/move']?.(
      true,
      { subject: 'user-1', orgId: OWNER_ORG },
      form
    );
    return outcome ?? 'none';
  };

  it('RED: without the allow-list a form field picks where the owner is sent, GREEN: the real action sends them to the all list', async () => {
    const broken = await importSabotaged<TicketsModule>(
      'tickets-no-list-allow',
      'return LIST_PATHS.has(back) ? back : TICKETS_PATH;',
      'return back;',
      TICKETS
    );
    expect(await returnsTo(broken.createTicketsScreen, '//elsewhere.example.test')).toBe(
      '//elsewhere.example.test'
    );
    await rig?.close();
    rig = undefined;

    expect(await returnsTo(createTicketsScreen, '//elsewhere.example.test')).toBe('/tickets');
  });
});
