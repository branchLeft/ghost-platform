import { createEssentialsRoutes, type KindReader, type RouteSet } from './essentialsRoutes.js';
import { createProfessionalRoutes, type EnquiryRecorder } from './professionalRoutes.js';
import type { ProvisioningSettings } from './provisioningSettings.js';
import type { SupportSettings } from './supportMailer.js';
import type { ThirdPartyOff } from './thirdPartyOff.js';
import type { TicketRecorder } from './ticketRecorder.js';

/**
 * The two promotion screens the tenant portal adds: ask for Essentials (needs
 * the provisioning API) and the Professional enquiry (needs the support mail
 * settings). Each is present only with its own settings, so the portal built
 * with neither is as it was.
 */
export function createPromotionRoutes(
  provisioning: ProvisioningSettings | undefined,
  support: SupportSettings | undefined,
  reader: KindReader,
  clock: () => number,
  enquiries: EnquiryRecorder,
  thirdPartyOff?: ThirdPartyOff,
  onError?: (line: string) => void,
  recorder?: TicketRecorder
): RouteSet {
  const essentials = createEssentialsRoutes(provisioning, reader, thirdPartyOff);
  const professional = createProfessionalRoutes(
    support,
    reader,
    clock,
    enquiries,
    onError,
    recorder
  );
  return {
    nav: [...essentials.nav, ...professional.nav],
    pages: { ...essentials.pages, ...professional.pages },
    actions: { ...essentials.actions, ...professional.actions },
  };
}
