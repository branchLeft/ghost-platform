import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProvisioningStore } from '../../src/service/store.js';
import { raw } from '../support/mockHarness.js';
import {
  OWNER_CREDENTIAL,
  TENANT_A,
  TENANT_A_CREDENTIAL,
  makeRig,
  type Rig,
} from '../support/serviceHarness.js';

let rig: Rig;
beforeEach(() => {
  rig = makeRig();
});
afterEach(async () => {
  await rig.cleanup();
});

const tenant = { 'x-tenant-credential': TENANT_A_CREDENTIAL, 'content-type': 'application/json' };
const owner = { 'x-owner-credential': OWNER_CREDENTIAL, 'content-type': 'application/json' };
const SUPPORT = JSON.stringify({
  kind: 'support',
  contact: 'a@example.test',
  message: 'TEST_MESSAGE',
});

interface Held {
  ticket_id: string;
  state: string;
  history: { state: string }[];
}

describe('the real service keeps its tickets', () => {
  it('keeps a ticket and every move of it across a restart', async () => {
    const first = await rig.start();
    const made = await raw(first.baseUrl, 'POST', `/tenants/${TENANT_A}/tickets`, {
      headers: tenant,
      body: SUPPORT,
    });
    expect(made.status).toBe(201);
    const id = (made.json as Held).ticket_id;
    for (const state of ['open', 'replied']) {
      const moved = await raw(first.baseUrl, 'POST', `/tickets/${id}/state`, {
        headers: owner,
        body: JSON.stringify({ state }),
      });
      expect(moved.status).toBe(200);
    }
    await first.close();

    const second = await rig.start();
    const listed = await raw(second.baseUrl, 'GET', '/tickets', { headers: owner });
    const items = (listed.json as { items: Held[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.state).toBe('replied');
    expect(items[0]?.history.map((h) => h.state)).toEqual(['new', 'open', 'replied']);

    const closed = await raw(second.baseUrl, 'POST', `/tickets/${id}/state`, {
      headers: owner,
      body: JSON.stringify({ state: 'closed' }),
    });
    expect(closed.status).toBe(200);
    const illegal = await raw(second.baseUrl, 'POST', `/tickets/${id}/state`, {
      headers: owner,
      body: JSON.stringify({ state: 'new' }),
    });
    expect([illegal.status, illegal.json]).toEqual([409, { code: 'illegal-transition' }]);
  });

  it('keeps the ticket an Essentials request made across a restart', async () => {
    const first = await rig.start();
    await raw(first.baseUrl, 'POST', `/tenants/${TENANT_A}/promotion-requests`, {
      headers: tenant,
      body: JSON.stringify({ tier: 'essentials' }),
    });
    await first.close();
    const second = await rig.start();
    const listed = await raw(second.baseUrl, 'GET', '/tickets?kind=essentials', { headers: owner });
    expect((listed.json as { items: unknown[] }).items).toHaveLength(1);
  });

  it('starts on a state written before tickets existed, with none', async () => {
    const first = await rig.start();
    await raw(first.baseUrl, 'POST', `/tenants/${TENANT_A}/promotion-requests`, {
      headers: tenant,
      body: JSON.stringify({ tier: 'essentials' }),
    });
    await first.close();
    const path = join(rig.files.state, 'state.json');
    const old = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    delete old['tickets'];
    writeFileSync(path, `${JSON.stringify(old)}\n`, { mode: 0o600 });

    const second = await rig.start();
    const listed = await raw(second.baseUrl, 'GET', '/tickets', { headers: owner });
    expect(listed.json).toEqual({ items: [] });
    const made = await raw(second.baseUrl, 'POST', `/tenants/${TENANT_A}/tickets`, {
      headers: tenant,
      body: SUPPORT,
    });
    expect(made.status).toBe(201);
  });

  it('refuses a state whose ticket is not one', async () => {
    const first = await rig.start();
    await raw(first.baseUrl, 'POST', `/tenants/${TENANT_A}/tickets`, {
      headers: tenant,
      body: SUPPORT,
    });
    await first.close();
    const path = join(rig.files.state, 'state.json');
    const damaged = JSON.parse(readFileSync(path, 'utf8')) as { tickets: { state: string }[] };
    damaged.tickets[0]!.state = 'resolved';
    writeFileSync(path, `${JSON.stringify(damaged)}\n`, { mode: 0o600 });
    await expect(rig.start()).rejects.toThrow('state');
  });

  it('a write that fails refuses the call and leaves the ticket unrecorded or unmoved', async () => {
    const running = await rig.start();
    const made = await raw(running.baseUrl, 'POST', `/tenants/${TENANT_A}/tickets`, {
      headers: tenant,
      body: SUPPORT,
    });
    const id = (made.json as Held).ticket_id;
    const blocker = join(rig.files.state, `state.json.${String(process.pid)}.tmp`);
    mkdirSync(blocker);

    const refusedMove = await raw(running.baseUrl, 'POST', `/tickets/${id}/state`, {
      headers: owner,
      body: JSON.stringify({ state: 'closed' }),
    });
    expect(refusedMove.status).toBe(500);
    const refusedMake = await raw(running.baseUrl, 'POST', `/tenants/${TENANT_A}/tickets`, {
      headers: tenant,
      body: SUPPORT,
    });
    expect(refusedMake.status).toBe(500);

    rmSync(blocker, { recursive: true });
    const listed = await raw(running.baseUrl, 'GET', '/tickets', { headers: owner });
    const items = (listed.json as { items: Held[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.state).toBe('new');
    expect(items[0]?.history).toHaveLength(1);
  });
});

describe('the store undoes a ticket change that cannot be written down', () => {
  it('forgets a ticket, an Essentials request and its ticket, and a move', () => {
    let failing = false;
    const store = new ProvisioningStore({
      onChange: () => {
        if (failing) throw new Error('disk');
      },
    });
    store.seedDemoTenant(TENANT_A);
    const made = store.createTicket(TENANT_A, 'support', {
      contact: 'a@example.test',
      message: 'm',
    });
    if (made.kind !== 'recorded') throw new Error('expected a recorded ticket');

    failing = true;
    expect(() => store.moveTicket(made.ticket.ticket_id, 'open')).toThrow('disk');
    expect(() =>
      store.createTicket(TENANT_A, 'support', { contact: 'a@example.test', message: 'm' })
    ).toThrow('disk');
    expect(() => store.createRequest(TENANT_A, 'essentials')).toThrow('disk');
    failing = false;

    expect(store.listTickets(undefined, undefined)).toEqual([made.ticket]);
    expect(store.listRequests(undefined)).toEqual([]);
  });
});
