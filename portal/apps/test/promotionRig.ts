import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TenantDb } from 'ghost-platform-portal-data/tenant';
import { ORG_A, ORG_B, TENANT_A, TENANT_B } from '../../data/test/helpers.js';
// The mock is a test double and is imported by tests only, from the built package
// (the portal's CI builds it first); no application module imports it.
import {
  createMock,
  type Mock,
} from '../../../services/provisioning-controller/dist/mock/server.js';
import { createTenantPortal, type TenantPortalOptions } from '../src/tenant/app.js';
import type { ProvisioningSettings } from '../src/tenant/provisioningSettings.js';
import { Browser } from './browser.js';
import { CLIENT_PORTAL, FakeIssuer, ISSUER, jwks, mint, NOW, PROJECT_ID } from './idp.js';

export const CREDENTIAL_A = 'TEST_CREDENTIAL_FOR_A';
export const CREDENTIAL_B = 'TEST_CREDENTIAL_FOR_B';
export const OWNER_CREDENTIAL = 'TEST_OWNER_CREDENTIAL';

const FORM = 'application/x-www-form-urlencoded';

export interface RunningMock {
  readonly baseUrl: string;
  readonly mock: Mock;
  /** Everything the generated server turned into a 500. */
  readonly errors: unknown[];
  close(): Promise<void>;
}

/** The in-memory provisioning API, served through the generated server on a loopback port. Both tenants start with a `LIVE` demo. */
export async function startMock(): Promise<RunningMock> {
  const errors: unknown[] = [];
  const mock = createMock({
    credentials: {
      owner: OWNER_CREDENTIAL,
      tenants: new Map([
        [CREDENTIAL_A, TENANT_A],
        [CREDENTIAL_B, TENANT_B],
      ]),
    },
    tenants: [TENANT_A, TENANT_B],
    onError: (error) => errors.push(error),
  });
  await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const { port } = mock.server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    mock,
    errors,
    close: () =>
      new Promise<void>((resolve) => {
        mock.server.close(() => resolve());
        mock.server.closeAllConnections();
      }),
  };
}

/** The credentials the portal holds: one per tenant, as the contract issues them. */
export function settingsFor(baseUrl: string): ProvisioningSettings {
  const issued = new Map([
    [TENANT_A, CREDENTIAL_A],
    [TENANT_B, CREDENTIAL_B],
  ]);
  return {
    baseUrl,
    credentialFor: (tenantId) => {
      const credential = issued.get(tenantId);
      if (credential === undefined) throw new Error('no credential issued for this tenant');
      return credential;
    },
  };
}

/** A server that answers every request with one fixed status and JSON body, for answers the mock never gives. */
export async function startStub(
  status: number,
  body: unknown
): Promise<{ baseUrl: string; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const server: Server = createServer((request, response) => {
    seen.push(`${request.method ?? ''} ${request.url ?? ''}`);
    request.resume();
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** The address of a loopback port nothing listens on. */
export async function deadBaseUrl(): Promise<string> {
  const stub = await startStub(204, {});
  const { baseUrl } = stub;
  await stub.close();
  return baseUrl;
}

export const issuer = new FakeIssuer();

export function portalOptions(
  origin: string,
  db: TenantDb,
  extra: Partial<TenantPortalOptions>,
  errorLines: string[]
): TenantPortalOptions {
  return {
    issuer: ISSUER,
    clientId: CLIENT_PORTAL,
    projectId: PROJECT_ID,
    publicOrigin: origin,
    allowedOrgIds: new Set([ORG_A, ORG_B]),
    db,
    secureCookies: false,
    clock: () => NOW,
    fetch: issuer.fetch,
    fetchKeys: async () => jwks,
    sessionSeconds: 100_000,
    onError: (line) => errorLines.push(line),
    ...extra,
  };
}

export const portalOn = (
  origin: string,
  db: TenantDb,
  extra: Partial<TenantPortalOptions>,
  errorLines: string[]
) => createTenantPortal(portalOptions(origin, db, extra, errorLines));

export async function signedIn(origin: string, org: string): Promise<Browser> {
  const browser = new Browser(origin);
  const token = mint({ org, client: CLIENT_PORTAL, role: 'tenant-admin', exp: NOW + 1_000_000 });
  const reply = await browser.finish(issuer.issue(token));
  if (reply.status !== 302) throw new Error('the test sign-in did not succeed');
  return browser;
}

export const postForm = (
  browser: Browser,
  origin: string,
  path: string,
  fields: Record<string, string> = {},
  headers: Record<string, string> = {}
) =>
  browser.request(path, {
    method: 'POST',
    headers: { origin, 'content-type': FORM, ...headers },
    body: new URLSearchParams(fields).toString(),
  });
