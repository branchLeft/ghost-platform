import { readFileSync } from 'node:fs';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface IdentityOutputs {
  readonly ownerOrgId: string;
  readonly projectId: string;
  readonly tenantOrgIds: readonly string[];
  readonly clientIds: { readonly console: string; readonly portal: string };
}

export type FileReader = (path: string) => string;

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Reads the reconciler's outputs file, refusing anything incomplete. */
export function parseOutputs(raw: string): IdentityOutputs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError('outputs file is not JSON');
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  const clients = (record['clientIds'] ?? {}) as Record<string, unknown>;
  const tenants = record['tenantOrgIds'];
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const orgIds = isRecord(tenants) ? Object.values(tenants) : null;
  if (
    !nonEmpty(record['ownerOrgId']) ||
    !nonEmpty(record['projectId']) ||
    !nonEmpty(clients['console']) ||
    !nonEmpty(clients['portal']) ||
    orgIds === null ||
    !orgIds.every(nonEmpty)
  ) {
    throw new ConfigError('outputs file is missing an identifier');
  }
  return {
    ownerOrgId: record['ownerOrgId'],
    projectId: record['projectId'],
    tenantOrgIds: orgIds as string[],
    clientIds: { console: clients['console'], portal: clients['portal'] },
  };
}

export interface PublicOrigin {
  readonly origin: string;
  /** Cookies are marked Secure whenever the origin is https. */
  readonly secureCookies: boolean;
}

/** Plain HTTP is accepted only for a loopback address, for local development. */
export function parseOrigin(value: string | undefined): PublicOrigin {
  let url: URL;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new ConfigError('public origin is not a URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ConfigError('public origin must be https');
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '') {
    throw new ConfigError('public origin must be an origin alone');
  }
  return { origin: url.origin, secureCookies: url.protocol === 'https:' };
}

export function requireEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string
): string {
  const value = env[name];
  if (!nonEmpty(value)) throw new ConfigError(`${name} is not set`);
  return value;
}

export const readText: FileReader = (path) => readFileSync(path, 'utf8');

export function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError('PORT is invalid');
  return port;
}
