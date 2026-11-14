import { afterEach, describe, expect, it } from 'vitest';
import {
  approvePromotionRequest,
  createPromotionRequest,
  getDemo,
  getTenant,
  listPromotionRequests,
} from '../../src/generated/index.js';
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

async function up(overrides?: Parameters<typeof startMock>[0]): Promise<RunningMock> {
  running = await startMock(overrides);
  return running;
}

describe('the promotion journey, through the generated client and server', () => {
  it('from a bound tenant: see the demo, ask, approve, see the site', async () => {
    const { baseUrl } = await up();
    const tenant = clientWith(baseUrl, TENANT_A_CREDENTIAL);
    const owner = clientWith(baseUrl, OWNER_CREDENTIAL);

    const demo = await getDemo({ client: tenant, path: { tenant: TENANT_A } });
    expect(demo.response?.status).toBe(200);
    expect(demo.data).toEqual({
      demo_id: '00000000-0000-4000-8000-000000000001',
      address: 'demo-1.example.test',
      state: 'LIVE',
      expires_at: '2026-01-15T00:00:00.000Z',
    });

    const asked = await createPromotionRequest({
      client: tenant,
      path: { tenant: TENANT_A },
      body: { tier: 'essentials' },
    });
    expect(asked.response?.status).toBe(201);
    expect(asked.data).toMatchObject({ tier: 'essentials', state: 'pending', approval: null });

    const queue = await listPromotionRequests({ client: owner, query: { state: 'pending' } });
    expect(queue.data?.items.map((item) => item.request_id)).toEqual([asked.data?.request_id]);

    const approved = await approvePromotionRequest({
      client: owner,
      path: { id: asked.data?.request_id ?? '' },
    });
    expect(approved.response?.status).toBe(200);
    expect(approved.data?.state).toBe('approved');
    expect(approved.data?.approval).toMatchObject({
      tenant_id: TENANT_A,
      scopes: ['setup', 'web-address', 'first-deploy'],
    });

    const after = await listPromotionRequests({ client: owner, query: { state: 'pending' } });
    expect(after.data).toEqual({ items: [] });
    const site = await getTenant({ client: tenant, path: { tenant: TENANT_A } });
    expect(site.data).toMatchObject({
      tenant_id: TENANT_A,
      tier: 'essentials',
      state: 'live',
      invoice_ref: expect.stringMatching(/^MOCK_INVOICE_REF_/) as unknown,
      hostnames: [expect.stringMatching(/\.example\.test$/) as unknown],
    });
    const demoAfter = await getDemo({ client: tenant, path: { tenant: TENANT_A } });
    expect(demoAfter.data?.state).toBe('PROMOTED');
  });

  it('stays provisioning until settled when asked not to settle on approve', async () => {
    const { baseUrl, mock } = await up({ settleOnApprove: false });
    const tenant = clientWith(baseUrl, TENANT_A_CREDENTIAL);
    const owner = clientWith(baseUrl, OWNER_CREDENTIAL);
    const asked = await createPromotionRequest({
      client: tenant,
      path: { tenant: TENANT_A },
      body: { tier: 'essentials' },
    });
    await approvePromotionRequest({ client: owner, path: { id: asked.data?.request_id ?? '' } });
    const during = await getTenant({ client: tenant, path: { tenant: TENANT_A } });
    expect(during.data).toMatchObject({
      tier: 'essentials',
      state: 'provisioning',
      invoice_ref: null,
    });
    mock.store.settle(TENANT_A);
    const after = await getTenant({ client: tenant, path: { tenant: TENANT_A } });
    expect(after.data?.state).toBe('live');
    // Settling a tenant that is not there, or not promoted, is a no-op.
    mock.store.settle('99999999-9999-4999-8999-999999999999');
    mock.store.settle(TENANT_B);
    expect(mock.store.getTenant(TENANT_B)?.tier).toBe('demo');
  });

  it('lists requests oldest first, and filters by state', async () => {
    let tick = 0;
    const { baseUrl } = await up({
      now: () => {
        tick += 1;
        return new Date(Date.UTC(2026, 0, 1, 0, 0, tick));
      },
    });
    const owner = clientWith(baseUrl, OWNER_CREDENTIAL);
    for (const [credential, tenant] of [
      [TENANT_B_CREDENTIAL, TENANT_B],
      [TENANT_A_CREDENTIAL, TENANT_A],
    ] as const) {
      await createPromotionRequest({
        client: clientWith(baseUrl, credential),
        path: { tenant },
        body: { tier: 'essentials' },
      });
    }
    const all = await listPromotionRequests({ client: owner });
    expect(all.data?.items.map((item) => item.tenant_id)).toEqual([TENANT_B, TENANT_A]);
    const approvedOnly = await listPromotionRequests({
      client: owner,
      query: { state: 'approved' },
    });
    expect(approvedOnly.data?.items).toEqual([]);
  });
});

describe('asking for a tier', () => {
  it('records a professional enquiry, lists it, and refuses to approve it', async () => {
    const { baseUrl } = await up();
    const tenant = clientWith(baseUrl, TENANT_A_CREDENTIAL);
    const owner = clientWith(baseUrl, OWNER_CREDENTIAL);
    const asked = await createPromotionRequest({
      client: tenant,
      path: { tenant: TENANT_A },
      body: { tier: 'professional-enquiry' },
    });
    expect(asked.response?.status).toBe(201);
    const queue = await listPromotionRequests({ client: owner, query: { state: 'pending' } });
    expect(queue.data?.items).toHaveLength(1);

    const refused = await approvePromotionRequest({
      client: owner,
      path: { id: asked.data?.request_id ?? '' },
    });
    expect(refused.response?.status).toBe(409);
    expect(refused.error).toEqual({ code: 'not-approvable' });
    const site = await getTenant({ client: tenant, path: { tenant: TENANT_A } });
    expect(site.data).toMatchObject({ tier: 'demo', invoice_ref: null });
  });

  it('answers a repeat of the open request with that request, and the other tier with 409', async () => {
    const { baseUrl } = await up();
    const tenant = clientWith(baseUrl, TENANT_A_CREDENTIAL);
    const first = await createPromotionRequest({
      client: tenant,
      path: { tenant: TENANT_A },
      body: { tier: 'essentials' },
    });
    const again = await createPromotionRequest({
      client: tenant,
      path: { tenant: TENANT_A },
      body: { tier: 'essentials' },
    });
    expect(again.response?.status).toBe(201);
    expect(again.data).toEqual(first.data);
    const other = await createPromotionRequest({
      client: tenant,
      path: { tenant: TENANT_A },
      body: { tier: 'professional-enquiry' },
    });
    expect(other.response?.status).toBe(409);
    expect(other.error).toEqual({ code: 'request-already-open' });
  });

  it('refuses a demo that cannot be promoted', async () => {
    const { baseUrl, mock } = await up();
    mock.store.seedDemoTenant(TENANT_B, 'PURGED');
    const stuck = await createPromotionRequest({
      client: clientWith(baseUrl, TENANT_B_CREDENTIAL),
      path: { tenant: TENANT_B },
      body: { tier: 'essentials' },
    });
    expect(stuck.response?.status).toBe(409);
    expect(stuck.error).toEqual({ code: 'demo-not-promotable' });
  });

  it('answers 404 for a tenant the service holds nothing for', async () => {
    const strangerId = '33333333-3333-4333-8333-333333333333';
    const { baseUrl } = await up({
      credentials: {
        owner: OWNER_CREDENTIAL,
        tenants: new Map([['TEST_STRANGER_CREDENTIAL', strangerId]]),
      },
      tenants: [],
    });
    const client = clientWith(baseUrl, 'TEST_STRANGER_CREDENTIAL');
    const noDemo = await getDemo({ client, path: { tenant: strangerId } });
    expect(noDemo.response?.status).toBe(404);
    expect(noDemo.error).toEqual({ code: 'demo-not-found' });
    const noTenant = await getTenant({ client, path: { tenant: strangerId } });
    expect(noTenant.error).toEqual({ code: 'tenant-not-found' });
    const noAsk = await createPromotionRequest({
      client,
      path: { tenant: strangerId },
      body: { tier: 'essentials' },
    });
    expect(noAsk.error).toEqual({ code: 'demo-not-found' });
  });
});

describe('approving', () => {
  it('a second approve changes nothing and answers the identical body and status', async () => {
    const { baseUrl } = await up();
    const tenant = clientWith(baseUrl, TENANT_A_CREDENTIAL);
    const owner = clientWith(baseUrl, OWNER_CREDENTIAL);
    const asked = await createPromotionRequest({
      client: tenant,
      path: { tenant: TENANT_A },
      body: { tier: 'essentials' },
    });
    const id = asked.data?.request_id ?? '';
    const first = await approvePromotionRequest({ client: owner, path: { id } });
    const siteAfterFirst = await getTenant({ client: tenant, path: { tenant: TENANT_A } });
    const second = await approvePromotionRequest({ client: owner, path: { id } });
    const third = await approvePromotionRequest({ client: owner, path: { id } });

    expect(second.response?.status).toBe(first.response?.status);
    expect(second.data).toEqual(first.data);
    expect(third.data).toEqual(first.data);
    expect(first.data?.approval?.approval_id).toBeDefined();
    const siteAfterThird = await getTenant({ client: tenant, path: { tenant: TENANT_A } });
    expect(siteAfterThird.data).toEqual(siteAfterFirst.data);
    const everything = await listPromotionRequests({ client: owner });
    expect(everything.data?.items).toHaveLength(1);
  });

  it('answers 404 for a request nobody made', async () => {
    const { baseUrl } = await up();
    const missing = await approvePromotionRequest({
      client: clientWith(baseUrl, OWNER_CREDENTIAL),
      path: { id: '44444444-4444-4444-8444-444444444444' },
    });
    expect(missing.response?.status).toBe(404);
    expect(missing.error).toEqual({ code: 'request-not-found' });
  });
});

describe('the two credentials', () => {
  it('a tenant credential is refused on list and approve, and changes nothing', async () => {
    const { baseUrl } = await up();
    const tenant = clientWith(baseUrl, TENANT_A_CREDENTIAL);
    const asked = await createPromotionRequest({
      client: tenant,
      path: { tenant: TENANT_A },
      body: { tier: 'essentials' },
    });
    const id = asked.data?.request_id ?? '';

    const list = await listPromotionRequests({ client: tenant });
    expect(list.response?.status).toBe(403);
    expect(list.error).toEqual({ code: 'forbidden' });
    const approve = await approvePromotionRequest({ client: tenant, path: { id } });
    expect(approve.response?.status).toBe(403);
    expect(approve.error).toEqual({ code: 'forbidden' });

    const pending = await listPromotionRequests({
      client: clientWith(baseUrl, OWNER_CREDENTIAL),
      query: { state: 'pending' },
    });
    expect(pending.data?.items).toHaveLength(1);
    expect(pending.data?.items[0]?.state).toBe('pending');
  });

  it('refuses a tenant credential presented in the owner header, and the reverse', async () => {
    const { baseUrl } = await up();
    const swapped = await raw(baseUrl, 'GET', '/promotion-requests', {
      headers: { 'X-Owner-Credential': TENANT_A_CREDENTIAL },
    });
    expect(swapped.status).toBe(403);
    // The tenant's own header, on both owner calls.
    const own = { 'X-Tenant-Credential': TENANT_A_CREDENTIAL };
    const listed = await raw(baseUrl, 'GET', '/promotion-requests', { headers: own });
    expect(listed.status).toBe(403);
    const approved = await raw(baseUrl, 'POST', `/promotion-requests/${TENANT_A}/approve`, {
      headers: own,
    });
    expect(approved.status).toBe(403);
    const reverse = await raw(baseUrl, 'GET', `/tenants/${TENANT_A}`, {
      headers: { 'X-Tenant-Credential': OWNER_CREDENTIAL },
    });
    expect(reverse.status).toBe(403);
  });

  it('refuses an owner credential on tenant calls', async () => {
    const { baseUrl } = await up();
    const owner = clientWith(baseUrl, OWNER_CREDENTIAL);
    const demo = await getDemo({ client: owner, path: { tenant: TENANT_A } });
    expect(demo.response?.status).toBe(403);
    const site = await getTenant({ client: owner, path: { tenant: TENANT_A } });
    expect(site.response?.status).toBe(403);
    const ask = await createPromotionRequest({
      client: owner,
      path: { tenant: TENANT_A },
      body: { tier: 'essentials' },
    });
    expect(ask.response?.status).toBe(403);
  });

  it('refuses one tenant credential on another tenant, and no or unknown credential with 401', async () => {
    const { baseUrl } = await up();
    const a = clientWith(baseUrl, TENANT_A_CREDENTIAL);
    const crossed = await getDemo({ client: a, path: { tenant: TENANT_B } });
    expect(crossed.response?.status).toBe(403);
    for (const credential of [undefined, 'TEST_NOT_ISSUED']) {
      const client = clientWith(baseUrl, credential);
      const demo = await getDemo({ client, path: { tenant: TENANT_A } });
      expect(demo.response?.status).toBe(401);
      const list = await listPromotionRequests({ client });
      expect(list.response?.status).toBe(401);
      const approve = await approvePromotionRequest({ client, path: { id: TENANT_A } });
      expect(approve.response?.status).toBe(401);
    }
    const unauthenticated = await raw(baseUrl, 'GET', '/promotion-requests', {
      headers: {
        'X-Owner-Credential': 'TEST_NOT_ISSUED',
        'X-Tenant-Credential': 'TEST_NOT_ISSUED',
      },
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.json).toEqual({ code: 'unauthenticated' });
  });
});

describe('what the spec forbids is refused by the generated server before a handler runs', () => {
  it('refuses a body, path or query the spec does not allow, with a 400 problem document', async () => {
    const { baseUrl } = await up();
    const headers = {
      'X-Tenant-Credential': TENANT_A_CREDENTIAL,
      'Content-Type': 'application/json',
    };
    const path = `/tenants/${TENANT_A}/promotion-requests`;
    for (const body of [
      JSON.stringify({ tier: 'platinum' }),
      JSON.stringify({}),
      '{not json',
      '',
    ]) {
      const res = await raw(baseUrl, 'POST', path, { headers, body });
      expect(res.status, body).toBe(400);
      expect(res.contentType, body).toBe('application/problem+json');
    }
    const badPath = await raw(baseUrl, 'GET', '/tenants/not-a-uuid/demo', { headers });
    expect(badPath.status).toBe(400);
    const badQuery = await raw(baseUrl, 'GET', '/promotion-requests?state=bogus', {
      headers: { 'X-Owner-Credential': OWNER_CREDENTIAL },
    });
    expect(badQuery.status).toBe(400);

    const queue = await listPromotionRequests({ client: clientWith(baseUrl, OWNER_CREDENTIAL) });
    expect(queue.data?.items).toEqual([]);
  });

  it('does not refuse an extra field, but never acts on it: the generated schema strips it', async () => {
    const { baseUrl, mock } = await up();
    const res = await raw(baseUrl, 'POST', `/tenants/${TENANT_A}/promotion-requests`, {
      headers: { 'X-Tenant-Credential': TENANT_A_CREDENTIAL, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'essentials', tenant_id: TENANT_B }),
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ tenant_id: TENANT_A });
    const owner = clientWith(baseUrl, OWNER_CREDENTIAL);
    const queue = await listPromotionRequests({ client: owner });
    expect(queue.data?.items.map((item) => item.tenant_id)).toEqual([TENANT_A]);
    expect(mock.store.listRequests(undefined)).toHaveLength(1);
  });

  it('answers 404 for a route the spec does not have', async () => {
    const { baseUrl } = await up();
    expect((await raw(baseUrl, 'DELETE', `/tenants/${TENANT_A}`)).status).toBe(404);
    expect((await raw(baseUrl, 'GET', '/promotion-requests/x/y/z')).status).toBe(404);
  });

  it('refuses to send a success body the spec forbids: the caller gets a 500 and the fault is reported', async () => {
    const { baseUrl, mock, errors } = await up();
    // The store is made to hold a demo the schema cannot describe.
    const demo = mock.store.getDemo(TENANT_A);
    expect(demo).toBeDefined();
    if (demo !== undefined) Object.assign(demo, { state: 'NOT_A_STATE' });
    const res = await raw(baseUrl, 'GET', `/tenants/${TENANT_A}/demo`, {
      headers: { 'X-Tenant-Credential': TENANT_A_CREDENTIAL },
    });
    expect(res.status).toBe(500);
    expect(errors).toHaveLength(1);
  });
});
