import type { JourneyStep } from '../walk.js';
import { approvalQueue, approved, consoleSignIn } from './console.js';
import { signInPage, tenantHome } from './signIn.js';
import { askForEssentials, essentialsRequested, essentialsSite, seeMyDemo } from './tenant.js';

/**
 * The Essentials journey, in order. The six screens the waypoint names are
 * sign in, See my demo, Ask for Essentials, the owner's console sign-in, the
 * queue with its Approve button, and the Essentials site; the walk also
 * photographs the tenant's home, the request's confirmation and the queue
 * after the click, so the owner sees each hand-over. A screen added to the
 * portal is one entry here.
 */
export const JOURNEY: readonly JourneyStep[] = [
  signInPage,
  tenantHome,
  seeMyDemo,
  askForEssentials,
  essentialsRequested,
  consoleSignIn,
  approvalQueue,
  approved,
  essentialsSite,
];

/** The journey with the owner's Approve left out: the Essentials site screen must then fail. */
export const WITHOUT_APPROVE: readonly JourneyStep[] = JOURNEY.filter(
  (step) => step.id !== approved.id
);

export { PROFESSIONAL_JOURNEY } from './professional.js';
