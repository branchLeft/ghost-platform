import { readText, type FileReader } from '../shell/config.js';

type Env = Readonly<Record<string, string | undefined>>;

export const PROVISIONING_VARIABLES = {
  url: 'PORTAL_PROVISIONING_URL',
  credentialsFile: 'PORTAL_PROVISIONING_CREDENTIALS_FILE',
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * How the tenant portal reaches the provisioning API. Each tenant credential
 * the contract issues is good for exactly one tenant, so the portal holds one
 * per tenant and looks it up by the tenant its session is bound to.
 */
export interface ProvisioningSettings {
  /** The API's origin, with no trailing slash and no credentials in it. */
  readonly baseUrl: string;
  /** The credential issued for `tenantId`, or undefined when the portal holds none. */
  credentialFor(tenantId: string): string | undefined;
}

export interface ProvisioningLoad {
  /** Absent when anything is missing or invalid: the pages that need it are then not served. */
  readonly provisioning: ProvisioningSettings | undefined;
  /** Variable names only, never a value. */
  readonly disabledBecause: readonly string[];
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

function baseUrlOf(value: string | undefined): string | undefined {
  if (!present(value)) return undefined;
  try {
    const url = new URL(value.trim());
    const plain = url.protocol === 'http:' || url.protocol === 'https:';
    if (
      !plain ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return undefined;
    }
    return url.href.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

/** `<tenant uuid>=<credential>` per line, blank lines ignored; anything else is no map at all. */
function credentialsFrom(
  path: string | undefined,
  read: FileReader
): ReadonlyMap<string, string> | undefined {
  if (!present(path)) return undefined;
  let text: string;
  try {
    text = read(path);
  } catch {
    return undefined;
  }
  const byTenant = new Map<string, string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const at = trimmed.indexOf('=');
    const tenant = trimmed.slice(0, at);
    const credential = trimmed.slice(at + 1);
    if (at < 0 || !UUID.test(tenant) || credential === '' || byTenant.has(tenant)) return undefined;
    byTenant.set(tenant, credential);
  }
  return byTenant.size === 0 ? undefined : byTenant;
}

/**
 * The provisioning API's settings from the environment. Fail closed: if the
 * URL or the credentials file is missing or invalid there are no settings, the
 * portal still starts, and the pages that need the API are not served. The
 * credentials come from a file, never the environment.
 */
export function loadProvisioningSettings(env: Env, read: FileReader = readText): ProvisioningLoad {
  const names = PROVISIONING_VARIABLES;
  const baseUrl = baseUrlOf(env[names.url]);
  const credentials = credentialsFrom(env[names.credentialsFile], read);
  const bad: string[] = [];
  if (baseUrl === undefined) bad.push(names.url);
  if (credentials === undefined) bad.push(names.credentialsFile);
  if (baseUrl === undefined || credentials === undefined) {
    return { provisioning: undefined, disabledBecause: bad };
  }
  return {
    provisioning: { baseUrl, credentialFor: (tenantId) => credentials.get(tenantId) },
    disabledBecause: [],
  };
}

/** One stderr line saying the provisioning pages are off and which variables to look at. */
export function provisioningDisabledLine(names: readonly string[]): string {
  return JSON.stringify({ event: 'provisioning_disabled', variables: names });
}
