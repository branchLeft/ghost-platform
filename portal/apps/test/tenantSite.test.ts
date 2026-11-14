import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ORG_A, ORG_B, TENANT_A, TENANT_B } from '../../data/test/helpers.js';
import { bindTenant } from 'ghost-platform-portal-data/tenant';
import {
  createSiteRoutes,
  ESSENTIALS_REQUEST_PATH,
  renderSite,
  SITE_PATH,
} from '../src/tenant/site.js';
import { Browser, serve, type Running } from './browser.js';
import {
  CREDENTIAL_A,
  CREDENTIAL_B,
  errorLines,
  portalOn,
  promote,
  settingsFor,
  signedIn,
  startMock,
  type RunningMock,
} from './tenantSiteRig.js';

const HOSTILE = `"><script>HOSTILE_MARKER()</script><img src=x onerror='HOSTILE_MARKER()'>&amp;`;

let live: RunningMock;
let held: RunningMock;
let both: RunningMock;
let on: Running;
let bothOn: Running;
let off: Running;
let broken: Running;
let refused: Running;

function siteOf(mock: RunningMock, tenant: string) {
  const found = mock.mock.store.getTenant(tenant);
  if (found === undefined) throw new Error('the mock holds no such tenant');
  return found;
}

beforeAll(async () => {
  live = await startMock();
  held = await startMock({ settleOnApprove: false });
  // Tenant A is promoted and live; tenant B is still a demo.
  await promote(live, TENANT_A, CREDENTIAL_A);
  // On the second mock tenant A is approved but not yet provisioned.
  await promote(held, TENANT_A, CREDENTIAL_A);
  // Both tenants promoted, each with a site of its own.
  both = await startMock();
  await promote(both, TENANT_A, CREDENTIAL_A);
  await promote(both, TENANT_B, CREDENTIAL_B);
  on = await serve((origin) => portalOn(origin, settingsFor(live.baseUrl)));
  bothOn = await serve((origin) => portalOn(origin, settingsFor(both.baseUrl)));
  off = await serve((origin) => portalOn(origin, undefined));
  broken = await serve((origin) => portalOn(origin, settingsFor(held.baseUrl)));
  // A portal that holds a wrong credential for tenant A, and one whose API is unreachable.
  refused = await serve((origin) =>
    portalOn(origin, settingsFor(live.baseUrl, new Map([[TENANT_A, CREDENTIAL_B]])))
  );
});

afterAll(async () => {
  await Promise.all([on.close(), bothOn.close(), off.close(), broken.close(), refused.close()]);
  await Promise.all([live.close(), held.close(), both.close()]);
});

beforeEach(() => {
  errorLines.length = 0;
});

describe('the Essentials site screen', () => {
  it('shows a promoted tenant its state, tier, invoice reference and every hostname', async () => {
    const tenant = siteOf(live, TENANT_A);
    const browser = await signedIn(on.origin, ORG_A);
    const page = await browser.request(SITE_PATH);
    expect(page.status).toBe(200);
    expect(page.body).toContain('SITE_STATE_LIVE');
    expect(page.body).toContain('SITE_TIER_ESSENTIALS');
    expect(tenant.invoice_ref).not.toBeNull();
    expect(page.body).toContain(tenant.invoice_ref ?? '');
    expect(tenant.hostnames.length).toBeGreaterThan(0);
    for (const hostname of tenant.hostnames) expect(page.body).toContain(hostname);
    expect(page.body).toContain('NAV_SITE');
  });

  it('shows every hostname the API returns when there are several', async () => {
    const tenant = siteOf(live, TENANT_A);
    const original = tenant.hostnames;
    Object.assign(tenant, { hostnames: ['first.example.test', 'second.example.test'] });
    try {
      const page = await (await signedIn(on.origin, ORG_A)).request(SITE_PATH);
      expect(page.body).toContain('first.example.test');
      expect(page.body).toContain('second.example.test');
    } finally {
      Object.assign(tenant, { hostnames: original });
    }
  });

  it('shows the provisioning state with no invoice and no hostname yet', async () => {
    const tenant = siteOf(held, TENANT_A);
    expect(tenant.state).toBe('provisioning');
    const page = await (await signedIn(broken.origin, ORG_A)).request(SITE_PATH);
    expect(page.status).toBe(200);
    expect(page.body).toContain('SITE_STATE_PROVISIONING');
    expect(page.body).toContain('SITE_NO_INVOICE_YET');
  });

  it('shows a placeholder when the API lists no hostname', async () => {
    const tenant = siteOf(held, TENANT_A);
    const original = tenant.hostnames;
    Object.assign(tenant, { hostnames: [] });
    try {
      const page = await (await signedIn(broken.origin, ORG_A)).request(SITE_PATH);
      expect(page.body).toContain('SITE_NO_HOSTNAMES_YET');
      expect(page.body).not.toContain('<ul>');
    } finally {
      Object.assign(tenant, { hostnames: original });
    }
  });

  it('shows a tenant that is still a demo the placeholder pointing to the Essentials request, not an error', async () => {
    const browser = await signedIn(on.origin, ORG_B);
    const page = await browser.request(SITE_PATH);
    expect(page.status).toBe(200);
    expect(page.body).toContain('SITE_NOT_PROMOTED');
    expect(page.body).toContain(`href="${ESSENTIALS_REQUEST_PATH}"`);
    expect(page.body).not.toContain('SITE_STATE_');
    expect(page.body).not.toContain('SITE_UNAVAILABLE');
  });

  it('shows only the bound tenant when a request names another tenant in the URL or a form', async () => {
    const a = siteOf(both, TENANT_A);
    const b = siteOf(both, TENANT_B);
    expect(b.hostnames[0]).toBeDefined();
    expect(b.hostnames).not.toEqual(a.hostnames);
    const browser = await signedIn(bothOn.origin, ORG_A);
    for (const path of [
      `${SITE_PATH}?tenant=${TENANT_B}`,
      `${SITE_PATH}?tenant_id=${TENANT_B}&tenantId=${TENANT_B}`,
    ]) {
      const page = await browser.request(path);
      expect(page.status).toBe(200);
      for (const hostname of a.hostnames) expect(page.body).toContain(hostname);
      for (const hostname of b.hostnames) expect(page.body).not.toContain(hostname);
      expect(page.body).not.toContain(b.invoice_ref ?? 'no-such-reference');
    }
    const form = await browser.request(SITE_PATH, {
      method: 'POST',
      headers: { origin: bothOn.origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tenant: TENANT_B }).toString(),
    });
    expect(form.status).not.toBe(200);
    for (const hostname of b.hostnames) expect(form.body).not.toContain(hostname);
    expect((await browser.request(`${SITE_PATH}/${TENANT_B}`)).status).toBe(404);
  });

  it('serves nothing to a request with no session', async () => {
    const reply = await new Browser(on.origin).request(SITE_PATH);
    expect(reply.status).toBe(302);
    expect(reply.body).not.toContain('SITE_');
  });

  it('escapes a hostile hostname and a hostile invoice reference so they are inert', async () => {
    const tenant = siteOf(live, TENANT_A);
    const original = { hostnames: tenant.hostnames, invoice_ref: tenant.invoice_ref };
    Object.assign(tenant, { hostnames: [HOSTILE], invoice_ref: HOSTILE });
    try {
      const page = await (await signedIn(on.origin, ORG_A)).request(SITE_PATH);
      expect(page.status).toBe(200);
      expect(page.body).not.toContain('<script');
      expect(page.body).not.toContain('<img');
      expect(page.body).not.toContain("onerror='");
      expect(page.body).toContain('&lt;script&gt;HOSTILE_MARKER()&lt;/script&gt;');
      expect(page.body).toContain('&amp;amp;');
    } finally {
      Object.assign(tenant, original);
    }
  });

  it('is absent, with no navigation entry, when the provisioning API is not configured', async () => {
    const browser = await signedIn(off.origin, ORG_A);
    expect((await browser.request(SITE_PATH)).status).toBe(404);
    const other = await browser.request('/documents');
    expect(other.status).toBe(200);
    expect(other.body).not.toContain('NAV_SITE');
    expect(other.body).not.toContain(SITE_PATH);
  });

  it('shows the same placeholder when the portal holds no credential for the tenant', async () => {
    const none = await serve((origin) =>
      portalOn(origin, settingsFor(live.baseUrl, new Map<string, string>()))
    );
    try {
      const page = await (await signedIn(none.origin, ORG_A)).request(SITE_PATH);
      expect(page.status).toBe(200);
      expect(page.body).toContain('SITE_UNAVAILABLE');
      expect(page.body).not.toContain(CREDENTIAL_A);
    } finally {
      await none.close();
    }
  });

  it('answers a refusal from the API with the unavailable placeholder, never the API body', async () => {
    const page = await (await signedIn(refused.origin, ORG_A)).request(SITE_PATH);
    expect(page.status).toBe(200);
    expect(page.body).toContain('SITE_UNAVAILABLE');
    expect(page.body).not.toContain('forbidden');
    expect(page.body).not.toContain(CREDENTIAL_B);
  });

  it('answers an unreachable API with the unavailable placeholder and no address in it', async () => {
    const dead = await serve((origin) => portalOn(origin, settingsFor('http://127.0.0.1:1')));
    try {
      const page = await (await signedIn(dead.origin, ORG_A)).request(SITE_PATH);
      expect(page.status).toBe(200);
      expect(page.body).toContain('SITE_UNAVAILABLE');
      expect(page.body).not.toContain('127.0.0.1');
    } finally {
      await dead.close();
    }
  });

  it('answers a read that throws with the unavailable placeholder and a log line of names only', async () => {
    const failing = await serve((origin) =>
      portalOn(origin, {
        baseUrl: live.baseUrl,
        credentialFor: () => {
          throw new RangeError('SECRET_DETAIL');
        },
      })
    );
    try {
      const page = await (await signedIn(failing.origin, ORG_A)).request(SITE_PATH);
      expect(page.status).toBe(200);
      expect(page.body).toContain('SITE_UNAVAILABLE');
      expect(errorLines).toEqual([
        JSON.stringify({ event: 'portal.error', step: 'handler', error: 'RangeError' }),
      ]);
    } finally {
      await failing.close();
    }
  });
});

describe('the place for the custom-domain screen', () => {
  const promoted = {
    kind: 'site' as const,
    tenant: {
      tenant_id: TENANT_A,
      tier: 'essentials' as const,
      state: 'live' as const,
      invoice_ref: null,
      hostnames: ['site.example.test'],
    },
  };

  it('is empty until that screen has a route, so no link is made up for it', () => {
    expect(renderSite(promoted)).not.toContain('data-slot="custom-domain"');
  });

  it('links to the route the custom-domain screen gives it', () => {
    const body = renderSite(promoted, '/domain');
    expect(body).toContain('data-slot="custom-domain"');
    expect(body).toContain('href="/domain"');
    expect(body).toContain('SITE_CUSTOM_DOMAIN_LINK');
  });

  it('carries the route through the page the portal serves', async () => {
    const routes = createSiteRoutes(settingsFor(live.baseUrl), { customDomainPath: '/domain' });
    const page = routes.pages[SITE_PATH];
    expect(await page?.(bindTenant(TENANT_A))).toContain('href="/domain"');
  });
});
