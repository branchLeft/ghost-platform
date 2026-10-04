import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  app = await serve((origin) =>
    createOwnerConsole({
      issuer: ISSUER,
      clientId: CLIENT_CONSOLE,
      projectId: PROJECT_ID,
      publicOrigin: origin,
      ownerOrgId: OWNER_ORG,
      db: {
        listTenants: () => (failing ? Promise.reject(new Error('down')) : db.listTenants()),
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
