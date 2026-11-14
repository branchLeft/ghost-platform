import type { JourneyStep } from '../walk.js';

/** Screen 1: the sign-in page the portal sends a visitor to. */
export const signInPage: JourneyStep = {
  id: 'sign-in',
  go: async ({ page, portalOrigin }) => {
    await page.goto(`${portalOrigin}/`);
  },
  expect: ['TEST_IDP_SIGN_IN', 'SIGN_IN_AS_DEMO_ADMIN'],
};

/** The tenant app's home, after the demo tenant's administrator signs in. */
export const tenantHome: JourneyStep = {
  id: 'tenant-home',
  go: async ({ page, portalOrigin }) => {
    await page.getByRole('button', { name: 'SIGN_IN_AS_DEMO_ADMIN' }).click();
    await page.waitForURL(`${portalOrigin}/`);
  },
  expect: ['LANDING_PLACEHOLDER', 'YOUR_TENANT_ID', 'NAV_HOME'],
};
