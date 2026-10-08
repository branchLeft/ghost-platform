import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgSchema,
  primaryKey,
  foreignKey,
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

/** The kinds of versioned document the portal serves. */
export const DOCUMENT_KINDS = ['terms', 'usage', 'subprocessors'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** The kinds a tenant accepts; the sub-processor list is notified, not accepted. */
export const ACCEPTABLE_KINDS = ['terms', 'usage'] as const;
export type AcceptableKind = (typeof ACCEPTABLE_KINDS)[number];

/** One entry of a sub-processor list version; the text is placeholder until Rob supplies it. */
export interface SubprocessorEntry {
  name: string;
  purpose: string;
}

/**
 * The portal's versioned documents, one row per published version, shared by
 * every tenant (no tenant column: a document is the platform's, not a
 * tenant's). A row is never updated or deleted -- the roles hold no such
 * privilege -- so what a tenant accepted stays exactly what it was. A version
 * is current once `effective_at` has passed; for the sub-processor list the
 * table itself refuses an effective date earlier than `published_at` plus the
 * notice period, so a new entry cannot go live inside its notice. It holds no
 * tenant's data, so it has no row-level policy (one that raises on an unbound
 * tenant only fires per row, and would assure nothing on an empty table);
 * `TenantDb` still takes a scope for every read of it.
 */
export const documentVersion = portal.table(
  'document_version',
  {
    kind: text('kind').notNull(),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    entries: jsonb('entries')
      .$type<SubprocessorEntry[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    noticeDays: integer('notice_days').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.version] }),
    check('document_version_kind_known', sql`${table.kind} IN ('terms', 'usage', 'subprocessors')`),
    check('document_version_version_positive', sql`${table.version} >= 1`),
    check('document_version_notice_not_negative', sql`${table.noticeDays} >= 0`),
    check(
      'document_version_notice_elapsed',
      sql`${table.effectiveAt} >= ${table.publishedAt} + make_interval(hours => ${table.noticeDays} * 24)`
    ),
    check(
      'document_version_subprocessors_noticed',
      sql`${table.kind} <> 'subprocessors' OR ${table.noticeDays} >= 1`
    ),
  ]
);

/**
 * Which tenant accepted which version of which document, who for, and when.
 * Insert-only and tenant-isolated like every tenant table; it points at an
 * immutable version row, so a later document change cannot alter it.
 */
export const documentAcceptance = portal
  .table(
    'document_acceptance',
    {
      tenantId: uuid('tenant_id')
        .notNull()
        .references(() => tenantRegister.tenantId),
      kind: text('kind').notNull(),
      version: integer('version').notNull(),
      acceptedBy: text('accepted_by').notNull(),
      acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.tenantId, table.kind, table.version] }),
      foreignKey({
        columns: [table.kind, table.version],
        foreignColumns: [documentVersion.kind, documentVersion.version],
      }),
      check('document_acceptance_kind_acceptable', sql`${table.kind} IN ('terms', 'usage')`),
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
