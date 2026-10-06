import { INFORMATION_SCHEMA_PUBLIC as PG14_INFORMATION_SCHEMA } from './informationSchema14.js';
import { INFORMATION_SCHEMA_PUBLIC as PG17_INFORMATION_SCHEMA } from './informationSchema17.js';

// How every privilege-bearing part of the catalog is classified, per server
// version. The meta-test checks each list against the live server, together
// with a committed snapshot of every pg_catalog column and every privilege
// name, so a catalog, column or privilege a new version adds fails CI until
// it is classified here. The command refuses a server major version with no
// committed snapshot.

/**
 * The information_schema relations initdb grants SELECT to PUBLIC, per
 * version, with no pg_init_privs row. Every other relation there has no
 * PUBLIC grant. The meta-test compares each list with a fresh template1.
 */
export const INFORMATION_SCHEMA_PUBLIC: Record<number, readonly string[]> = {
  14: PG14_INFORMATION_SCHEMA,
  17: PG17_INFORMATION_SCHEMA,
};

/** Server major versions whose catalog shape has been classified. */
export const SUPPORTED_MAJORS: readonly number[] = [14, 17];

/**
 * pg_shdepend deptypes. They are C constants the server cannot list, so this
 * is a hand-kept list; a row naming a portal role with any other deptype is
 * refused at run time (M19), and the meta-test fails on any other deptype.
 */
export const KNOWN_SHDEPEND_DEPTYPES: readonly string[] = ['a', 'r', 'i'];
export const ALL_SHDEPEND_DEPTYPES: readonly string[] = ['o', 'a', 'r', 'i', 'p', 't'];

const AUTHID_BASE: Record<string, string> = {
  'pg_proc.proowner': 'M18',
  'pg_type.typowner': 'M18',
  'pg_class.relowner': 'M18',
  'pg_operator.oprowner': 'M18',
  'pg_opfamily.opfowner': 'M18',
  'pg_opclass.opcowner': 'M18',
  'pg_language.lanowner': 'M18',
  'pg_largeobject_metadata.lomowner': 'M13',
  'pg_statistic_ext.stxowner': 'M18',
  'pg_event_trigger.evtowner': 'M18',
  'pg_namespace.nspowner': 'M18',
  'pg_conversion.conowner': 'M18',
  'pg_database.datdba': 'M18',
  'pg_db_role_setting.setrole': 'M03',
  'pg_tablespace.spcowner': 'M18',
  'pg_auth_members.roleid': 'M02',
  'pg_auth_members.member': 'M02',
  'pg_auth_members.grantor': 'M02',
  'pg_ts_config.cfgowner': 'M18',
  'pg_ts_dict.dictowner': 'M18',
  'pg_extension.extowner': 'M18',
  'pg_foreign_data_wrapper.fdwowner': 'M18',
  'pg_foreign_server.srvowner': 'M18',
  'pg_user_mapping.umuser': 'M15',
  'pg_policy.polroles': 'M20',
  'pg_default_acl.defaclrole': 'M17',
  'pg_collation.collowner': 'M18',
  'pg_publication.pubowner': 'M18',
  'pg_subscription.subowner': 'M18',
};

/** Every catalog column `pg_get_catalog_foreign_keys()` says references pg_authid. */
export const AUTHID_REFERENCES: Record<number, Record<string, string>> = {
  14: AUTHID_BASE,
  17: AUTHID_BASE,
};

const ACL_BASE: Record<string, string> = {
  'pg_proc.proacl': 'M09',
  'pg_type.typacl': 'M11',
  'pg_attribute.attacl': 'M07',
  'pg_class.relacl': 'M06',
  'pg_language.lanacl': 'M12',
  'pg_largeobject_metadata.lomacl': 'M13',
  'pg_namespace.nspacl': 'M05',
  'pg_database.datacl': 'M04',
  'pg_tablespace.spcacl': 'M14',
  'pg_foreign_data_wrapper.fdwacl': 'M15',
  'pg_foreign_server.srvacl': 'M15',
  'pg_default_acl.defaclacl': 'M17',
  'pg_init_privs.initprivs': 'M29',
};

/** Every `aclitem[]` column in pg_catalog, and the mechanism that reads it. */
export const ACL_COLUMNS: Record<number, Record<string, string>> = {
  14: ACL_BASE,
  17: { ...ACL_BASE, 'pg_parameter_acl.paracl': 'M16' },
};

/** Shared catalogs with an oid column: judged by S-scoped rules, never M25. */
export const SHARED_OID_CATALOGS: Record<number, Record<string, string>> = {
  14: { pg_authid: 'M01', pg_database: 'M04', pg_tablespace: 'M14', pg_subscription: 'M23' },
  17: {
    pg_authid: 'M01',
    pg_database: 'M04',
    pg_tablespace: 'M14',
    pg_subscription: 'M23',
    pg_auth_members: 'M02',
    pg_parameter_acl: 'M16',
  },
};

export interface BaselineCatalog {
  catalog: string;
  acl: string;
  owner: string;
  kind: string;
  join?: string;
  /**
   * Where initdb's information_schema grant to PUBLIC applies, and what it
   * grants. `listed` limits it to the relations in INFORMATION_SCHEMA_PUBLIC.
   */
  informationSchema?: { namespace: string; privilege: string; listed?: string };
}

/** The non-shared catalogs whose initdb objects M29 diffs against pg_init_privs. */
export const BASELINE_ACL_CATALOGS: readonly BaselineCatalog[] = [
  {
    catalog: 'pg_class',
    acl: 'relacl',
    owner: 'c.relowner',
    kind: `CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END`,
    informationSchema: { namespace: 'c.relnamespace', privilege: 'SELECT', listed: 'c.relname' },
  },
  { catalog: 'pg_proc', acl: 'proacl', owner: 'c.proowner', kind: `'f'::"char"` },
  { catalog: 'pg_type', acl: 'typacl', owner: 'c.typowner', kind: `'T'::"char"` },
  { catalog: 'pg_language', acl: 'lanacl', owner: 'c.lanowner', kind: `'l'::"char"` },
  {
    catalog: 'pg_namespace',
    acl: 'nspacl',
    owner: 'c.nspowner',
    kind: `'n'::"char"`,
    informationSchema: { namespace: 'c.oid', privilege: 'USAGE' },
  },
  {
    catalog: 'pg_foreign_data_wrapper',
    acl: 'fdwacl',
    owner: 'c.fdwowner',
    kind: `'F'::"char"`,
  },
  { catalog: 'pg_foreign_server', acl: 'srvacl', owner: 'c.srvowner', kind: `'S'::"char"` },
  {
    catalog: 'pg_largeobject_metadata',
    acl: 'lomacl',
    owner: 'c.lomowner',
    kind: `'L'::"char"`,
  },
  {
    catalog: 'pg_attribute',
    acl: 'attacl',
    owner: 'r.relowner',
    kind: `'c'::"char"`,
    join: 'JOIN pg_class r ON r.oid = c.attrelid',
  },
];
