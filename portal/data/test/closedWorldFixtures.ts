import { OTHER_DB, OWNER, PROV_DB, TENANT } from './provisionSetup.js';

// One "extra" per mechanism on the design note's closed list, each applied to
// a correctly provisioned database, and one "missing" per ACL family. Each
// names the line the refusal must print and the SQL that undoes it.

export interface Tamper {
  /** The mechanism the refusal must name. */
  id: string;
  title: string;
  /** Statements run as the administrator, in order, each in its database. */
  apply: readonly (readonly [string, string])[];
  undo: readonly (readonly [string, string])[];
  /** A pattern the refusal must print. */
  expect: RegExp;
  /** Lowest server major version the tamper can be made on. */
  since?: number;
  /** Rewrites pg_hba.conf instead of running SQL. */
  hba?: (original: string) => string;
}

const P = PROV_DB;
const O = OTHER_DB;
const PG = 'postgres';

export const EXTRAS: readonly Tamper[] = [
  {
    id: 'M01',
    title: 'a login given CREATEDB',
    apply: [[PG, `ALTER ROLE ${TENANT} CREATEDB`]],
    undo: [[PG, `ALTER ROLE ${TENANT} NOCREATEDB`]],
    expect: new RegExp(`extra M01: role ${TENANT}: .*createdb=true`),
  },
  {
    id: 'M02',
    title: 'a predefined role granted to a portal role',
    apply: [[PG, 'GRANT pg_read_all_data TO portal_tenant']],
    undo: [[PG, 'REVOKE pg_read_all_data FROM portal_tenant']],
    expect: /extra M02: portal_tenant is a member of pg_read_all_data/,
  },
  {
    id: 'M03',
    title: 'a setting on every role in every database (ALTER ROLE ALL SET)',
    apply: [[PG, 'ALTER ROLE ALL SET row_security = off']],
    undo: [[PG, 'ALTER ROLE ALL RESET row_security']],
    expect: /extra M03: setting for every role in every database: row_security=off/,
  },
  {
    id: 'M04',
    title: 'TEMPORARY on the portal database for a login',
    apply: [[PG, `GRANT TEMPORARY ON DATABASE ${P} TO ${TENANT}`]],
    undo: [[PG, `REVOKE TEMPORARY ON DATABASE ${P} FROM ${TENANT}`]],
    expect: new RegExp(`extra M04: TEMPORARY on database ${P} to ${TENANT}`),
  },
  {
    id: 'M05',
    title: 'CREATE on schema portal',
    apply: [[P, 'GRANT CREATE ON SCHEMA portal TO portal_tenant']],
    undo: [[P, 'REVOKE CREATE ON SCHEMA portal FROM portal_tenant']],
    expect: /extra M05: CREATE on schema portal to portal_tenant/,
  },
  {
    id: 'M06',
    title: 'TRUNCATE on the register',
    apply: [[P, 'GRANT TRUNCATE ON portal.tenant_register TO portal_tenant']],
    undo: [[P, 'REVOKE TRUNCATE ON portal.tenant_register FROM portal_tenant']],
    expect: /extra M06: TRUNCATE on table portal.tenant_register to portal_tenant/,
  },
  {
    id: 'M07',
    title: 'a column grant',
    apply: [[P, 'GRANT UPDATE (zitadel_org_id) ON portal.tenant_register TO portal_owner']],
    undo: [[P, 'REVOKE UPDATE (zitadel_org_id) ON portal.tenant_register FROM portal_owner']],
    expect: /extra M07: UPDATE on column portal.tenant_register.zitadel_org_id to portal_owner/,
  },
  {
    id: 'M08',
    title: 'row-level policies switched off on the register',
    apply: [[P, 'ALTER TABLE portal.tenant_register DISABLE ROW LEVEL SECURITY']],
    undo: [[P, 'ALTER TABLE portal.tenant_register ENABLE ROW LEVEL SECURITY']],
    expect: /extra M08: row \S+ on portal.tenant_register: enabled=false/,
  },
  {
    id: 'M09',
    title: 'a binding function marked LEAKPROOF',
    apply: [[P, 'ALTER FUNCTION public.bound_tenant() LEAKPROOF']],
    undo: [[P, 'ALTER FUNCTION public.bound_tenant() NOT LEAKPROOF']],
    expect: /extra M09: definition of public.bound_tenant\(\): .*leakproof=true/,
  },
  {
    id: 'M10',
    title: 'a SECURITY DEFINER function',
    apply: [
      [
        P,
        'CREATE FUNCTION public.definer() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$SELECT 1$$',
      ],
    ],
    undo: [[P, 'DROP FUNCTION public.definer()']],
    expect: /extra M10: SECURITY DEFINER function public.definer\(\)/,
  },
  {
    id: 'M11',
    title: "an ACL on a manifest table's row type (a catalog edit)",
    apply: [
      [
        P,
        "UPDATE pg_type SET typacl = '{portal_tenant=U/postgres}' WHERE oid = 'portal.tenant_register'::regtype",
      ],
    ],
    undo: [[P, "UPDATE pg_type SET typacl = NULL WHERE oid = 'portal.tenant_register'::regtype"]],
    expect: /extra M11: type portal.tenant_register has an ACL/,
  },
  {
    id: 'M12',
    title: 'USAGE on plpgsql for a portal role',
    apply: [[P, 'GRANT USAGE ON LANGUAGE plpgsql TO portal_tenant']],
    undo: [[P, 'REVOKE USAGE ON LANGUAGE plpgsql FROM portal_tenant']],
    expect: /extra M12: added USAGE on language plpgsql to portal_tenant/,
  },
  {
    id: 'M13',
    title: 'a large object with an OID below 16384',
    apply: [[P, 'SELECT lo_create(1000)']],
    undo: [[P, 'SELECT lo_unlink(1000)']],
    expect: /extra M13: large object 1000 owned by/,
  },
  {
    id: 'M14',
    title: 'CREATE on a tablespace',
    apply: [[PG, 'GRANT CREATE ON TABLESPACE pg_default TO portal_tenant']],
    undo: [[PG, 'REVOKE CREATE ON TABLESPACE pg_default FROM portal_tenant']],
    expect: /extra M14: CREATE on tablespace pg_default to portal_tenant/,
  },
  {
    id: 'M15',
    title: 'a foreign-data wrapper',
    apply: [[P, 'CREATE FOREIGN DATA WRAPPER prov_fdw']],
    undo: [[P, 'DROP FOREIGN DATA WRAPPER prov_fdw']],
    expect: /extra M15: foreign-data wrapper prov_fdw/,
  },
  {
    id: 'M16',
    title: 'a parameter grant',
    since: 15,
    apply: [[PG, 'GRANT SET ON PARAMETER work_mem TO portal_tenant']],
    undo: [[PG, 'REVOKE SET ON PARAMETER work_mem FROM portal_tenant']],
    expect: /extra M16: SET on parameter work_mem to portal_tenant/,
  },
  {
    id: 'M17',
    title: 'default privileges in schema portal',
    apply: [
      [P, 'ALTER DEFAULT PRIVILEGES IN SCHEMA portal GRANT SELECT ON TABLES TO portal_tenant'],
    ],
    undo: [
      [P, 'ALTER DEFAULT PRIVILEGES IN SCHEMA portal REVOKE SELECT ON TABLES FROM portal_tenant'],
    ],
    expect: /extra M17: default privileges of \S+ in portal for r/,
  },
  {
    id: 'M18',
    title: 'a schema owned by a portal role in another database',
    apply: [[O, 'CREATE SCHEMA owned_elsewhere AUTHORIZATION portal_tenant']],
    undo: [[O, 'DROP SCHEMA owned_elsewhere']],
    expect: new RegExp(`extra M18: portal_tenant owns pg_namespace \\d+ in database ${O}`),
  },
  {
    id: 'M19',
    title: 'a grant to a portal role in another database',
    apply: [
      [O, 'CREATE TABLE public.elsewhere (i integer)'],
      [O, 'GRANT SELECT ON public.elsewhere TO portal_tenant'],
    ],
    undo: [[O, 'DROP TABLE public.elsewhere']],
    expect: new RegExp(`extra M19: a pg_class \\d+ in database ${O} -> portal_tenant`),
  },
  {
    id: 'M20',
    title: 'an extra policy on the register',
    apply: [
      [
        P,
        'CREATE POLICY open_all ON portal.tenant_register FOR SELECT TO portal_tenant USING (true)',
      ],
    ],
    undo: [[P, 'DROP POLICY open_all ON portal.tenant_register']],
    expect: /extra M20: policy open_all on portal.tenant_register: cmd=r/,
  },
  {
    id: 'M21',
    title: 'a column added to the register',
    apply: [[P, 'ALTER TABLE portal.tenant_register ADD COLUMN extra text']],
    undo: [[P, 'ALTER TABLE portal.tenant_register DROP COLUMN extra']],
    expect: /extra M21: portal.tenant_register column extra text/,
  },
  {
    id: 'M22',
    title: 'an event trigger',
    apply: [
      [
        P,
        'CREATE FUNCTION public.on_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN END$$',
      ],
      [P, 'CREATE EVENT TRIGGER prov_evt ON ddl_command_start EXECUTE FUNCTION public.on_ddl()'],
    ],
    undo: [
      [P, 'DROP EVENT TRIGGER prov_evt'],
      [P, 'DROP FUNCTION public.on_ddl()'],
    ],
    expect: /extra M22: event trigger prov_evt/,
  },
  {
    id: 'M23',
    title: 'a publication of the register',
    apply: [[P, 'CREATE PUBLICATION prov_pub FOR TABLE portal.tenant_register']],
    undo: [[P, 'DROP PUBLICATION prov_pub']],
    expect: /extra M23: publication prov_pub/,
  },
  {
    id: 'M24',
    title: 'an extension',
    apply: [[P, 'CREATE EXTENSION citext']],
    undo: [[P, 'DROP EXTENSION citext']],
    expect: /extra M24: extension citext/,
  },
  {
    id: 'M25',
    title: 'a table no rule classifies',
    apply: [[P, 'CREATE TABLE public.stray (i integer)']],
    undo: [[P, 'DROP TABLE public.stray']],
    expect: /extra M25: unclassified pg_class table public.stray/,
  },
  {
    id: 'M27',
    title: 'ALTER SYSTEM turning large-object checks off, not yet reloaded',
    apply: [[PG, 'ALTER SYSTEM SET lo_compat_privileges = on']],
    undo: [[PG, 'ALTER SYSTEM RESET lo_compat_privileges']],
    expect: /extra M27: file setting lo_compat_privileges = on/,
  },
  {
    id: 'M28',
    // The stock image's rule, from an address nothing connects from, so the
    // test's own administrator keeps its access: the static rule ignores
    // addresses.
    title: "a pg_hba rule letting a portal login reach every database (the stock image's rule)",
    apply: [],
    undo: [],
    hba: (original) => `host all all 192.0.2.0/24 scram-sha-256\n${original}`,
    expect: new RegExp(
      `extra M28: pg_hba rule at .*:1 lets ${TENANT} \\(as all\\) reach database all`
    ),
  },
  {
    id: 'M29',
    title: 'EXECUTE on a system function for PUBLIC',
    apply: [[P, 'GRANT EXECUTE ON FUNCTION pg_ls_dir(text) TO PUBLIC']],
    undo: [[P, 'REVOKE EXECUTE ON FUNCTION pg_ls_dir(text) FROM PUBLIC']],
    expect:
      /extra M29: added EXECUTE on function pg_catalog.pg_ls_dir\(pg_catalog.text\) to PUBLIC/,
  },
];

/** Further extras the design check named, beyond one per mechanism. */
export const MORE_EXTRAS: readonly Tamper[] = [
  {
    id: 'M03',
    title: 'a setting on the portal database (row_security off)',
    apply: [[PG, `ALTER DATABASE ${P} SET row_security = off`]],
    undo: [[PG, `ALTER DATABASE ${P} RESET row_security`]],
    expect: new RegExp(`extra M03: setting for every role in ${P}: row_security=off`),
  },
  {
    id: 'M04',
    title: 'an explicit CONNECT for a login on another database',
    apply: [[PG, `GRANT CONNECT ON DATABASE ${O} TO ${TENANT}`]],
    undo: [[PG, `REVOKE CONNECT ON DATABASE ${O} FROM ${TENANT}`]],
    expect: new RegExp(`extra M04: CONNECT on database ${O} to ${TENANT}`),
  },
  {
    id: 'M21',
    title: 'an index backing no constraint on the register',
    apply: [[P, 'CREATE INDEX extra_idx ON portal.tenant_register (lower(zitadel_org_id))']],
    undo: [[P, 'DROP INDEX portal.extra_idx']],
    expect: /extra M21: portal.tenant_register index portal.extra_idx/,
  },
  {
    id: 'M25',
    title: 'the same index, unclassified by the catch-all',
    apply: [[P, 'CREATE INDEX extra_idx ON portal.tenant_register (lower(zitadel_org_id))']],
    undo: [[P, 'DROP INDEX portal.extra_idx']],
    expect: /extra M25: unclassified pg_class index portal.extra_idx/,
  },
  {
    id: 'M18',
    title: 'a manifest table handed to a portal role',
    apply: [[P, 'ALTER TABLE portal.health_reading OWNER TO portal_owner']],
    // The new owner's grants merge into its owner entry, so they are re-made.
    undo: [
      [P, 'ALTER TABLE portal.health_reading OWNER TO postgres'],
      [P, 'GRANT INSERT, SELECT, UPDATE ON portal.health_reading TO portal_owner'],
    ],
    expect: /extra M18: portal_owner owns table portal.health_reading/,
  },
];

/** One per ACL family: a manifest grant taken away. */
export const MISSING: readonly Tamper[] = [
  {
    id: 'M02',
    title: "the tenant login's membership",
    apply: [[PG, `REVOKE portal_tenant FROM ${TENANT}`]],
    undo: [[PG, `GRANT portal_tenant TO ${TENANT}`]],
    expect: new RegExp(`missing M02: ${TENANT} is a member of portal_tenant`),
  },
  {
    id: 'M04',
    title: "the owner login's CONNECT",
    apply: [[PG, `REVOKE CONNECT ON DATABASE ${P} FROM ${OWNER}`]],
    undo: [[PG, `GRANT CONNECT ON DATABASE ${P} TO ${OWNER}`]],
    expect: new RegExp(`missing M04: CONNECT on database ${P} to ${OWNER}`),
  },
  {
    id: 'M05',
    title: "the owner role's USAGE on schema portal",
    apply: [[P, 'REVOKE USAGE ON SCHEMA portal FROM portal_owner']],
    undo: [[P, 'GRANT USAGE ON SCHEMA portal TO portal_owner']],
    expect: /missing M05: USAGE on schema portal to portal_owner/,
  },
  {
    id: 'M06',
    title: "the owner role's INSERT on health readings",
    apply: [[P, 'REVOKE INSERT ON portal.health_reading FROM portal_owner']],
    undo: [[P, 'GRANT INSERT ON portal.health_reading TO portal_owner']],
    expect: /missing M06: INSERT on table portal.health_reading to portal_owner/,
  },
  {
    id: 'M09',
    title: "the tenant role's EXECUTE on bound_tenant()",
    apply: [[P, 'REVOKE EXECUTE ON FUNCTION public.bound_tenant() FROM portal_tenant']],
    undo: [[P, 'GRANT EXECUTE ON FUNCTION public.bound_tenant() TO portal_tenant']],
    expect: /missing M09: EXECUTE on function public.bound_tenant\(\) to portal_tenant/,
  },
];
