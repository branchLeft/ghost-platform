// The closed permission manifest: everything the provisioning command creates
// and everything the portal's roles and logins may hold. The command checks
// the server against this and refuses on any difference, missing or extra; it
// never repairs. A migration that adds an object needs an entry here, or the
// migration-sync test fails before the migration can reach a server.

/** The four principals, by the part each plays. */
export type Principal = 'tenantRole' | 'ownerRole' | 'tenantLogin' | 'ownerLogin';
export type Grantee = Principal | 'PUBLIC';

export const TENANT_ROLE = 'portal_tenant';
export const OWNER_ROLE = 'portal_owner';

export interface Names {
  tenantRole: string;
  ownerRole: string;
  tenantLogin: string;
  ownerLogin: string;
}

export function principalNames(tenantLogin: string, ownerLogin: string): Names {
  return { tenantRole: TENANT_ROLE, ownerRole: OWNER_ROLE, tenantLogin, ownerLogin };
}

/** The attributes each principal has, exactly (M01). */
export interface RoleAttributes {
  canLogin: boolean;
  bypassRls: boolean;
}

export const ROLE_ATTRIBUTES: Record<Principal, RoleAttributes> = {
  tenantRole: { canLogin: false, bypassRls: false },
  // The owner console's cross-tenant reads bypass row security by attribute.
  ownerRole: { canLogin: false, bypassRls: true },
  tenantLogin: { canLogin: true, bypassRls: false },
  ownerLogin: { canLogin: true, bypassRls: false },
};

/** Each login is a member of exactly one role (M02). */
export const MEMBERSHIPS: readonly (readonly [Principal, Principal])[] = [
  ['tenantLogin', 'tenantRole'],
  ['ownerLogin', 'ownerRole'],
];

export type ObjectKind = 'database' | 'schema' | 'table' | 'sequence' | 'function';

export interface Grant {
  grantee: Grantee;
  privileges: readonly string[];
}

/**
 * One object the manifest manages. `since` is the migration that creates it,
 * or `init` for what the command itself sets up on a new database. `grants`
 * is the whole ACL beyond the owner's own entries. `ownedBy` is
 * `administrator` (the superuser that owns the database) unless stated.
 */
export interface ManifestObject {
  kind: ObjectKind;
  /** As `pg_identify_object` prints it, e.g. `portal.tenant_register`. */
  identity: string;
  since: string;
  grants: readonly Grant[];
  ownedBy?: 'administrator' | 'pg_database_owner' | 'bootstrap';
}

export const INIT = 'init';
const FIRST = '0000_binding_functions';
const REGISTER = '0001_tenant_register';
const HEALTH = '0002_health_reading';
const DOCUMENTS = '0003_versioned_documents';

/**
 * Schema `public` (OID 2200) is a system object the manifest manages: one
 * rule per server version. Before PostgreSQL 15 it is owned by the bootstrap
 * superuser and PUBLIC holds CREATE, which the command revokes; from 15 it is
 * owned by `pg_database_owner` and PUBLIC holds USAGE alone.
 */
export function publicSchema(major: number): ManifestObject {
  return {
    kind: 'schema',
    identity: 'public',
    since: INIT,
    ownedBy: major >= 15 ? 'pg_database_owner' : 'bootstrap',
    grants: [
      { grantee: 'PUBLIC', privileges: ['USAGE'] },
      // The policies call public.bound_*() as the invoking role.
      { grantee: 'tenantRole', privileges: ['USAGE'] },
    ],
  };
}

/** Every object the manifest manages on a database whose server is `major`. */
export function manifest(major: number, database: string): readonly ManifestObject[] {
  return [
    {
      kind: 'database',
      identity: database,
      since: INIT,
      grants: [
        { grantee: 'tenantLogin', privileges: ['CONNECT'] },
        { grantee: 'ownerLogin', privileges: ['CONNECT'] },
      ],
    },
    publicSchema(major),
    // The migration history, administrator only.
    { kind: 'schema', identity: 'drizzle', since: FIRST, grants: [] },
    { kind: 'table', identity: 'drizzle.__drizzle_migrations', since: FIRST, grants: [] },
    {
      kind: 'sequence',
      identity: 'drizzle.__drizzle_migrations_id_seq',
      since: FIRST,
      grants: [],
    },
    // The policy expressions call these; PUBLIC's default EXECUTE is revoked
    // when they are created.
    {
      kind: 'function',
      identity: 'public.bound_tenant()',
      since: FIRST,
      grants: [{ grantee: 'tenantRole', privileges: ['EXECUTE'] }],
    },
    {
      kind: 'function',
      identity: 'public.bound_organisation()',
      since: FIRST,
      grants: [{ grantee: 'tenantRole', privileges: ['EXECUTE'] }],
    },
    {
      kind: 'schema',
      identity: 'portal',
      since: REGISTER,
      grants: [
        { grantee: 'tenantRole', privileges: ['USAGE'] },
        { grantee: 'ownerRole', privileges: ['USAGE'] },
      ],
    },
    // TenantDb.ownRegistration and scopeForOrganisation read; OwnerDb
    // registerTenant inserts, listTenants and listHealth read. Nothing
    // updates or deletes a registration.
    {
      kind: 'table',
      identity: 'portal.tenant_register',
      since: REGISTER,
      grants: [
        { grantee: 'tenantRole', privileges: ['SELECT'] },
        { grantee: 'ownerRole', privileges: ['INSERT', 'SELECT'] },
      ],
    },
    // TenantDb.ownHealth reads; OwnerDb.recordReading inserts and, through
    // FOR UPDATE and ON CONFLICT DO UPDATE, updates. Nothing deletes.
    {
      kind: 'table',
      identity: 'portal.health_reading',
      since: HEALTH,
      grants: [
        { grantee: 'tenantRole', privileges: ['SELECT'] },
        { grantee: 'ownerRole', privileges: ['INSERT', 'SELECT', 'UPDATE'] },
      ],
    },
    // TenantDb reads the published versions; OwnerDb.publishDocument inserts
    // and reads. Nothing updates or deletes a version, so what a tenant
    // accepted cannot change under it.
    {
      kind: 'table',
      identity: 'portal.document_version',
      since: DOCUMENTS,
      grants: [
        { grantee: 'tenantRole', privileges: ['SELECT'] },
        { grantee: 'ownerRole', privileges: ['INSERT', 'SELECT'] },
      ],
    },
    // TenantDb.acceptDocument inserts and reads the tenant's own acceptances;
    // the owner reads. Nothing updates or deletes an acceptance.
    {
      kind: 'table',
      identity: 'portal.document_acceptance',
      since: DOCUMENTS,
      grants: [
        { grantee: 'tenantRole', privileges: ['INSERT', 'SELECT'] },
        { grantee: 'ownerRole', privileges: ['SELECT'] },
      ],
    },
  ];
}

/** Row security on each manifest table, exactly (M08). */
export const ROW_SECURITY: Record<string, { enabled: boolean; forced: boolean }> = {
  'portal.tenant_register': { enabled: true, forced: false },
  'portal.health_reading': { enabled: true, forced: false },
  'portal.document_version': { enabled: false, forced: false },
  'portal.document_acceptance': { enabled: true, forced: false },
  'drizzle.__drizzle_migrations': { enabled: false, forced: false },
};

/**
 * The definition of each manifest function (M09): a SHA-256 of `prosrc` and
 * the attributes that decide how it runs.
 */
export const FUNCTIONS: Record<string, { since: string; fingerprint: string }> = {
  'public.bound_tenant()': {
    since: FIRST,
    fingerprint:
      'src=7d82506fa89603930a12b58a28fd2d2441ee34e75cda70dfcb49be9fd19a4961 lang=plpgsql ' +
      'volatile=s secdef=false leakproof=false config=null',
  },
  'public.bound_organisation()': {
    since: FIRST,
    fingerprint:
      'src=9eab2b396e407b7655f4ee175b776f08baf64140c416fa6e04564a12a2ed560c lang=sql ' +
      'volatile=s secdef=false leakproof=false config=null',
  },
};

/** The row-security policies, exactly (M20), as the server deparses them. */
export interface PolicyEntry {
  table: string;
  name: string;
  since: string;
  text: string;
}

const BOUND = 'tenant_id = public.bound_tenant()';

function policy(
  table: string,
  name: string,
  since: string,
  cmd: string,
  using: string,
  check: string
): PolicyEntry {
  return {
    table,
    name,
    since,
    text: `policy ${name} on ${table}: cmd=${cmd} permissive=true roles=${TENANT_ROLE} using=${using} check=${check}`,
  };
}

export const POLICIES: readonly PolicyEntry[] = [
  policy('portal.tenant_register', 'tenant_isolation', REGISTER, '*', `(${BOUND})`, `(${BOUND})`),
  policy(
    'portal.tenant_register',
    'organisation_lookup',
    REGISTER,
    'r',
    '(zitadel_org_id = public.bound_organisation())',
    'null'
  ),
  policy('portal.health_reading', 'tenant_isolation', HEALTH, '*', `(${BOUND})`, `(${BOUND})`),
  policy(
    'portal.document_acceptance',
    'tenant_isolation',
    DOCUMENTS,
    '*',
    `(${BOUND})`,
    `(${BOUND})`
  ),
];

/**
 * The shape of each manifest table (M21 with the design check's A4): columns,
 * defaults, constraints and indexes as the server deparses them. Anything
 * else on these tables (a trigger, a rule, an extra column or index, a child
 * table, statistics) is an extra.
 */
export interface TableShape {
  since: string;
  lines: readonly string[];
}

const PLAIN = 'generated=- identity=-';

export const TABLE_SHAPES: Record<string, TableShape> = {
  'drizzle.__drizzle_migrations': {
    since: FIRST,
    lines: [
      `column id integer notnull=true ${PLAIN}`,
      `column hash text notnull=true ${PLAIN}`,
      `column created_at bigint notnull=false ${PLAIN}`,
      "default id nextval('drizzle.__drizzle_migrations_id_seq'::regclass)",
      'constraint __drizzle_migrations_pkey PRIMARY KEY (id)',
      'index drizzle.__drizzle_migrations_pkey CREATE UNIQUE INDEX __drizzle_migrations_pkey ' +
        'ON drizzle.__drizzle_migrations USING btree (id)',
    ],
  },
  'portal.tenant_register': {
    since: REGISTER,
    lines: [
      `column tenant_id uuid notnull=true ${PLAIN}`,
      `column zitadel_org_id text notnull=true ${PLAIN}`,
      `column created_at timestamp with time zone notnull=true ${PLAIN}`,
      'default created_at now()',
      'constraint tenant_register_pkey PRIMARY KEY (tenant_id)',
      'constraint tenant_register_zitadel_org_id_unique UNIQUE (zitadel_org_id)',
      'index portal.tenant_register_pkey CREATE UNIQUE INDEX tenant_register_pkey ' +
        'ON portal.tenant_register USING btree (tenant_id)',
      'index portal.tenant_register_zitadel_org_id_unique CREATE UNIQUE INDEX ' +
        'tenant_register_zitadel_org_id_unique ON portal.tenant_register USING btree (zitadel_org_id)',
    ],
  },
  'portal.health_reading': {
    since: HEALTH,
    lines: [
      `column tenant_id uuid notnull=true ${PLAIN}`,
      `column health text notnull=true ${PLAIN}`,
      `column reported_version text notnull=false ${PLAIN}`,
      `column version_match boolean notnull=false ${PLAIN}`,
      `column mismatch_since timestamp with time zone notnull=false ${PLAIN}`,
      `column observed_at timestamp with time zone notnull=true ${PLAIN}`,
      'constraint health_reading_health_known CHECK ((health = ANY ' +
        "(ARRAY['healthy'::text, 'unhealthy'::text, 'unknown'::text])))",
      'constraint health_reading_pkey PRIMARY KEY (tenant_id)',
      'constraint health_reading_tenant_id_tenant_register_tenant_id_fk FOREIGN KEY (tenant_id) ' +
        'REFERENCES portal.tenant_register(tenant_id)',
      'index portal.health_reading_pkey CREATE UNIQUE INDEX health_reading_pkey ' +
        'ON portal.health_reading USING btree (tenant_id)',
    ],
  },
  'portal.document_version': {
    since: DOCUMENTS,
    lines: [
      `column kind text notnull=true ${PLAIN}`,
      `column version integer notnull=true ${PLAIN}`,
      `column title text notnull=true ${PLAIN}`,
      `column body text notnull=true ${PLAIN}`,
      `column entries jsonb notnull=true ${PLAIN}`,
      `column published_at timestamp with time zone notnull=true ${PLAIN}`,
      `column effective_at timestamp with time zone notnull=true ${PLAIN}`,
      `column notice_days integer notnull=true ${PLAIN}`,
      "default entries '[]'::jsonb",
      'default notice_days 0',
      "constraint document_version_kind_known CHECK ((kind = ANY (ARRAY['terms'::text, " +
        "'usage'::text, 'subprocessors'::text])))",
      'constraint document_version_kind_version_pk PRIMARY KEY (kind, version)',
      'constraint document_version_notice_elapsed CHECK ((effective_at >= ' +
        '(published_at + make_interval(hours => (notice_days * 24)))))',
      'constraint document_version_notice_not_negative CHECK ((notice_days >= 0))',
      "constraint document_version_subprocessors_noticed CHECK (((kind <> 'subprocessors'::text) " +
        'OR (notice_days >= 1)))',
      'constraint document_version_version_positive CHECK ((version >= 1))',
      'index portal.document_version_kind_version_pk CREATE UNIQUE INDEX ' +
        'document_version_kind_version_pk ON portal.document_version USING btree (kind, version)',
    ],
  },
  'portal.document_acceptance': {
    since: DOCUMENTS,
    lines: [
      `column tenant_id uuid notnull=true ${PLAIN}`,
      `column kind text notnull=true ${PLAIN}`,
      `column version integer notnull=true ${PLAIN}`,
      `column accepted_by text notnull=true ${PLAIN}`,
      `column accepted_at timestamp with time zone notnull=true ${PLAIN}`,
      "constraint document_acceptance_kind_acceptable CHECK ((kind = ANY (ARRAY['terms'::text, " +
        "'usage'::text])))",
      'constraint document_acceptance_kind_version_document_version_kind_version_ FOREIGN KEY ' +
        '(kind, version) REFERENCES portal.document_version(kind, version)',
      'constraint document_acceptance_tenant_id_kind_version_pk PRIMARY KEY ' +
        '(tenant_id, kind, version)',
      'constraint document_acceptance_tenant_id_tenant_register_tenant_id_fk FOREIGN KEY ' +
        '(tenant_id) REFERENCES portal.tenant_register(tenant_id)',
      'index portal.document_acceptance_tenant_id_kind_version_pk CREATE UNIQUE INDEX ' +
        'document_acceptance_tenant_id_kind_version_pk ON portal.document_acceptance ' +
        'USING btree (tenant_id, kind, version)',
    ],
  },
};

export interface Mechanism {
  id: string;
  name: string;
  /** Lowest server major version the mechanism exists on. */
  since?: number;
  /** Checked outside the command's in-database enumeration. */
  external?: boolean;
}

/** The design note's closed list, M01 to M29. */
export const MECHANISMS: readonly Mechanism[] = [
  { id: 'M01', name: 'role attributes' },
  { id: 'M02', name: 'membership and reach' },
  { id: 'M03', name: 'role and database settings' },
  { id: 'M04', name: 'database ACLs' },
  { id: 'M05', name: 'schema ACLs' },
  { id: 'M06', name: 'relation ACLs' },
  { id: 'M07', name: 'column ACLs' },
  { id: 'M08', name: 'row-security switch' },
  { id: 'M09', name: 'function ACLs and definitions' },
  { id: 'M10', name: 'SECURITY DEFINER' },
  { id: 'M11', name: 'type ACLs' },
  { id: 'M12', name: 'language ACLs' },
  { id: 'M13', name: 'large objects' },
  { id: 'M14', name: 'tablespace ACLs' },
  { id: 'M15', name: 'foreign data wrappers, servers, user mappings' },
  { id: 'M16', name: 'parameter grants', since: 15 },
  { id: 'M17', name: 'default ACLs' },
  { id: 'M18', name: 'ownership' },
  { id: 'M19', name: 'explicit mentions, cluster-wide' },
  { id: 'M20', name: 'row-level security policies' },
  { id: 'M21', name: 'code and shape on manifest tables' },
  { id: 'M22', name: 'event triggers' },
  { id: 'M23', name: 'publications and subscriptions' },
  { id: 'M24', name: 'extensions' },
  { id: 'M25', name: 'catch-all over every catalog with an oid' },
  { id: 'M26', name: 'predefined roles (through M02 reach)', external: true },
  { id: 'M27', name: 'server settings that change checks' },
  { id: 'M28', name: 'pg_hba: loaded rules and cross-database login' },
  { id: 'M29', name: 'system-object ACL drift' },
];

/** Server settings that switch a check off, and the value each must hold (M27). */
export const SETTINGS: Record<string, string> = {
  lo_compat_privileges: 'off',
  shared_preload_libraries: '',
  session_preload_libraries: '',
  local_preload_libraries: '',
};

/** The one extension a database starts with (M24). */
export const EXTENSIONS: readonly string[] = ['plpgsql'];
