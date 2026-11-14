import type { JourneyStep } from '../walk.js';

/** Screen 4: the owner console's sign-in page, opened by the owner in their own browser context. */
export const consoleSignIn: JourneyStep = {
  id: 'console-sign-in',
  actor: 'owner',
  go: async ({ pages, consoleOrigin }) => {
    await pages.owner.goto(`${consoleOrigin}/`);
  },
  expect: ['TEST_IDP_SIGN_IN', 'SIGN_IN_AS_OWNER'],
};

/** Screen 5: the pending-request queue, with the Approve button against the tenant's request. */
export const approvalQueue: JourneyStep = {
  id: 'approval-queue',
  actor: 'owner',
  go: async ({ pages, consoleOrigin }) => {
    await pages.owner.getByRole('button', { name: 'SIGN_IN_AS_OWNER' }).click();
    await pages.owner.waitForURL(`${consoleOrigin}/`);
    await pages.owner.getByRole('link', { name: 'NAV_REQUESTS', exact: true }).click();
    await pages.owner.waitForURL(/\/requests$/);
  },
  expect: ['REQUESTS_HEADING', 'REQUEST_ID', 'TIER_ESSENTIALS', 'APPROVE'],
  forbid: ['REQUESTS_EMPTY'],
};

/** The one owner click: Approve. The queue is then empty and the request is listed as approved. */
export const approved: JourneyStep = {
  id: 'approved',
  actor: 'owner',
  go: async ({ pages }) => {
    await pages.owner.getByRole('button', { name: 'APPROVE', exact: true }).click();
    await pages.owner.waitForURL(/\/requests$/);
  },
  expect: [
    'REQUESTS_HEADING',
    'REQUESTS_EMPTY',
    'REQUESTS_APPROVED_HEADING',
    'REQUEST_APPROVED_AT',
  ],
  forbid: ['REQUEST_NOT_FOUND', 'REQUEST_NOT_APPROVABLE'],
};
