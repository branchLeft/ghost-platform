import type { JourneyStep } from '../walk.js';

/** Screen 1: the sign-in page the portal sends a visitor to. */
export const signInPage: JourneyStep = {
  id: 'sign-in',
  actor: 'tenant',
  go: async ({ pages, portalOrigin }) => {
    await pages.tenant.goto(`${portalOrigin}/`);
  },
  expect: ['TEST_IDP_SIGN_IN', 'SIGN_IN_AS_DEMO_ADMIN'],
};

/** The tenant app's home, after the demo tenant's administrator signs in. */
export const tenantHome: JourneyStep = {
  id: 'tenant-home',
  actor: 'tenant',
  go: async ({ pages, portalOrigin }) => {
    await pages.tenant.getByRole('button', { name: 'SIGN_IN_AS_DEMO_ADMIN' }).click();
    await pages.tenant.waitForURL(`${portalOrigin}/`);
  },
  expect: ['LANDING_PLACEHOLDER', 'YOUR_TENANT_ID', 'NAV_HOME', 'NAV_DEMO', 'NAV_ESSENTIALS'],
};
