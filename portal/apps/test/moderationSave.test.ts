import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from 'ghost-platform-portal-data/tenant';
import {
  createFixture,
  ORG_A,
  ORG_B,
  TENANT_A,
  TENANT_B,
  type Fixture,
} from '../../data/test/helpers.js';
import { createTenantPortal } from '../src/tenant/app.js';
import { ABSOLUTE_CHECKS, COMMENT_CHECKS, FLOOR_CHECKS } from '../src/tenant/moderationSettings.js';
import { Browser, serve, type Running } from './browser.js';
import { CLIENT_PORTAL, FakeIssuer, ISSUER, jwks, mint, NOW, PROJECT_ID } from './idp.js';

let fixture: Fixture;
let app: Running;
const issuer = new FakeIssuer();

const token = (org: string, subject: string): string =>
  mint({ org, client: CLIENT_PORTAL, role: 'tenant-admin', subject });

async function signedIn(org: string, subject: string): Promise<Browser> {
  const browser = new Browser(app.origin);
  expect((await browser.finish(issuer.issue(token(org, subject)))).status).toBe(302);
  return browser;
}

/** The form the page posts: a sensitivity for each check and `enabled` for each that is on. */
function form(overrides: Record<string, string | null> = {}, extra = ''): string {
  const fields = new URLSearchParams();
  for (const id of COMMENT_CHECKS) {
    fields.set(`comment.${id}.enabled`, '1');
    fields.set(`comment.${id}.sensitivity`, 'medium');
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) fields.delete(key);
    else fields.set(key, value);
  }
  return fields.toString() + extra;
}

function save(browser: Browser, body: string, origin = app.origin) {
  return browser.request('/moderation/save', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

/** What is stored for one tenant, read as the administrator through the ORM, by check. */
const rows = async (tenant: string) =>
  (
    await fixture.adminDb.query.moderationSetting.findMany({
      where: (table, { eq }) => eq(table.tenantId, tenant),
      orderBy: (table, { asc }) => asc(table.checkId),
    })
  ).map((row) => ({
    check_id: row.checkId,
    enabled: row.enabled,
    sensitivity: row.sensitivity,
    updated_by: row.updatedBy,
  }));

beforeAll(async () => {
  fixture = await createFixture();
  // Tenant A is a real tenant and tenant B is a demo slot.
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
      tenantKind: async (scope) => (scope.tenantId === TENANT_A ? 'REAL' : 'DEMO'),
    })
  );
});

afterAll(async () => {
  await app.close();
  await fixture.close();
});

describe('the save route, before anything is saved', () => {
  it('needs a sign-in', async () => {
    const reply = await save(new Browser(app.origin), form());
    expect(reply.status).toBe(302);
    expect(reply.location).toBe('/login');
  });

  it('refuses a post from another origin or from none', async () => {
    const a = await signedIn(ORG_A, 'user-a');
    expect((await save(a, form(), 'https://evil.example')).status).toBe(403);
    const none = await a.request('/moderation/save', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form(),
    });
    expect(none.status).toBe(403);
    expect(await rows(TENANT_A)).toEqual([]);
  });

  it('refuses a huge body', async () => {
    const a = await signedIn(ORG_A, 'user-a');
    expect((await save(a, form({}, `&pad=${'x'.repeat(5000)}`))).status).toBe(413);
  });
});

describe('saving the comment checks', () => {
  it('saves the form for the signed-in real tenant and shows it back', async () => {
    const a = await signedIn(ORG_A, 'user-a');
    const reply = await save(
      a,
      form({
        'comment.spam.enabled': null,
        'comment.spam.sensitivity': 'high',
        'comment.off_topic.sensitivity': 'low',
      })
    );
    expect(reply.status).toBe(303);
    expect(reply.location).toBe('/moderation');
    const saved = await rows(TENANT_A);
    expect(saved).toHaveLength(COMMENT_CHECKS.length);
    expect(saved.find((r) => r.check_id === 'spam')).toMatchObject({
      enabled: false,
      sensitivity: 'high',
      updated_by: 'user-a',
    });
    expect(saved.find((r) => r.check_id === 'off_topic')).toMatchObject({
      enabled: true,
      sensitivity: 'low',
    });
    const page = await a.request('/moderation');
    expect(page.body).not.toContain('SETTINGS_NOT_YET_SAVED');
    expect(page.body).toMatch(/name="comment\.spam\.enabled" value="1">/);
    expect(page.body).toMatch(/<option value="high" selected>/);
  });

  it('replaces the saved values on a second save', async () => {
    const a = await signedIn(ORG_A, 'user-a2');
    expect((await save(a, form())).status).toBe(303);
    const saved = await rows(TENANT_A);
    expect(saved).toHaveLength(COMMENT_CHECKS.length);
    expect(saved.every((r) => r.enabled && r.sensitivity === 'medium')).toBe(true);
    expect(saved.every((r) => r.updated_by === 'user-a2')).toBe(true);
  });

  it('writes for the session tenant alone: a form naming another tenant is refused whole', async () => {
    const a = await signedIn(ORG_A, 'user-a');
    const before = await rows(TENANT_A);
    const reply = await save(
      a,
      form({ 'comment.spam.sensitivity': 'low' }, `&tenant_id=${TENANT_B}&organisation_id=${ORG_B}`)
    );
    expect(reply.status).toBe(400);
    expect(await rows(TENANT_A)).toEqual(before);
    expect(await rows(TENANT_B)).toEqual([]);
  });
});

describe('a demo slot (control case)', () => {
  it('cannot save, and sees no controls', async () => {
    const b = await signedIn(ORG_B, 'user-b');
    expect((await save(b, form())).status).toBe(400);
    expect(await rows(TENANT_B)).toEqual([]);
    const page = await b.request('/moderation');
    expect(page.body).toContain('DEMO_NO_MODERATION_SETTINGS');
    expect(page.body).not.toContain('/moderation/save');
  });
});

describe('lowering the floor through a request (control case)', () => {
  const targets = [...FLOOR_CHECKS, ...ABSOLUTE_CHECKS];
  const spellings = (id: string): [string, string][] => [
    [`comment.${id}.enabled`, '0'],
    [`comment.${id}.sensitivity`, 'low'],
    [`floor.${id}.enabled`, '0'],
    [`article.${id}.enabled`, '0'],
    [id, 'off'],
  ];

  it.each(targets.flatMap((id) => spellings(id).map(([key, value]) => [id, key, value] as const)))(
    'refuses %s posted as %s=%s, and nothing else in the request is saved',
    async (_id, key, value) => {
      const a = await signedIn(ORG_A, 'user-a-floor');
      const before = await rows(TENANT_A);
      const reply = await save(
        a,
        form({ 'comment.spam.enabled': null, 'comment.spam.sensitivity': 'high' }) +
          `&${encodeURIComponent(key)}=${encodeURIComponent(value)}`
      );
      expect(reply.status).toBe(400);
      expect(await rows(TENANT_A)).toEqual(before);
    }
  );

  it('never renders an input for a floor or absolute check on the page', async () => {
    const a = await signedIn(ORG_A, 'user-a');
    const page = await a.request('/moderation');
    for (const id of targets) {
      expect(page.body).not.toMatch(new RegExp(`<(input|select)[^>]*name="[^"]*${id}`));
    }
  });
});
