import type { TenantScope } from 'ghost-platform-portal-data/tenant';
import type { NavItem } from '../shell/html.js';
import { SupportLimiter } from './supportLimiter.js';
import type { SupportSettings } from './supportMailer.js';
import {
  renderSupportForm,
  renderSupportLink,
  renderTicketLimited,
  renderTicketSent,
} from './supportPages.js';
import {
  entryFor,
  screenForSendPath,
  SUPPORT_SCREENS,
  type SupportScreen,
} from './supportScreens.js';
import {
  LIMITED_PATH,
  SENT_PATH,
  TicketSubmitter,
  type SupportReader,
} from './supportSubmitter.js';

type SupportPage = () => Promise<string>;
type SupportAction = (
  scope: TenantScope,
  identity: { readonly subject: string },
  form: URLSearchParams
) => Promise<string>;

/**
 * What the tenant portal adds when support is on. With no settings every part
 * is empty, so the portal registers nothing and renders nothing extra.
 */
export interface SupportRoutes {
  readonly nav: readonly NavItem[];
  readonly pages: Readonly<Record<string, SupportPage>>;
  readonly actions: Readonly<Record<string, SupportAction>>;
  /** The link a screen carries to its own support form; empty when support is off. */
  linkFrom(screen: SupportScreen): string;
}

const OFF: SupportRoutes = { nav: [], pages: {}, actions: {}, linkFrom: () => '' };

/**
 * Builds the support pages and actions. The action for each screen's send path
 * knows its screen from the fixed table, so the screen is never read from the
 * request.
 *
 * @throws {SupportTicketError} INVALID_HEADER_VALUE when the recipient or sender is unusable:
 *   an invalid injected address stops the portal being built rather than turning support off.
 */
export function createSupportRoutes(
  settings: SupportSettings | undefined,
  reader: SupportReader,
  clock: () => number
): SupportRoutes {
  if (settings === undefined) return OFF;
  const submitter = new TicketSubmitter({
    reader,
    mailer: settings.mailer,
    recipient: settings.recipient,
    sender: settings.sender,
    limiter: new SupportLimiter(clock),
  });
  const pages: Record<string, SupportPage> = {
    [SENT_PATH]: async () => renderTicketSent(),
    [LIMITED_PATH]: async () => renderTicketLimited(),
  };
  const actions: Record<string, SupportAction> = {};
  for (const entry of SUPPORT_SCREENS) {
    pages[entry.pagePath] = async () => renderSupportForm(entry.sendPath);
    const screen = screenForSendPath(entry.sendPath);
    actions[entry.sendPath] = (scope, _identity, form) => submitter.submit(screen, scope, form);
  }
  return {
    nav: [{ label: 'NAV_SUPPORT', href: entryFor('SUPPORT').pagePath }],
    pages,
    actions,
    linkFrom: (screen) => renderSupportLink(entryFor(screen).pagePath),
  };
}
