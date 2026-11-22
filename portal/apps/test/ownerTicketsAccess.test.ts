import { afterEach, describe, expect, it } from 'vitest';
import { Browser } from './browser.js';
import { mint } from './idp.js';
import { NOT_THE_OWNER, startRig, TENANT_TWO, type Rig } from './ownerRequestsRig.js';

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const CONTACT = 'tenant@example.test';

const up = async (): Promise<{ rig: Rig; ticketId: string }> => {
  rig = await startRig();
  const made = rig.mock.store.createTicket(TENANT_TWO, 'support', {
    contact: CONTACT,
    message: 'MESSAGE_TEXT',
  });
  if (made.kind !== 'recorded') throw new Error('the ticket was not recorded');
  return { rig, ticketId: made.ticket.ticket_id };
};

/** What a session that is not the owner's must get from every route of the ticket list. */
async function expectNothingReachable(r: Rig, ticketId: string, browser: Browser): Promise<void> {
  for (const path of ['/tickets', '/tickets/new', '/tickets/closed']) {
    const page = await browser.request(path);
    expect(page.status, path).toBe(302);
    expect(page.location, path).toBe('/login');
  }
  const move = await r.post(browser, '/tickets/move', { ticket_id: ticketId, state: 'closed' });
  expect(move.status).toBe(302);
  expect(move.location).toBe('/login');
  expect(r.mock.store.listTickets(undefined, undefined)[0]?.state).toBe('new');
}

describe('who may reach the ticket list and move a ticket', () => {
  for (const entry of NOT_THE_OWNER) {
    it(`refuses ${entry.why}, and moves nothing`, async () => {
      const { rig: r, ticketId } = await up();
      const browser = new Browser(r.console_.origin);
      const token = mint({ org: entry.org, client: entry.client, role: entry.role });
      expect((await browser.finish(r.issuer.issue(token))).status).toBe(403);
      await expectNothingReachable(r, ticketId, browser);
    });
  }

  it('refuses a visitor with no session, and a forged session cookie', async () => {
    const { rig: r, ticketId } = await up();
    await expectNothingReachable(r, ticketId, new Browser(r.console_.origin));
    const cookie = 'console_session=not-a-session; portal_session=not-a-session';
    const forged = new Browser(r.console_.origin);
    const page = await forged.request('/tickets', { headers: { cookie } });
    expect(page.status).toBe(302);
    expect(page.location).toBe('/login');
    const post = await forged.request('/tickets/move', {
      method: 'POST',
      headers: {
        origin: r.console_.origin,
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `ticket_id=${ticketId}&state=closed`,
    });
    expect(post.status).toBe(302);
    expect(post.location).toBe('/login');
    expect(r.mock.store.listTickets(undefined, undefined)[0]?.state).toBe('new');
  });

  it('lets the owner through, as the control case', async () => {
    const { rig: r, ticketId } = await up();
    const browser = await r.ownerBrowser();
    expect((await browser.request('/tickets')).status).toBe(200);
    const reply = await r.post(browser, '/tickets/move', { ticket_id: ticketId, state: 'closed' });
    expect(reply.status).toBe(303);
    expect(r.mock.store.listTickets(undefined, undefined)[0]?.state).toBe('closed');
  });
});
