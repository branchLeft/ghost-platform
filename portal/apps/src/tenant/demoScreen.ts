import {
  getDemo,
  type Demo,
  type DemoState,
} from 'ghost-platform-provisioning-controller/provisioning-api';
import type { TenantScope } from 'ghost-platform-portal-data/tenant';
import { escapeHtml, type NavItem } from '../shell/html.js';
import type { ProvisioningSettings } from './provisioningSettings.js';

export const DEMO_PATH = '/demo';

/** Why the read failed, as a closed set; never anything the API or the network said. */
export type DemoReadFailure = 'NO_CREDENTIAL' | 'UNREACHABLE' | 'REFUSED' | 'MALFORMED';

/**
 * The provisioning API could not give a usable answer. The shell logs the
 * error's name alone and answers 500 `FAILED`, so the page says nothing of why.
 */
export class DemoReadError extends Error {
  constructor(readonly reason: DemoReadFailure) {
    super(`the demo could not be read: ${reason}`);
    this.name = 'DemoReadError';
  }
}

const TIMEOUT_MS = 5000;

/**
 * One placeholder per state the contract can return. Typed by the generated
 * `DemoState`, so a state added to the contract is a compile error here until
 * it has its line. The screen does no lifecycle logic: the API's state is shown.
 */
const STATE_PLACEHOLDER: Readonly<Record<DemoState, string>> = {
  VERIFIED: 'DEMO_STATE_VERIFIED',
  WAITING: 'DEMO_STATE_WAITING',
  CLAIMED: 'DEMO_STATE_CLAIMED',
  PROVISIONING: 'DEMO_STATE_PROVISIONING',
  LIVE: 'DEMO_STATE_LIVE',
  EXTENDED: 'DEMO_STATE_EXTENDED',
  EXPIRING: 'DEMO_STATE_EXPIRING',
  REBUILDING: 'DEMO_STATE_REBUILDING',
  PROMOTING: 'DEMO_STATE_PROMOTING',
  PROMOTED: 'DEMO_STATE_PROMOTED',
  FAILED: 'DEMO_STATE_FAILED',
  KILLED: 'DEMO_STATE_KILLED',
  FROZEN: 'DEMO_STATE_FROZEN',
  PURGED: 'DEMO_STATE_PURGED',
};

/** The read: the demo, or null when the API answers that this tenant has none. */
type DemoReading = Demo | null;

function isDemo(value: unknown): value is Demo {
  if (typeof value !== 'object' || value === null) return false;
  const demo = value as Record<string, unknown>;
  return (
    typeof demo['state'] === 'string' &&
    (demo['address'] === null || typeof demo['address'] === 'string') &&
    (demo['expires_at'] === null ||
      (typeof demo['expires_at'] === 'string' && !Number.isNaN(Date.parse(demo['expires_at']))))
  );
}

/**
 * The bound tenant's own demo, through the generated client. The tenant is
 * the scope's and nothing else, and the credential presented is the one
 * issued for that tenant.
 */
export async function readOwnDemo(
  settings: ProvisioningSettings,
  scope: TenantScope
): Promise<DemoReading> {
  const credential = settings.credentialFor(scope.tenantId);
  if (credential === undefined) throw new DemoReadError('NO_CREDENTIAL');
  const result = await getDemo({
    baseUrl: settings.baseUrl,
    path: { tenant: scope.tenantId },
    auth: () => credential,
    throwOnError: false,
    // A redirect would carry the credential somewhere the settings did not name.
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...(settings.fetch === undefined ? {} : { fetch: settings.fetch }),
  }).catch(() => undefined);
  if (result === undefined || result.response === undefined) throw new DemoReadError('UNREACHABLE');
  const code = (result.error as { code?: unknown } | undefined)?.code;
  if (result.response.status === 404 && code === 'demo-not-found') return null;
  if (!result.response.ok || result.error !== undefined) throw new DemoReadError('REFUSED');
  if (!isDemo(result.data)) throw new DemoReadError('MALFORMED');
  return result.data;
}

/** The screen's markup, already escaped. Every visible string is an ALL_CAPS placeholder. */
export function renderDemo(reading: DemoReading): string {
  if (reading === null) return '<h1>SEE_MY_DEMO_HEADING</h1><p>NO_DEMO_FOUND</p>';
  const state = Object.hasOwn(STATE_PLACEHOLDER, reading.state)
    ? STATE_PLACEHOLDER[reading.state]
    : undefined;
  if (state === undefined) {
    return '<h1>SEE_MY_DEMO_HEADING</h1><p>DEMO_STATE_UNKNOWN</p>';
  }
  const expiry = reading.expires_at === null ? null : new Date(reading.expires_at);
  const address =
    reading.address === null ? 'NO_ADDRESS_YET' : `<code>${escapeHtml(reading.address)}</code>`;
  const expires =
    expiry === null
      ? 'NO_EXPIRY_YET'
      : `<time datetime="${expiry.toISOString()}">${expiry.toISOString()}</time>`;
  return (
    '<h1>SEE_MY_DEMO_HEADING</h1>' +
    `<dl><dt>DEMO_ADDRESS</dt><dd>${address}</dd>` +
    `<dt>DEMO_STATE</dt><dd>${state}</dd>` +
    `<dt>DEMO_EXPIRES</dt><dd>${expires}</dd></dl>`
  );
}

export interface DemoRoutes {
  readonly nav: readonly NavItem[];
  readonly pages: Readonly<Record<string, (scope: TenantScope) => Promise<string>>>;
}

/** With no settings there is no page and no navigation entry. */
export function createDemoRoutes(settings: ProvisioningSettings | undefined): DemoRoutes {
  if (settings === undefined) return { nav: [], pages: {} };
  return {
    nav: [{ label: 'NAV_DEMO', href: DEMO_PATH }],
    pages: { [DEMO_PATH]: async (scope) => renderDemo(await readOwnDemo(settings, scope)) },
  };
}
