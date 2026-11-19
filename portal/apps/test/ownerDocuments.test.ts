import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OwnerDb } from 'ghost-platform-portal-data/owner';
import { TenantDb } from 'ghost-platform-portal-data/tenant';
import { createFixture, ORG_A, type Fixture } from '../../data/test/helpers.js';
import { createOwnerConsole } from '../src/console/app.js';
import { createTenantPortal } from '../src/tenant/app.js';
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

// The document text is test text only; the owner's own is pasted at run time.
const DAY_MS = 86_400_000;

let fixture: Fixture;
let consoleApp: Running;
let tenantApp: Running;
const issuer = new FakeIssuer();

const post = (browser: Browser, origin: string, path: string, fields: Record<string, string>) =>
  browser.request(path, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });

const publish = (browser: Browser, fields: Record<string, string>) =>
  post(browser, consoleApp.origin, '/documents/publish', fields);

/**
 * The status of a post the console refuses as too large. It answers 413 and
 * stops reading, so a client still sending may see the connection reset
 * instead; either is a refusal, and a post that was taken answers 303.
 */
async function tooLarge(attempt: Promise<{ readonly status: number }>): Promise<number | 'reset'> {
  try {
    return (await attempt).status;
  } catch {
    return 'reset';
  }
}

async function ownerBrowser(): Promise<Browser> {
  const browser = new Browser(consoleApp.origin);
  const token = mint({ org: OWNER_ORG, client: CLIENT_CONSOLE, role: 'owner' });
  await browser.finish(issuer.issue(token));
  return browser;
}

async function tenantDocumentsPage(): Promise<string> {
  const browser = new Browser(tenantApp.origin);
  const token = mint({
    org: ORG_A,
    client: CLIENT_PORTAL,
    role: 'tenant-admin',
    subject: 'user-a',
  });
  await browser.finish(issuer.issue(token));
  return (await browser.request('/documents')).body;
}

async function versionsStored(): Promise<number> {
  const result = await fixture.admin.query<{ n: number }>(
    'select count(*)::int as n from portal.document_version'
  );
  return result.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  fixture = await createFixture();
  const owner = new OwnerDb(fixture.owner);
  consoleApp = await serve((origin) =>
    createOwnerConsole({
      issuer: ISSUER,
      clientId: CLIENT_CONSOLE,
      projectId: PROJECT_ID,
      publicOrigin: origin,
      ownerOrgId: OWNER_ORG,
      db: owner,
      secureCookies: false,
      clock: () => NOW,
      fetch: issuer.fetch,
      fetchKeys: async () => jwks,
    })
  );
  tenantApp = await serve((origin) =>
    createTenantPortal({
      issuer: ISSUER,
      clientId: CLIENT_PORTAL,
      projectId: PROJECT_ID,
      publicOrigin: origin,
      allowedOrgIds: new Set([ORG_A]),
      db: new TenantDb(fixture.tenant),
      secureCookies: false,
      clock: () => NOW,
      fetch: issuer.fetch,
      fetchKeys: async () => jwks,
    })
  );
});

afterAll(async () => {
  await consoleApp.close();
  await tenantApp.close();
  await fixture.close();
});

describe('publishing a document from the owner console', () => {
  it('shows a test tenant nothing before anything is published', async () => {
    expect(await tenantDocumentsPage()).not.toContain('TEST_TERMS_TITLE');
  });

  it('shows the pasted text, its version and effective date on the tenant documents page', async () => {
    const owner = await ownerBrowser();
    const reply = await publish(owner, {
      kind: 'terms',
      title: 'TEST_TERMS_TITLE',
      effective_date: '2026-12-01',
      body: 'TEST_TERMS_BODY_V1 <b>not markup</b>',
    });
    expect(reply.status).toBe(303);
    expect(reply.location).toBe('/documents/published');
    const page = await tenantDocumentsPage();
    expect(page).toContain('TEST_TERMS_TITLE');
    expect(page).toContain('TEST_TERMS_BODY_V1 &lt;b&gt;not markup&lt;/b&gt;');
    expect(page).toContain('2026-12-01');
    expect(page).toContain('<dt>VERSION</dt><dd>1</dd>');
    expect(page).toContain('ACCEPT_THIS_VERSION');
  });

  it('gives the next version the next number, whatever the form says', async () => {
    const owner = await ownerBrowser();
    const reply = await publish(owner, {
      kind: 'terms',
      title: 'TEST_TERMS_TITLE_V2',
      effective_date: '2026-12-02',
      body: 'TEST_TERMS_BODY_V2',
      version: '99',
      published_at: '2020-01-01',
    });
    expect(reply.status).toBe(303);
    const page = await tenantDocumentsPage();
    expect(page).toContain('TEST_TERMS_TITLE_V2');
    expect(page).toContain('<dt>VERSION</dt><dd>2</dd>');
    expect(page).not.toContain('<dd>99</dd>');
  });

  it('takes a document far larger than an ordinary form, and refuses one beyond its limit', async () => {
    const owner = await ownerBrowser();
    const body = `TEST_LONG_BODY_START ${'TEST_FILLER '.repeat(20_000)}TEST_LONG_BODY_END`;
    expect(body.length).toBeGreaterThan(200_000);
    const reply = await publish(owner, {
      kind: 'usage',
      title: 'TEST_USAGE_TITLE',
      effective_date: '2026-12-01',
      body,
    });
    expect(reply.status).toBe(303);
    const page = await tenantDocumentsPage();
    expect(page).toContain('TEST_LONG_BODY_START');
    expect(page).toContain('TEST_LONG_BODY_END');

    const before = await versionsStored();
    const huge = await tooLarge(
      publish(owner, {
        kind: 'usage',
        title: 'TEST_USAGE_TITLE',
        effective_date: '2026-12-01',
        body: 'x'.repeat(600_000),
      })
    );
    expect([413, 'reset']).toContain(huge);
    expect(await versionsStored()).toBe(before);
  });

  it('keeps the shell limit on every other action', async () => {
    const owner = await ownerBrowser();
    const reply = await tooLarge(
      post(owner, consoleApp.origin, '/support-requests/dealt-with', {
        tenant: 'x'.repeat(5000),
      })
    );
    expect([413, 'reset']).toContain(reply);
  });

  it('publishes nothing for a form that is incomplete or names an unknown kind or a date that is not one', async () => {
    const owner = await ownerBrowser();
    const whole = {
      kind: 'terms',
      title: 'TEST_REFUSED_TITLE',
      effective_date: '2026-12-01',
      body: 'TEST_REFUSED_BODY',
    };
    const before = await versionsStored();
    const refused: Record<string, string>[] = [
      { ...whole, kind: 'privacy' },
      { ...whole, kind: '' },
      { ...whole, title: '   ' },
      { ...whole, title: 'x'.repeat(201) },
      { ...whole, body: ' \n ' },
      { ...whole, effective_date: '2026-02-30' },
      { ...whole, effective_date: '' },
      { ...whole, kind: 'subprocessors' },
      { ...whole, kind: 'subprocessors', entries: 'TEST_NAME_WITHOUT_PURPOSE' },
    ];
    for (const fields of refused) {
      const reply = await publish(owner, fields);
      expect(reply.status).toBe(303);
      expect(reply.location).toBe('/documents/not-published');
    }
    expect((await owner.request('/documents/not-published')).body).toContain(
      'DOCUMENT_NOT_PUBLISHED'
    );
    expect(await versionsStored()).toBe(before);
    expect(await tenantDocumentsPage()).not.toContain('TEST_REFUSED_TITLE');
  });

  it('publishes a sub-processor list from NAME | PURPOSE lines, and not inside its notice', async () => {
    const owner = await ownerBrowser();
    const list = {
      kind: 'subprocessors',
      title: 'TEST_LIST_TITLE',
      body: 'TEST_LIST_BODY',
      entries: 'TEST_PROCESSOR_ONE | TEST_PURPOSE_ONE\nTEST_PROCESSOR_TWO | TEST_PURPOSE_TWO',
    };
    const before = await versionsStored();
    const inside = new Date(Date.now() + 10 * DAY_MS).toISOString().slice(0, 10);
    // The table refuses it, and the console says so without storing anything.
    const early = await publish(owner, { ...list, effective_date: inside });
    expect(early.status).toBe(303);
    expect(early.location).toBe('/documents/not-published');
    expect(await versionsStored()).toBe(before);

    const outside = new Date(Date.now() + 40 * DAY_MS).toISOString().slice(0, 10);
    expect((await publish(owner, { ...list, effective_date: outside })).status).toBe(303);
    expect(await versionsStored()).toBe(before + 1);
    const page = await tenantDocumentsPage();
    expect(page).toContain('TEST_LIST_TITLE');
    for (const text of ['TEST_PROCESSOR_ONE', 'TEST_PURPOSE_TWO']) expect(page).toContain(text);
  });
});
