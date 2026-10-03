import { assertTenantTablesIsolated } from './isolation.js';
import * as schema from './schema.js';

assertTenantTablesIsolated(schema);
console.log('every tenant table is isolated');
