import { sql } from 'drizzle-orm';
import { pgPolicy, pgSchema, text, uuid } from 'drizzle-orm/pg-core';
import { portalTenant } from '../src/schema.js';

// Two tables beside the register, in their own schema: `note` is isolated the
// way every tenant table must be, `leaky` is the control case that was left
// without the policy.
export const fixture = pgSchema('portal_test');

export const note = fixture
  .table(
    'note',
    {
      id: uuid('id').primaryKey().defaultRandom(),
      tenantId: uuid('tenant_id').notNull(),
      body: text('body').notNull(),
    },
    (table) => [
      pgPolicy('tenant_isolation', {
        as: 'permissive',
        for: 'all',
        to: portalTenant,
        using: sql`${table.tenantId} = public.bound_tenant()`,
        withCheck: sql`${table.tenantId} = public.bound_tenant()`,
      }),
    ]
  )
  .enableRLS();

export const leaky = fixture.table('leaky', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  body: text('body').notNull(),
});
