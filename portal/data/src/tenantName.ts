/**
 * The name a customer signs up under, which is also the slug of the tenant's
 * repository, database and stack. Defined once, here, and used by the register
 * table that stores it and the owner role that writes it. The shape is the
 * provisioning workflow's own rule (3-26 characters, lowercase alphanumerics
 * and single hyphens, no leading or trailing hyphen), so a name this accepts is
 * one that workflow accepts, and two spellings that reach the same repository
 * are the same name here.
 *
 * Customer names live in the control plane's database and in no repository, so
 * this is the only place the rule is applied to one.
 */
export const TENANT_NAME_PATTERN = '^[a-z][a-z0-9-]{1,24}[a-z0-9]$';

const SLUG = new RegExp(TENANT_NAME_PATTERN);
const SINGLE_HYPHENS = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A name that is not a plain slug once its case and padding are folded away. */
export class InvalidTenantNameError extends Error {
  constructor() {
    super('tenant name is not a valid name');
    this.name = 'InvalidTenantNameError';
  }
}

/** The name is already held by another tenant. It carries no name. */
export class TenantNameTakenError extends Error {
  constructor() {
    super('that tenant name is already taken');
    this.name = 'TenantNameTakenError';
  }
}

/**
 * The stored form of a tenant name: trimmed and lowercased, then required to be
 * a slug. Anything else is refused, never repaired. The input is not echoed in
 * the error, because a name is a customer's.
 */
export function normaliseTenantName(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidTenantNameError();
  const name = value.trim().toLowerCase();
  if (!SLUG.test(name) || !SINGLE_HYPHENS.test(name)) throw new InvalidTenantNameError();
  return name;
}
