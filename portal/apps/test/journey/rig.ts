import {
  CALLBACK_PATH,
  ROLE_OWNER,
  ROLE_TENANT_ADMIN,
} from 'ghost-platform-identity/dist/index.js';
import { TenantDb } from 'ghost-platform-portal-data/tenant';
import { createFixture, ORG_B, TENANT_B, type Fixture } from '../../../data/test/helpers.js';
import { createTenantPortal } from '../../src/tenant/app.js';
import { serve, type Running } from '../browser.js';
import { CLIENT_CONSOLE, CLIENT_PORTAL, PROJECT_ID } from '../idp.js';
import { startTestIdp, type TestIdp } from '../idpServer.js';

export const OWNER_ORG_ID = 'org-owner-journey';

export interface Rig {
  readonly portalOrigin: string;
  readonly idp: TestIdp;
  /** The demo tenant the journey signs in as: a DEMO row in the fixture register. */
  readonly demoTenantId: string;
  close(): Promise<void>;
}

/**
 * The tenant portal on its real data layer (the fixture database), signing in
 * against the HTTP test identity provider with nothing injected: the portal
 * exchanges its code and fetches its keys over HTTP, as it does against
 * Zitadel. Needs `PORTAL_TEST_DATABASE_URL`, like the data-layer tests.
 */
export async function startRig(): Promise<Rig> {
  const fixture: Fixture = await createFixture();
  const idp = await startTestIdp({
    users: [
      {
        id: 'demo-admin',
        label: 'DEMO_ADMIN',
        subject: 'journey-demo-admin',
        org: ORG_B,
        role: ROLE_TENANT_ADMIN,
      },
      {
        id: 'owner',
        label: 'OWNER',
        subject: 'journey-owner',
        org: OWNER_ORG_ID,
        role: ROLE_OWNER,
      },
    ],
    clients: [
      { clientId: CLIENT_PORTAL, redirectUris: [] },
      { clientId: CLIENT_CONSOLE, redirectUris: [] },
    ],
  });
  let portal: Running;
  try {
    portal = await serve((origin) => {
      idp.allowRedirect(CLIENT_PORTAL, `${origin}${CALLBACK_PATH}`);
      return createTenantPortal({
        issuer: idp.issuer,
        clientId: CLIENT_PORTAL,
        projectId: PROJECT_ID,
        publicOrigin: origin,
        allowedOrgIds: new Set([ORG_B]),
        db: new TenantDb(fixture.tenant),
        secureCookies: false,
      });
    });
  } catch (error) {
    await idp.close();
    await fixture.close();
    throw error;
  }
  return {
    portalOrigin: portal.origin,
    idp,
    demoTenantId: TENANT_B,
    close: async () => {
      await portal.close();
      await idp.close();
      await fixture.close();
    },
  };
}
