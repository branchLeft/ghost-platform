import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALLBACK_PATH } from 'ghost-platform-identity/dist/index.js';
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

const ORG_UNREGISTERED = 'org-not-in-register';

let fixture: Fixture;
let app: Running;
let now = NOW;

let ownerDb: OwnerDb;

const portalOn = (origin: string, db: TenantDb) =>
  createTenantPortal({
    issuer: ISSUER,
    clientId: CLIENT_PORTAL,
    projectId: PROJECT_ID,
    publicOrigin: origin,
    allowedOrgIds: new Set([ORG_A, ORG_B, ORG_UNREGISTERED]),
    db,
    secureCookies: false,
    clock: () => now,
    fetch: issuer.fetch,
    fetchKeys: async () => jwks,
    sessionSeconds: 600,
  });

/** What only tenant B's reading can put on a page: its version, its check and its dated mismatch. */
const showsB = (body: string): boolean =>
  ['6.54.0', 'VERSION_MISMATCH', '2026-10-02'].some((marker) => body.includes(marker));

/**
 * The sabotage, kept as a control case: the health read taken from the owner's
 * cross-tenant query (the latest reading across every tenant, no tenant key).
 */
const crossTenantDb = (): TenantDb => {
  const real = new TenantDb(fixture.tenant);
  const leakyHealth = async () => {
    const all = await ownerDb.listHealth();
    return (
      all
        .map((t) => t.health)
        .filter((h) => h !== null)
        .at(-1) ?? null
    );
  };
  // Everything but the health read is the real tenant data layer, so the
  // landing page keeps working whenever the portal reads something new.
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'ownHealth') return leakyHealth;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};
const issuer = new FakeIssuer();

const tenantToken = (org: string, client = CLIENT_PORTAL, role = 'tenant-admin'): string =>
  mint({ org, client, role });

async function signIn(browser: Browser, token: string) {
  return browser.finish(issuer.issue(token));
}

beforeAll(async () => {
  fixture = await createFixture();
  const owner = new OwnerDb(fixture.owner);
  await owner.recordReading(
    TENANT_A,
    [
      'drain_sidecar_drained 0\ndrain_sidecar_ghost_version_info{version="6.55.0"} 1\ndrain_sidecar_version_match 1',
    ],
    new Date('2026-10-01T10:00:00Z')
  );
  await owner.recordReading(
    TENANT_B,
    [
      'drain_sidecar_drained 0\ndrain_sidecar_ghost_version_info{version="6.54.0"} 1\ndrain_sidecar_version_match 0',
    ],
    new Date('2026-10-02T10:00:00Z')
  );
  ownerDb = owner;
  app = await serve((origin) => portalOn(origin, new TenantDb(fixture.tenant)));
});

afterAll(async () => {
  await app.close();
  await fixture.close();
});

describe('the tenant portal sign-in', () => {
  it('sends the browser to the sign-in service with a code-and-PKCE request for its own client', async () => {
    const reply = await new Browser(app.origin).request('/login');
    const target = new URL(reply.location ?? '');
    expect(reply.status).toBe(302);
    expect(`${target.origin}${target.pathname}`).toBe(`${ISSUER}/oauth/v2/authorize`);
    expect(target.searchParams.get('client_id')).toBe(CLIENT_PORTAL);
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('redirect_uri')).toBe(`${app.origin}${CALLBACK_PATH}`);
    expect(target.searchParams.get('scope')).toContain(`org:project:id:${PROJECT_ID}:aud`);
  });

  it("shows tenant A's administrator tenant A and nothing of B", async () => {
    const browser = new Browser(app.origin);
    expect((await signIn(browser, tenantToken(ORG_A))).status).toBe(302);
    const page = await browser.request('/');
    expect(page.status).toBe(200);
    expect(page.body).toContain(TENANT_A);
    expect(page.body).not.toContain(TENANT_B);
  });

  it("shows tenant B's administrator tenant B and nothing of A", async () => {
    const browser = new Browser(app.origin);
    await signIn(browser, tenantToken(ORG_B));
    const page = await browser.request('/');
    expect(page.body).toContain(TENANT_B);
    expect(page.body).not.toContain(TENANT_A);
  });

  it("shows tenant A its own health and version, and nothing of B's reading", async () => {
    const browser = new Browser(app.origin);
    await signIn(browser, tenantToken(ORG_A));
    const page = await browser.request('/');
    expect(page.body).toContain('SITE_HEALTH');
    expect(page.body).toContain('HEALTHY');
    expect(page.body).toContain('6.55.0');
    expect(page.body).toContain('VERSION_MATCHES');
    expect(showsB(page.body)).toBe(false);
  });

  it("shows tenant B its own dated mismatch, and nothing of A's reading", async () => {
    const browser = new Browser(app.origin);
    await signIn(browser, tenantToken(ORG_B));
    const page = await browser.request('/');
    expect(page.body).toContain('6.54.0');
    expect(page.body).toContain('VERSION_MISMATCH');
    expect(page.body).toContain('2026-10-02');
    expect(page.body).not.toContain('6.55.0');
    expect(page.body).not.toContain('VERSION_MATCHES');
  });

  it('still serves A when the request names B in the path, query, headers and cookies', async () => {
    const browser = new Browser(app.origin);
    await signIn(browser, tenantToken(ORG_A));
    const page = await browser.request(
      `/?tenant_id=${TENANT_B}&tenantId=${TENANT_B}&org=${ORG_B}&organisation_id=${ORG_B}`,
      {
        headers: {
          'x-tenant-id': TENANT_B,
          'x-organisation-id': ORG_B,
          'x-forwarded-host': `${TENANT_B}.example.test`,
          cookie: `tenant_id=${TENANT_B}; portal_org=${ORG_B}; ${
            ['portal_session'].map((name) => `${name}=${browser.cookie(name) ?? ''}`)[0]
          }`,
        },
      }
    );
    expect(page.status).toBe(200);
    expect(page.body).toContain(TENANT_A);
    expect(page.body).not.toContain(TENANT_B);
  });

  it('refuses an organisation the portal admits but the register does not know', async () => {
    const browser = new Browser(app.origin);
    const reply = await signIn(browser, tenantToken(ORG_UNREGISTERED));
    expect(reply.status).toBe(403);
    expect(browser.cookie('portal_session')).toBeUndefined();
    expect((await browser.request('/')).status).toBe(302);
  });

  it('refuses the owner organisation, even holding the tenant role and the portal client', async () => {
    const browser = new Browser(app.origin);
    const reply = await signIn(browser, tenantToken(OWNER_ORG));
    expect(reply.status).toBe(403);
    expect((await browser.request('/')).status).toBe(302);
  });

  it("refuses a console token: the owner's organisation, owner role, console client", async () => {
    const browser = new Browser(app.origin);
    const reply = await signIn(browser, tenantToken(OWNER_ORG, CLIENT_CONSOLE, 'owner'));
    expect(reply.status).toBe(403);
    expect(browser.cookie('portal_session')).toBeUndefined();
  });

  it("refuses a tenant's own token issued to the console client", async () => {
    const browser = new Browser(app.origin);
    const reply = await signIn(browser, tenantToken(ORG_A, CLIENT_CONSOLE));
    expect(reply.status).toBe(403);
    expect((await browser.request('/')).status).toBe(302);
  });

  it('refuses a tenant token that does not hold the tenant role', async () => {
    const browser = new Browser(app.origin);
    expect((await signIn(browser, tenantToken(ORG_A, CLIENT_PORTAL, 'owner'))).status).toBe(403);
  });

  it('refuses a callback that did not start here, or whose state differs, or that repeats', async () => {
    const lone = new Browser(app.origin);
    expect(
      (await lone.request(`${CALLBACK_PATH}?code=${issuer.issue(tenantToken(ORG_A))}&state=x`))
        .status
    ).toBe(400);

    const browser = new Browser(app.origin);
    const code = issuer.issue(tenantToken(ORG_A));
    expect((await browser.finish(code, 'a-different-state')).status).toBe(400);

    const again = new Browser(app.origin);
    const state = await again.begin();
    const good = issuer.issue(tenantToken(ORG_A));
    expect((await again.request(`${CALLBACK_PATH}?code=${good}&state=${state}`)).status).toBe(302);
    expect(
      (
        await again.request(
          `${CALLBACK_PATH}?code=${issuer.issue(tenantToken(ORG_A))}&state=${state}`
        )
      ).status
    ).toBe(400);

    const empty = new Browser(app.origin);
    const emptyState = await empty.begin();
    expect((await empty.request(`${CALLBACK_PATH}?state=${emptyState}`)).status).toBe(400);
  });

  it('refuses when the token endpoint fails, refuses the code, or returns no token', async () => {
    for (const mode of ['down', 'refuse', 'empty'] as const) {
      issuer.mode = mode;
      const browser = new Browser(app.origin);
      expect((await signIn(browser, tenantToken(ORG_A))).status).toBe(403);
      expect(browser.cookie('portal_session')).toBeUndefined();
    }
    issuer.mode = 'ok';
  });

  it('refuses a forged token', async () => {
    const browser = new Browser(app.origin);
    const [header, payload] = tenantToken(ORG_A).split('.');
    expect((await signIn(browser, `${header}.${payload}.AAAA`)).status).toBe(403);
  });
});

describe('the control case for the tenant health page', () => {
  it("goes red when the page is rendered from the owner's cross-tenant query", async () => {
    const leaky = await serve((origin) => portalOn(origin, crossTenantDb()));
    try {
      const browser = new Browser(leaky.origin);
      await signIn(browser, tenantToken(ORG_A));
      const page = await browser.request('/');
      // The same detector the real test uses for "A never sees B" fires here.
      expect(showsB(page.body)).toBe(true);
    } finally {
      await leaky.close();
    }
  });
});

describe('the tenant portal session', () => {
  it('ends when it expires, and a token that expires sooner ends it sooner', async () => {
    const browser = new Browser(app.origin);
    await signIn(browser, tenantToken(ORG_A));
    expect((await browser.request('/')).status).toBe(200);
    now += 601;
    expect((await browser.request('/')).status).toBe(302);
    now = NOW;

    const short = new Browser(app.origin);
    await signIn(
      short,
      mint({ org: ORG_A, client: CLIENT_PORTAL, role: 'tenant-admin', exp: NOW + 100 })
    );
    now += 101;
    expect((await short.request('/')).status).toBe(302);
    now = NOW;
  });

  it('is ended by signing out, which a foreign origin cannot do', async () => {
    const browser = new Browser(app.origin);
    await signIn(browser, tenantToken(ORG_A));
    expect(
      (
        await browser.request('/logout', {
          method: 'POST',
          headers: { origin: 'https://evil.example' },
        })
      ).status
    ).toBe(403);
    expect((await browser.request('/')).status).toBe(200);
    expect(
      (await browser.request('/logout', { method: 'POST', headers: { origin: app.origin } })).status
    ).toBe(302);
    expect((await browser.request('/')).status).toBe(302);
    expect((await browser.request('/logout', { method: 'POST' })).status).toBe(302);
  });

  it('is never read from a header or a query: a made-up session id gets nothing', async () => {
    const browser = new Browser(app.origin);
    const reply = await browser.request('/?session=abc', {
      headers: { cookie: 'portal_session=abc', authorization: `Bearer ${tenantToken(ORG_A)}` },
    });
    expect(reply.status).toBe(302);
    expect(reply.location).toBe('/login');
  });
});

describe('the tenant portal surface', () => {
  it('answers health, the stylesheet, unknown paths and wrong methods', async () => {
    const browser = new Browser(app.origin);
    expect((await browser.request('/healthz')).body).toBe('ok');
    expect((await browser.request('/shell.css')).headers.get('content-type')).toBe('text/css');
    expect((await browser.request('/nope')).status).toBe(404);
    expect((await browser.request('/__proto__')).status).toBe(404);
    expect((await browser.request('/logout')).status).toBe(405);
    expect((await browser.request('/', { method: 'POST' })).status).toBe(405);
  });

  it('sends security headers and renders placeholder strings only', async () => {
    const browser = new Browser(app.origin);
    await signIn(browser, tenantToken(ORG_A));
    const page = await browser.request('/');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.body).toContain('LANDING_PLACEHOLDER');
    expect(page.body).toContain('TENANT_PORTAL');
  });
});
