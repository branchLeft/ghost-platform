import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TenantDb } from 'ghost-platform-portal-data/tenant';
import {
  createFixture,
  ORG_A,
  ORG_B,
  TENANT_A,
  TENANT_B,
  type Fixture,
} from '../../data/test/helpers.js';
import { Browser, serve, type Running } from './browser.js';
import {
  CREDENTIAL_A,
  CREDENTIAL_B,
  deadBaseUrl,
  portalOn,
  postForm,
  settingsFor,
  signedIn,
  startMock,
  type RunningMock,
} from './promotionRig.js';

let fixture: Fixture;
let db: TenantDb;

beforeAll(async () => {
  fixture = await createFixture();
  db = new TenantDb(fixture.tenant);
});

afterAll(async () => {
  await fixture.close();
});

/** The portal under test, with a fresh mock behind it for each test. */
let api: RunningMock;
let app: Running;
let errorLines: string[];

async function start(
  options: {
    baseUrl?: string;
    readDb?: TenantDb;
    credentials?: 'issued' | 'wrong';
  } = {}
): Promise<void> {
  api = await startMock();
  errorLines = [];
  const settings = settingsFor(options.baseUrl ?? api.baseUrl);
  const provisioning =
    options.credentials === 'wrong' ? { ...settings, credentialFor: () => 'NOT_ISSUED' } : settings;
  app = await serve((origin) =>
    portalOn(origin, options.readDb ?? db, { provisioning }, errorLines)
  );
}

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  await app.close();
  await api.close();
});

const requests = () => api.mock.store.listRequests(undefined);

describe('Ask for Essentials: the page', () => {
  it('shows a demo tenant one button and no field, and a navigation entry on every page', async () => {
    const browser = await signedIn(app.origin, ORG_B);
    const page = await browser.request('/essentials');
    expect(page.status).toBe(200);
    expect(page.body).toContain('ESSENTIALS_TITLE');
    expect(page.body).toContain('NAV_ESSENTIALS');
    expect(page.body).toContain('action="/essentials/request"');
    expect(page.body).toContain('REQUEST_ESSENTIALS');
    expect(page.body).not.toMatch(/<(input|textarea|select)\b/);
    expect((await browser.request('/')).body).toContain('NAV_ESSENTIALS');
  });

  it('shows a tenant that is not a demo a placeholder and no form', async () => {
    const browser = await signedIn(app.origin, ORG_A);
    const page = await browser.request('/essentials');
    expect(page.status).toBe(200);
    expect(page.body).toContain('NOT_FOR_THIS_TENANT');
    expect(page.body).not.toContain('<form method="post" action="/essentials/request"');
  });

  it.each([
    ['/essentials/sent', 'ESSENTIALS_REQUEST_PENDING'],
    ['/essentials/open-request', 'ANOTHER_REQUEST_ALREADY_OPEN'],
    ['/essentials/unavailable', 'ESSENTIALS_NOT_AVAILABLE_NOW'],
  ])('renders %s as an ALL_CAPS placeholder', async (path, heading) => {
    const browser = await signedIn(app.origin, ORG_B);
    const page = await browser.request(path);
    expect(page.status).toBe(200);
    const words = [...page.body.matchAll(/>([^<]*)</g)].flatMap((match) =>
      (match[1] ?? '').split(/\s+/).filter((word) => word !== '')
    );
    expect(words).toContain(heading);
    for (const word of words) expect(word, path).toMatch(/^[A-Z0-9_]+$/);
  });

  it('sends a request with no session to sign in', async () => {
    const reply = await new Browser(app.origin).request('/essentials');
    expect(reply.status).toBe(302);
    expect(reply.location).toBe('/login');
  });
});

describe('Ask for Essentials: the request', () => {
  it('creates exactly one pending request for a signed-in demo tenant and shows its confirmation', async () => {
    const browser = await signedIn(app.origin, ORG_B);
    const reply = await postForm(browser, app.origin, '/essentials/request');
    expect(reply.status).toBe(303);
    expect(reply.location).toBe('/essentials/sent');
    const [only, ...rest] = requests();
    expect(rest).toHaveLength(0);
    expect(only).toMatchObject({ tenant_id: TENANT_B, tier: 'essentials', state: 'pending' });
    const page = await browser.request('/essentials/sent');
    expect(page.body).toContain('ESSENTIALS_REQUEST_PENDING');
    expect(errorLines).toEqual([]);
    expect(api.errors).toEqual([]);
  });

  it('creates one request, not two, for a double submit, and shows the pending state both times', async () => {
    const browser = await signedIn(app.origin, ORG_B);
    const first = await postForm(browser, app.origin, '/essentials/request');
    const second = await postForm(browser, app.origin, '/essentials/request');
    expect([first.location, second.location]).toEqual(['/essentials/sent', '/essentials/sent']);
    expect(requests()).toHaveLength(1);
  });

  it('refuses a tenant that is not a demo, and the API is never asked', async () => {
    const browser = await signedIn(app.origin, ORG_A);
    const reply = await postForm(browser, app.origin, '/essentials/request');
    expect(reply.status).toBe(400);
    expect(reply.body).toBe('REFUSED');
    expect(requests()).toHaveLength(0);
    expect(errorLines.join('\n')).toContain('PromotionError');
  });

  it('refuses a request with no session and creates nothing', async () => {
    const reply = await postForm(new Browser(app.origin), app.origin, '/essentials/request');
    expect(reply.status).toBe(302);
    expect(reply.location).toBe('/login');
    expect(requests()).toHaveLength(0);
  });

  it('refuses a post from another origin and creates nothing', async () => {
    const browser = await signedIn(app.origin, ORG_B);
    const reply = await postForm(browser, 'https://other.example.org', '/essentials/request');
    expect(reply.status).toBe(403);
    expect(requests()).toHaveLength(0);
  });

  it('answers a GET on the action with 405 and creates nothing', async () => {
    const browser = await signedIn(app.origin, ORG_B);
    expect((await browser.request('/essentials/request')).status).toBe(405);
    expect(requests()).toHaveLength(0);
  });

  it('files the request under the signed-in tenant, whatever the query, the form or a header names', async () => {
    const browser = await signedIn(app.origin, ORG_B);
    const reply = await postForm(
      browser,
      app.origin,
      `/essentials/request?tenant=${TENANT_A}&tenant_id=${TENANT_A}`,
      { tenant: TENANT_A, tenant_id: TENANT_A, tier: 'professional-enquiry', demo_id: TENANT_A },
      { 'x-tenant-id': TENANT_A, 'x-tenant-credential': CREDENTIAL_A }
    );
    expect(reply.location).toBe('/essentials/sent');
    const all = requests();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ tenant_id: TENANT_B, tier: 'essentials' });
    expect(all.some((request) => request.tenant_id === TENANT_A)).toBe(false);
  });

  it('answers a refusal, creates nothing and logs no credential when the API refuses the portal', async () => {
    await app.close();
    await api.close();
    await start({ credentials: 'wrong' });
    const browser = await signedIn(app.origin, ORG_B);
    const reply = await postForm(browser, app.origin, '/essentials/request');
    expect(reply.status).toBe(400);
    expect(requests()).toHaveLength(0);
    const logged = errorLines.join('\n');
    expect(logged).toContain('PromotionError');
    for (const secret of ['NOT_ISSUED', CREDENTIAL_A, CREDENTIAL_B]) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe('Ask for Essentials: what the contract answers', () => {
  it('shows another request is open, and creates nothing, when the tenant has asked about Professional', async () => {
    api.mock.store.createRequest(TENANT_B, 'professional-enquiry');
    const browser = await signedIn(app.origin, ORG_B);
    const reply = await postForm(browser, app.origin, '/essentials/request');
    expect(reply.location).toBe('/essentials/open-request');
    expect(requests()).toHaveLength(1);
    expect(requests()[0]?.tier).toBe('professional-enquiry');
  });

  it('shows the demo cannot be promoted now, and creates nothing, when its state forbids it', async () => {
    api.mock.store.seedDemoTenant(TENANT_B, 'PROMOTED');
    const browser = await signedIn(app.origin, ORG_B);
    const reply = await postForm(browser, app.origin, '/essentials/request');
    expect(reply.location).toBe('/essentials/unavailable');
    expect(requests()).toHaveLength(0);
  });
});

describe('Ask for Essentials: when it cannot be done', () => {
  it('answers a refusal and logs the error name only when the API cannot be reached', async () => {
    await app.close();
    await api.close();
    await start({ baseUrl: await deadBaseUrl() });
    const browser = await signedIn(app.origin, ORG_B);
    const reply = await postForm(browser, app.origin, '/essentials/request');
    expect(reply.status).toBe(400);
    expect(reply.body).toBe('REFUSED');
    expect(errorLines).toEqual([
      JSON.stringify({ event: 'portal.error', step: 'action', error: 'PromotionError' }),
    ]);
  });

  it('answers a failure and logs the error name only when the tenant register cannot be read', async () => {
    const broken = new Proxy(db, {
      get(target, prop) {
        if (prop === 'ownKind') return async () => Promise.reject(new Error('SECRET_DRIVER_TEXT'));
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await app.close();
    await api.close();
    await start({ readDb: broken });
    const browser = await signedIn(app.origin, ORG_B);
    expect((await browser.request('/essentials')).status).toBe(500);
    const reply = await postForm(browser, app.origin, '/essentials/request');
    expect(reply.status).toBe(400);
    expect(requests()).toHaveLength(0);
    expect(errorLines.join('\n')).not.toContain('SECRET_DRIVER_TEXT');
    expect(errorLines.join('\n')).toContain('PromotionError');
  });
});

describe('Ask for Essentials: without the provisioning API configured', () => {
  it('has no page, no action and no navigation entry', async () => {
    const bare = await serve((origin) => portalOn(origin, db, {}, []));
    try {
      const browser = await signedIn(bare.origin, ORG_B);
      for (const path of ['/essentials', '/essentials/sent']) {
        expect((await browser.request(path)).status).toBe(404);
      }
      expect((await postForm(browser, bare.origin, '/essentials/request')).status).toBe(404);
      expect((await browser.request('/')).body).not.toContain('NAV_ESSENTIALS');
    } finally {
      await bare.close();
    }
  });
});
