import { parseTenantId, type TenantId } from '../tenantId.js';

const mint = Symbol('mint a tenant scope');

/**
 * The proof that a tenant was bound at the session. It has no public
 * constructor and `bindTenant` is the only way to make one, so a function
 * that takes a `TenantScope` cannot be called without one: the missing
 * binding is a compile error, not a forgotten filter.
 */
export class TenantScope {
  readonly #tenantId: TenantId;

  constructor(token: symbol, tenantId: TenantId) {
    if (token !== mint) {
      throw new TypeError('a TenantScope is made with bindTenant');
    }
    this.#tenantId = tenantId;
  }

  get tenantId(): TenantId {
    return this.#tenantId;
  }
}

/** Binds a tenant, taking the id from the signed-in session. */
export function bindTenant(tenantId: unknown): TenantScope {
  return new TenantScope(mint, parseTenantId(tenantId));
}
