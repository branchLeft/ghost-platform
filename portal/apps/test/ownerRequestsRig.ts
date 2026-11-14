import type { AddressInfo } from 'node:net';
import type { OwnerDb } from 'ghost-platform-portal-data/owner';
import { createMock, type Mock } from '../../../services/provisioning-controller/mock/server.js';
import { createOwnerConsole } from '../src/console/app.js';
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

export const TENANT_ONE = '11111111-1111-4111-8111-111111111111';
export const TENANT_TWO = '22222222-2222-4222-8222-222222222222';
export const TENANT_THREE = '33333333-3333-4333-8333-333333333333';
export const OWNER_CREDENTIAL = 'TEST_OWNER_CREDENTIAL';
export const TENANT_CREDENTIAL = 'TEST_TENANT_CREDENTIAL';

export interface Rig {
  readonly mock: Mock;
  readonly api: { readonly baseUrl: string; close(): Promise<void> };
  readonly console_: Running;
  readonly issuer: FakeIssuer;
  /** Every `approve` the mock was asked to make, whether or not it changed anything. */
  readonly approveCalls: string[];
  /** The lines the console wrote through `onError`. */
  readonly errors: string[];
  /** A browser signed in to the console as the owner. */
  ownerBrowser(): Promise<Browser>;
  /** A POST with this console's origin, as a form submit from its own page. */
  post(
    browser: Browser,
    path: string,
    fields: Record<string, string>
  ): ReturnType<Browser['request']>;
  close(): Promise<void>;
}

export interface RigOptions {
  /** The owner credential the console presents; the mock's own is `OWNER_CREDENTIAL`. */
  readonly consoleCredential?: string;
  /** Left out, the console is built with no provisioning configuration. */
  readonly provisioned?: boolean;
  /** Replaces the console builder, for a sabotaged copy of it. */
  readonly build?: typeof createOwnerConsole;
  /** The API origin the console is given, when it should point somewhere else. */
  readonly baseUrl?: string;
}

/** The request ids the mock hands out, in order, so a test can name them. */
export const requestId = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * The in-memory provisioning mock, served through the generated server on a
 * loopback port, and an owner console pointed at it. No database is involved.
 */
export async function startRig(options: RigOptions = {}): Promise<Rig> {
  let counter = 0;
  let minute = 0;
  const approveCalls: string[] = [];
  const mock = createMock({
    credentials: {
      owner: OWNER_CREDENTIAL,
      tenants: new Map([[TENANT_CREDENTIAL, TENANT_ONE]]),
    },
    tenants: [TENANT_ONE, TENANT_TWO, TENANT_THREE],
    newId: () => {
      counter += 1;
      return requestId(counter);
    },
    now: () => new Date(Date.UTC(2026, 0, 1, 0, minute++)),
  });
  // Seeding the demos used ids and times; the requests start from the first.
  counter = 0;
  minute = 0;
  const realApprove = mock.store.approve.bind(mock.store);
  mock.store.approve = (id) => {
    approveCalls.push(id);
    return realApprove(id);
  };
  await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${String((mock.server.address() as AddressInfo).port)}`;
  const api = {
    baseUrl,
    close: () =>
      new Promise<void>((resolve) => {
        mock.server.close(() => resolve());
        mock.server.closeAllConnections();
      }),
  };

  const errors: string[] = [];
  const issuer = new FakeIssuer();
  const build = options.build ?? createOwnerConsole;
  const console_ = await serve((origin) =>
    build({
      issuer: ISSUER,
      clientId: CLIENT_CONSOLE,
      projectId: PROJECT_ID,
      publicOrigin: origin,
      ownerOrgId: OWNER_ORG,
      db: { listHealth: () => Promise.resolve([]) } as unknown as OwnerDb,
      secureCookies: false,
      clock: () => NOW,
      fetch: issuer.fetch,
      fetchKeys: async () => jwks,
      onError: (line) => errors.push(line),
      ...(options.provisioned === false
        ? {}
        : {
            provisioning: {
              baseUrl: options.baseUrl ?? baseUrl,
              ownerCredential: options.consoleCredential ?? OWNER_CREDENTIAL,
            },
          }),
    })
  );

  return {
    mock,
    api,
    console_,
    issuer,
    approveCalls,
    errors,
    async ownerBrowser() {
      const browser = new Browser(console_.origin);
      const token = mint({ org: OWNER_ORG, client: CLIENT_CONSOLE, role: 'owner' });
      await browser.finish(issuer.issue(token));
      return browser;
    },
    post: (browser, path, fields) =>
      browser.request(path, {
        method: 'POST',
        headers: {
          origin: console_.origin,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(fields).toString(),
      }),
    close: async () => {
      await console_.close();
      await api.close();
    },
  };
}

/** A tenant organisation's id, as the identity provider would issue it. */
export const TENANT_ORG = 'org-tenant';

/** Every way into the console that is not the owner organisation holding the owner role. */
export const NOT_THE_OWNER = [
  {
    why: 'a tenant administrator, in the console client',
    org: TENANT_ORG,
    client: CLIENT_CONSOLE,
    role: 'tenant-admin',
  },
  {
    why: 'a tenant administrator, in the tenant portal client',
    org: TENANT_ORG,
    client: CLIENT_PORTAL,
    role: 'tenant-admin',
  },
  {
    why: 'a tenant organisation handed the owner role',
    org: TENANT_ORG,
    client: CLIENT_CONSOLE,
    role: 'owner',
  },
  {
    why: 'the owner organisation holding only the tenant role',
    org: OWNER_ORG,
    client: CLIENT_CONSOLE,
    role: 'tenant-admin',
  },
  {
    why: "the owner's token issued to the portal client",
    org: OWNER_ORG,
    client: CLIENT_PORTAL,
    role: 'owner',
  },
] as const;
