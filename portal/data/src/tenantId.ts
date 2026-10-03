declare const tenantIdBrand: unique symbol;

/** A platform tenant id: a lower-case UUID, validated at the boundary. */
export type TenantId = string & { readonly [tenantIdBrand]: true };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class InvalidTenantIdError extends Error {
  constructor() {
    super('tenant id is not a UUID');
    this.name = 'InvalidTenantIdError';
  }
}

/**
 * Validates a tenant id. The value is later set as a database setting and
 * cast to uuid there, so anything that is not already a canonical UUID is
 * refused here rather than left for the cast to reject.
 */
export function parseTenantId(value: unknown): TenantId {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new InvalidTenantIdError();
  }
  return value as TenantId;
}
