import { sql } from 'drizzle-orm';
import { pgPolicy, pgRole, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Both roles are created by provisioning, never by a migration, so they are
 * declared here as existing: the policies below name them and nothing more.
 */
export const portalTenant = pgRole('portal_tenant').existing();
export const portalOwner = pgRole('portal_owner').existing();

export const portal = pgSchema('portal');

/**
 * The tenant register: the platform's tenant id against its Zitadel
 * organisation id. A tenant sees its own row; the owner role has no policy
 * because provisioning creates it with the attribute that bypasses row
 * security.
 *
 * `public.bound_tenant()` raises when no tenant (and no organisation) is
 * bound to the transaction, so an unbound statement fails rather than
 * returning nothing or everything. The second policy lets a session whose
 * organisation is known, and nothing else, read that organisation's row, which
 * is how the session's organisation becomes a bound tenant.
 */
export const tenantRegister = portal
  .table(
    'tenant_register',
    {
      tenantId: uuid('tenant_id').primaryKey(),
      zitadelOrgId: text('zitadel_org_id').notNull().unique(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      pgPolicy('tenant_isolation', {
        as: 'permissive',
        for: 'all',
        to: portalTenant,
        using: sql`${table.tenantId} = public.bound_tenant()`,
        withCheck: sql`${table.tenantId} = public.bound_tenant()`,
      }),
      pgPolicy('organisation_lookup', {
        as: 'permissive',
        for: 'select',
        to: portalTenant,
        using: sql`${table.zitadelOrgId} = public.bound_organisation()`,
      }),
    ]
  )
  .enableRLS();
