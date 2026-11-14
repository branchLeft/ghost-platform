import type { TenantKind, TenantScope } from 'ghost-platform-portal-data/tenant';
import type { NavItem } from '../shell/html.js';
import { PromotionError } from './promotionError.js';
import {
  ESSENTIALS_OPEN_PATH,
  ESSENTIALS_PATH,
  ESSENTIALS_SENT_PATH,
  ESSENTIALS_SEND_PATH,
  ESSENTIALS_UNAVAILABLE_PATH,
  renderEssentialsForm,
  renderEssentialsOtherRequestOpen,
  renderEssentialsSent,
  renderEssentialsUnavailable,
  renderNotForThisTenant,
} from './promotionPages.js';
import { requestPromotion, type PromotionOutcome } from './promotionRequest.js';
import type { ProvisioningSettings } from './provisioningSettings.js';

/** The one read the promotion screens need of the tenant data layer. `TenantDb` satisfies it. */
export interface KindReader {
  ownKind(scope: TenantScope): Promise<TenantKind>;
}

export type PromotionPage = (scope: TenantScope) => Promise<string>;
export type PromotionAction = (
  scope: TenantScope,
  identity: { readonly subject: string },
  form: URLSearchParams
) => Promise<string>;

/** What a group of screens adds to the tenant portal; empty, it adds nothing. */
export interface RouteSet {
  readonly nav: readonly NavItem[];
  readonly pages: Readonly<Record<string, PromotionPage>>;
  readonly actions: Readonly<Record<string, PromotionAction>>;
}

export const NO_ROUTES: RouteSet = { nav: [], pages: {}, actions: {} };

/** Where each answer of the contract lands. A closed table: nothing from the request picks it. */
const LANDING: Readonly<Record<PromotionOutcome, string>> = {
  REQUESTED: ESSENTIALS_SENT_PATH,
  OTHER_REQUEST_OPEN: ESSENTIALS_OPEN_PATH,
  NOT_PROMOTABLE: ESSENTIALS_UNAVAILABLE_PATH,
};

/** The kind of the bound tenant, read fresh; a failed read is a refusal, so the shell logs a name and not a driver's. */
export async function readKind(reader: KindReader, scope: TenantScope): Promise<TenantKind> {
  try {
    return await reader.ownKind(scope);
  } catch (error) {
    throw new PromotionError('READ_FAILED', error instanceof Error ? { cause: error } : undefined);
  }
}

/**
 * The Essentials request. The page is a form with no field; the action asks
 * the provisioning API, through the generated client, to record one request
 * for the tenant bound at sign-in. The tenant is read from the scope and from
 * nothing the request carries, and a tenant that is not a demo is refused
 * before the API is asked. With no settings the screens do not exist.
 */
export function createEssentialsRoutes(
  settings: ProvisioningSettings | undefined,
  reader: KindReader
): RouteSet {
  if (settings === undefined) return NO_ROUTES;
  const pages: Record<string, PromotionPage> = {
    [ESSENTIALS_PATH]: async (scope) =>
      (await readKind(reader, scope)) === 'DEMO'
        ? renderEssentialsForm()
        : renderNotForThisTenant(),
    [ESSENTIALS_SENT_PATH]: async () => renderEssentialsSent(),
    [ESSENTIALS_OPEN_PATH]: async () => renderEssentialsOtherRequestOpen(),
    [ESSENTIALS_UNAVAILABLE_PATH]: async () => renderEssentialsUnavailable(),
  };
  const actions: Record<string, PromotionAction> = {
    [ESSENTIALS_SEND_PATH]: async (scope) => {
      const tenant = scope.tenantId;
      if ((await readKind(reader, scope)) !== 'DEMO') throw new PromotionError('NOT_A_DEMO');
      return LANDING[await requestPromotion(settings, tenant, 'essentials')];
    },
  };
  return { nav: [{ label: 'NAV_ESSENTIALS', href: ESSENTIALS_PATH }], pages, actions };
}
