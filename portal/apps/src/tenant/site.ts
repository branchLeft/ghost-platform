import { getTenant, type Tenant } from 'ghost-platform-provisioning-controller/provisioning-api';
import type { TenantScope } from 'ghost-platform-portal-data/tenant';
import { portalErrorLine } from '../shell/errorLine.js';
import { escapeHtml, type NavItem } from '../shell/html.js';
import type { ProvisioningSettings } from './provisioningSettings.js';

/** The page this screen is served at. */
export const SITE_PATH = '/site';

/** Where a tenant that is still a demo asks for Essentials. */
export const ESSENTIALS_REQUEST_PATH = '/essentials';

const READ_TIMEOUT_MS = 5000;

/** What the provisioning API said about the bound tenant. */
export type SiteRead =
  | { readonly kind: 'site'; readonly tenant: Tenant }
  /** Still a demo: nothing has been promoted. */
  | { readonly kind: 'demo' }
  /** No credential, a refusal, an unknown tenant or no answer. Never shown as an error body. */
  | { readonly kind: 'unavailable' };

const STATE_LABELS: Readonly<Record<string, string>> = {
  provisioning: 'SITE_STATE_PROVISIONING',
  live: 'SITE_STATE_LIVE',
};

const TIER_LABELS: Readonly<Record<string, string>> = {
  essentials: 'SITE_TIER_ESSENTIALS',
};

/**
 * Reads the tenant's own site from the provisioning API through the generated
 * client. The tenant id is an argument the caller takes from the bound scope;
 * the credential presented is the one issued for that tenant alone.
 *
 * @param onError Receives the error of a read that threw (name only, as a log line).
 */
export async function readSite(
  settings: ProvisioningSettings,
  tenantId: string,
  onError?: (line: string) => void
): Promise<SiteRead> {
  try {
    const credential = settings.credentialFor(tenantId);
    if (credential === undefined) return { kind: 'unavailable' };
    const result = await getTenant({
      path: { tenant: tenantId },
      baseUrl: settings.baseUrl,
      auth: () => credential,
      throwOnError: false,
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    const tenant = result.data;
    // An answer that is not about the bound tenant is never shown.
    if (tenant === undefined || tenant.tenant_id !== tenantId) return { kind: 'unavailable' };
    return tenant.tier === 'demo' ? { kind: 'demo' } : { kind: 'site', tenant };
  } catch (error) {
    try {
      onError?.(portalErrorLine('handler', error));
    } catch {
      // Logging must not change the answer.
    }
    return { kind: 'unavailable' };
  }
}

/** The place the custom-domain screen links from; nothing when that screen has no route yet. */
function renderCustomDomainSlot(customDomainPath: string | undefined): string {
  if (customDomainPath === undefined) return '';
  return `<p data-slot="custom-domain"><a href="${escapeHtml(customDomainPath)}">SITE_CUSTOM_DOMAIN_LINK</a></p>`;
}

function renderHostnames(hostnames: readonly string[]): string {
  if (hostnames.length === 0) return '<p>SITE_NO_HOSTNAMES_YET</p>';
  return `<ul>${hostnames.map((name) => `<li><code>${escapeHtml(name)}</code></li>`).join('')}</ul>`;
}

/**
 * The page body. Every string is a placeholder except the values the API
 * returned, which are escaped here and nowhere else.
 */
export function renderSite(read: SiteRead, customDomainPath?: string): string {
  switch (read.kind) {
    case 'demo':
      return (
        '<h1>SITE_NOT_PROMOTED</h1>' +
        `<p><a href="${escapeHtml(ESSENTIALS_REQUEST_PATH)}">SITE_ASK_FOR_ESSENTIALS_LINK</a></p>`
      );
    case 'unavailable':
      return '<h1>SITE_UNAVAILABLE</h1>';
    case 'site': {
      const { tenant } = read;
      const invoice =
        tenant.invoice_ref === null
          ? 'SITE_NO_INVOICE_YET'
          : `<code>${escapeHtml(tenant.invoice_ref)}</code>`;
      return (
        '<h1>SITE_TITLE</h1>' +
        '<dl>' +
        `<dt>SITE_STATE_LABEL</dt><dd>${STATE_LABELS[tenant.state] ?? 'SITE_STATE_UNKNOWN'}</dd>` +
        `<dt>SITE_TIER_LABEL</dt><dd>${TIER_LABELS[tenant.tier] ?? 'SITE_TIER_UNKNOWN'}</dd>` +
        `<dt>SITE_INVOICE_LABEL</dt><dd>${invoice}</dd>` +
        `<dt>SITE_HOSTNAMES_LABEL</dt><dd>${renderHostnames(tenant.hostnames)}</dd>` +
        '</dl>' +
        renderCustomDomainSlot(customDomainPath)
      );
    }
  }
}

export interface SiteRoutes {
  readonly nav: readonly NavItem[];
  readonly pages: Readonly<Record<string, (scope: TenantScope) => Promise<string>>>;
}

export interface SiteRoutesOptions {
  readonly onError?: (line: string) => void;
  /** The custom-domain screen's route, once it has one. */
  readonly customDomainPath?: string;
}

const OFF: SiteRoutes = { nav: [], pages: {} };

/**
 * The Essentials site screen. With no provisioning settings there is no page
 * and no navigation entry. The tenant is the bound scope's and nothing else:
 * the shell hands a page its session value and never the request.
 */
export function createSiteRoutes(
  settings: ProvisioningSettings | undefined,
  options: SiteRoutesOptions = {}
): SiteRoutes {
  if (settings === undefined) return OFF;
  return {
    nav: [{ label: 'NAV_SITE', href: SITE_PATH }],
    pages: {
      [SITE_PATH]: async (scope) =>
        renderSite(
          await readSite(settings, scope.tenantId, options.onError),
          options.customDomainPath
        ),
    },
  };
}
