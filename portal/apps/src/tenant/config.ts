import type { BlockList } from 'node:net';
import {
  ConfigError,
  parseOrigin,
  parseOutputs,
  parsePort,
  parseTrustedProxyList,
  readText,
  requireEnv,
  type FileReader,
} from '../shell/config.js';
import { loadProvisioningSettings, type ProvisioningSettings } from './provisioningSettings.js';

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
  /** Set by `PORTAL_PROVISIONING_URL`; absent, there is no demo screen. */
  readonly provisioning?: ProvisioningSettings;
  /** Set by `PORTAL_ALLOW_PLACEHOLDER_COPY=1`; otherwise a tenant is never shown an unfilled placeholder. */
  readonly allowPlaceholderCopy: boolean;
}

/** Off unless the variable is exactly `1`; `0` and unset are off, anything else stops the process. */
export function parseAllowPlaceholderCopy(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new ConfigError('PORTAL_ALLOW_PLACEHOLDER_COPY must be 1 or 0');
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
  const provisioning = loadProvisioningSettings(env, read);
  return {
    issuer: requireEnv(env, 'PORTAL_ISSUER_URL'),
    clientId: outputs.clientIds.portal,
    projectId: outputs.projectId,
    publicOrigin: origin.origin,
    secureCookies: origin.secureCookies,
    allowedOrgIds: new Set(outputs.tenantOrgIds),
    databaseUrl: read(requireEnv(env, 'PORTAL_DATABASE_URL_FILE')).trim(),
    port: parsePort(env['PORT'], 8080),
    allowPlaceholderCopy: parseAllowPlaceholderCopy(env['PORTAL_ALLOW_PLACEHOLDER_COPY']),
    ...(trustedProxies === undefined ? {} : { trustedProxies }),
    ...(provisioning === undefined ? {} : { provisioning }),
  };
}
