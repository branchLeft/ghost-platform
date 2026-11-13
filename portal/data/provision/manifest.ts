// The closed permission manifest: everything the provisioning command creates
// and everything the portal's roles and logins may hold. The command checks
// the server against this and refuses on any difference, missing or extra; it
// never repairs. A migration that adds an object needs an entry here, or the
// migration-sync test fails before the migration can reach a server.

/** The nine principals, by the part each plays. */
export type Principal =
  | 'tenantRole'
  | 'ownerRole'
  | 'provisionerRole'
  | 'prospectRole'
  | 'tenantLogin'
  | 'ownerLogin'
  | 'provisionerLogin'
  | 'prospectLogin'
  | 'migratorLogin';
export type Grantee = Principal | 'PUBLIC';

export const TENANT_ROLE = 'portal_tenant';
export const OWNER_ROLE = 'portal_owner';
export const PROVISIONER_ROLE = 'portal_provisioner';
export const PROSPECT_ROLE = 'portal_prospect';

export interface Names {
  tenantRole: string;
  ownerRole: string;
  provisionerRole: string;
  prospectRole: string;
  tenantLogin: string;
  ownerLogin: string;
  provisionerLogin: string;
  prospectLogin: string;
  migratorLogin: string;
}

export function principalNames(
  tenantLogin: string,
  ownerLogin: string,
  provisionerLogin: string,
  prospectLogin: string,
  migratorLogin: string
): Names {
  return {
    tenantRole: TENANT_ROLE,
    ownerRole: OWNER_ROLE,
    provisionerRole: PROVISIONER_ROLE,
    prospectRole: PROSPECT_ROLE,
    tenantLogin,
    ownerLogin,
    provisionerLogin,
    prospectLogin,
    migratorLogin,
  };
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
  // Writes the hostname register and the demo's state events, insert-only.
  provisionerRole: { canLogin: false, bypassRls: false },
  // The internet-facing front door: inserts a request and reads its own.
  prospectRole: { canLogin: false, bypassRls: false },
  tenantLogin: { canLogin: true, bypassRls: false },
  ownerLogin: { canLogin: true, bypassRls: false },
  provisionerLogin: { canLogin: true, bypassRls: false },
  prospectLogin: { canLogin: true, bypassRls: false },
  // Owns the portal database and everything the migrations create, and applies
  // them. A login like the others: no superuser, no BYPASSRLS, no CREATEROLE,
  // no CREATEDB, no REPLICATION, and a member of no role. The database's
  // privileges below it are its own as owner; nothing else on the server is.
  migratorLogin: { canLogin: true, bypassRls: false },
};

/**
 * Each login but the migrator is a member of exactly one role (M02). The
 * migrator is a member of none: its reach is itself.
 */
export const MEMBERSHIPS: readonly (readonly [Principal, Principal])[] = [
  ['tenantLogin', 'tenantRole'],
  ['ownerLogin', 'ownerRole'],
  ['provisionerLogin', 'provisionerRole'],
  ['prospectLogin', 'prospectRole'],
];

export type ObjectKind = 'database' | 'schema' | 'table' | 'sequence' | 'function';

export interface Grant {
  grantee: Grantee;
  privileges: readonly string[];
}

/**
 * One object the manifest manages. `since` is the migration that creates it,
 * or `init` for what the command itself sets up on a new database. `grants`
 * is the whole ACL beyond the owner's own entries. `ownedBy` is `migrator`
 * (the non-superuser login that owns the database) unless stated.
 */
export interface ManifestObject {
  kind: ObjectKind;
  /** As `pg_identify_object` prints it, e.g. `portal.tenant_register`. */
  identity: string;
  since: string;
  grants: readonly Grant[];
  /**
   * Grants a later migration gave the object: expected once that migration is
   * applied, and an extra before it, so a server held back still verifies.
   */
  added?: readonly { since: string; grants: readonly Grant[] }[];
  ownedBy?: 'migrator' | 'pg_database_owner' | 'bootstrap';
}

/** The whole ACL the manifest gives `object` once the migrations in `applied` are in. */
export function grantsAt(object: ManifestObject, applied: readonly string[]): readonly Grant[] {
  return [
    ...object.grants,
    ...(object.added ?? [])
      .filter((later) => applied.includes(later.since))
      .flatMap((later) => later.grants),
  ];
}

export const INIT = 'init';
const FIRST = '0000_binding_functions';
const REGISTER = '0001_tenant_register';
const HEALTH = '0002_health_reading';
const DOCUMENTS = '0003_versioned_documents';
const MODERATION = '0004_moderation_setting';
const KIND = '0005_tenant_kind';
const DEMO_LIFECYCLE = '0006_demo_lifecycle_register';
const DEMO_REBUILD = '0007_demo_rebuild_extended';
const TENANT_NAME = '0008_tenant_name';
const CUSTOM_DOMAIN = '0009_custom_domain';
const DEMO_REQUEST = '0010_demo_request';
export const STATUS_READ = '0011_demo_request_status_read';

/**
 * Schema `public` (OID 2200) is a system object the manifest manages: one
 * rule per server version. Before PostgreSQL 15 it is owned by the bootstrap
 * superuser and PUBLIC holds CREATE; the command hands it to the migrator once,
 * when it initialises the database, and revokes PUBLIC's CREATE. From 15 it is
 * owned by `pg_database_owner`, the migrator while the migrator owns the
 * database, and PUBLIC holds USAGE alone.
 */
export function publicSchema(major: number): ManifestObject {
  return {
    kind: 'schema',
    identity: 'public',
    since: INIT,
    ownedBy: major >= 15 ? 'pg_database_owner' : 'migrator',
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
        { grantee: 'provisionerLogin', privileges: ['CONNECT'] },
        { grantee: 'prospectLogin', privileges: ['CONNECT'] },
      ],
    },
    publicSchema(major),
    // The migration history, the migrator only.
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
    // The front door's own-row policy calls this as the invoking role.
    {
      kind: 'function',
      identity: 'public.bound_address()',
      since: STATUS_READ,
      grants: [{ grantee: 'prospectRole', privileges: ['EXECUTE'] }],
    },
    {
      kind: 'schema',
      identity: 'portal',
      since: REGISTER,
      grants: [
        { grantee: 'tenantRole', privileges: ['USAGE'] },
        { grantee: 'ownerRole', privileges: ['USAGE'] },
        { grantee: 'provisionerRole', privileges: ['USAGE'] },
        { grantee: 'prospectRole', privileges: ['USAGE'] },
      ],
    },
    // TenantDb.ownRegistration, ownKind and scopeForOrganisation read; OwnerDb
    // registerTenant inserts, listTenants and listHealth read. Nothing
    // updates or deletes a registration, so a tenant cannot change its own
    // kind (the tenant role holds SELECT alone).
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
    // TenantDb.moderationSettings reads and saveModerationSettings inserts
    // and, through ON CONFLICT DO UPDATE, updates the tenant's own rows. The
    // owner role reads nothing here yet; nothing deletes a setting.
    {
      kind: 'table',
      identity: 'portal.moderation_setting',
      since: MODERATION,
      grants: [{ grantee: 'tenantRole', privileges: ['INSERT', 'SELECT', 'UPDATE'] }],
    },
    // TenantDb.requestCustomDomain inserts and reads the tenant's own requests,
    // connectCustomDomain deletes the request it turns into a connection and
    // removeCustomDomain deletes one. Nothing updates a request. The owner role
    // reads nothing here yet.
    {
      kind: 'table',
      identity: 'portal.custom_domain_request',
      since: CUSTOM_DOMAIN,
      grants: [{ grantee: 'tenantRole', privileges: ['DELETE', 'INSERT', 'SELECT'] }],
    },
    // TenantDb.connectCustomDomain inserts and customDomains reads the tenant's
    // own connections; removeCustomDomain deletes one. Nothing updates a
    // connection. The owner role reads nothing here yet.
    {
      kind: 'table',
      identity: 'portal.connected_domain',
      since: CUSTOM_DOMAIN,
      grants: [{ grantee: 'tenantRole', privileges: ['DELETE', 'INSERT', 'SELECT'] }],
    },
    // ProvisionerDb appends events and reads the latest to decide the next;
    // OwnerDb.listDemos and demoHistory read. No role updates or deletes an
    // event: the history is the record, and the tenant role holds nothing.
    {
      kind: 'table',
      identity: 'portal.demo_state_event',
      since: DEMO_LIFECYCLE,
      grants: [
        { grantee: 'provisionerRole', privileges: ['INSERT', 'SELECT'] },
        { grantee: 'ownerRole', privileges: ['SELECT'] },
      ],
    },
    // ProvisionerDb.allocateHostname inserts; OwnerDb.listHostnames reads. The
    // register is append-only by grant: no role may update or delete a row.
    {
      kind: 'table',
      identity: 'portal.hostname_register',
      since: DEMO_LIFECYCLE,
      grants: [
        { grantee: 'provisionerRole', privileges: ['INSERT', 'SELECT'] },
        { grantee: 'ownerRole', privileges: ['SELECT'] },
      ],
    },
    // ProvisionerDb.retireHostname inserts; a retirement is a row, never an
    // edit of the register. OwnerDb.listHostnames reads.
    {
      kind: 'table',
      identity: 'portal.hostname_retirement',
      since: DEMO_LIFECYCLE,
      grants: [
        { grantee: 'provisionerRole', privileges: ['INSERT', 'SELECT'] },
        { grantee: 'ownerRole', privileges: ['SELECT'] },
      ],
    },
    // ProspectDb.submit inserts. ProspectDb.ownRequest reads once the status
    // migration has given the front door SELECT, and the table's row policy
    // shows it only the row whose address the transaction bound; it cannot
    // change a request or remove one. ProvisionerDb.request and
    // OwnerDb.listRequests read. No role updates or deletes a request.
    {
      kind: 'table',
      identity: 'portal.demo_request',
      since: DEMO_REQUEST,
      grants: [
        { grantee: 'prospectRole', privileges: ['INSERT'] },
        { grantee: 'provisionerRole', privileges: ['SELECT'] },
        { grantee: 'ownerRole', privileges: ['SELECT'] },
      ],
      added: [
        { since: STATUS_READ, grants: [{ grantee: 'prospectRole', privileges: ['SELECT'] }] },
      ],
    },
  ];
}

/** Whether row security is on, and forced on the owner. `enabledFrom` is the migration that turns it on. */
export interface RowSecurity {
  enabled: boolean;
  forced: boolean;
  enabledFrom?: string;
}

/** Whether the manifest expects row security on once the migrations in `applied` are in. */
export function rowSecurityEnabled(want: RowSecurity, applied: readonly string[]): boolean {
  return want.enabled && (want.enabledFrom === undefined || applied.includes(want.enabledFrom));
}

/** Row security on each manifest table, exactly (M08). */
export const ROW_SECURITY: Record<string, RowSecurity> = {
  'portal.tenant_register': { enabled: true, forced: false },
  'portal.health_reading': { enabled: true, forced: false },
  'portal.document_version': { enabled: false, forced: false },
  'portal.document_acceptance': { enabled: true, forced: false },
  'portal.moderation_setting': { enabled: true, forced: false },
  'portal.custom_domain_request': { enabled: true, forced: false },
  'portal.connected_domain': { enabled: true, forced: false },
  'portal.demo_state_event': { enabled: false, forced: false },
  'portal.hostname_register': { enabled: false, forced: false },
  'portal.hostname_retirement': { enabled: false, forced: false },
  // Off until the status migration turns it on: a server held back verifies.
  'portal.demo_request': { enabled: true, forced: false, enabledFrom: STATUS_READ },
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
  'public.bound_address()': {
    since: STATUS_READ,
    fingerprint:
      'src=f5c5ee9694e97ebc88efc6da944e52f3fb2ff7a66ea2dc62526e88ed93e82bf6 lang=sql ' +
      'volatile=s secdef=false leakproof=false config=null',
  },
};

/** The row-security policies, exactly (M20), as the server deparses them. */
export interface PolicyEntry {
  table: string;
  name: string;
  since: string;
  /** The principal the policy is written `TO`; the tenant role unless stated. */
  role: 'tenantRole' | 'prospectRole' | 'provisionerRole';
  text: string;
}

const BOUND = 'tenant_id = public.bound_tenant()';

const POLICY_ROLE_NAMES: Record<PolicyEntry['role'], string> = {
  tenantRole: TENANT_ROLE,
  prospectRole: PROSPECT_ROLE,
  provisionerRole: PROVISIONER_ROLE,
};

function policy(
  table: string,
  name: string,
  since: string,
  cmd: string,
  using: string,
  check: string,
  role: PolicyEntry['role'] = 'tenantRole'
): PolicyEntry {
  return {
    table,
    name,
    since,
    role,
    text: `policy ${name} on ${table}: cmd=${cmd} permissive=true roles=${POLICY_ROLE_NAMES[role]} using=${using} check=${check}`,
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
  policy(
    'portal.moderation_setting',
    'tenant_isolation',
    MODERATION,
    '*',
    `(${BOUND})`,
    `(${BOUND})`
  ),
  policy(
    'portal.custom_domain_request',
    'tenant_isolation',
    CUSTOM_DOMAIN,
    '*',
    `(${BOUND})`,
    `(${BOUND})`
  ),
  policy(
    'portal.connected_domain',
    'tenant_isolation',
    CUSTOM_DOMAIN,
    '*',
    `(${BOUND})`,
    `(${BOUND})`
  ),
  // The front door appends a request and reads the one whose address its
  // transaction bound: an own-row policy, which compares the table's address
  // column to `public.bound_address()` and nothing else. The lifecycle worker
  // reads every request. The owner role bypasses row security by attribute.
  policy('portal.demo_request', 'request_insert', STATUS_READ, 'a', 'null', 'true', 'prospectRole'),
  policy(
    'portal.demo_request',
    'own_request',
    STATUS_READ,
    'r',
    '(verified_address = public.bound_address())',
    'null',
    'prospectRole'
  ),
  policy(
    'portal.demo_request',
    'provisioner_read',
    STATUS_READ,
    'r',
    'true',
    'null',
    'provisionerRole'
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
  /**
   * What a later migration added to the table: expected once that migration
   * is applied, and an extra before it, like any other line.
   */
  added?: readonly { since: string; lines: readonly string[] }[];
  /**
   * A line a later migration rewrote: once that migration is applied, the line
   * starting with `replaces` is no longer expected and `lines` are. Before it,
   * the old text stays expected, so a server held back still verifies.
   */
  revised?: readonly { since: string; replaces: string; lines: readonly string[] }[];
}

const PLAIN = 'generated=- identity=-';

/** The domain-name check as the server deparses it; written out so the manifest pins the text, not an import. */
const FQDN_REGEX = '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$';

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
    // The kind has no default: a row that names none is refused by NOT NULL.
    added: [
      {
        since: KIND,
        lines: [
          `column kind text notnull=true ${PLAIN}`,
          "constraint tenant_register_kind_known CHECK ((kind = ANY (ARRAY['REAL'::text, " +
            "'DEMO'::text])))",
        ],
      },
      // The customer's sign-up name: nullable (a demo has none), unique, and a slug.
      {
        since: TENANT_NAME,
        lines: [
          `column tenant_name text notnull=false ${PLAIN}`,
          'constraint tenant_register_tenant_name_unique UNIQUE (tenant_name)',
          'constraint tenant_register_tenant_name_shape CHECK ((tenant_name ~ ' +
            "'^[a-z][a-z0-9-]{1,24}[a-z0-9]$'::text))",
          'index portal.tenant_register_tenant_name_unique CREATE UNIQUE INDEX ' +
            'tenant_register_tenant_name_unique ON portal.tenant_register USING btree (tenant_name)',
        ],
      },
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
      'default published_at now()',
      'default notice_days 0',
      "constraint document_version_kind_known CHECK ((kind = ANY (ARRAY['terms'::text, " +
        "'usage'::text, 'subprocessors'::text])))",
      'constraint document_version_kind_version_pk PRIMARY KEY (kind, version)',
      "constraint document_version_notice_elapsed CHECK (((kind <> 'subprocessors'::text) OR " +
        '(effective_at >= (published_at + make_interval(hours => (notice_days * 24))))))',
      'constraint document_version_notice_not_negative CHECK ((notice_days >= 0))',
      "constraint document_version_subprocessors_noticed CHECK (((kind <> 'subprocessors'::text) " +
        'OR (notice_days >= 30)))',
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
  'portal.moderation_setting': {
    since: MODERATION,
    lines: [
      `column tenant_id uuid notnull=true ${PLAIN}`,
      `column check_id text notnull=true ${PLAIN}`,
      `column enabled boolean notnull=true ${PLAIN}`,
      `column sensitivity text notnull=true ${PLAIN}`,
      `column updated_by text notnull=true ${PLAIN}`,
      `column updated_at timestamp with time zone notnull=true ${PLAIN}`,
      "constraint moderation_setting_check_configurable CHECK ((check_id = ANY (ARRAY['harassment'::text, " +
        "'spam'::text, 'sexual_content'::text, 'self_harm'::text, 'off_topic'::text])))",
      "constraint moderation_setting_sensitivity_known CHECK ((sensitivity = ANY (ARRAY['low'::text, " +
        "'medium'::text, 'high'::text])))",
      'constraint moderation_setting_tenant_id_check_id_pk PRIMARY KEY (tenant_id, check_id)',
      'constraint moderation_setting_tenant_id_tenant_register_tenant_id_fk FOREIGN KEY ' +
        '(tenant_id) REFERENCES portal.tenant_register(tenant_id)',
      'index portal.moderation_setting_tenant_id_check_id_pk CREATE UNIQUE INDEX ' +
        'moderation_setting_tenant_id_check_id_pk ON portal.moderation_setting ' +
        'USING btree (tenant_id, check_id)',
    ],
  },
  'portal.custom_domain_request': {
    since: CUSTOM_DOMAIN,
    lines: [
      `column tenant_id uuid notnull=true ${PLAIN}`,
      `column fqdn text notnull=true ${PLAIN}`,
      `column verification_token text notnull=true ${PLAIN}`,
      `column requested_at timestamp with time zone notnull=true ${PLAIN}`,
      `constraint custom_domain_request_fqdn_shape CHECK (((fqdn ~ '${FQDN_REGEX}'::text) AND (length(fqdn) <= 253)))`,
      'constraint custom_domain_request_tenant_id_fqdn_pk PRIMARY KEY (tenant_id, fqdn)',
      'constraint custom_domain_request_tenant_id_tenant_register_tenant_id_fk FOREIGN KEY ' +
        '(tenant_id) REFERENCES portal.tenant_register(tenant_id)',
      "constraint custom_domain_request_token_shape CHECK ((verification_token ~ '^[a-z2-7]{32}$'::text))",
      'index portal.custom_domain_request_tenant_id_fqdn_pk CREATE UNIQUE INDEX ' +
        'custom_domain_request_tenant_id_fqdn_pk ON portal.custom_domain_request ' +
        'USING btree (tenant_id, fqdn)',
    ],
  },
  'portal.connected_domain': {
    since: CUSTOM_DOMAIN,
    lines: [
      `column fqdn text notnull=true ${PLAIN}`,
      `column tenant_id uuid notnull=true ${PLAIN}`,
      `column connected_at timestamp with time zone notnull=true ${PLAIN}`,
      `constraint connected_domain_fqdn_shape CHECK (((fqdn ~ '${FQDN_REGEX}'::text) AND (length(fqdn) <= 253)))`,
      'constraint connected_domain_pkey PRIMARY KEY (fqdn)',
      'constraint connected_domain_tenant_id_tenant_register_tenant_id_fk FOREIGN KEY ' +
        '(tenant_id) REFERENCES portal.tenant_register(tenant_id)',
      'index portal.connected_domain_pkey CREATE UNIQUE INDEX connected_domain_pkey ON ' +
        'portal.connected_domain USING btree (fqdn)',
    ],
  },
  'portal.demo_state_event': {
    since: DEMO_LIFECYCLE,
    lines: [
      `column demo_id uuid notnull=true ${PLAIN}`,
      `column extension_days integer notnull=true ${PLAIN}`,
      `column from_state text notnull=false ${PLAIN}`,
      `column lease_ends_at timestamp with time zone notnull=false ${PLAIN}`,
      `column lease_issued_at timestamp with time zone notnull=false ${PLAIN}`,
      `column previous_sequence integer notnull=false ${PLAIN}`,
      `column recorded_at timestamp with time zone notnull=true ${PLAIN}`,
      `column sequence integer notnull=true ${PLAIN}`,
      `column to_state text notnull=true ${PLAIN}`,
      'default extension_days 0',
      'default recorded_at now()',
      'constraint demo_state_event_continues_previous_fk FOREIGN KEY (demo_id, ' +
        'previous_sequence, from_state) REFERENCES portal.demo_state_event(demo_id, sequence, to_state)',
      'constraint demo_state_event_demo_id_sequence_pk PRIMARY KEY (demo_id, sequence)',
      'constraint demo_state_event_demo_sequence_state_unique UNIQUE (demo_id, sequence, ' +
        'to_state)',
      'constraint demo_state_event_extension_only_extended CHECK (((extension_days >= 0) AND ' +
        "((extension_days = 0) OR (to_state = 'EXTENDED'::text))))",
      'constraint demo_state_event_lease_by_state CHECK ((((to_state = ANY ' +
        "(ARRAY['VERIFIED'::text, 'WAITING'::text, 'CLAIMED'::text])) AND (lease_ends_at IS NULL)) OR ((to_state = ANY (ARRAY['PROVISIONING'::text, 'LIVE'::text, 'EXTENDED'::text, 'EXPIRING'::text, 'REBUILDING'::text, 'PROMOTING'::text, 'PROMOTED'::text, 'PURGED'::text])) AND (lease_ends_at IS NOT NULL)) OR (to_state = ANY (ARRAY['FAILED'::text, 'KILLED'::text, 'FROZEN'::text]))))",
      'constraint demo_state_event_lease_complete CHECK (((lease_issued_at IS NULL) = ' +
        '(lease_ends_at IS NULL)))',
      'constraint demo_state_event_lease_finite CHECK ((lease_ends_at > lease_issued_at))',
      'constraint demo_state_event_sequence_chain CHECK (((sequence >= 1) AND ((sequence = ' +
        '1) = (previous_sequence IS NULL)) AND ((previous_sequence IS NULL) = (from_state IS NULL)) AND ((previous_sequence IS NULL) OR (previous_sequence = (sequence - 1)))))',
      "constraint demo_state_event_term_set CHECK (((to_state <> 'PROVISIONING'::text) OR " +
        '((lease_issued_at = recorded_at) AND (lease_ends_at = (lease_issued_at + make_interval(hours => 168))))))',
      "constraint demo_state_event_transition_allowed CHECK ((((from_state IS NULL) AND (sequence = 1) AND (to_state = 'VERIFIED'::text)) OR ((from_state IS NOT NULL) AND (((from_state = 'VERIFIED'::text) AND (to_state = ANY (ARRAY['CLAIMED'::text, 'WAITING'::text])))" +
        " OR ((from_state = 'WAITING'::text) AND (to_state = 'CLAIMED'::text))" +
        " OR ((from_state = 'CLAIMED'::text) AND (to_state = ANY (ARRAY['PROVISIONING'::text, 'WAITING'::text, 'KILLED'::text, 'FROZEN'::text])))" +
        " OR ((from_state = 'PROVISIONING'::text) AND (to_state = ANY (ARRAY['LIVE'::text, 'FAILED'::text, 'KILLED'::text, 'FROZEN'::text])))" +
        " OR ((from_state = 'LIVE'::text) AND (to_state = ANY (ARRAY['EXPIRING'::text, 'EXTENDED'::text, 'PROMOTING'::text, 'REBUILDING'::text, 'KILLED'::text, 'FROZEN'::text])))" +
        " OR ((from_state = 'EXTENDED'::text) AND (to_state = ANY (ARRAY['EXPIRING'::text, 'PROMOTING'::text, 'KILLED'::text, 'FROZEN'::text])))" +
        " OR ((from_state = 'EXPIRING'::text) AND (to_state = ANY (ARRAY['PURGED'::text, 'EXTENDED'::text, 'PROMOTING'::text, 'KILLED'::text, 'FROZEN'::text])))" +
        " OR ((from_state = 'REBUILDING'::text) AND (to_state = ANY (ARRAY['LIVE'::text, 'FAILED'::text, 'KILLED'::text, 'FROZEN'::text])))" +
        " OR ((from_state = 'PROMOTING'::text) AND (to_state = ANY (ARRAY['PROMOTED'::text, 'LIVE'::text, 'EXTENDED'::text, 'EXPIRING'::text, 'KILLED'::text, 'FROZEN'::text])))))))",
      'index portal.demo_state_event_demo_id_sequence_pk CREATE UNIQUE INDEX ' +
        'demo_state_event_demo_id_sequence_pk ON portal.demo_state_event USING btree (demo_id, sequence)',
      'index portal.demo_state_event_demo_sequence_state_unique CREATE UNIQUE INDEX ' +
        'demo_state_event_demo_sequence_state_unique ON portal.demo_state_event USING btree (demo_id, sequence, to_state)',
    ],
    revised: [
      {
        since: DEMO_REBUILD,
        replaces: 'constraint demo_state_event_transition_allowed CHECK',
        lines: [
          "constraint demo_state_event_transition_allowed CHECK ((((from_state IS NULL) AND (sequence = 1) AND (to_state = 'VERIFIED'::text)) OR ((from_state IS NOT NULL) AND (((from_state = 'VERIFIED'::text) AND (to_state = ANY (ARRAY['CLAIMED'::text, 'WAITING'::text])))" +
            " OR ((from_state = 'WAITING'::text) AND (to_state = 'CLAIMED'::text))" +
            " OR ((from_state = 'CLAIMED'::text) AND (to_state = ANY (ARRAY['PROVISIONING'::text, 'WAITING'::text, 'KILLED'::text, 'FROZEN'::text])))" +
            " OR ((from_state = 'PROVISIONING'::text) AND (to_state = ANY (ARRAY['LIVE'::text, 'FAILED'::text, 'KILLED'::text, 'FROZEN'::text])))" +
            " OR ((from_state = 'LIVE'::text) AND (to_state = ANY (ARRAY['EXPIRING'::text, 'EXTENDED'::text, 'PROMOTING'::text, 'REBUILDING'::text, 'KILLED'::text, 'FROZEN'::text])))" +
            " OR ((from_state = 'EXTENDED'::text) AND (to_state = ANY (ARRAY['EXPIRING'::text, 'PROMOTING'::text, 'REBUILDING'::text, 'KILLED'::text, 'FROZEN'::text])))" +
            " OR ((from_state = 'EXPIRING'::text) AND (to_state = ANY (ARRAY['PURGED'::text, 'EXTENDED'::text, 'PROMOTING'::text, 'KILLED'::text, 'FROZEN'::text])))" +
            " OR ((from_state = 'REBUILDING'::text) AND (to_state = ANY (ARRAY['LIVE'::text, 'EXTENDED'::text, 'FAILED'::text, 'KILLED'::text, 'FROZEN'::text])))" +
            " OR ((from_state = 'PROMOTING'::text) AND (to_state = ANY (ARRAY['PROMOTED'::text, 'LIVE'::text, 'EXTENDED'::text, 'EXPIRING'::text, 'KILLED'::text, 'FROZEN'::text])))))))",
        ],
      },
    ],
  },
  'portal.hostname_register': {
    since: DEMO_LIFECYCLE,
    lines: [
      `column allocated_at timestamp with time zone notnull=true ${PLAIN}`,
      `column demo_id uuid notnull=true ${PLAIN}`,
      `column label text notnull=true ${PLAIN}`,
      'default allocated_at now()',
      'constraint hostname_register_demo_id_unique UNIQUE (demo_id)',
      "constraint hostname_register_label_shape CHECK ((label ~ '^[a-z2-7]{20}$'::text))",
      'constraint hostname_register_pkey PRIMARY KEY (label)',
      'index portal.hostname_register_demo_id_unique CREATE UNIQUE INDEX ' +
        'hostname_register_demo_id_unique ON portal.hostname_register USING btree (demo_id)',
      'index portal.hostname_register_pkey CREATE UNIQUE INDEX hostname_register_pkey ON ' +
        'portal.hostname_register USING btree (label)',
    ],
  },
  'portal.hostname_retirement': {
    since: DEMO_LIFECYCLE,
    lines: [
      `column label text notnull=true ${PLAIN}`,
      `column retired_at timestamp with time zone notnull=true ${PLAIN}`,
      'default retired_at now()',
      'constraint hostname_retirement_label_hostname_register_label_fk FOREIGN KEY (label) ' +
        'REFERENCES portal.hostname_register(label)',
      'constraint hostname_retirement_pkey PRIMARY KEY (label)',
      'index portal.hostname_retirement_pkey CREATE UNIQUE INDEX hostname_retirement_pkey ON ' +
        'portal.hostname_retirement USING btree (label)',
    ],
  },
  'portal.demo_request': {
    since: DEMO_REQUEST,
    lines: [
      `column accent_colour text notnull=false ${PLAIN}`,
      `column consent_wording text notnull=true ${PLAIN}`,
      `column demo_id uuid notnull=true ${PLAIN}`,
      `column description text notnull=false ${PLAIN}`,
      `column explainer_wording text notnull=true ${PLAIN}`,
      `column font text notnull=false ${PLAIN}`,
      `column import_source text notnull=false ${PLAIN}`,
      `column logo_hash text notnull=false ${PLAIN}`,
      `column new_to_ghost boolean notnull=true ${PLAIN}`,
      `column outlet_type text notnull=true ${PLAIN}`,
      `column publication_name text notnull=true ${PLAIN}`,
      `column submitted_at timestamp with time zone notnull=true ${PLAIN}`,
      `column theme text notnull=false ${PLAIN}`,
      `column verified_address text notnull=true ${PLAIN}`,
      `column verified_subject text notnull=true ${PLAIN}`,
      'default submitted_at now()',
      'constraint demo_request_address_shape CHECK (((verified_address = lower(verified_address)) AND ' +
        "(char_length(verified_address) <= 254) AND (verified_address ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'::text)))",
      'constraint demo_request_choices_shape CHECK ((((theme IS NULL) OR ' +
        "(theme ~ '^[a-z0-9-]{1,40}$'::text)) AND ((font IS NULL) OR " +
        "(font ~ '^[a-z0-9-]{1,40}$'::text)) AND (outlet_type ~ '^[a-z0-9-]{1,40}$'::text)))",
      "constraint demo_request_colour_shape CHECK (((accent_colour IS NULL) OR (accent_colour ~ '^#[0-9a-f]{6}$'::text)))",
      'constraint demo_request_description_length CHECK (((description IS NULL) OR ' +
        '((char_length(description) >= 1) AND (char_length(description) <= 500))))',
      'constraint demo_request_import_source_length CHECK (((import_source IS NULL) OR ' +
        '((char_length(import_source) >= 1) AND (char_length(import_source) <= 100))))',
      "constraint demo_request_logo_hash_shape CHECK (((logo_hash IS NULL) OR (logo_hash ~ '^[0-9a-f]{64}$'::text)))",
      'constraint demo_request_name_length CHECK (((char_length(publication_name) >= 1) AND ' +
        '(char_length(publication_name) <= 100)))',
      'constraint demo_request_pkey PRIMARY KEY (demo_id)',
      'constraint demo_request_subject_length CHECK (((char_length(verified_subject) >= 1) AND ' +
        '(char_length(verified_subject) <= 255)))',
      'constraint demo_request_verified_address_unique UNIQUE (verified_address)',
      'constraint demo_request_wording_length CHECK ((((char_length(consent_wording) >= 1) AND ' +
        '(char_length(consent_wording) <= 2000)) AND ((char_length(explainer_wording) >= 1) AND ' +
        '(char_length(explainer_wording) <= 2000))))',
      'index portal.demo_request_pkey CREATE UNIQUE INDEX demo_request_pkey ON ' +
        'portal.demo_request USING btree (demo_id)',
      'index portal.demo_request_verified_address_unique CREATE UNIQUE INDEX ' +
        'demo_request_verified_address_unique ON portal.demo_request USING btree (verified_address)',
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
