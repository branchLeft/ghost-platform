import type { BlockList } from 'node:net';
import {
  parseOrigin,
  ConfigError,
  parseOutputs,
  parsePort,
  parseTrustedProxyList,
  readText,
  requireEnv,
  type FileReader,
} from '../shell/config.js';
import type { ProvisioningOptions } from './requestsScreen.js';

export interface OwnerConsoleConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly projectId: string;
  readonly publicOrigin: string;
  readonly secureCookies: boolean;
  readonly ownerOrgId: string;
  readonly databaseUrl: string;
  readonly port: number;
  /** Set by `CONSOLE_TRUSTED_PROXIES`; absent, sign-in is not rate limited. */
  readonly trustedProxies?: BlockList;
  /**
   * Set by `CONSOLE_PROVISIONING_URL` and `CONSOLE_PROVISIONING_CREDENTIAL_FILE`
   * together; absent, the request queue is not served.
   */
  readonly provisioning?: ProvisioningOptions;
}

/**
 * Neither variable set is no queue. One alone is a mistake that stops the
 * process at start, so a half-configured console never looks configured. The
 * credential travels in a header, so the URL is an origin over https (plain
 * http only for loopback), with nothing else in it.
 */
export function loadProvisioning(
  env: Readonly<Record<string, string | undefined>>,
  read: FileReader
): ProvisioningOptions | undefined {
  const url = env['CONSOLE_PROVISIONING_URL'];
  const file = env['CONSOLE_PROVISIONING_CREDENTIAL_FILE'];
  if ((url === undefined || url === '') && (file === undefined || file === '')) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(requireEnv(env, 'CONSOLE_PROVISIONING_URL'));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('CONSOLE_PROVISIONING_URL is not a URL');
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new ConfigError('CONSOLE_PROVISIONING_URL must be https');
  }
  if (
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== ''
  ) {
    throw new ConfigError('CONSOLE_PROVISIONING_URL must be an origin alone');
  }
  const ownerCredential = read(requireEnv(env, 'CONSOLE_PROVISIONING_CREDENTIAL_FILE')).trim();
  if (ownerCredential === '') throw new ConfigError('the provisioning credential file is empty');
  return { baseUrl: parsed.origin, ownerCredential };
}

/** Everything the owner console needs, from its own variables. */
export function loadConsoleConfig(
  env: Readonly<Record<string, string | undefined>>,
  read: FileReader = readText
): OwnerConsoleConfig {
  const outputs = parseOutputs(read(requireEnv(env, 'CONSOLE_OUTPUTS_FILE')));
  const origin = parseOrigin(env['CONSOLE_PUBLIC_ORIGIN']);
  const trustedProxies = parseTrustedProxyList(env, 'CONSOLE_TRUSTED_PROXIES');
  const provisioning = loadProvisioning(env, read);
  return {
    issuer: requireEnv(env, 'CONSOLE_ISSUER_URL'),
    clientId: outputs.clientIds.console,
    projectId: outputs.projectId,
    publicOrigin: origin.origin,
    secureCookies: origin.secureCookies,
    ownerOrgId: outputs.ownerOrgId,
    databaseUrl: read(requireEnv(env, 'CONSOLE_DATABASE_URL_FILE')).trim(),
    port: parsePort(env['PORT'], 8081),
    ...(trustedProxies === undefined ? {} : { trustedProxies }),
    ...(provisioning === undefined ? {} : { provisioning }),
  };
}
