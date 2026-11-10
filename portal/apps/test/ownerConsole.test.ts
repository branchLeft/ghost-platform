import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALLBACK_PATH } from 'ghost-platform-identity/dist/index.js';
import { OwnerDb } from 'ghost-platform-portal-data/owner';
import {
  createFixture,
  ORG_A,
  ORG_B,
  TENANT_A,
  TENANT_B,
  type Fixture,
} from '../../data/test/helpers.js';
import { supportAccessRequest } from '../../data/src/schema.js';
import { createOwnerConsole } from '../src/console/app.js';
import { Browser, serve, type Running } from './browser.js';
import {
  CLIENT_CONSOLE,
  CLIENT_PORTAL,
  FakeIssuer,
  ISSUER,
  jwks,
  mint,
  NOW,
  OWNER_ORG,
  PROJECT_ID,
} from './idp.js';

let fixture: Fixture;
let app: Running;
let failing = false;
let ownerData: OwnerDb;
const issuer = new FakeIssuer();

beforeAll(async () => {
  fixture = await createFixture();
  const db = new OwnerDb(fixture.owner);
  ownerData = db;
  await db.recordReading(
    TENANT_A,
    [
      'drain_sidecar_drained 0\ndrain_sidecar_ghost_version_info{version="6.55.0"} 1\ndrain_sidecar_version_match 1',
    ],
    new Date('2026-10-01T10:00:00Z')
  );
  await db.recordReading(
    TENANT_B,
    [
      'drain_sidecar_drained 1',
      'drain_sidecar_drained 0\ndrain_sidecar_ghost_version_info{version="6.54.0"} 1\ndrain_sidecar_version_match 0',
    ],
    new Date('2026-10-02T10:00:00Z')
  );
  app = await serve((origin) =>
    createOwnerConsole({
      issuer: ISSUER,
      clientId: CLIENT_CONSOLE,
      projectId: PROJECT_ID,
      publicOrigin: origin,
      ownerOrgId: OWNER_ORG,
      db: {
        listHealth: () => (failing ? Promise.reject(new Error('down')) : db.listHealth()),
        listSupportRequests: () => db.listSupportRequests(),
      } as OwnerDb,
      secureCookies: false,
      clock: () => NOW,
      fetch: issuer.fetch,
      fetchKeys: async () => jwks,
    })
  );
});

afterAll(async () => {
  await app.close();
  await fixture.close();
});

const ownerToken = (): string => mint({ org: OWNER_ORG, client: CLIENT_CONSOLE, role: 'owner' });

describe('the owner console', () => {
  it('shows the owner every registered tenant', async () => {
    const browser = new Browser(app.origin);
    expect((await browser.finish(issuer.issue(ownerToken()))).status).toBe(302);
    const page = await browser.request('/');
    expect(page.status).toBe(200);
    expect(page.body).toContain(TENANT_A);
    expect(page.body).toContain(TENANT_B);
    expect(page.body).toContain('OWNER_CONSOLE');
  });

  it("shows the owner every tenant's health and version, with the reverted tenant's mismatch dated", async () => {
    const browser = new Browser(app.origin);
    await browser.finish(issuer.issue(ownerToken()));
    const page = await browser.request('/');
    expect(page.body).toContain('6.55.0');
    expect(page.body).toContain('VERSION_MATCHES');
    expect(page.body).toContain('6.54.0');
    expect(page.body).toContain('VERSION_MISMATCH');
    expect(page.body).toContain('MISMATCH_SINCE');
    expect(page.body).toContain('2026-10-02');
  });

  it('lists every tenant asking for support access, oldest first, in one page', async () => {
    const browser = new Browser(app.origin);
    await browser.finish(issuer.issue(ownerToken()));
    const empty = await browser.request('/');
    expect(empty.body).toContain('SUPPORT_REQUESTS_PENDING 0');
    await fixture.adminDb
      .insert(supportAccessRequest)
      .values({ tenantId: TENANT_B, requestedAt: new Date('2027-01-14T09:00:00Z') });
    await fixture.adminDb
      .insert(supportAccessRequest)
      .values({ tenantId: TENANT_A, requestedAt: new Date('2027-01-14T10:00:00Z') });
    try {
      const page = await browser.request('/');
      expect(page.body).toContain('SUPPORT_REQUESTS_PENDING 2');
      expect(page.body).toContain('2027-01-14T09:00:00.000Z');
      expect(page.body).toContain('2027-01-14T10:00:00.000Z');
      const queue = page.body.slice(page.body.indexOf('SUPPORT_REQUESTS_PENDING'));
      expect(queue.indexOf(TENANT_B)).toBeGreaterThan(-1);
      expect(queue.indexOf(TENANT_B)).toBeLessThan(queue.indexOf(TENANT_A));
      expect(await ownerData.listSupportRequests()).toHaveLength(2);
    } finally {
      await fixture.adminDb.delete(supportAccessRequest);
    }
  });

  it('shows the queue with no control to act on a request', async () => {
    const browser = new Browser(app.origin);
    await browser.finish(issuer.issue(ownerToken()));
    await fixture.adminDb.insert(supportAccessRequest).values({ tenantId: TENANT_A });
    try {
      const page = await browser.request('/');
      expect(page.body).toContain('SUPPORT_REQUESTS_PENDING 1');
      expect(page.body).not.toMatch(/<form method="post" action="(?!\/logout)/);
    } finally {
      await fixture.adminDb.delete(supportAccessRequest);
    }
  });

  // Browsers do not isolate cookies by port, so on loopback development the
  // tenant portal and this console share one cookie jar. Each must keep to its
  // own names, or signing in to one would replace the other's session. The
  // tenant portal's names are asserted in tenantPortal.test.ts and
  // loginStart.test.ts (`portal_session`, `portal_login`); this pins the
  // console to a disjoint pair.
  it('keeps its own cookie names, disjoint from the tenant portal', async () => {
    const browser = new Browser(app.origin);
    const state = await browser.begin();
    expect(browser.cookie('console_login')).toBeDefined();
    expect(browser.cookie('portal_login')).toBeUndefined();
    const done = await browser.request(
      `${CALLBACK_PATH}?code=${issuer.issue(ownerToken())}&state=${state}`
    );
    expect(done.status).toBe(302);
    expect(browser.cookie('console_session')).toBeDefined();
    expect(browser.cookie('portal_session')).toBeUndefined();
    expect(browser.cookie('portal_login')).toBeUndefined();
  });

  it('sends an unsigned visitor to sign in', async () => {
    const reply = await new Browser(app.origin).request('/');
    expect(reply.status).toBe(302);
    expect(reply.location).toBe('/login');
  });

  it('refuses a tenant administrator holding the tenant role, in either client', async () => {
    for (const client of [CLIENT_PORTAL, CLIENT_CONSOLE]) {
      const browser = new Browser(app.origin);
      const token = mint({ org: ORG_A, client, role: 'tenant-admin' });
      expect((await browser.finish(issuer.issue(token))).status).toBe(403);
      expect((await browser.request('/')).status).toBe(302);
    }
  });

  it('refuses a tenant organisation even if its user were handed the owner role', async () => {
    const browser = new Browser(app.origin);
    const token = mint({ org: ORG_B, client: CLIENT_CONSOLE, role: 'owner' });
    expect((await browser.finish(issuer.issue(token))).status).toBe(403);
  });

  it("refuses the owner's token issued to the portal client", async () => {
    const browser = new Browser(app.origin);
    const token = mint({ org: OWNER_ORG, client: CLIENT_PORTAL, role: 'owner' });
    expect((await browser.finish(issuer.issue(token))).status).toBe(403);
    expect((await browser.request('/')).status).toBe(302);
  });

  it('refuses the owner organisation holding only the tenant role', async () => {
    const browser = new Browser(app.origin);
    const token = mint({ org: OWNER_ORG, client: CLIENT_CONSOLE, role: 'tenant-admin' });
    expect((await browser.finish(issuer.issue(token))).status).toBe(403);
  });

  it('answers a failing read with a fixed error and no detail', async () => {
    const browser = new Browser(app.origin);
    await browser.finish(issuer.issue(ownerToken()));
    failing = true;
    const reply = await browser.request('/');
    failing = false;
    expect(reply.status).toBe(500);
    expect(reply.body).toBe('FAILED');
  });
});
