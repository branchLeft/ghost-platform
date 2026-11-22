import { afterEach, describe, expect, it } from 'vitest';
import {
  createPromotionRequest,
  createTicket,
  listPromotionRequests,
  listTickets,
  moveTicket,
  type Ticket,
  type TicketState,
} from '../../src/generated/index.js';
import { TICKET_STATES } from '../../src/service/ticketLifecycle.js';
import {
  OWNER_CREDENTIAL,
  TENANT_A,
  TENANT_A_CREDENTIAL,
  TENANT_B,
  TENANT_B_CREDENTIAL,
  clientWith,
  raw,
  startMock,
  type RunningMock,
} from '../support/mockHarness.js';

let running: RunningMock | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

/** A mock whose clock moves one minute with every reading and whose ticket ids count up. */
async function up(): Promise<RunningMock> {
  let minute = 0;
  let ticket = 0;
  running = await startMock({
    now: () => new Date(Date.UTC(2026, 0, 1, 0, minute++)),
    newTicketId: () => `00000000-0000-4000-9000-${String(++ticket).padStart(12, '0')}`,
  });
  return running;
}

const ticketId = (n: number): string => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;

const SUPPORT = { kind: 'support', contact: 'a@example.test', message: 'TEST_MESSAGE' } as const;
const ENQUIRY = {
  kind: 'professional-enquiry',
  contact: 'b@example.test',
  message: 'TEST_ENQUIRY',
} as const;

async function raise(
  baseUrl: string,
  body: typeof SUPPORT | typeof ENQUIRY,
  tenant = TENANT_A,
  credential = TENANT_A_CREDENTIAL
): Promise<Ticket> {
  const result = await createTicket({
    client: clientWith(baseUrl, credential),
    path: { tenant },
    body,
  });
  expect(result.response?.status).toBe(201);
  return result.data as Ticket;
}

/** Moves a ticket and returns the status and body, whatever they are. */
async function move(baseUrl: string, id: string, state: TicketState) {
  const result = await moveTicket({
    client: clientWith(baseUrl, OWNER_CREDENTIAL),
    path: { id },
    body: { state },
  });
  return { status: result.response?.status, data: result.data, error: result.error };
}

async function owned(baseUrl: string): Promise<Ticket[]> {
  const result = await listTickets({ client: clientWith(baseUrl, OWNER_CREDENTIAL) });
  return result.data?.items ?? [];
}

describe('every contact request at every tier is a ticket', () => {
  it('records a support ticket in state new, with what the tenant wrote and when', async () => {
    const { baseUrl } = await up();
    const made = await raise(baseUrl, SUPPORT);
    expect(made).toEqual({
      ticket_id: ticketId(1),
      tenant_id: TENANT_A,
      kind: 'support',
      state: 'new',
      contact: 'a@example.test',
      message: 'TEST_MESSAGE',
      request_id: null,
      created_at: '2026-01-01T00:02:00.000Z',
      updated_at: '2026-01-01T00:02:00.000Z',
      history: [{ state: 'new', at: '2026-01-01T00:02:00.000Z' }],
    });
  });

  it('records a Professional enquiry in state new', async () => {
    const { baseUrl } = await up();
    const made = await raise(baseUrl, ENQUIRY);
    expect(made).toMatchObject({ kind: 'professional-enquiry', state: 'new', request_id: null });
  });

  it('records an Essentials request as a ticket linked to its promotion request', async () => {
    const { baseUrl } = await up();
    const asked = await createPromotionRequest({
      client: clientWith(baseUrl, TENANT_A_CREDENTIAL),
      path: { tenant: TENANT_A },
      body: { tier: 'essentials' },
    });
    expect(asked.response?.status).toBe(201);
    const tickets = await owned(baseUrl);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      tenant_id: TENANT_A,
      kind: 'essentials',
      state: 'new',
      contact: null,
      message: null,
      request_id: asked.data?.request_id,
    });
  });

  it('records no second ticket when the same Essentials request is asked for again', async () => {
    const { baseUrl } = await up();
    const client = clientWith(baseUrl, TENANT_A_CREDENTIAL);
    const options = { client, path: { tenant: TENANT_A }, body: { tier: 'essentials' } } as const;
    await createPromotionRequest(options);
    await createPromotionRequest(options);
    expect(await owned(baseUrl)).toHaveLength(1);
  });

  it('records no ticket for a request the demo cannot make', async () => {
    const { baseUrl } = await up();
    const client = clientWith(baseUrl, TENANT_A_CREDENTIAL);
    await createPromotionRequest({
      client,
      path: { tenant: TENANT_A },
      body: { tier: 'essentials' },
    });
    const other = await createPromotionRequest({
      client,
      path: { tenant: TENANT_A },
      body: { tier: 'professional-enquiry' },
    });
    expect(other.response?.status).toBe(409);
    expect(await owned(baseUrl)).toHaveLength(1);
  });

  it('lists the three kinds together, oldest first, each in its own kind', async () => {
    const { baseUrl } = await up();
    await raise(baseUrl, SUPPORT);
    await createPromotionRequest({
      client: clientWith(baseUrl, TENANT_B_CREDENTIAL),
      path: { tenant: TENANT_B },
      body: { tier: 'essentials' },
    });
    await raise(baseUrl, ENQUIRY);
    const tickets = await owned(baseUrl);
    expect(tickets.map((t) => t.kind)).toEqual(['support', 'essentials', 'professional-enquiry']);
    expect(tickets.map((t) => t.tenant_id)).toEqual([TENANT_A, TENANT_B, TENANT_A]);
  });

  it('does not move the ids the promotion requests get', async () => {
    const { baseUrl } = await up();
    await raise(baseUrl, SUPPORT);
    const asked = await createPromotionRequest({
      client: clientWith(baseUrl, TENANT_A_CREDENTIAL),
      path: { tenant: TENANT_A },
      body: { tier: 'essentials' },
    });
    // Two demos took ids 1 and 2 at start; the first request is the next id.
    expect(asked.data?.request_id).toBe('00000000-0000-4000-8000-000000000003');
  });

  it('leaves the owner queue of promotion requests as it was', async () => {
    const { baseUrl } = await up();
    await raise(baseUrl, ENQUIRY);
    const queue = await listPromotionRequests({
      client: clientWith(baseUrl, OWNER_CREDENTIAL),
    });
    expect(queue.data).toEqual({ items: [] });
  });
});

describe('the list filters by state and by kind', () => {
  it('returns only tickets in the state asked for, and every ticket with none', async () => {
    const { baseUrl } = await up();
    const first = await raise(baseUrl, SUPPORT);
    await raise(baseUrl, ENQUIRY);
    await move(baseUrl, first.ticket_id, 'open');
    const owner = clientWith(baseUrl, OWNER_CREDENTIAL);

    const byState = async (state: TicketState) =>
      (await listTickets({ client: owner, query: { state } })).data?.items.map((t) => t.ticket_id);
    expect(await byState('new')).toEqual([ticketId(2)]);
    expect(await byState('open')).toEqual([ticketId(1)]);
    expect(await byState('replied')).toEqual([]);
    expect(await byState('closed')).toEqual([]);
    expect(await owned(baseUrl)).toHaveLength(2);
  });

  it('combines state and kind', async () => {
    const { baseUrl } = await up();
    await raise(baseUrl, SUPPORT);
    await raise(baseUrl, ENQUIRY);
    const owner = clientWith(baseUrl, OWNER_CREDENTIAL);
    const both = await listTickets({
      client: owner,
      query: { state: 'new', kind: 'professional-enquiry' },
    });
    expect(both.data?.items.map((t) => t.ticket_id)).toEqual([ticketId(2)]);
    const none = await listTickets({ client: owner, query: { state: 'closed', kind: 'support' } });
    expect(none.data?.items).toEqual([]);
  });

  it('refuses a state or kind the contract does not name', async () => {
    const { baseUrl } = await up();
    const headers = { 'x-owner-credential': OWNER_CREDENTIAL };
    expect((await raw(baseUrl, 'GET', '/tickets?state=pending', { headers })).status).toBe(400);
    expect((await raw(baseUrl, 'GET', '/tickets?kind=billing', { headers })).status).toBe(400);
  });
});

describe('a ticket moves through its lifecycle', () => {
  it('walks new, replied, closed and shows each change in its history', async () => {
    const { baseUrl } = await up();
    const made = await raise(baseUrl, ENQUIRY);
    const replied = await move(baseUrl, made.ticket_id, 'replied');
    expect(replied.status).toBe(200);
    expect(replied.data).toMatchObject({
      state: 'replied',
      updated_at: '2026-01-01T00:03:00.000Z',
    });
    const closed = await move(baseUrl, made.ticket_id, 'closed');
    expect(closed.status).toBe(200);
    expect(closed.data?.state).toBe('closed');
    expect(closed.data?.created_at).toBe(made.created_at);
    expect(closed.data?.history).toEqual([
      { state: 'new', at: '2026-01-01T00:02:00.000Z' },
      { state: 'replied', at: '2026-01-01T00:03:00.000Z' },
      { state: 'closed', at: '2026-01-01T00:04:00.000Z' },
    ]);
    expect((await owned(baseUrl))[0]).toEqual(closed.data);
  });

  it('reopens a closed ticket, and reopens a replied one the customer wrote to again', async () => {
    const { baseUrl } = await up();
    const made = await raise(baseUrl, SUPPORT);
    await move(baseUrl, made.ticket_id, 'closed');
    expect((await move(baseUrl, made.ticket_id, 'open')).data?.state).toBe('open');
    await move(baseUrl, made.ticket_id, 'replied');
    const again = await move(baseUrl, made.ticket_id, 'open');
    expect(again.data?.history.map((h) => h.state)).toEqual([
      'new',
      'closed',
      'open',
      'replied',
      'open',
    ]);
  });

  it('refuses every move the lifecycle does not allow, 409, and changes nothing', async () => {
    const allowed: Readonly<Record<TicketState, readonly TicketState[]>> = {
      new: ['open', 'replied', 'closed'],
      open: ['replied', 'closed'],
      replied: ['open', 'closed'],
      closed: ['open'],
    };
    // One ticket per starting state, brought there by an allowed path.
    const path: Readonly<Record<TicketState, readonly TicketState[]>> = {
      new: [],
      open: ['open'],
      replied: ['replied'],
      closed: ['closed'],
    };
    for (const from of TICKET_STATES) {
      for (const to of TICKET_STATES) {
        if (allowed[from].includes(to)) continue;
        const { baseUrl } = await up();
        const made = await raise(baseUrl, SUPPORT);
        for (const step of path[from]) await move(baseUrl, made.ticket_id, step);
        const before = (await owned(baseUrl))[0];
        const refused = await move(baseUrl, made.ticket_id, to);
        expect(refused.status, `${from} -> ${to}`).toBe(409);
        expect(refused.error, `${from} -> ${to}`).toEqual({ code: 'illegal-transition' });
        expect((await owned(baseUrl))[0], `${from} -> ${to}`).toEqual(before);
        await running?.close();
        running = undefined;
      }
    }
  });

  it('refuses a ticket that does not exist with 404, and a malformed id with 400', async () => {
    const { baseUrl } = await up();
    const missing = await move(baseUrl, ticketId(99), 'open');
    expect(missing.status).toBe(404);
    expect(missing.error).toEqual({ code: 'ticket-not-found' });
    const headers = { 'x-owner-credential': OWNER_CREDENTIAL, 'content-type': 'application/json' };
    const bad = await raw(baseUrl, 'POST', '/tickets/not-an-id/state', {
      headers,
      body: JSON.stringify({ state: 'open' }),
    });
    expect(bad.status).toBe(400);
  });

  it('refuses a state the contract does not name', async () => {
    const { baseUrl } = await up();
    const made = await raise(baseUrl, SUPPORT);
    const headers = { 'x-owner-credential': OWNER_CREDENTIAL, 'content-type': 'application/json' };
    for (const body of [{ state: 'pending' }, { state: 'Open' }, {}, { state: 'open', extra: 1 }]) {
      const result = await raw(baseUrl, 'POST', `/tickets/${made.ticket_id}/state`, {
        headers,
        body: JSON.stringify(body),
      });
      // An unknown field is dropped by the generated server, never acted on.
      expect(result.status, JSON.stringify(body)).toBe(
        'state' in body && body.state === 'open' ? 200 : 400
      );
    }
  });
});

describe('who may do what', () => {
  it('lets only the owner list and move tickets', async () => {
    const { baseUrl } = await up();
    const made = await raise(baseUrl, SUPPORT);
    const tenant = { 'x-tenant-credential': TENANT_A_CREDENTIAL };
    const json = { ...tenant, 'content-type': 'application/json' };
    expect((await raw(baseUrl, 'GET', '/tickets', { headers: tenant })).status).toBe(403);
    expect((await raw(baseUrl, 'GET', '/tickets')).status).toBe(401);
    const attempt = await raw(baseUrl, 'POST', `/tickets/${made.ticket_id}/state`, {
      headers: json,
      body: JSON.stringify({ state: 'closed' }),
    });
    expect(attempt.status).toBe(403);
    expect((await owned(baseUrl))[0]?.state).toBe('new');
  });

  it('lets a tenant raise a ticket on its own path only', async () => {
    const { baseUrl } = await up();
    const result = await createTicket({
      client: clientWith(baseUrl, TENANT_B_CREDENTIAL),
      path: { tenant: TENANT_A },
      body: SUPPORT,
    });
    expect(result.response?.status).toBe(403);
    const owner = await createTicket({
      client: clientWith(baseUrl, OWNER_CREDENTIAL),
      path: { tenant: TENANT_A },
      body: SUPPORT,
    });
    expect(owner.response?.status).toBe(403);
    expect(await owned(baseUrl)).toEqual([]);
  });

  it('refuses a ticket the contract does not describe', async () => {
    const { baseUrl } = await up();
    const headers = {
      'x-tenant-credential': TENANT_A_CREDENTIAL,
      'content-type': 'application/json',
    };
    const bodies: unknown[] = [
      { ...SUPPORT, kind: 'essentials' },
      { ...SUPPORT, kind: 'billing' },
      { ...SUPPORT, message: '' },
      { ...SUPPORT, message: 'x'.repeat(1001) },
      { ...SUPPORT, contact: 'a@' },
      { ...SUPPORT, contact: `${'a'.repeat(250)}@example.test` },
      { kind: 'support', contact: 'a@example.test' },
      { kind: 'support', message: 'TEST_MESSAGE' },
    ];
    for (const body of bodies) {
      const result = await raw(baseUrl, 'POST', `/tenants/${TENANT_A}/tickets`, {
        headers,
        body: JSON.stringify(body),
      });
      expect(result.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(await owned(baseUrl)).toEqual([]);
  });

  it('keeps one tenant out of another tenant`s count', async () => {
    const { baseUrl } = await up();
    for (let n = 0; n < 50; n += 1) await raise(baseUrl, SUPPORT);
    const other = await raise(baseUrl, SUPPORT, TENANT_B, TENANT_B_CREDENTIAL);
    expect(other.tenant_id).toBe(TENANT_B);
  });
});

describe('a tenant cannot hold more than fifty tickets that are not closed', () => {
  it('refuses the fifty-first, and takes one again when one is closed', async () => {
    const { baseUrl } = await up();
    const first = await raise(baseUrl, SUPPORT);
    for (let n = 1; n < 50; n += 1) await raise(baseUrl, SUPPORT);
    const refused = await createTicket({
      client: clientWith(baseUrl, TENANT_A_CREDENTIAL),
      path: { tenant: TENANT_A },
      body: SUPPORT,
    });
    expect(refused.response?.status).toBe(409);
    expect(refused.error).toEqual({ code: 'ticket-limit' });
    expect(await owned(baseUrl)).toHaveLength(50);

    await move(baseUrl, first.ticket_id, 'closed');
    expect((await raise(baseUrl, SUPPORT)).state).toBe('new');
    expect(await owned(baseUrl)).toHaveLength(51);
  });
});
