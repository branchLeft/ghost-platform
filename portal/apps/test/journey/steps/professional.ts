import type { JourneyStep } from '../walk.js';
import { signInPage, tenantHome } from './signIn.js';

/** The Professional enquiry form, from the navigation. */
export const professionalForm: JourneyStep = {
  id: 'professional-enquiry',
  actor: 'tenant',
  go: async ({ pages }) => {
    await pages.tenant.getByRole('link', { name: 'NAV_PROFESSIONAL', exact: true }).click();
    await pages.tenant.waitForURL(/\/professional$/);
  },
  expect: ['PROFESSIONAL_ENQUIRY_TITLE', 'CONTACT_ADDRESS', 'ENQUIRY_MESSAGE', 'SEND_ENQUIRY'],
  forbid: ['NOT_FOR_THIS_TENANT'],
};

/** The confirmation. Nothing is recorded in the provisioning API: the one email is the enquiry. */
export const professionalSent: JourneyStep = {
  id: 'professional-sent',
  actor: 'tenant',
  go: async ({ pages }) => {
    await pages.tenant.getByLabel('CONTACT_ADDRESS').fill('journey-visitor@example.test');
    await pages.tenant.getByLabel('ENQUIRY_MESSAGE').fill('JOURNEY_ENQUIRY_MESSAGE');
    await pages.tenant.getByRole('button', { name: 'SEND_ENQUIRY' }).click();
    await pages.tenant.waitForURL(/\/professional\/sent$/);
  },
  expect: ['ENQUIRY_SENT'],
  forbid: ['ENQUIRY_LIMIT_REACHED'],
};

/** The second run: sign in, then the Professional enquiry to its confirmation. */
export const PROFESSIONAL_JOURNEY: readonly JourneyStep[] = [
  signInPage,
  tenantHome,
  professionalForm,
  professionalSent,
];
