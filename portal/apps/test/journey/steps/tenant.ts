import type { JourneyStep } from '../walk.js';

/** Screen 2: See my demo, from the navigation. The mock's demo is live with an address and an expiry. */
export const seeMyDemo: JourneyStep = {
  id: 'see-my-demo',
  actor: 'tenant',
  go: async ({ pages }) => {
    await pages.tenant.getByRole('link', { name: 'NAV_DEMO', exact: true }).click();
    await pages.tenant.waitForURL(/\/demo$/);
  },
  expect: ['SEE_MY_DEMO_HEADING', 'DEMO_ADDRESS', 'DEMO_STATE_LIVE', 'DEMO_EXPIRES'],
  forbid: ['NO_DEMO_FOUND', 'NO_ADDRESS_YET', 'NO_EXPIRY_YET'],
};

/** Screen 3: Ask for Essentials, the form with its one button. */
export const askForEssentials: JourneyStep = {
  id: 'ask-for-essentials',
  actor: 'tenant',
  go: async ({ pages }) => {
    await pages.tenant.getByRole('link', { name: 'NAV_ESSENTIALS', exact: true }).click();
    await pages.tenant.waitForURL(/\/essentials$/);
  },
  expect: ['ESSENTIALS_TITLE', 'THIRD_PARTY_OFF_ONBOARDING_LINE', 'REQUEST_ESSENTIALS'],
  forbid: ['NOT_FOR_THIS_TENANT'],
};

/** The answer to the request: it is recorded and waiting for the owner. */
export const essentialsRequested: JourneyStep = {
  id: 'essentials-requested',
  actor: 'tenant',
  go: async ({ pages }) => {
    await pages.tenant.getByRole('button', { name: 'REQUEST_ESSENTIALS' }).click();
    await pages.tenant.waitForURL(/\/essentials\/sent$/);
  },
  expect: ['ESSENTIALS_REQUEST_PENDING'],
  forbid: ['ANOTHER_REQUEST_ALREADY_OPEN', 'ESSENTIALS_NOT_AVAILABLE_NOW'],
};

/** Screen 6: the Essentials site, once the owner has approved. A tenant still a demo sees SITE_NOT_PROMOTED here. */
export const essentialsSite: JourneyStep = {
  id: 'essentials-site',
  actor: 'tenant',
  go: async ({ pages }) => {
    await pages.tenant.getByRole('link', { name: 'NAV_SITE', exact: true }).click();
    await pages.tenant.waitForURL(/\/site$/);
  },
  expect: [
    'SITE_TITLE',
    'SITE_STATE_LIVE',
    'SITE_TIER_ESSENTIALS',
    'SITE_INVOICE_LABEL',
    'MOCK_INVOICE_REF_',
    'SITE_HOSTNAMES_LABEL',
    'THIRD_PARTY_OFF_HEADING',
    'THIRD_PARTY_OFF_BODY',
    'THIRD_PARTY_OFF_LINK_LABEL',
  ],
  forbid: ['SITE_NOT_PROMOTED', 'SITE_UNAVAILABLE'],
};
