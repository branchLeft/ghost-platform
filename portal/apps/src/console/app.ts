import { createTokenVerifier, ROLE_OWNER } from 'ghost-platform-identity/dist/index.js';
import type { TokenVerifierOptions } from 'ghost-platform-identity/dist/index.js';
import { OwnerDb } from 'ghost-platform-portal-data/owner';
import { escapeHtml } from '../shell/html.js';
import { createShell } from '../shell/app.js';

export interface OwnerConsoleOptions {
  readonly issuer: string;
  /** The console's own client id; the portal's is never given to this application. */
  readonly clientId: string;
  readonly projectId: string;
  readonly publicOrigin: string;
  /** The owner's own organisation, and no other. */
  readonly ownerOrgId: string;
  readonly db: OwnerDb;
  readonly secureCookies: boolean;
  readonly clock?: () => number;
  readonly fetch?: typeof fetch;
  readonly fetchKeys?: TokenVerifierOptions['fetchKeys'];
  readonly sessionSeconds?: number;
}

/**
 * The owner console. It admits only the owner's organisation holding the owner
 * role, and it alone reads across tenants, through the owner entry point of the
 * data layer. It shares no code path with the tenant portal beyond the page
 * shell and the sign-in plumbing.
 */
export function createOwnerConsole(options: OwnerConsoleOptions) {
  const verifier = createTokenVerifier({
    issuer: options.issuer,
    clientId: options.clientId,
    requiredRole: ROLE_OWNER,
    allowedOrgIds: new Set([options.ownerOrgId]),
    leewaySeconds: 30,
    clock: options.clock,
    fetchKeys: options.fetchKeys,
  });
  return createShell<true>({
    issuer: options.issuer,
    clientId: options.clientId,
    projectId: options.projectId,
    redirectUri: `${options.publicOrigin}/callback`,
    publicOrigin: options.publicOrigin,
    verifier,
    secureCookies: options.secureCookies,
    title: 'OWNER_CONSOLE',
    nav: [{ label: 'NAV_HOME', href: '/' }],
    signOutLabel: 'SIGN_OUT',
    clock: options.clock,
    fetch: options.fetch,
    sessionSeconds: options.sessionSeconds,
    bind: async () => true,
    landing: async () => {
      const tenants = await options.db.listTenants();
      const rows = tenants.map((t) => `<li><code>${escapeHtml(t.tenantId)}</code></li>`).join('');
      return `<h1>LANDING_PLACEHOLDER</h1><p>TENANTS_REGISTERED ${tenants.length}</p><ul>${rows}</ul>`;
    },
  });
}
