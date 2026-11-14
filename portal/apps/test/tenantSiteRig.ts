import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { bindTenant, TenantDb } from 'ghost-platform-portal-data/tenant';
import {
  approvePromotionRequest,
  createPromotionRequest,
} from 'ghost-platform-provisioning-controller/provisioning-api';
import { ORG_A, ORG_B, TENANT_A, TENANT_B } from '../../data/test/helpers.js';
import {
  createMock,
  type Mock,
  type MockOptions,
} from '../../../services/provisioning-controller/dist/mock/server.js';
import { createTenantPortal } from '../src/tenant/app.js';
import { createSiteRoutes, SITE_PATH } from '../src/tenant/site.js';
import type { ProvisioningSettings } from '../src/tenant/siteConfig.js';
import { Browser } from './browser.js';
import { CLIENT_PORTAL, FakeIssuer, ISSUER, jwks, mint, NOW, PROJECT_ID } from './idp.js';

/** Test values only: the mock refuses to run without credentials of its own. */
export const CREDENTIAL_A = 'TEST_TENANT_A_CREDENTIAL';
export const CREDENTIAL_B = 'TEST_TENANT_B_CREDENTIAL';
export const OWNER_CREDENTIAL = 'TEST_OWNER_CREDENTIAL';

export interface RunningMock {
  readonly baseUrl: string;
  readonly mock: Mock;
  readonly close: () => Promise<void>;
}

/** The in-memory provisioning mock, served through the generated server on a loopback port. */
export async function startMock(overrides: Partial<MockOptions> = {}): Promise<RunningMock> {
  const mock = createMock({
    credentials: {
      owner: OWNER_CREDENTIAL,
      tenants: new Map([
        [CREDENTIAL_A, TENANT_A],
        [CREDENTIAL_B, TENANT_B],
      ]),
    },
    tenants: [TENANT_A, TENANT_B],
    ...overrides,
  });
  await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const { port } = mock.server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    mock,
    close: () =>
      new Promise<void>((resolve, reject) => {
        mock.server.close((error) => (error === undefined ? resolve() : reject(error)));
        mock.server.closeAllConnections();
      }),
  };
}

/** What the portal holds for the mock: a credential per tenant, never one for both. */
export function settingsFor(
  baseUrl: string,
  credentials: ReadonlyMap<string, string> = new Map([
    [TENANT_A, CREDENTIAL_A],
    [TENANT_B, CREDENTIAL_B],
  ])
): ProvisioningSettings {
  return { baseUrl, credentialFor: (tenantId) => credentials.get(tenantId) };
}

/** The tenant asks for Essentials and the owner approves, both through the generated client. */
export async function promote(
  running: RunningMock,
  tenant: string,
  credential: string
): Promise<void> {
  const asked = await createPromotionRequest({
    path: { tenant },
    body: { tier: 'essentials' },
    baseUrl: running.baseUrl,
    auth: () => credential,
    throwOnError: true,
  });
  await approvePromotionRequest({
    path: { id: asked.data.request_id },
    baseUrl: running.baseUrl,
    auth: () => OWNER_CREDENTIAL,
    throwOnError: true,
  });
}

/**
 * A tenant data layer that answers from memory, so the page runs with no
 * database. It binds each organisation to its tenant, as the register does, and
 * fails closed on any call it was not given an answer for.
 */
export function inMemoryTenantDb(): TenantDb {
  const registered = new Map<string, string>([
    [ORG_A, TENANT_A],
    [ORG_B, TENANT_B],
  ]);
  const answers: Partial<Record<keyof TenantDb, unknown>> = {
    scopeForOrganisation: async (org: string) => {
      const tenant = registered.get(org);
      return tenant === undefined ? null : bindTenant(tenant);
    },
    pendingAcceptances: async () => [],
    currentDocuments: async () => [],
    acceptances: async () => [],
    upcomingSubprocessors: async () => [],
  };
  // The pool is never used: every method the portal calls here is answered above.
  return new Proxy(new TenantDb(new pg.Pool()), {
    get(_target, property) {
      if (!Object.hasOwn(answers, property)) {
        throw new TypeError(`no in-memory answer for ${String(property)}`);
      }
      return answers[property as keyof TenantDb];
    },
  });
}

export const issuer = new FakeIssuer();
export const errorLines: string[] = [];

/** The tenant portal over the in-memory data layer, with or without provisioning settings. */
export function portalOn(origin: string, provisioning: ProvisioningSettings | undefined) {
  return createTenantPortal({
    issuer: ISSUER,
    clientId: CLIENT_PORTAL,
    projectId: PROJECT_ID,
    publicOrigin: origin,
    allowedOrgIds: new Set([ORG_A, ORG_B]),
    db: inMemoryTenantDb(),
    secureCookies: false,
    clock: () => NOW,
    fetch: issuer.fetch,
    fetchKeys: async () => jwks,
    sessionSeconds: 100_000,
    onError: (line) => errorLines.push(line),
    ...(provisioning === undefined ? {} : { provisioning }),
  });
}

export async function signedIn(origin: string, org: string): Promise<Browser> {
  const browser = new Browser(origin);
  const token = mint({ org, client: CLIENT_PORTAL, role: 'tenant-admin', exp: NOW + 1_000_000 });
  const reply = await browser.finish(issuer.issue(token));
  if (reply.status !== 302) throw new Error(`sign-in answered ${String(reply.status)}`);
  return browser;
}

/** What a tenant's own page showed while a request named another tenant. */
export interface Isolation {
  readonly showsOwn: boolean;
  readonly showsOther: boolean;
}

/**
 * Renders `own`'s page while a request, as a query string would, names `other`.
 * The shell hands a page its bound scope and never the request, so the real
 * module cannot see the name; the sabotage reads it from `globalThis`.
 */
export async function isolationOutcome(
  createRoutes: typeof createSiteRoutes,
  settings: ProvisioningSettings,
  own: { readonly tenant: string; readonly hostname: string },
  other: { readonly tenant: string; readonly hostname: string }
): Promise<Isolation> {
  const ambient = globalThis as Record<string, unknown>;
  ambient['queryTenant'] = other.tenant;
  try {
    const page = createRoutes(settings).pages[SITE_PATH];
    if (page === undefined) throw new Error('the site page is not registered');
    const body = await page(bindTenant(own.tenant));
    return { showsOwn: body.includes(own.hostname), showsOther: body.includes(other.hostname) };
  } finally {
    delete ambient['queryTenant'];
  }
}
