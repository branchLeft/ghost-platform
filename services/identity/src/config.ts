import { ConfigError } from './errors.js';

/** One tenant. The slug is the tenant's stable key; the display name is only
 * a label and is never used to find or match anything. */
export interface TenantEntry {
  readonly slug: string;
  readonly displayName: string;
}

/** The three public names. They are inputs, never constants: Zitadel fixes its
 * external domain when an instance is first initialised, so the operator
 * decides them, and this service refuses any set that would let the two
 * applications share a name. */
export interface Hostnames {
  readonly console: string;
  readonly portal: string;
  readonly identity: string;
}

/** The mail provider the sign-in service sends its codes and links through.
 * The password is deliberately not here: it is read from a file the operator
 * names (`smtp.ts`), so this document can be committed and logged. The
 * account name Zitadel authenticates as is always the sender address, because
 * the mail host refuses a sender that is not the account's own address. */
export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly senderAddress: string;
  readonly senderName: string;
  /** STARTTLS is required of the mail host. False is accepted only for a
   * single-label host (a container name or localhost), which can never be a
   * real mail host, so a plaintext submission to the internet is unwritable. */
  readonly tls: boolean;
}

export interface IdentityConfig {
  readonly hostnames: Hostnames;
  readonly tenants: readonly TenantEntry[];
  readonly smtp?: SmtpConfig;
}

/** Matches the tenant descriptor's own slug grammar. */
const SLUG_PATTERN = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

/** Tenant organisation names are `tenant-<slug>`, so the slug cap leaves room
 * for that prefix inside a 63-character name. */
export const MAX_SLUG_LENGTH = 52;
export const MAX_DISPLAY_NAME_LENGTH = 100;

/** Slugs that would read as the owner's own organisation or an application. */
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'owner',
  'branchleft-owner',
  'console',
  'portal',
  'identity',
  'admin',
]);

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A bare, lowercase, multi-label DNS name. Anything that is not one (a URL, a
 * port, a wildcard, an address, an upper-case spelling that would compare
 * unequal to its lower-case twin) is refused rather than normalised, so what
 * is validated is exactly what is written into a redirect URI. */
export function hostnameProblem(field: string, value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return `${field} must be a non-empty string`;
  }
  if (value.length > 253) {
    return `${field} is longer than 253 characters`;
  }
  if (IPV4.test(value) || value.includes(':')) {
    return `${field} "${value}" must be a DNS name, not an address or a host:port`;
  }
  const labels = value.split('.');
  if (labels.length < 2) {
    return `${field} "${value}" must have at least two labels`;
  }
  if (!labels.every((label) => LABEL.test(label))) {
    return `${field} "${value}" must be lower-case letters, digits and hyphens in dot-separated labels, with no scheme, path or wildcard`;
  }
  return null;
}

function validateHostnames(raw: unknown, problems: string[]): Hostnames | null {
  if (!isRecord(raw)) {
    problems.push('hostnames must be an object with console, portal and identity');
    return null;
  }
  const before = problems.length;
  for (const field of ['console', 'portal', 'identity'] as const) {
    const problem = hostnameProblem(`hostnames.${field}`, raw[field]);
    if (problem) problems.push(problem);
  }
  if (problems.length > before) return null;
  const hostnames: Hostnames = {
    console: raw['console'] as string,
    portal: raw['portal'] as string,
    identity: raw['identity'] as string,
  };
  const seen = new Map<string, string>();
  for (const [field, value] of Object.entries(hostnames)) {
    const earlier = seen.get(value);
    if (earlier) {
      problems.push(
        `hostnames.${field} and hostnames.${earlier} are both "${value}"; the console, the portal and sign-in each need their own name`
      );
    } else {
      seen.set(value, field);
    }
  }
  return problems.length > before ? null : hostnames;
}

function validateTenants(raw: unknown, problems: string[]): TenantEntry[] {
  if (!Array.isArray(raw)) {
    problems.push('tenants must be an array');
    return [];
  }
  const tenants: TenantEntry[] = [];
  const slugs = new Set<string>();
  raw.forEach((entry: unknown, index) => {
    const where = `tenants[${index}]`;
    if (!isRecord(entry)) {
      problems.push(`${where} must be an object with slug and displayName`);
      return;
    }
    const { slug, displayName } = entry;
    let ok = true;
    if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
      problems.push(
        `${where}.slug must be lower-case letters, digits and inner hyphens, starting with a letter`
      );
      ok = false;
    } else if (slug.length > MAX_SLUG_LENGTH) {
      problems.push(`${where}.slug "${slug}" is longer than ${MAX_SLUG_LENGTH} characters`);
      ok = false;
    } else if (RESERVED_SLUGS.has(slug)) {
      problems.push(`${where}.slug "${slug}" is reserved`);
      ok = false;
    } else if (slugs.has(slug)) {
      problems.push(`${where}.slug "${slug}" appears twice`);
      ok = false;
    }
    if (
      typeof displayName !== 'string' ||
      displayName.trim().length === 0 ||
      displayName.length > MAX_DISPLAY_NAME_LENGTH
    ) {
      problems.push(
        `${where}.displayName must be a non-empty string of at most ${MAX_DISPLAY_NAME_LENGTH} characters`
      );
      ok = false;
    }
    if (ok) {
      slugs.add(slug as string);
      tenants.push({ slug: slug as string, displayName: displayName as string });
    }
  });
  return tenants;
}

export const SMTP_SUBMISSION_PORT = 587;
const SINGLE_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_PART = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SMTP_KEYS = new Set(['host', 'port', 'senderAddress', 'senderName', 'tls']);

function validateSmtp(raw: unknown, problems: string[]): SmtpConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    problems.push('smtp must be an object with host, port, senderAddress and senderName');
    return undefined;
  }
  const before = problems.length;
  for (const key of Object.keys(raw)) {
    if (/pass|secret|token|credential|user/i.test(key)) {
      problems.push(
        `smtp.${key} is not accepted here: the account name is the sender address and the password is read from a file`
      );
    } else if (!SMTP_KEYS.has(key)) {
      problems.push(`smtp.${key} is not a known setting`);
    }
  }
  const tlsRaw = raw['tls'];
  if (tlsRaw !== undefined && typeof tlsRaw !== 'boolean')
    problems.push('smtp.tls must be true or false');
  const tls = tlsRaw !== false;
  const host = raw['host'];
  if (typeof host !== 'string' || host.length === 0) {
    problems.push('smtp.host must be a non-empty string');
  } else if (tls) {
    const problem = hostnameProblem('smtp.host', host);
    if (problem) problems.push(problem);
  } else if (!SINGLE_LABEL.test(host)) {
    problems.push(
      'smtp.host "' +
        host +
        '" must be a single-label name (a container name or localhost) while tls is off; a real mail host needs tls'
    );
  }
  const port = raw['port'] ?? SMTP_SUBMISSION_PORT;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push('smtp.port must be a whole number from 1 to 65535');
  } else if (tls && port !== SMTP_SUBMISSION_PORT) {
    problems.push(`smtp.port must be ${SMTP_SUBMISSION_PORT} (STARTTLS submission) when tls is on`);
  }
  const address = raw['senderAddress'];
  const at = typeof address === 'string' ? address.indexOf('@') : -1;
  if (typeof address !== 'string' || at < 1 || address.indexOf('@', at + 1) !== -1) {
    problems.push('smtp.senderAddress must be a single address, local@domain');
  } else {
    if (!LOCAL_PART.test(address.slice(0, at))) {
      problems.push(
        'smtp.senderAddress local part must be lower-case letters, digits, dots, hyphens or underscores'
      );
    }
    const domainProblem = hostnameProblem('smtp.senderAddress domain', address.slice(at + 1));
    if (domainProblem) problems.push(domainProblem);
  }
  const name = raw['senderName'];
  if (
    typeof name !== 'string' ||
    name.trim().length === 0 ||
    name.length > MAX_DISPLAY_NAME_LENGTH ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f<>"]/.test(name)
  ) {
    problems.push(
      `smtp.senderName must be a non-empty string of at most ${MAX_DISPLAY_NAME_LENGTH} characters with no control characters, quotes or angle brackets`
    );
  }
  if (problems.length > before) return undefined;
  return {
    host: host as string,
    port: port as number,
    senderAddress: address as string,
    senderName: name as string,
    tls,
  };
}

/** Validates untrusted parsed JSON. Every problem is collected; any problem
 * throws, so nothing is reconciled from a partly valid list. */
export function validateConfig(raw: unknown): IdentityConfig {
  if (!isRecord(raw)) {
    throw new ConfigError(['configuration must be a JSON object']);
  }
  const problems: string[] = [];
  const hostnames = validateHostnames(raw['hostnames'], problems);
  const tenants = validateTenants(raw['tenants'], problems);
  const smtp = validateSmtp(raw['smtp'], problems);
  if (problems.length > 0 || hostnames === null) {
    throw new ConfigError(problems);
  }
  return smtp === undefined ? { hostnames, tenants } : { hostnames, tenants, smtp };
}
