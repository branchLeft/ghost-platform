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
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { TENANT_KINDS } from './tenantKind.js';
import {
  DEMO_STATES,
  LABEL_PATTERN,
  LEASE_DAYS,
  NEXT_STATES,
  STATES_BEFORE_LEASE,
  STATES_WITH_LEASE,
} from './demoStates.js';

/**
 * Both roles are created by provisioning, never by a migration, so they are
 * declared here as existing: the policies below name them and nothing more.
 */
export const portalTenant = pgRole('portal_tenant').existing();
export const portalOwner = pgRole('portal_owner').existing();

export const portal = pgSchema('portal');

const sqlList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');

/**
 * The tenant register: the platform's tenant id against its Zitadel
 * organisation id and its kind (a real tenant or a demo slot). A tenant reads
 * its own row and holds no write privilege on it, so it cannot change its own
 * kind; the owner role bypasses row security by attribute. The kind has no
 * default: a row that names none is refused, never guessed. The policies are
 * explained in the package README.
 */
export const tenantRegister = portal
  .table(
    'tenant_register',
    {
      tenantId: uuid('tenant_id').primaryKey(),
      zitadelOrgId: text('zitadel_org_id').notNull().unique(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      kind: text('kind').notNull(),
    },
    (table) => [
      check(
        'tenant_register_kind_known',
        sql`${table.kind} IN (${sql.raw(sqlList(TENANT_KINDS))})`
      ),
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

/**
 * The notice, in days, before a new sub-processor list version goes live:
 * owner ruling, 2026-10-08. The table refuses any list version with less.
 */
export const SUBPROCESSOR_NOTICE_DAYS = 30;

/** One entry of a sub-processor list version; the text is placeholder until the owner supplies it. */
export interface SubprocessorEntry {
  name: string;
  purpose: string;
}

/**
 * The portal's versioned documents: one immutable row per published version,
 * shared by every tenant (no tenant column). A version is current once
 * `effective_at` has passed. For the sub-processor list the table refuses an
 * effective date earlier than `published_at` plus the notice, and
 * `published_at` is the database's own clock, so no entry goes live inside its
 * notice. It holds no tenant's data, so it has no row policy: see the README.
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
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
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
      sql`${table.kind} <> 'subprocessors' OR ${table.effectiveAt} >= ${table.publishedAt} + make_interval(hours => ${table.noticeDays} * 24)`
    ),
    check(
      'document_version_subprocessors_noticed',
      sql`${table.kind} <> 'subprocessors' OR ${table.noticeDays} >= ${sql.raw(String(SUBPROCESSOR_NOTICE_DAYS))}`
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

/**
 * The comment checks a tenant may configure, and the sensitivities each takes.
 * Nothing outside this list can be stored: the table below refuses any other
 * check, so a mandatory or absolute check is not a row this table can hold.
 */
export const COMMENT_CHECKS = [
  'harassment',
  'spam',
  'sexual_content',
  'self_harm',
  'off_topic',
] as const;
export type CommentCheck = (typeof COMMENT_CHECKS)[number];

export const SENSITIVITIES = ['low', 'medium', 'high'] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

/**
 * A tenant's choice for one comment check: on or off, and how sensitive. One
 * row per tenant and check, replaced in place, with who changed it and when.
 * A tenant has a row only for a check it has saved; the page shows a
 * placeholder default for the rest. Isolated like every tenant table, and the
 * closed list of checks is a database constraint as well as a code rule.
 */
export const moderationSetting = portal
  .table(
    'moderation_setting',
    {
      tenantId: uuid('tenant_id')
        .notNull()
        .references(() => tenantRegister.tenantId),
      checkId: text('check_id').notNull(),
      enabled: boolean('enabled').notNull(),
      sensitivity: text('sensitivity').notNull(),
      updatedBy: text('updated_by').notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.tenantId, table.checkId] }),
      check(
        'moderation_setting_check_configurable',
        sql`${table.checkId} IN (${sql.raw(sqlList(COMMENT_CHECKS))})`
      ),
      check(
        'moderation_setting_sensitivity_known',
        sql`${table.sensitivity} IN (${sql.raw(sqlList(SENSITIVITIES))})`
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

/** The role that writes the hostname register and the demo's state events; declared as existing like the others. */
export const portalProvisioner = pgRole('portal_provisioner').existing();

const TRANSITION_ALLOWED = DEMO_STATES.filter((from) => NEXT_STATES[from].length > 0)
  .map((from) => `(from_state = '${from}' AND to_state IN (${sqlList(NEXT_STATES[from])}))`)
  .join(' OR ');

/**
 * One row per transition of a demo, appended and never changed: the demo's
 * state history and the only place its state is held. The current state and
 * the term in force are the latest row's. The database refuses a pair that is
 * not an allowed transition (check), a row that does not continue the demo's
 * real previous row (foreign key on the previous sequence and state) and two
 * rows for one position (primary key). The term (`lease_*`) belongs to rows
 * from PROVISIONING on; on that row it is seven days and starts at the row's
 * own database-clock time. No person is recorded.
 */
export const demoStateEvent = portal.table(
  'demo_state_event',
  {
    demoId: uuid('demo_id').notNull(),
    sequence: integer('sequence').notNull(),
    previousSequence: integer('previous_sequence'),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    leaseIssuedAt: timestamp('lease_issued_at', { withTimezone: true }),
    leaseEndsAt: timestamp('lease_ends_at', { withTimezone: true }),
    extensionDays: integer('extension_days').notNull().default(0),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.demoId, table.sequence] }),
    unique('demo_state_event_demo_sequence_state_unique').on(
      table.demoId,
      table.sequence,
      table.toState
    ),
    foreignKey({
      name: 'demo_state_event_continues_previous_fk',
      columns: [table.demoId, table.previousSequence, table.fromState],
      foreignColumns: [table.demoId, table.sequence, table.toState],
    }),
    check(
      'demo_state_event_transition_allowed',
      sql`(${table.fromState} IS NULL AND ${table.sequence} = 1 AND ${table.toState} = 'VERIFIED') OR (${table.fromState} IS NOT NULL AND (${sql.raw(TRANSITION_ALLOWED)}))`
    ),
    check(
      'demo_state_event_sequence_chain',
      sql`${table.sequence} >= 1 AND (${table.sequence} = 1) = (${table.previousSequence} IS NULL) AND (${table.previousSequence} IS NULL) = (${table.fromState} IS NULL) AND (${table.previousSequence} IS NULL OR ${table.previousSequence} = ${table.sequence} - 1)`
    ),
    check(
      'demo_state_event_lease_complete',
      sql`(${table.leaseIssuedAt} IS NULL) = (${table.leaseEndsAt} IS NULL)`
    ),
    check('demo_state_event_lease_finite', sql`${table.leaseEndsAt} > ${table.leaseIssuedAt}`),
    check(
      'demo_state_event_lease_by_state',
      sql`(${table.toState} IN (${sql.raw(sqlList(STATES_BEFORE_LEASE))}) AND ${table.leaseEndsAt} IS NULL) OR (${table.toState} IN (${sql.raw(sqlList(STATES_WITH_LEASE))}) AND ${table.leaseEndsAt} IS NOT NULL) OR ${table.toState} IN ('FAILED', 'KILLED', 'FROZEN')`
    ),
    check(
      'demo_state_event_term_set',
      sql`${table.toState} <> 'PROVISIONING' OR (${table.leaseIssuedAt} = ${table.recordedAt} AND ${table.leaseEndsAt} = ${table.leaseIssuedAt} + make_interval(hours => ${sql.raw(String(LEASE_DAYS * 24))}))`
    ),
    check(
      'demo_state_event_extension_only_extended',
      sql`${table.extensionDays} >= 0 AND (${table.extensionDays} = 0 OR ${table.toState} = 'EXTENDED')`
    ),
  ]
);

/**
 * Every hostname ever allocated, one row per demo and one per label, for all
 * time: the primary key is the label and `demo_id` is unique, so a name is
 * never given twice and a demo never has a second. Append-only by grant: the
 * writing role may insert and cannot update or delete. It holds no personal
 * data: the label is random, the demo id opaque.
 */
export const hostnameRegister = portal.table(
  'hostname_register',
  {
    label: text('label').primaryKey(),
    demoId: uuid('demo_id').notNull().unique(),
    allocatedAt: timestamp('allocated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('hostname_register_label_shape', sql`${table.label} ~ ${sql.raw(`'${LABEL_PATTERN}'`)}`),
  ]
);

/** A hostname's retirement is a row here, keyed on the label, so the register itself is never edited. */
export const hostnameRetirement = portal.table('hostname_retirement', {
  label: text('label')
    .primaryKey()
    .references(() => hostnameRegister.label),
  retiredAt: timestamp('retired_at', { withTimezone: true }).notNull().defaultNow(),
});
