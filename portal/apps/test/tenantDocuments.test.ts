import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OwnerDb } from 'ghost-platform-portal-data/owner';
import { TenantDb } from 'ghost-platform-portal-data/tenant';
import { createFixture, ORG_A, ORG_B, type Fixture } from '../../data/test/helpers.js';
import { createTenantPortal } from '../src/tenant/app.js';
import { Browser, serve, type Running } from './browser.js';
import { CLIENT_PORTAL, FakeIssuer, ISSUER, jwks, mint, NOW, PROJECT_ID } from './idp.js';

const at = (seconds: number): Date => new Date(seconds * 1000);
const DAY = 86_400;

let fixture: Fixture;
let owner: OwnerDb;
let app: Running;
let now = NOW;
const issuer = new FakeIssuer();

const token = (org: string, subject: string): string =>
  mint({ org, client: CLIENT_PORTAL, role: 'tenant-admin', subject, exp: NOW + 60 * DAY });

async function signedIn(org: string, subject: string): Promise<Browser> {
  const browser = new Browser(app.origin);
  expect((await browser.finish(issuer.issue(token(org, subject)))).status).toBe(302);
  return browser;
}

function accept(browser: Browser, fields: string, origin = app.origin) {
  return browser.request('/documents/accept', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: fields,
  });
}

beforeAll(async () => {
  fixture = await createFixture();
  owner = new OwnerDb(fixture.owner);
  const effective = at(NOW - 40 * DAY);
  const published = at(NOW - 80 * DAY);
  await owner.publishDocument(
    { kind: 'terms', title: 'TERMS_TITLE', body: 'TERMS_BODY_V1', effectiveAt: effective },
    published
  );
  await owner.publishDocument(
    {
      kind: 'subprocessors',
      title: 'SUBPROCESSORS_TITLE',
      body: 'SUBPROCESSORS_BODY',
      entries: [
        { name: 'HETZNER', purpose: 'PURPOSE_PLACEHOLDER' },
        { name: 'OVHCLOUD', purpose: 'PURPOSE_PLACEHOLDER' },
        { name: 'STRIPE', purpose: 'PURPOSE_PLACEHOLDER' },
      ],
      effectiveAt: effective,
    },
    published
  );
  app = await serve((origin) =>
    createTenantPortal({
      issuer: ISSUER,
      clientId: CLIENT_PORTAL,
      projectId: PROJECT_ID,
      publicOrigin: origin,
      allowedOrgIds: new Set([ORG_A, ORG_B]),
      db: new TenantDb(fixture.tenant),
      secureCookies: false,
      clock: () => now,
      fetch: issuer.fetch,
      fetchKeys: async () => jwks,
      sessionSeconds: 100 * DAY,
    })
  );
});

afterEach(() => {
  now = NOW;
});

afterAll(async () => {
  await app.close();
  await fixture.close();
});

describe('the documents page', () => {
  it('needs a sign-in', async () => {
    const lone = new Browser(app.origin);
    const page = await lone.request('/documents');
    expect(page.status).toBe(302);
    expect(page.location).toBe('/login');
  });

  it('shows each document in force with its version, date, marking and entries', async () => {
    const page = await (await signedIn(ORG_A, 'user-a')).request('/documents');
    expect(page.status).toBe(200);
    expect(page.body).toContain('TERMS_TITLE');
    expect(page.body).toContain('BEST_EFFORT_NOT_PROFESSIONALLY_REVIEWED');
    expect(page.body.match(/BEST_EFFORT_NOT_PROFESSIONALLY_REVIEWED/g)).toHaveLength(2);
    expect(page.body).toContain('2026-12-06');
    for (const name of ['HETZNER', 'OVHCLOUD', 'STRIPE']) expect(page.body).toContain(name);
    expect(page.body).toContain('ACCEPT_THIS_VERSION');
    expect(page.body).toContain('NOTHING_ACCEPTED_YET');
  });

  it('points the landing page at documents awaiting acceptance', async () => {
    const page = await (await signedIn(ORG_A, 'user-a')).request('/');
    expect(page.body).toContain('DOCUMENTS_AWAIT_ACCEPTANCE');
  });
});

describe('accepting a document', () => {
  it('refuses a post from another origin, from none, or with no sign-in', async () => {
    const a = await signedIn(ORG_A, 'user-a');
    expect((await accept(a, 'kind=terms&version=1', 'https://evil.example')).status).toBe(403);
    const noOrigin = await a.request('/documents/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'kind=terms&version=1',
    });
    expect(noOrigin.status).toBe(403);
    const lone = new Browser(app.origin);
    expect((await accept(lone, 'kind=terms&version=1')).location).toBe('/login');
    expect((await a.request('/documents')).body).toContain('NOTHING_ACCEPTED_YET');
  });

  it('refuses a version that is not in force, a kind that is not accepted, and a huge body', async () => {
    const a = await signedIn(ORG_A, 'user-a');
    expect((await accept(a, 'kind=terms&version=99')).status).toBe(400);
    expect((await accept(a, 'kind=subprocessors&version=1')).status).toBe(400);
    expect((await accept(a, 'kind=terms')).status).toBe(400);
    expect((await accept(a, 'version=1')).status).toBe(400);
    expect((await accept(a, `kind=terms&version=1&pad=${'x'.repeat(5000)}`)).status).toBe(413);
    expect((await a.request('/documents')).body).toContain('NOTHING_ACCEPTED_YET');
  });

  it('records the acceptance for the signed-in tenant alone, whatever the form names', async () => {
    const a = await signedIn(ORG_A, 'user-a');
    const reply = await accept(
      a,
      `kind=terms&version=1&tenant_id=${ORG_B}&organisation_id=${ORG_B}`
    );
    expect(reply.status).toBe(303);
    expect(reply.location).toBe('/documents');
    const pageA = await a.request('/documents');
    expect(pageA.body).toContain('TERMS VERSION 1 ACCEPTED_BY');
    expect(pageA.body).toContain('user-a');
    expect(pageA.body).not.toContain('ACCEPT_THIS_VERSION');
    expect((await a.request('/')).body).not.toContain('DOCUMENTS_AWAIT_ACCEPTANCE');

    const pageB = await (await signedIn(ORG_B, 'user-b')).request('/documents');
    expect(pageB.body).toContain('ACCEPT_THIS_VERSION');
    expect(pageB.body).toContain('NOTHING_ACCEPTED_YET');
    expect(pageB.body).not.toContain('user-a');
  });
});

describe('a new version', () => {
  it('asks the tenant again once it is in force, and shows the earlier acceptance unchanged', async () => {
    const a = await signedIn(ORG_A, 'user-a');
    await owner.publishDocument(
      {
        kind: 'terms',
        title: 'TERMS_TITLE_V2',
        body: 'TERMS_BODY_V2',
        effectiveAt: at(NOW + 10 * DAY),
      },
      at(NOW)
    );
    // Published, not in force: A is not asked yet.
    expect((await a.request('/')).body).not.toContain('DOCUMENTS_AWAIT_ACCEPTANCE');
    expect((await a.request('/documents')).body).not.toContain('TERMS_TITLE_V2');

    now = NOW + 11 * DAY;
    const landing = await a.request('/');
    expect(landing.body).toContain('DOCUMENTS_AWAIT_ACCEPTANCE');
    const page = await a.request('/documents');
    expect(page.body).toContain('TERMS_TITLE_V2');
    expect(page.body).toContain('ACCEPT_THIS_VERSION');
    expect(page.body).toContain('TERMS VERSION 1 ACCEPTED_BY');

    expect((await accept(a, 'kind=terms&version=1')).status).toBe(400);
    expect((await accept(a, 'kind=terms&version=2')).status).toBe(303);
    const after = await a.request('/documents');
    expect(after.body).not.toContain('ACCEPT_THIS_VERSION');
    expect(after.body).toContain('TERMS VERSION 1 ACCEPTED_BY');
    expect(after.body).toContain('TERMS VERSION 2 ACCEPTED_BY');
  });

  it('keeps a new sub-processor entry off the page until its notice has elapsed', async () => {
    const a = await signedIn(ORG_A, 'user-a');
    await owner.publishDocument(
      {
        kind: 'subprocessors',
        title: 'SUBPROCESSORS_TITLE',
        body: 'SUBPROCESSORS_BODY',
        entries: [
          { name: 'HETZNER', purpose: 'PURPOSE_PLACEHOLDER' },
          { name: 'NEWLY_ADDED_PLACEHOLDER', purpose: 'PURPOSE_PLACEHOLDER' },
        ],
        effectiveAt: at(NOW + 30 * DAY),
      },
      at(NOW)
    );
    expect((await a.request('/documents')).body).not.toContain('NEWLY_ADDED_PLACEHOLDER');
    now = NOW + 31 * DAY;
    const later = await a.request('/documents');
    expect(later.body).toContain('NEWLY_ADDED_PLACEHOLDER');
  });
});

describe('the tenant portal without an injected clock', () => {
  it('starts and answers, reading the real time only when it needs a date', async () => {
    const real = await serve((origin) =>
      createTenantPortal({
        issuer: ISSUER,
        clientId: CLIENT_PORTAL,
        projectId: PROJECT_ID,
        publicOrigin: origin,
        allowedOrgIds: new Set([ORG_A]),
        db: new TenantDb(fixture.tenant),
        secureCookies: false,
        fetch: issuer.fetch,
        fetchKeys: async () => jwks,
      })
    );
    try {
      expect((await new Browser(real.origin).request('/healthz')).body).toBe('ok');
    } finally {
      await real.close();
    }
  });
});
