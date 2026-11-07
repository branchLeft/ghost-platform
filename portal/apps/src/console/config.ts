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
}

/** Everything the owner console needs, from its own variables. */
export function loadConsoleConfig(
  env: Readonly<Record<string, string | undefined>>,
  read: FileReader = readText
): OwnerConsoleConfig {
  const outputs = parseOutputs(read(requireEnv(env, 'CONSOLE_OUTPUTS_FILE')));
  const origin = parseOrigin(env['CONSOLE_PUBLIC_ORIGIN']);
  const trustedProxies = parseTrustedProxyList(env, 'CONSOLE_TRUSTED_PROXIES');
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
  };
}
