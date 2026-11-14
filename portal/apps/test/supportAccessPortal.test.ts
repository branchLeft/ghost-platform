import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { supportAccessRequest } from '../../data/src/schema.js';
import {
  READING_POLICY_OPEN,
  deleteReading,
  readingRow,
  requestRowText,
  whileLoosened,
} from '../../data/test/supportAccessAdmin.js';
import { createTenantPortal } from '../src/tenant/app.js';
import { Browser, serve, type Running } from './browser.js';
import { CLIENT_PORTAL, FakeIssuer, ISSUER, jwks, mint, NOW, PROJECT_ID } from './idp.js';

const issuer = new FakeIssuer();
let fixture: Fixture;
let owner: OwnerDb;
let app: Running;

const seconds = (offset: number): Date => new Date((NOW + offset) * 1000);
/** What only tenant A's reading puts on a page, and what only tenant B's does. */
const DEADLINE_A = seconds(4 * 3600);
const DEADLINE_B = seconds(2 * 3600 + 1800);
const ONLY_A = DEADLINE_A.toISOString();
const ONLY_B = DEADLINE_B.toISOString();

const open = (deadline: Date) => ({
  state: 'open' as const,
  lane: 'consented' as const,
  grantedAt: seconds(0),
  deadline,
});
const closed = { state: 'closed' as const, lane: null, grantedAt: null, deadline: null };

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

const requests = async () =>
  (await fixture.adminDb.select().from(supportAccessRequest)).map((row) => row.tenantId).sort();

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
  await fixture.adminDb.delete(supportAccessRequest);
  await owner.recordSupportAccess(TENANT_A, open(DEADLINE_A), seconds(-30));
  await owner.recordSupportAccess(TENANT_B, open(DEADLINE_B), seconds(-30));
});

describe('the support-access page', () => {
  it('needs a sign-in', async () => {
    const reply = await new Browser(app.origin).request('/site-access');
    expect(reply.status).toBe(302);
    expect(reply.location).toBe('/login');
  });

  it('is in the navigation', async () => {
    const page = await (await signedIn(ORG_A)).request('/');
    expect(page.body).toContain('NAV_SITE_ACCESS');
    expect(page.body).toContain('href="/site-access"');
  });

  it("shows tenant A its own open state and deadline and nothing of B's", async () => {
    const page = await (await signedIn(ORG_A)).request('/site-access');
    expect(page.status).toBe(200);
    expect(page.body).toContain('SUPPORT_ACCESS_STATE_OPEN');
    expect(page.body).toContain(ONLY_A);
    expect(page.body).not.toContain(ONLY_B);
  });

  it("shows tenant B its own deadline and nothing of A's", async () => {
    const page = await (await signedIn(ORG_B)).request('/site-access');
    expect(page.body).toContain(ONLY_B);
    expect(page.body).not.toContain(ONLY_A);
  });

  it('shows a closed reading as closed, with no deadline', async () => {
    await owner.recordSupportAccess(TENANT_A, closed, seconds(-30));
    const page = await (await signedIn(ORG_A)).request('/site-access');
    expect(page.body).toContain('SUPPORT_ACCESS_STATE_CLOSED');
    expect(page.body).not.toContain('SUPPORT_ACCESS_DEADLINE');
  });

  it('control case: a tenant with no reading is unknown, never closed', async () => {
    await deleteReading(fixture, TENANT_A);
    const page = await (await signedIn(ORG_A)).request('/site-access');
    expect(page.body).toContain('SUPPORT_ACCESS_STATE_UNKNOWN');
    expect(page.body).not.toContain('SUPPORT_ACCESS_STATE_CLOSED');
    expect(page.body).not.toContain('SUPPORT_ACCESS_STATE_OPEN');
  });

  it('control case: a reading that has gone stale is unknown, whatever it said', async () => {
    for (const reading of [closed, open(DEADLINE_A)]) {
      await owner.recordSupportAccess(TENANT_A, reading, seconds(-3600));
      const page = await (await signedIn(ORG_A)).request('/site-access');
      expect(page.body).toContain('SUPPORT_ACCESS_STATE_UNKNOWN');
      expect(page.body).not.toContain('SUPPORT_ACCESS_STATE_CLOSED');
      expect(page.body).not.toContain(ONLY_A);
    }
  });

  it('control case: a reading dated ahead of the clock is unknown', async () => {
    await owner.recordSupportAccess(TENANT_A, closed, seconds(3600));
    const page = await (await signedIn(ORG_A)).request('/site-access');
    expect(page.body).toContain('SUPPORT_ACCESS_STATE_UNKNOWN');
    expect(page.body).not.toContain('SUPPORT_ACCESS_STATE_CLOSED');
  });

  it('still serves A when the request names B in the path, query and headers', async () => {
    const browser = await signedIn(ORG_A);
    const page = await browser.request(`/site-access?tenant_id=${TENANT_B}&org=${ORG_B}`, {
      headers: { 'x-tenant-id': TENANT_B, 'x-organisation-id': ORG_B },
    });
    expect(page.body).toContain(ONLY_A);
    expect(page.body).not.toContain(ONLY_B);
  });

  it('control case: with the database policy opened, B’s deadline reaches A’s page', async () => {
    // Tenant B is bound; the loosened policy also hands it A's row, first.
    await whileLoosened(fixture, READING_POLICY_OPEN, async () => {
      const page = await (await signedIn(ORG_B)).request('/site-access');
      expect(page.body).toContain(ONLY_A);
    });
    const page = await (await signedIn(ORG_B)).request('/site-access');
    expect(page.body).not.toContain(ONLY_A);
  });
});

describe('the request button', () => {
  it('records the signed-in tenant’s request and nothing else', async () => {
    const browser = await signedIn(ORG_A);
    const reply = await post(browser, '/site-access/request');
    expect(reply.status).toBe(303);
    expect(reply.location).toBe('/site-access');
    expect(await requests()).toEqual([TENANT_A]);
    const page = await browser.request('/site-access');
    expect(page.body).toContain('SUPPORT_ACCESS_REQUEST_SENT');
    expect(page.body).toContain('SUPPORT_REQUEST_STATUS_OPEN');
    expect(page.body).not.toContain('<form method="post" action="/site-access/request">');
  });

  it('files an open request whatever status the body asks for', async () => {
    const browser = await signedIn(ORG_A);
    const body = new URLSearchParams({ status: 'dealt_with' }).toString();
    expect((await post(browser, '/site-access/request', body)).status).toBe(303);
    const rows = await fixture.adminDb.select().from(supportAccessRequest);
    expect(rows.map((row) => row.status)).toEqual(['open']);
  });

  it('shows the status word once the owner has dealt with the request, with the button again', async () => {
    const browser = await signedIn(ORG_A);
    await post(browser, '/site-access/request');
    expect(await owner.markSupportRequestDealtWith(TENANT_A)).toBe(true);
    const page = await browser.request('/site-access');
    expect(page.body).toContain('SUPPORT_REQUEST_STATUS_DEALT_WITH');
    expect(page.body).not.toContain('SUPPORT_REQUEST_STATUS_OPEN');
    expect(page.body).toContain('<form method="post" action="/site-access/request">');
  });

  it('files a new open request after one is dealt with, and shows only the latest status', async () => {
    const browser = await signedIn(ORG_A);
    await post(browser, '/site-access/request');
    await owner.markSupportRequestDealtWith(TENANT_A);
    expect((await post(browser, '/site-access/request')).status).toBe(303);
    const rows = await fixture.adminDb.select().from(supportAccessRequest);
    expect(rows.map((row) => row.status).sort()).toEqual(['dealt_with', 'open']);
    const page = await browser.request('/site-access');
    expect(page.body).toContain('SUPPORT_REQUEST_STATUS_OPEN');
    expect(page.body).not.toContain('SUPPORT_REQUEST_STATUS_DEALT_WITH');
    expect(page.body).not.toContain('<form method="post" action="/site-access/request">');
    await post(browser, '/site-access/request');
    expect(await fixture.adminDb.select().from(supportAccessRequest)).toHaveLength(2);
  });

  it('offers the tenant no way to mark its own request', async () => {
    const browser = await signedIn(ORG_A);
    await post(browser, '/site-access/request');
    const reply = await post(browser, '/support-requests/dealt-with', `tenant=${TENANT_A}`);
    expect(reply.status).toBe(404);
    const rows = await fixture.adminDb.select().from(supportAccessRequest);
    expect(rows.map((row) => row.status)).toEqual(['open']);
  });

  it('takes the tenant from the session: a body naming B, with text, files A’s row only', async () => {
    const browser = await signedIn(ORG_A);
    const body = new URLSearchParams({
      tenant_id: TENANT_B,
      tenantId: TENANT_B,
      organisation_id: ORG_B,
      reason: 'FREE_TEXT_NEVER_STORED',
      requested_at: '1999-01-01T00:00:00Z',
    }).toString();
    expect((await post(browser, '/site-access/request', body)).status).toBe(303);
    expect(await requests()).toEqual([TENANT_A]);
    const stored = await requestRowText(fixture);
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toContain('FREE_TEXT_NEVER_STORED');
    expect(stored[0]).not.toContain('1999');
  });

  it('a second press records nothing more', async () => {
    const browser = await signedIn(ORG_A);
    await post(browser, '/site-access/request');
    await post(browser, '/site-access/request');
    expect(await requests()).toEqual([TENANT_A]);
  });

  it('opens nothing and closes nothing: the reading is as it was', async () => {
    const browser = await signedIn(ORG_A);
    await post(browser, '/site-access/request');
    expect(await readingRow(fixture, TENANT_A)).toMatchObject({
      state: 'open',
      observedAt: seconds(-30),
    });
    const page = await browser.request('/site-access');
    expect(page.body).toContain('SUPPORT_ACCESS_STATE_OPEN');
  });

  it('refuses a post from another origin or from none, and a visitor who is not signed in', async () => {
    const browser = await signedIn(ORG_A);
    expect((await post(browser, '/site-access/request', '', 'https://evil.example')).status).toBe(
      403
    );
    const none = await browser.request('/site-access/request', { method: 'POST' });
    expect(none.status).toBe(403);
    const lone = await post(new Browser(app.origin), '/site-access/request');
    expect(lone.status).toBe(302);
    expect(lone.location).toBe('/login');
    expect(await requests()).toEqual([]);
  });

  it('is a post route only', async () => {
    const reply = await (await signedIn(ORG_A)).request('/site-access/request');
    expect(reply.status).toBe(405);
  });

  it('keeps A’s request from B’s page', async () => {
    await post(await signedIn(ORG_A), '/site-access/request');
    const page = await (await signedIn(ORG_B)).request('/site-access');
    expect(page.body).not.toContain('SUPPORT_ACCESS_REQUEST_SENT');
    expect(page.body).toContain('<form method="post" action="/site-access/request">');
  });
});

describe('nothing in the portal can reach a tenant host', () => {
  const roots = ['../src/', '../../data/src/'].map((path) =>
    fileURLToPath(new URL(path, import.meta.url))
  );
  const files = (directory: string): string[] =>
    readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
    });
  // What the owner's host-side tool and the transports into a tenant host are
  // called: none of it belongs in portal source.
  const FORBIDDEN =
    /revoke|break-?glass|docker\.sock|child_process|\bssh2?\b|ssh-keygen|net\.connect|tls\.connect/i;

  it('has no revoke, no break-glass, no socket, no process and no ssh in its source', () => {
    const offenders = roots
      .flatMap(files)
      .filter((file) => FORBIDDEN.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
