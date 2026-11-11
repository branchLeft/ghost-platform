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
const issuer = new FakeIssuer();

beforeAll(async () => {
  fixture = await createFixture();
  const db = new OwnerDb(fixture.owner);
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
