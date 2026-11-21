import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OwnerDb } from 'ghost-platform-portal-data/owner';
import { TenantDb } from 'ghost-platform-portal-data/tenant';
import {
  createFixture,
  ORG_A,
  ORG_B,
  TENANT_A,
  TENANT_B,
  type Fixture,
} from '../../data/test/helpers.js';
import { tenantErasureRequest } from '../../data/src/schema.js';
import {
  markDestroyedWithoutMoment,
  whileMomentCheckDropped,
} from '../../data/test/erasureAdmin.js';
import { createTenantPortal } from '../src/tenant/app.js';
import { Browser, serve, type Running } from './browser.js';
import { problemsAfterKeyDestroyed, problemsBeforeKeyDestroyed } from './erasureHonesty.js';
import { CLIENT_PORTAL, FakeIssuer, ISSUER, jwks, mint, NOW, PROJECT_ID } from './idp.js';

const issuer = new FakeIssuer();
let fixture: Fixture;
let owner: OwnerDb;
let app: Running;

const token = (org: string): string =>
  mint({ org, client: CLIENT_PORTAL, role: 'tenant-admin', subject: `user-${org}` });

async function signedIn(org: string): Promise<Browser> {
  const browser = new Browser(app.origin);
  expect((await browser.finish(issuer.issue(token(org)))).status).toBe(302);
  return browser;
}

const post = (browser: Browser, path: string, body = '', origin = app.origin) =>
  browser.request(path, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

const rows = () => fixture.adminDb.select().from(tenantErasureRequest);

beforeAll(async () => {
  fixture = await createFixture();
  owner = new OwnerDb(fixture.owner);
  app = await serve((origin) =>
    createTenantPortal({
      issuer: ISSUER,
      clientId: CLIENT_PORTAL,
      projectId: PROJECT_ID,
      publicOrigin: origin,
      allowedOrgIds: new Set([ORG_A, ORG_B]),
      db: new TenantDb(fixture.tenant),
      secureCookies: false,
      clock: () => NOW,
      fetch: issuer.fetch,
      fetchKeys: async () => jwks,
      sessionSeconds: 600,
    })
  );
});

afterAll(async () => {
  await app.close();
  await fixture.close();
});

beforeEach(async () => {
  await fixture.adminDb.delete(tenantErasureRequest);
});

describe('the erasure page', () => {
  it('needs a sign-in', async () => {
    const reply = await new Browser(app.origin).request('/erasure');
    expect(reply.status).toBe(302);
    expect(reply.location).toBe('/login');
  });

  it('is in the navigation', async () => {
    const page = await (await signedIn(ORG_A)).request('/');
    expect(page.body).toContain('NAV_ERASURE');
    expect(page.body).toContain('href="/erasure"');
  });

  it("says it is about the tenant's whole site and not a member's request, and offers one button", async () => {
    const page = await (await signedIn(ORG_A)).request('/erasure');
    expect(page.status).toBe(200);
    expect(page.body).toContain('ERASURE_SCOPE_WHOLE_SITE');
    expect(page.body).toContain('ERASURE_NOT_A_MEMBER_REQUEST');
    expect(page.body).toContain('action="/erasure/request"');
    expect(page.body).not.toContain('RESIDUAL');
    expect(page.body).not.toContain('<input');
  });

  it('a request files one row for the signed-in tenant, then says requested and nothing erased', async () => {
    const browser = await signedIn(ORG_A);
    const filed = await post(browser, '/erasure/request');
    expect(filed.status).toBe(303);
    expect(filed.location).toBe('/erasure');
    const stored = await rows();
    expect(stored.map((r) => [r.tenantId, r.status, r.keyDestroyedAt])).toEqual([
      [TENANT_A, 'requested', null],
    ]);
    const page = await browser.request('/erasure');
    expect(problemsBeforeKeyDestroyed(page.body, stored[0]!.requestedAt.toISOString())).toEqual([]);
  });

  it('control case: until the key is recorded destroyed the page never says the data is gone, however long it waits', async () => {
    const browser = await signedIn(ORG_A);
    await post(browser, '/erasure/request');
    const requestedAt = (await rows())[0]!.requestedAt.toISOString();
    // Asking again, reloading and waiting change nothing the page says.
    await post(browser, '/erasure/request');
    for (let i = 0; i < 3; i += 1) {
      const page = await browser.request('/erasure');
      expect(problemsBeforeKeyDestroyed(page.body, requestedAt)).toEqual([]);
    }
    expect(await rows()).toHaveLength(1);
  });

  it('nothing in the form names a tenant: a posted tenant id is ignored', async () => {
    const browser = await signedIn(ORG_A);
    await post(browser, '/erasure/request', `tenant=${TENANT_B}&tenant_id=${TENANT_B}`);
    expect((await rows()).map((r) => r.tenantId)).toEqual([TENANT_A]);
  });

  it("shows tenant B nothing of tenant A's request", async () => {
    await post(await signedIn(ORG_A), '/erasure/request');
    const page = await (await signedIn(ORG_B)).request('/erasure');
    expect(page.body).toContain('action="/erasure/request"');
    expect(page.body).not.toContain('ERASURE_STATUS_REQUESTED');
    expect(page.body).not.toContain(TENANT_A);
  });

  it('refuses a post from another origin and files nothing', async () => {
    const reply = await post(
      await signedIn(ORG_A),
      '/erasure/request',
      '',
      'https://other.example'
    );
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(await rows()).toHaveLength(0);
  });

  it('once the owner records the key destroyed, the page states the residual window, its reason, and no end', async () => {
    const browser = await signedIn(ORG_A);
    await post(browser, '/erasure/request');
    expect(await owner.recordKeyDestroyed(TENANT_A)).toBe(true);
    const [row] = await rows();
    const page = await browser.request('/erasure');
    expect(
      problemsAfterKeyDestroyed(
        page.body,
        row!.requestedAt.toISOString(),
        row!.keyDestroyedAt!.toISOString()
      )
    ).toEqual([]);
    expect(page.body).not.toContain('ERASURE_REQUEST_BUTTON');
  });

  it("control case: tenant A's key being recorded destroyed does not change tenant B's page", async () => {
    const a = await signedIn(ORG_A);
    const b = await signedIn(ORG_B);
    await post(a, '/erasure/request');
    await post(b, '/erasure/request');
    await owner.recordKeyDestroyed(TENANT_A);
    const [rowB] = (await rows()).filter((r) => r.tenantId === TENANT_B);
    const page = await b.request('/erasure');
    expect(problemsBeforeKeyDestroyed(page.body, rowB!.requestedAt.toISOString())).toEqual([]);
  });

  it('a stored row that says destroyed without a moment is shown as requested', async () => {
    const browser = await signedIn(ORG_A);
    await post(browser, '/erasure/request');
    const [row] = await rows();
    // The table refuses this row; it is made by removing the check for the length of the probe.
    await whileMomentCheckDropped(fixture, async () => {
      await markDestroyedWithoutMoment(fixture);
      const page = await browser.request('/erasure');
      expect(problemsBeforeKeyDestroyed(page.body, row!.requestedAt.toISOString())).toEqual([]);
    });
  });
});
