import { ne } from 'drizzle-orm';
import type { Tx } from '../db.js';
import { tenantRegister } from '../schema.js';
import type { TenantScope } from './scope.js';

/**
 * A tenant-facing unit of work left the session bound to something other than
 * its scope's tenant, or left it in a state in which the binding could not be
 * confirmed. The transaction is rolled back: nothing the work read or wrote
 * leaves it.
 */
export class TenantBindingChangedError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(
      'the tenant binding was changed during the request, or could not be confirmed after it',
      options
    );
    this.name = 'TenantBindingChangedError';
  }
}

/**
 * Confirms, inside the transaction and after the work has run, that the session
 * still sees exactly the scope's tenant. The register is the anchor: under the
 * tenant role, the tenant policy and the bound tenant it holds at most the
 * scope's own row, so any other row means the binding was rebound (to a tenant
 * or an organisation) or the role was left. A probe that fails -- the role was
 * left and its privileges went with it, or the transaction is aborted -- is
 * refused the same way. The probe is a typed query, so it adds no raw SQL.
 *
 * It checks the state the work leaves behind. A rebinding that is undone
 * before the work returns is not seen: see "The guarantee" in the README.
 */
export async function assertBindingIntact(tx: Tx, scope: TenantScope): Promise<void> {
  let foreign: Array<{ tenantId: string }>;
  try {
    foreign = await tx
      .select({ tenantId: tenantRegister.tenantId })
      .from(tenantRegister)
      .where(ne(tenantRegister.tenantId, scope.tenantId))
      .limit(1);
  } catch (error) {
    throw new TenantBindingChangedError({ cause: error });
  }
  if (foreign.length > 0) throw new TenantBindingChangedError();
}
