export { bindTenant, TenantScope } from './scope.js';
export { TenantDb, type TenantRegistration } from './session.js';
export { InvalidTenantIdError, type TenantId } from '../tenantId.js';
export { assertTenantTablesIsolated, UnisolatedTableError } from '../isolation.js';
export type { Tx } from '../db.js';
