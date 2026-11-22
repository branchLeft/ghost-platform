// Where the suite points. With no base URL it points at the local rig of two
// disposable tenants. With ATTACK_BASE_URL it points at a deployed shared
// domain, and only when the operator has said, in a second variable, that both
// tenants are throwaway: the suite plants hostile content and sends one
// oversize-cookie request, which no real tenant should ever receive.

import type { PslState } from './model.ts';

export interface Credentials {
  readonly email: string;
  readonly password: string;
}

export interface LocalTarget {
  readonly kind: 'local';
}

export interface DeployedTarget {
  readonly kind: 'deployed';
  readonly scheme: 'https' | 'http';
  /** The shared tenant domain, e.g. the parent of both tenants' hostnames. */
  readonly sharedDomain: string;
  readonly rootDomain: string;
  readonly tenantA: string;
  readonly tenantB: string;
  readonly portalOrigin: string;
  readonly portalLoginPath: string;
  readonly adminA: Credentials;
  readonly adminB: Credentials;
  readonly psl: PslState;
  /** Image digests the operator read from the registry or host, recorded as supplied. */
  readonly suppliedImages: readonly string[];
}

export type Target = LocalTarget | DeployedTarget;

export class TargetError extends Error {}

export const CONFIRM_VALUE = 'both-tenants-are-throwaway';

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/;
const DIGEST = /^[a-z0-9][a-z0-9./_:-]*@sha256:[0-9a-f]{64}$/;

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new TargetError(`${name} is required`);
  return value;
}

/**
 * Reads the target from the environment. Throws TargetError with a message
 * naming the variable, never echoing a credential's value.
 */
export function targetFromEnv(env: Readonly<Record<string, string | undefined>>): Target {
  const base = env['ATTACK_BASE_URL'];
  if (base === undefined || base === '') return { kind: 'local' };

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new TargetError('ATTACK_BASE_URL is not a URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TargetError('ATTACK_BASE_URL must be an http or https URL');
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '') {
    throw new TargetError(
      'ATTACK_BASE_URL must be the shared domain alone: no path, query or login'
    );
  }
  if (url.port !== '') {
    throw new TargetError(
      'ATTACK_BASE_URL must not carry a port: tenants are served on the default one'
    );
  }
  if (!HOST.test(url.hostname)) throw new TargetError('ATTACK_BASE_URL host is not a plain domain');
  if (env['ATTACK_CONFIRM'] !== CONFIRM_VALUE) {
    throw new TargetError(
      `a deployed target is only attacked when ATTACK_CONFIRM=${CONFIRM_VALUE}: the suite plants hostile content on both tenants`
    );
  }

  const tenantA = required(env, 'ATTACK_TENANT_A');
  const tenantB = required(env, 'ATTACK_TENANT_B');
  if (!LABEL.test(tenantA) || !LABEL.test(tenantB)) {
    throw new TargetError('ATTACK_TENANT_A and ATTACK_TENANT_B are single DNS labels');
  }
  if (tenantA === tenantB) throw new TargetError('the two tenants must differ');

  const sharedDomain = url.hostname;
  const rootDomain = required(env, 'ATTACK_ROOT_DOMAIN');
  if (sharedDomain !== rootDomain && !sharedDomain.endsWith(`.${rootDomain}`)) {
    throw new TargetError('ATTACK_ROOT_DOMAIN must be the shared domain or a parent of it');
  }

  const portal = required(env, 'ATTACK_PORTAL_URL');
  let portalUrl: URL;
  try {
    portalUrl = new URL(portal);
  } catch {
    throw new TargetError('ATTACK_PORTAL_URL is not a URL');
  }
  if (portalUrl.hostname !== rootDomain && !portalUrl.hostname.endsWith(`.${rootDomain}`)) {
    throw new TargetError('ATTACK_PORTAL_URL must sit under the root domain');
  }

  const pslRaw = env['ATTACK_PSL'] ?? 'absent';
  if (pslRaw !== 'absent' && pslRaw !== 'present') {
    throw new TargetError('ATTACK_PSL is "absent" or "present"');
  }

  const supplied = (env['ATTACK_IMAGE_DIGESTS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const digest of supplied) {
    if (!DIGEST.test(digest)) {
      throw new TargetError(
        'ATTACK_IMAGE_DIGESTS is a comma-separated list of name@sha256:<64 hex>'
      );
    }
  }

  return {
    kind: 'deployed',
    scheme: url.protocol === 'https:' ? 'https' : 'http',
    sharedDomain,
    rootDomain,
    tenantA,
    tenantB,
    portalOrigin: portalUrl.origin,
    portalLoginPath: env['ATTACK_PORTAL_LOGIN_PATH'] ?? '/login',
    adminA: {
      email: required(env, 'ATTACK_ADMIN_A_EMAIL'),
      password: required(env, 'ATTACK_ADMIN_A_PASSWORD'),
    },
    adminB: {
      email: required(env, 'ATTACK_ADMIN_B_EMAIL'),
      password: required(env, 'ATTACK_ADMIN_B_PASSWORD'),
    },
    psl: pslRaw,
    suppliedImages: supplied,
  };
}
