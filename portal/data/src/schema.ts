import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  pgPolicy,
  pgRole,
  pgSchema,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Both roles are created by provisioning, never by a migration, so they are
 * declared here as existing: the policies below name them and nothing more.
 */
export const portalTenant = pgRole('portal_tenant').existing();
export const portalOwner = pgRole('portal_owner').existing();

export const portal = pgSchema('portal');

/**
 * The tenant register: the platform's tenant id against its Zitadel
 * organisation id. A tenant reads its own row; the owner role bypasses row
 * security by attribute. The policies are explained in the package README.
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

/** The states a tenant's health reading can be in. */
export const HEALTH_STATES = ['healthy', 'unhealthy', 'unknown'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

/**
 * The latest health and version reading for each tenant, written by the owner
 * role's ingestion and read by the tenant (its own row only) and the owner
 * console (every row). `version_match` is the sidecar's own comparison of the
 * reported version against the descriptor's intended one; null means it could
 * not be made. `mismatch_since` dates the first reading of a continuing
 * mismatch.
 */
export const healthReading = portal
  .table(
    'health_reading',
    {
      tenantId: uuid('tenant_id')
        .primaryKey()
        .references(() => tenantRegister.tenantId),
      health: text('health').notNull(),
      reportedVersion: text('reported_version'),
      versionMatch: boolean('version_match'),
      mismatchSince: timestamp('mismatch_since', { withTimezone: true }),
      observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    },
    (table) => [
      check(
        'health_reading_health_known',
        sql`${table.health} IN ('healthy', 'unhealthy', 'unknown')`
      ),
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
