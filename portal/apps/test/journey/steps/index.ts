import type { JourneyStep } from '../walk.js';
import { signInPage, tenantHome } from './signIn.js';

/**
 * The journey, in order. Each later screen (See my demo, Ask for Essentials,
 * the console's Approve, the Essentials site) is one entry here.
 */
export const JOURNEY: readonly JourneyStep[] = [signInPage, tenantHome];
