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
import { DEMO_STATES } from '../../data/src/demoStates.js';
import { createTenantPortal } from '../src/tenant/app.js';
import type { ProvisioningSettings } from '../src/tenant/provisioningSettings.js';
import { Browser, serve, type Running } from './browser.js';
import { CLIENT_PORTAL, FakeIssuer, ISSUER, jwks, mint, NOW, PROJECT_ID } from './idp.js';
import {
  ambientRequestUrl,
  CREDENTIAL_A,
  CREDENTIAL_B,
  settingsFor,
  startApi,
  type RunningApi,
} from './provisioningRig.js';

const EXPIRES_A = '2026-01-15T00:00:00.000Z';

const issuer = new FakeIssuer();
let fixture: Fixture;
let api: RunningApi;
let lines: string[] = [];

/**
 * The portal, with the request in flight made ambient. The real screen is
 * never given the request and cannot reach it; this is what lets the same
 * isolation cases catch a screen that did (see tenantDemoSabotage.test.ts).
 */
const portalOn = (origin: string, provisioning: ProvisioningSettings | undefined) => {
  const portal = buildPortal(origin, provisioning);
  const handler: typeof portal = (request, response) =>
    ambientRequestUrl.run(request.url ?? '/', () => portal(request, response));
  return handler;
};

const buildPortal = (origin: string, provisioning: ProvisioningSettings | undefined) =>
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
    onError: (line) => lines.push(line),
    ...(provisioning === undefined ? {} : { provisioning }),
  });

const credentials = { [TENANT_A]: CREDENTIAL_A, [TENANT_B]: CREDENTIAL_B };

async function signedIn(app: Running, org: string): Promise<Browser> {
  const browser = new Browser(app.origin);
  await browser.finish(issuer.issue(mint({ org, client: CLIENT_PORTAL, role: 'tenant-admin' })));
  return browser;
}

/** A portal on its own port, for the cases that change what it is given. */
async function withPortal<T>(
  provisioning: ProvisioningSettings | undefined,
  run: (app: Running) => Promise<T>
): Promise<T> {
  const app = await serve((origin) => portalOn(origin, provisioning));
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

/** A provisioning API that answers with `response`, whatever it is asked. */
const answering =
  (response: () => Response): typeof fetch =>
  async () =>
    response();

const demoJson = (over: Record<string, unknown>): Response =>
  Response.json({
    demo_id: '00000000-0000-4000-8000-0000000000aa',
    address: 'stub.example.test',
    state: 'LIVE',
    expires_at: EXPIRES_A,
    ...over,
  });

let app: Running;

/** The addresses the mock holds now; a re-seeded demo gets a new one. */
const addressOf = (tenant: string): string => api.mock.store.getDemo(tenant)?.address ?? 'NONE';

beforeAll(async () => {
  fixture = await createFixture();
  api = await startApi(TENANT_A, TENANT_B, [TENANT_A, TENANT_B]);
  app = await serve((origin) => portalOn(origin, settingsFor(api.baseUrl, credentials)));
});

afterAll(async () => {
  await app.close();
  await api.close();
  await fixture.close();
});

describe('See my demo', () => {
  it("shows the signed-in tenant's demo address, state and expiry from the API", async () => {
    const page = await (await signedIn(app, ORG_A)).request('/demo');
    expect(page.status).toBe(200);
    expect(page.body).toContain('SEE_MY_DEMO_HEADING');
    expect(page.body).toContain(`<code>${addressOf(TENANT_A)}</code>`);
    expect(addressOf(TENANT_A)).not.toBe(addressOf(TENANT_B));
    expect(page.body).toContain('DEMO_STATE_LIVE');
    expect(page.body).toContain(`<time datetime="${EXPIRES_A}">${EXPIRES_A}</time>`);
  });

  it('shows the other tenant its own demo, and nothing of the first', async () => {
    const page = await (await signedIn(app, ORG_B)).request('/demo');
    expect(page.body).toContain(addressOf(TENANT_B));
    expect(page.body).not.toContain(addressOf(TENANT_A));
  });

  it('puts a navigation entry for it beside the others, on every page', async () => {
    const landing = await (await signedIn(app, ORG_A)).request('/');
    expect(landing.body).toContain('<a href="/demo">NAV_DEMO</a>');
  });

  it('sends a visitor with no session to sign in', async () => {
    const reply = await new Browser(app.origin).request('/demo');
    expect(reply.status).toBe(302);
    expect(reply.location).toBe('/login');
  });

  it('knows exactly the states the demo lifecycle has', async () => {
    const browser = await signedIn(app, ORG_A);
    const seen: string[] = [];
    for (const state of DEMO_STATES) {
      api.mock.store.seedDemoTenant(TENANT_A, state);
      const page = await browser.request('/demo');
      expect(page.status).toBe(200);
      expect(page.body).toContain(`DEMO_STATE_${state}`);
      seen.push(state);
    }
    expect(seen).toEqual([...DEMO_STATES]);
    api.mock.store.seedDemoTenant(TENANT_A, 'LIVE');
  });

  it('shows a placeholder, not a blank, for an address and an expiry not yet set', async () => {
    const stub = settingsFor(
      api.baseUrl,
      credentials,
      answering(() => demoJson({ address: null, expires_at: null, state: 'WAITING' }))
    );
    const page = await withPortal(stub, async (own) =>
      (await signedIn(own, ORG_A)).request('/demo')
    );
    expect(page.status).toBe(200);
    expect(page.body).toContain('NO_ADDRESS_YET');
    expect(page.body).toContain('NO_EXPIRY_YET');
    expect(page.body).toContain('DEMO_STATE_WAITING');
  });

  it('answers a generic error line, never a blank page, for a state the screen does not know (control case)', async () => {
    for (const state of ['SOMETHING_NEW', '__proto__', 'toString', '']) {
      const stub = settingsFor(
        api.baseUrl,
        credentials,
        answering(() => demoJson({ state }))
      );
      const page = await withPortal(stub, async (own) =>
        (await signedIn(own, ORG_A)).request('/demo')
      );
      expect(page.status).toBe(200);
      expect(page.body).toContain('DEMO_STATE_UNKNOWN');
      expect(page.body).not.toContain('stub.example.test');
    }
  });

  it('escapes an address that carries markup', async () => {
    const stub = settingsFor(
      api.baseUrl,
      credentials,
      answering(() => demoJson({ address: '<script>x</script>"' }))
    );
    const page = await withPortal(stub, async (own) =>
      (await signedIn(own, ORG_A)).request('/demo')
    );
    expect(page.body).not.toContain('<script>x');
    expect(page.body).toContain('&lt;script&gt;x&lt;/script&gt;&quot;');
  });

  it('says there is no demo when the API says the tenant has none', async () => {
    const own = await startApi(TENANT_A, TENANT_B, [TENANT_A]);
    try {
      const page = await withPortal(settingsFor(own.baseUrl, credentials), async (second) =>
        (await signedIn(second, ORG_B)).request('/demo')
      );
      expect(page.status).toBe(200);
      expect(page.body).toContain('NO_DEMO_FOUND');
      expect(lines).toEqual([]);
    } finally {
      await own.close();
    }
  });
});

describe('See my demo names only the bound tenant', () => {
  it("serves A when the request names B in the path, query, headers, cookies and a form's fields", async () => {
    const browser = await signedIn(app, ORG_A);
    const page = await browser.request(
      `/demo?tenant=${TENANT_B}&tenant_id=${TENANT_B}&demo_id=00000000-0000-4000-8000-000000000002&org=${ORG_B}`,
      {
        headers: {
          'x-tenant-id': TENANT_B,
          'x-tenant-credential': CREDENTIAL_B,
          'x-forwarded-host': `${TENANT_B}.example.test`,
          cookie: `tenant_id=${TENANT_B}; portal_session=${browser.cookie('portal_session') ?? ''}`,
        },
      }
    );
    expect(page.status).toBe(200);
    expect(page.body).toContain(addressOf(TENANT_A));
    expect(page.body).not.toContain(addressOf(TENANT_B));
    const posted = await browser.request('/demo', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `tenant=${TENANT_B}&demo_id=${TENANT_B}`,
    });
    expect(posted.status).toBe(405);
  });

  it("presents the bound tenant's own credential and no other", async () => {
    // The API refuses a credential on any tenant's path but its own, so a read
    // that named B with A's credential, or the reverse, would be a refusal and
    // a failure line here, not a page.
    const a = await (await signedIn(app, ORG_A)).request('/demo');
    const b = await (await signedIn(app, ORG_B)).request('/demo');
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(api.errors).toEqual([]);
  });
});

describe('See my demo when the API cannot answer', () => {
  it('answers 500 FAILED and logs the step and error name only, when the API is unreachable', async () => {
    lines = [];
    const dead = await startApi(TENANT_A, TENANT_B, [TENANT_A]);
    const baseUrl = dead.baseUrl;
    await dead.close();
    const page = await withPortal(settingsFor(baseUrl, credentials), async (own) =>
      (await signedIn(own, ORG_A)).request('/demo')
    );
    expect(page.status).toBe(500);
    expect(page.body).toBe('FAILED');
    expect(lines).toEqual([
      JSON.stringify({ event: 'portal.error', step: 'landing', error: 'DemoReadError' }),
    ]);
    expect(lines.join('')).not.toContain(baseUrl);
  });

  it('answers 500 FAILED, naming nothing the API said, when the API answers an error', async () => {
    lines = [];
    const wrong = settingsFor(api.baseUrl, { [TENANT_A]: 'TEST_NOBODY_ISSUED_THIS' });
    const page = await withPortal(wrong, async (own) =>
      (await signedIn(own, ORG_A)).request('/demo')
    );
    expect(page.status).toBe(500);
    expect(page.body).toBe('FAILED');
    expect(lines).toEqual([
      JSON.stringify({ event: 'portal.error', step: 'landing', error: 'DemoReadError' }),
    ]);
  });

  it('answers 500 FAILED when the portal holds no credential for the tenant', async () => {
    lines = [];
    const page = await withPortal(settingsFor(api.baseUrl, {}), async (own) =>
      (await signedIn(own, ORG_A)).request('/demo')
    );
    expect(page.status).toBe(500);
    expect(lines).toHaveLength(1);
  });

  it('answers 500 FAILED for an answer that is not a demo, and for a redirect', async () => {
    const cases: Response[] = [
      Response.json({ hello: 'world' }),
      Response.json({ state: 'LIVE', address: 'x.example.test', expires_at: 'not a date' }),
      new Response('<html>', { status: 200 }),
      new Response(null, { status: 302, headers: { location: 'http://elsewhere.example.test/' } }),
      Response.json({ code: 'forbidden' }, { status: 403 }),
    ];
    for (const answer of cases) {
      lines = [];
      const stub = settingsFor(
        api.baseUrl,
        credentials,
        answering(() => answer.clone())
      );
      const page = await withPortal(stub, async (own) =>
        (await signedIn(own, ORG_A)).request('/demo')
      );
      expect(page.status).toBe(500);
      expect(page.body).toBe('FAILED');
      expect(lines).toHaveLength(1);
    }
  });
});

describe('See my demo without a provisioning API', () => {
  it('has no page and no navigation entry', async () => {
    await withPortal(undefined, async (own) => {
      const browser = await signedIn(own, ORG_A);
      const page = await browser.request('/demo');
      expect(page.status).toBe(404);
      expect(page.body).toBe('NOT_FOUND');
      const landing = await browser.request('/');
      expect(landing.body).not.toContain('NAV_DEMO');
      expect(landing.body).not.toContain('/demo');
    });
  });
});
