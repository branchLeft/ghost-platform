/**
 * What a tenant is: a real one, or a demo slot. Defined once, here, and used by
 * the register table that stores it, the owner role that writes it and the
 * tenant portal that reads it, so the three cannot drift apart. A demo slot is
 * given none of the configurable moderation layers.
 */
export const TENANT_KINDS = ['REAL', 'DEMO'] as const;
export type TenantKind = (typeof TENANT_KINDS)[number];

/** A kind that is absent or not an exact member of `TENANT_KINDS`. */
export class InvalidTenantKindError extends Error {
  constructor() {
    super('tenant kind is not one of the recognised kinds');
    this.name = 'InvalidTenantKindError';
  }
}

/**
 * Validates a tenant kind. Only an exact member is accepted: a missing value, a
 * non-string, an empty string or a wrong-case spelling is refused, never
 * defaulted to a real tenant or to a demo.
 */
export function parseTenantKind(value: unknown): TenantKind {
  if (typeof value !== 'string' || !(TENANT_KINDS as readonly string[]).includes(value)) {
    throw new InvalidTenantKindError();
  }
  return value as TenantKind;
}
