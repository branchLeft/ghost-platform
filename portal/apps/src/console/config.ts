import {
  parseOrigin,
  parseOutputs,
  parsePort,
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
}

/** Everything the owner console needs, from its own variables. */
export function loadConsoleConfig(
  env: Readonly<Record<string, string | undefined>>,
  read: FileReader = readText
): OwnerConsoleConfig {
  const outputs = parseOutputs(read(requireEnv(env, 'CONSOLE_OUTPUTS_FILE')));
  const origin = parseOrigin(env['CONSOLE_PUBLIC_ORIGIN']);
  return {
    issuer: requireEnv(env, 'CONSOLE_ISSUER_URL'),
    clientId: outputs.clientIds.console,
    projectId: outputs.projectId,
    publicOrigin: origin.origin,
    secureCookies: origin.secureCookies,
    ownerOrgId: outputs.ownerOrgId,
    databaseUrl: read(requireEnv(env, 'CONSOLE_DATABASE_URL_FILE')).trim(),
    port: parsePort(env['PORT'], 8081),
  };
}
