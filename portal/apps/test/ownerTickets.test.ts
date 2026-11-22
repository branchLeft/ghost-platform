import { afterEach, describe, expect, it } from 'vitest';
import type { Ticket } from 'ghost-platform-provisioning-controller/provisioning-api';
import { startRig, TENANT_ONE, TENANT_THREE, TENANT_TWO, type Rig } from './ownerRequestsRig.js';

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const up = async (options?: Parameters<typeof startRig>[0]): Promise<Rig> => {
  rig = await startRig(options);
  return rig;
};

const CONTACT = 'tenant@example.test';

/** One ticket of each kind, from three tenants, oldest first: support, enquiry, then an Essentials request. */
function raiseThree(r: Rig): readonly [Ticket, Ticket, Ticket] {
  const support = r.mock.store.createTicket(TENANT_ONE, 'support', {
    contact: CONTACT,
    message: 'SUPPORT_TEXT',
  });
  const enquiry = r.mock.store.createTicket(TENANT_TWO, 'professional-enquiry', {
    contact: CONTACT,
    message: 'ENQUIRY_TEXT',
  });
  r.mock.store.createRequest(TENANT_THREE, 'essentials');
  const [essentials] = r.mock.store.listTickets(undefined, 'essentials');
  if (support.kind !== 'recorded' || enquiry.kind !== 'recorded' || essentials === undefined) {
    throw new Error('the three tickets were not recorded');
  }
  return [support.ticket, enquiry.ticket, essentials];
}

const move = (r: Rig, id: string, state: string, from = '/tickets') =>
  r
    .ownerBrowser()
    .then((browser) => r.post(browser, '/tickets/move', { ticket_id: id, state, from }));

describe('the owner console ticket list', () => {
  it('shows an empty-state placeholder when there are none, and a nav entry', async () => {
    const r = await up();
    const page = await (await r.ownerBrowser()).request('/tickets');
    expect(page.status).toBe(200);
    expect(page.body).toContain('TICKETS_EMPTY');
    expect(page.body).toContain('NAV_TICKETS');
    expect(page.body).not.toContain('<table');
  });

  it('lists every kind from every tenant, oldest first, each with its kind, tenant, state and text', async () => {
    const r = await up();
    const [support, enquiry, essentials] = raiseThree(r);
    const page = await (await r.ownerBrowser()).request('/tickets');
    const body = page.body;
    const places = [support, enquiry, essentials].map((ticket) => body.indexOf(ticket.ticket_id));
    expect(places[0]).toBeGreaterThan(-1);
    expect(places[1]).toBeGreaterThan(places[0] ?? 0);
    expect(places[2]).toBeGreaterThan(places[1] ?? 0);
    for (const label of [
      'TICKET_KIND_SUPPORT',
      'TICKET_KIND_PROFESSIONAL_ENQUIRY',
      'TICKET_KIND_ESSENTIALS',
    ]) {
      expect(body).toContain(label);
    }
    for (const tenant of [TENANT_ONE, TENANT_TWO, TENANT_THREE]) expect(body).toContain(tenant);
    expect(body).toContain('SUPPORT_TEXT');
    expect(body).toContain('ENQUIRY_TEXT');
    expect(body).toContain(CONTACT);
    expect(body.match(/TICKET_STATE_NEW/g)).toHaveLength(3 + 3 + 1);
    // An Essentials ticket links to the queue where it is approved; the others do not.
    expect(body.match(/TICKET_REQUEST/g)).toHaveLength(1);
    expect(body).toContain(essentials.request_id ?? 'missing');
  });

  it('escapes what a tenant wrote', async () => {
    const r = await up();
    r.mock.store.createTicket(TENANT_ONE, 'support', {
      contact: CONTACT,
      message: '<script>alert(1)</script> & "quoted"',
    });
    const page = await (await r.ownerBrowser()).request('/tickets');
    expect(page.body).not.toContain('<script>alert(1)</script>');
    expect(page.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot;');
  });

  it('filters by state, one path each, and shows none of the others', async () => {
    const r = await up();
    const [support, enquiry, essentials] = raiseThree(r);
    r.mock.store.moveTicket(support.ticket_id, 'open');
    r.mock.store.moveTicket(enquiry.ticket_id, 'replied');
    r.mock.store.moveTicket(essentials.ticket_id, 'closed');
    const browser = await r.ownerBrowser();
    const expected: Record<string, Ticket> = {
      '/tickets/open': support,
      '/tickets/replied': enquiry,
      '/tickets/closed': essentials,
    };
    for (const [path, ticket] of Object.entries(expected)) {
      const body = (await browser.request(path)).body;
      expect(body, path).toContain(ticket.ticket_id);
      for (const other of [support, enquiry, essentials]) {
        if (other !== ticket) expect(body, path).not.toContain(other.ticket_id);
      }
    }
    const none = await browser.request('/tickets/new');
    expect(none.status).toBe(200);
    expect(none.body).toContain('TICKETS_EMPTY');
    const all = (await browser.request('/tickets')).body;
    for (const ticket of [support, enquiry, essentials]) expect(all).toContain(ticket.ticket_id);
  });

  it('links each list from the others and does not link the one being shown', async () => {
    const r = await up();
    const body = (await (await r.ownerBrowser()).request('/tickets/open')).body;
    for (const href of ['/tickets', '/tickets/new', '/tickets/replied', '/tickets/closed']) {
      expect(body).toContain(`<a href="${href}">`);
    }
    expect(body).not.toContain('<a href="/tickets/open">');
    expect(body).toContain('<strong>TICKET_STATE_OPEN</strong>');
  });

  it('shows each ticket the moves its state allows, and only those', async () => {
    const r = await up();
    const [, enquiry, essentials] = raiseThree(r);
    r.mock.store.moveTicket(enquiry.ticket_id, 'replied');
    r.mock.store.moveTicket(essentials.ticket_id, 'closed');
    const browser = await r.ownerBrowser();
    const pageOf = async (path: string) => (await browser.request(path)).body;
    const moves = (body: string): string[] =>
      [...body.matchAll(/>(TICKET_MOVE_[A-Z]+)<\/button>/g)].map((m) => m[1] ?? '');
    expect(moves(await pageOf('/tickets/new'))).toEqual([
      'TICKET_MOVE_OPEN',
      'TICKET_MOVE_REPLIED',
      'TICKET_MOVE_CLOSED',
    ]);
    expect(moves(await pageOf('/tickets/replied'))).toEqual([
      'TICKET_MOVE_OPEN',
      'TICKET_MOVE_CLOSED',
    ]);
    expect(moves(await pageOf('/tickets/closed'))).toEqual(['TICKET_MOVE_OPEN']);
    expect((await pageOf('/tickets')).includes('TICKET_MOVE_NEW')).toBe(false);
  });

  it('keeps every user-visible string a placeholder, the tenant’s own words aside', async () => {
    const r = await up();
    const [support] = raiseThree(r);
    r.mock.store.moveTicket(support.ticket_id, 'open');
    const browser = await r.ownerBrowser();
    for (const path of [
      '/tickets',
      '/tickets/new',
      '/tickets/open',
      '/tickets/replied',
      '/tickets/closed',
      '/tickets/not-found',
      '/tickets/move-refused',
    ]) {
      const text = (await browser.request(path)).body
        .replace(/<pre>[\s\S]*?<\/pre>/g, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[0-9a-f]{8}-[0-9a-f-]{27}|\d{4}-\d\d-\d\dT[\d:.]+Z|\S+@\S+/g, ' ');
      const words = text.split(/\s+/).filter((word) => word !== '' && word !== 'OWNER_CONSOLE');
      expect(
        words.filter((word) => !/^[A-Z][A-Z0-9_]*$/.test(word)),
        path
      ).toEqual([]);
    }
  });

  it('without the provisioning URL, the pages, the action and the nav entry are absent', async () => {
    const r = await up({ provisioned: false });
    const browser = await r.ownerBrowser();
    expect((await browser.request('/')).body).not.toContain('NAV_TICKETS');
    for (const path of ['/tickets', '/tickets/new', '/tickets/not-found']) {
      expect((await browser.request(path)).status, path).toBe(404);
    }
    const reply = await r.post(browser, '/tickets/move', { ticket_id: 'x', state: 'open' });
    expect(reply.status).toBe(404);
  });

  it('with it, the nav entry is on the landing page', async () => {
    const r = await up();
    expect((await (await r.ownerBrowser()).request('/')).body).toContain('NAV_TICKETS');
  });

  it('an API that is down answers a fixed error, not a hang or a detail', async () => {
    const r = await up();
    const browser = await r.ownerBrowser();
    await r.api.close();
    const page = await browser.request('/tickets');
    expect(page.status).toBe(500);
    expect(page.body).toBe('FAILED');
    expect(r.errors.some((line) => line.includes('ProvisioningError'))).toBe(true);
  });

  it('a console holding the wrong credential shows a fixed error and moves nothing', async () => {
    const r = await up({ consoleCredential: 'TEST_WRONG_CREDENTIAL' });
    const [support] = raiseThree(r);
    const browser = await r.ownerBrowser();
    expect((await browser.request('/tickets')).status).toBe(500);
    const reply = await r.post(browser, '/tickets/move', {
      ticket_id: support.ticket_id,
      state: 'open',
    });
    expect(reply.status).toBe(400);
    expect(reply.body).toBe('REFUSED');
    expect(r.mock.store.listTickets(undefined, undefined)[0]?.state).toBe('new');
    expect(r.errors.every((line) => !line.includes('TEST_WRONG_CREDENTIAL'))).toBe(true);
  });
});

describe('the owner moves a ticket through its lifecycle', () => {
  it('walks an enquiry from new to replied to closed, and the lists and history show each change', async () => {
    const r = await up();
    const [, enquiry] = raiseThree(r);
    const browser = await r.ownerBrowser();
    expect((await browser.request('/tickets/new')).body).toContain(enquiry.ticket_id);

    const replied = await r.post(browser, '/tickets/move', {
      ticket_id: enquiry.ticket_id,
      state: 'replied',
      from: '/tickets/new',
    });
    expect(replied.status).toBe(303);
    expect(replied.location).toBe('/tickets/new');
    expect((await browser.request('/tickets/new')).body).not.toContain(enquiry.ticket_id);
    expect((await browser.request('/tickets/replied')).body).toContain(enquiry.ticket_id);

    const closed = await r.post(browser, '/tickets/move', {
      ticket_id: enquiry.ticket_id,
      state: 'closed',
      from: '/tickets/replied',
    });
    expect(closed.location).toBe('/tickets/replied');
    const page = (await browser.request('/tickets/closed')).body;
    expect(page).toContain(enquiry.ticket_id);
    expect(page).not.toContain('TICKET_MOVE_CLOSED');
    expect(page).toContain('TICKET_MOVE_OPEN');
    // Each state the ticket has been in, in order.
    const history = page.slice(page.indexOf('<ol>'), page.indexOf('</ol>'));
    expect([...history.matchAll(/TICKET_STATE_([A-Z]+)/g)].map((m) => m[1])).toEqual([
      'NEW',
      'REPLIED',
      'CLOSED',
    ]);
    expect(r.mock.store.listTickets('closed', undefined)).toHaveLength(1);
  });

  it('reopens a closed ticket', async () => {
    const r = await up();
    const [support] = raiseThree(r);
    r.mock.store.moveTicket(support.ticket_id, 'closed');
    const reply = await move(r, support.ticket_id, 'open', '/tickets/closed');
    expect(reply.location).toBe('/tickets/closed');
    expect(r.mock.store.listTickets('open', undefined).map((t) => t.ticket_id)).toEqual([
      support.ticket_id,
    ]);
  });

  it('returns to the all list by default and for any list it does not know', async () => {
    const r = await up();
    const [support, enquiry, essentials] = raiseThree(r);
    const browser = await r.ownerBrowser();
    const sent = async (id: string, from: string | undefined) =>
      (
        await r.post(browser, '/tickets/move', {
          ticket_id: id,
          state: 'open',
          ...(from === undefined ? {} : { from }),
        })
      ).location;
    expect(await sent(support.ticket_id, undefined)).toBe('/tickets');
    expect(await sent(enquiry.ticket_id, 'https://elsewhere.example.test/')).toBe('/tickets');
    expect(await sent(essentials.ticket_id, '//elsewhere.example.test')).toBe('/tickets');
  });

  it('refuses every move the lifecycle does not allow and changes nothing', async () => {
    const r = await up();
    const [support, enquiry] = raiseThree(r);
    r.mock.store.moveTicket(enquiry.ticket_id, 'closed');
    const before = r.mock.store.listTickets(undefined, undefined);
    const attempts: [Ticket, string][] = [
      [support, 'new'],
      [enquiry, 'new'],
      [enquiry, 'replied'],
      [enquiry, 'closed'],
    ];
    for (const [ticket, to] of attempts) {
      const reply = await move(r, ticket.ticket_id, to);
      expect(reply.status, `${ticket.state} -> ${to}`).toBe(303);
      expect(reply.location, `${ticket.state} -> ${to}`).toBe('/tickets/move-refused');
    }
    expect(r.mock.store.listTickets(undefined, undefined)).toEqual(before);
    const page = await (await r.ownerBrowser()).request('/tickets/move-refused');
    expect(page.status).toBe(200);
    expect(page.body).toContain('TICKET_MOVE_NOT_ALLOWED');
  });

  it('refuses a state the contract does not name without asking the API', async () => {
    const r = await up();
    const [support] = raiseThree(r);
    let asked = 0;
    const real = r.mock.store.moveTicket.bind(r.mock.store);
    r.mock.store.moveTicket = (id, to) => {
      asked += 1;
      return real(id, to);
    };
    for (const to of ['pending', 'OPEN', '', '../open']) {
      const reply = await move(r, support.ticket_id, to);
      expect(reply.location, to).toBe('/tickets/move-refused');
    }
    expect(asked).toBe(0);
    expect(r.mock.store.listTickets(undefined, undefined)[0]?.state).toBe('new');
  });

  it('answers a placeholder line for an id that is not a ticket, and moves nothing', async () => {
    const r = await up();
    raiseThree(r);
    let asked = 0;
    const real = r.mock.store.moveTicket.bind(r.mock.store);
    r.mock.store.moveTicket = (id, to) => {
      asked += 1;
      return real(id, to);
    };
    const unknown = '00000000-0000-4000-9000-0000000000ff';
    for (const id of [unknown, 'not-a-uuid', '../tenants', '']) {
      const reply = await move(r, id, 'open');
      expect(reply.status, id).toBe(303);
      expect(reply.location, id).toBe('/tickets/not-found');
    }
    // Only the well-formed unknown id reached the API at all.
    expect(asked).toBe(1);
    const page = await (await r.ownerBrowser()).request('/tickets/not-found');
    expect(page.body).toContain('TICKET_NOT_FOUND');
    expect(r.mock.store.listTickets('new', undefined)).toHaveLength(3);
  });

  it('refuses a move posted from another origin', async () => {
    const r = await up();
    const [support] = raiseThree(r);
    const browser = await r.ownerBrowser();
    const reply = await browser.request('/tickets/move', {
      method: 'POST',
      headers: {
        origin: 'https://elsewhere.example.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `ticket_id=${support.ticket_id}&state=open`,
    });
    expect(reply.status).toBe(403);
    expect(r.mock.store.listTickets(undefined, undefined)[0]?.state).toBe('new');
  });
});
