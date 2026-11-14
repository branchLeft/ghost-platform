import { ConfigError, type FileReader } from '../shell/config.js';

/**
 * How the tenant portal reaches the provisioning API: where it is, and the
 * credential issued for one tenant. The credential is looked up by the tenant
 * id the session bound, so a request can never choose which one is presented.
 */
export interface ProvisioningSettings {
  readonly baseUrl: string;
  /** The credential issued for exactly this tenant, or undefined when none was. */
  readonly credentialFor: (tenantId: string) => string | undefined;
  /** Test seam only; absent, the generated client uses the platform's `fetch`. */
  readonly fetch?: typeof fetch;
}

export const PROVISIONING_VARIABLES = {
  url: 'PORTAL_PROVISIONING_API_URL',
  credentialsFile: 'PORTAL_PROVISIONING_CREDENTIALS_FILE',
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Plain HTTP is accepted only for a loopback address, for local development. */
function parseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${PROVISIONING_VARIABLES.url} is not a URL`);
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ConfigError(`${PROVISIONING_VARIABLES.url} must be https`);
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new ConfigError(`${PROVISIONING_VARIABLES.url} must not carry credentials or a query`);
  }
  return url.href.replace(/\/$/, '');
}

/** Lines of `<tenant uuid>=<credential>`; each tenant and each credential appears once. */
function parseCredentials(raw: string): ReadonlyMap<string, string> {
  const byTenant = new Map<string, string>();
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    const entry = line.trim();
    if (entry === '') continue;
    const at = entry.indexOf('=');
    const tenant = entry.slice(0, at);
    const credential = entry.slice(at + 1);
    if (at < 0 || !UUID.test(tenant) || credential === '') {
      throw new ConfigError(
        `${PROVISIONING_VARIABLES.credentialsFile} must hold lines of <tenant uuid>=<credential>`
      );
    }
    if (byTenant.has(tenant) || seen.has(credential)) {
      throw new ConfigError(
        `${PROVISIONING_VARIABLES.credentialsFile} must name each tenant and each credential once`
      );
    }
    byTenant.set(tenant, credential);
    seen.add(credential);
  }
  if (byTenant.size === 0) {
    throw new ConfigError(`${PROVISIONING_VARIABLES.credentialsFile} holds no credential`);
  }
  return byTenant;
}

/**
 * The provisioning API settings, or undefined when the URL variable is unset
 * or blank (the portal then has no demo screen). A URL that is set must be
 * usable, with a readable credentials file beside it: a half-configured
 * screen stops the process at start rather than answer every request with a
 * failure. The credentials come from a file, never the environment.
 */
export function loadProvisioningSettings(
  env: Readonly<Record<string, string | undefined>>,
  read: FileReader
): ProvisioningSettings | undefined {
  const url = env[PROVISIONING_VARIABLES.url];
  if (url === undefined || url.trim() === '') return undefined;
  const baseUrl = parseBaseUrl(url.trim());
  const file = env[PROVISIONING_VARIABLES.credentialsFile];
  if (file === undefined || file.trim() === '') {
    throw new ConfigError(`${PROVISIONING_VARIABLES.credentialsFile} is not set`);
  }
  let raw: string;
  try {
    raw = read(file.trim());
  } catch {
    throw new ConfigError(`${PROVISIONING_VARIABLES.credentialsFile} cannot be read`);
  }
  const credentials = parseCredentials(raw);
  return { baseUrl, credentialFor: (tenantId) => credentials.get(tenantId) };
}
