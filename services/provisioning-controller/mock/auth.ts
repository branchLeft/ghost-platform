import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * The mock's two credentials. A tenant credential is issued for one tenant; the
 * owner credential is the console's. They are never interchangeable, which is
 * what the contract says and what the mock enforces.
 */
export interface Credentials {
  readonly owner: string;
  /** Credential value to the one tenant id it is issued for. */
  readonly tenants: ReadonlyMap<string, string>;
}

export type Refusal = 'unauthenticated' | 'forbidden';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function same(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

/** The tenant a presented value is issued for, or undefined when nobody issued it. */
function tenantFor(credentials: Credentials, presented: string | undefined): string | undefined {
  if (presented === undefined) return undefined;
  let found: string | undefined;
  for (const [value, tenant] of credentials.tenants) {
    if (same(presented, value)) found = tenant;
  }
  return found;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Undefined when the request may proceed; otherwise why it may not. */
export function authorizeOwner(
  credentials: Credentials,
  request: IncomingMessage
): Refusal | undefined {
  const ownerHeader = header(request, 'x-owner-credential');
  const tenantHeader = header(request, 'x-tenant-credential');
  if (same(ownerHeader, credentials.owner)) return undefined;
  // A real credential of the other kind, in either header, is forbidden here;
  // anything nobody issued is unauthenticated.
  if (tenantFor(credentials, tenantHeader) !== undefined) return 'forbidden';
  if (tenantFor(credentials, ownerHeader) !== undefined) return 'forbidden';
  return 'unauthenticated';
}

export function authorizeTenant(
  credentials: Credentials,
  request: IncomingMessage,
  tenantId: string
): Refusal | undefined {
  const tenantHeader = header(request, 'x-tenant-credential');
  const ownerHeader = header(request, 'x-owner-credential');
  const issuedTo = tenantFor(credentials, tenantHeader);
  if (issuedTo !== undefined) return issuedTo === tenantId ? undefined : 'forbidden';
  if (same(tenantHeader, credentials.owner) || same(ownerHeader, credentials.owner)) {
    return 'forbidden';
  }
  return 'unauthenticated';
}
