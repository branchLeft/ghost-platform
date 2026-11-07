import type { BlockList } from 'node:net';
import {
  parseOrigin,
  parseOutputs,
  parsePort,
  parseTrustedProxyList,
  readText,
  requireEnv,
  type FileReader,
} from '../shell/config.js';

export interface TenantPortalConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly projectId: string;
  readonly publicOrigin: string;
  readonly secureCookies: boolean;
  readonly allowedOrgIds: ReadonlySet<string>;
  readonly databaseUrl: string;
  readonly port: number;
  /** Set by `PORTAL_TRUSTED_PROXIES`; absent, sign-in is not rate limited. */
  readonly trustedProxies?: BlockList;
}

/**
 * Everything the tenant portal needs, from its own variables. The database
 * login's URL is read from a file, never the environment, and the application
 * ids come from the reconciler's outputs file.
 */
export function loadTenantConfig(
  env: Readonly<Record<string, string | undefined>>,
  read: FileReader = readText
): TenantPortalConfig {
  const outputs = parseOutputs(read(requireEnv(env, 'PORTAL_OUTPUTS_FILE')));
  const origin = parseOrigin(env['PORTAL_PUBLIC_ORIGIN']);
  const trustedProxies = parseTrustedProxyList(env, 'PORTAL_TRUSTED_PROXIES');
  return {
    issuer: requireEnv(env, 'PORTAL_ISSUER_URL'),
    clientId: outputs.clientIds.portal,
    projectId: outputs.projectId,
    publicOrigin: origin.origin,
    secureCookies: origin.secureCookies,
    allowedOrgIds: new Set(outputs.tenantOrgIds),
    databaseUrl: read(requireEnv(env, 'PORTAL_DATABASE_URL_FILE')).trim(),
    port: parsePort(env['PORT'], 8080),
    ...(trustedProxies === undefined ? {} : { trustedProxies }),
  };
}
