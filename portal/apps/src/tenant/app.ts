import {
  CALLBACK_PATH,
  createTokenVerifier,
  ROLE_TENANT_ADMIN,
} from 'ghost-platform-identity/dist/index.js';
import type { TokenVerifierOptions } from 'ghost-platform-identity/dist/index.js';
import { TenantDb, type TenantScope } from 'ghost-platform-portal-data/tenant';
import { renderHealth } from '../shell/healthHtml.js';
import { escapeHtml } from '../shell/html.js';
import { createShell } from '../shell/app.js';

export interface TenantPortalOptions {
  readonly issuer: string;
  /** The portal's own client id; the console's is never given to this application. */
  readonly clientId: string;
  readonly projectId: string;
  readonly publicOrigin: string;
  /** The reconciled tenant organisations; an empty set admits no one. */
  readonly allowedOrgIds: ReadonlySet<string>;
  readonly db: TenantDb;
  readonly secureCookies: boolean;
  readonly clock?: () => number;
  readonly fetch?: typeof fetch;
  readonly fetchKeys?: TokenVerifierOptions['fetchKeys'];
  readonly sessionSeconds?: number;
}

/**
 * The tenant portal. The tenant comes from the signed-in session's
 * organisation and from nothing else: it is resolved once, at sign-in, into a
 * bound scope kept with the session, and the landing page is rendered from that
 * scope with no access to the request. This module imports only the tenant
 * entry point of the data layer.
 */
export function createTenantPortal(options: TenantPortalOptions) {
  const verifier = createTokenVerifier({
    issuer: options.issuer,
    clientId: options.clientId,
    requiredRole: ROLE_TENANT_ADMIN,
    allowedOrgIds: options.allowedOrgIds,
    leewaySeconds: 30,
    clock: options.clock,
    fetchKeys: options.fetchKeys,
  });
  return createShell<TenantScope>({
    issuer: options.issuer,
    clientId: options.clientId,
    projectId: options.projectId,
    redirectUri: `${options.publicOrigin}${CALLBACK_PATH}`,
    publicOrigin: options.publicOrigin,
    verifier,
    secureCookies: options.secureCookies,
    title: 'TENANT_PORTAL',
    nav: [{ label: 'NAV_HOME', href: '/' }],
    signOutLabel: 'SIGN_OUT',
    clock: options.clock,
    fetch: options.fetch,
    sessionSeconds: options.sessionSeconds,
    bind: ({ orgId }) => options.db.scopeForOrganisation(orgId),
    landing: async (scope) => {
      const own = await options.db.ownRegistration(scope);
      const id = own ? escapeHtml(own.tenantId) : 'NO_TENANT';
      const health = await options.db.ownHealth(scope);
      return `<h1>LANDING_PLACEHOLDER</h1><p>YOUR_TENANT_ID <code>${id}</code></p>${renderHealth(health)}`;
    },
  });
}
