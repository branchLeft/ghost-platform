import type { ClientBase } from 'pg';
import {
  EXTENSIONS,
  FUNCTIONS,
  INIT,
  MEMBERSHIPS,
  POLICIES,
  ROLE_ATTRIBUTES,
  ROW_SECURITY,
  SETTINGS,
  TABLE_SHAPES,
  manifest,
  type ManifestObject,
  type Names,
  type Principal,
} from './manifest.js';
import {
  AUTHID_REFERENCES,
  BASELINE_ACL_CATALOGS,
  KNOWN_SHDEPEND_DEPTYPES,
} from './catalogSnapshot.js';

// The closed-world enumeration. Each mechanism yields the tuples the server
// actually holds and the tuples the manifest expects at this checkpoint; any
// tuple in one and not the other is a difference, and any difference refuses.

export type DatabaseState = 'absent' | 'created-empty' | 'initialised';

export interface Checkpoint {
  major: number;
  database: string;
  names: Names;
  /** The principals that exist now; the others are absent and creatable. */
  present: ReadonlySet<Principal>;
  databaseState: DatabaseState;
  /** Migration tags applied, in order. */
  applied: readonly string[];
}

export interface Difference {
  kind: 'extra' | 'missing';
  mechanism: string;
  text: string;
}

export function formatDifference(difference: Difference): string {
  return `${difference.kind} ${difference.mechanism}: ${difference.text}`;
}

interface Observation {
  mechanism: string;
  actual: Iterable<string>;
  expected: Iterable<string>;
}

function differences(observations: readonly Observation[]): Difference[] {
  const out: Difference[] = [];
  for (const { mechanism, actual, expected } of observations) {
    const have = new Set(actual);
    const want = new Set(expected);
    for (const text of [...have].sort()) {
      if (!want.has(text)) out.push({ kind: 'extra', mechanism, text });
    }
    for (const text of [...want].sort()) {
      if (!have.has(text)) out.push({ kind: 'missing', mechanism, text });
    }
  }
  return out;
}

const PRINCIPALS: readonly Principal[] = ['tenantRole', 'ownerRole', 'tenantLogin', 'ownerLogin'];

/** The checkpoint of a fully provisioned database: every principal, every migration. */
export function checkpointFor(
  major: number,
  database: string,
  names: Names,
  applied: readonly string[]
): Checkpoint {
  return {
    major,
    database,
    names,
    present: new Set(PRINCIPALS),
    databaseState: 'initialised',
    applied,
  };
}

/** Objects the manifest expects to exist at this checkpoint. */
export function expectedObjects(checkpoint: Checkpoint): ManifestObject[] {
  return manifest(checkpoint.major, checkpoint.database).filter((object) =>
    isExpected(object, checkpoint)
  );
}

/** Whether the manifest expects `object` to exist at this checkpoint. */
export function isExpected(object: ManifestObject, checkpoint: Checkpoint): boolean {
  if (checkpoint.databaseState === 'absent') return false;
  return object.since === INIT || checkpoint.applied.includes(object.since);
}

interface Scope {
  /** Every principal that exists plus every role any of them reaches. */
  roleOids: number[];
  roleNames: string[];
  /** `roleOids` with PUBLIC (0). */
  withPublic: number[];
  administrator: string;
  administratorIsSuperuser: boolean;
  bootstrap: string;
  ownerDefaults: Record<string, string[]>;
  databaseOid: number | null;
}

const ACL_GRANTEE = "CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END";
const ACL_COLUMNS = `pg_get_userbyid(x.grantor) AS grantor, ${ACL_GRANTEE} AS grantee,
  x.privilege_type AS privilege, x.is_grantable AS grantable`;

interface AclRow {
  grantor: string;
  grantee: string;
  privilege: string;
  grantable: boolean;
}

function aclText(type: string, identity: string, row: AclRow): string {
  const option = row.grantable ? ' WITH GRANT OPTION' : '';
  return `${row.privilege}${option} on ${type} ${identity} to ${row.grantee} (grantor ${row.grantor})`;
}

async function rows<T>(client: ClientBase, text: string, values: unknown[] = []): Promise<T[]> {
  return (await client.query(text, values)).rows as T[];
}

async function scopeOf(client: ClientBase, checkpoint: Checkpoint): Promise<Scope> {
  const names = PRINCIPALS.map((p) => checkpoint.names[p]);
  const reach = await rows<{ oid: number; rolname: string }>(
    client,
    `SELECT r.oid::int AS oid, r.rolname FROM pg_roles r
      WHERE EXISTS (SELECT 1 FROM pg_roles p WHERE p.rolname = ANY($1)
                     AND pg_has_role(p.oid, r.oid, 'MEMBER'))
      ORDER BY r.rolname`,
    [names]
  );
  const database = await rows<{ oid: number; owner: string }>(
    client,
    'SELECT oid::int AS oid, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
    [checkpoint.database]
  );
  const me = await rows<{ name: string; superuser: boolean; bootstrap: string }>(
    client,
    `SELECT current_user AS name, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
            AS superuser, pg_get_userbyid(10) AS bootstrap`
  );
  const administrator = database[0]?.owner ?? me[0]!.name;
  const superuser = await rows<{ s: boolean }>(
    client,
    'SELECT coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = $1), false) AS s',
    [administrator]
  );
  const ownerDefaults: Record<string, string[]> = {};
  for (const kind of ['d', 'n', 'r', 's', 'f']) {
    for (const owner of [administrator, 'pg_database_owner', me[0]!.bootstrap]) {
      const found = await rows<{ p: string }>(
        client,
        `SELECT x.privilege_type AS p FROM pg_roles o,
                aclexplode(acldefault($1::"char", o.oid)) x
          WHERE o.rolname = $2 AND x.grantee = o.oid ORDER BY 1`,
        [kind, owner]
      );
      ownerDefaults[`${kind}:${owner}`] = found.map((row) => row.p);
    }
  }
  const roleOids = reach.map((row) => row.oid);
  return {
    roleOids,
    roleNames: reach.map((row) => row.rolname),
    withPublic: [0, ...roleOids],
    administrator,
    administratorIsSuperuser: superuser[0]!.s,
    bootstrap: me[0]!.bootstrap,
    ownerDefaults,
    databaseOid: database[0]?.oid ?? null,
  };
}

const KIND_ACL: Record<string, string> = {
  database: 'd',
  schema: 'n',
  table: 'r',
  sequence: 's',
  function: 'f',
};

function ownerOf(object: ManifestObject, scope: Scope): string {
  if (object.ownedBy === 'pg_database_owner') return 'pg_database_owner';
  if (object.ownedBy === 'bootstrap') return scope.bootstrap;
  return scope.administrator;
}

/** The whole ACL the manifest gives `object`, owner's own entries included. */
function expectedAcl(
  object: ManifestObject,
  checkpoint: Checkpoint,
  scope: Scope,
  grants = object.grants
): string[] {
  const owner = ownerOf(object, scope);
  const out: string[] = [];
  const kind = KIND_ACL[object.kind]!;
  for (const privilege of scope.ownerDefaults[`${kind}:${owner}`] ?? []) {
    out.push(
      aclText(object.kind, object.identity, {
        grantor: owner,
        grantee: owner,
        privilege,
        grantable: false,
      })
    );
  }
  for (const grant of grants) {
    if (grant.grantee !== 'PUBLIC' && !checkpoint.present.has(grant.grantee)) continue;
    const grantee = grant.grantee === 'PUBLIC' ? 'PUBLIC' : checkpoint.names[grant.grantee];
    for (const privilege of grant.privileges) {
      out.push(
        aclText(object.kind, object.identity, {
          grantor: owner,
          grantee,
          privilege,
          grantable: false,
        })
      );
    }
  }
  return out;
}

/** A manifest object's grants as they stand before the command first touches the database. */
function createdEmptyGrants(object: ManifestObject, major: number): ManifestObject['grants'] {
  if (object.kind === 'database') {
    return [{ grantee: 'PUBLIC', privileges: ['CONNECT', 'TEMPORARY'] }];
  }
  return [{ grantee: 'PUBLIC', privileges: major >= 15 ? ['USAGE'] : ['CREATE', 'USAGE'] }];
}

const ACL_SOURCE: Record<string, string> = {
  database: `SELECT ${ACL_COLUMNS} FROM pg_database o,
               aclexplode(coalesce(o.datacl, acldefault('d', o.datdba))) x WHERE o.datname = $1`,
  schema: `SELECT ${ACL_COLUMNS} FROM pg_namespace o,
             aclexplode(coalesce(o.nspacl, acldefault('n', o.nspowner))) x WHERE o.nspname = $1`,
  table: `SELECT ${ACL_COLUMNS} FROM pg_class o,
            aclexplode(coalesce(o.relacl, acldefault('r', o.relowner))) x
           WHERE o.oid = to_regclass($1) AND o.relkind <> 'S'`,
  sequence: `SELECT ${ACL_COLUMNS} FROM pg_class o,
               aclexplode(coalesce(o.relacl, acldefault('s', o.relowner))) x
              WHERE o.oid = to_regclass($1) AND o.relkind = 'S'`,
  function: `SELECT ${ACL_COLUMNS} FROM pg_proc o,
               aclexplode(coalesce(o.proacl, acldefault('f', o.proowner))) x
              WHERE o.oid = to_regprocedure($1)`,
};

const ACL_MECHANISM: Record<string, string> = {
  database: 'M04',
  schema: 'M05',
  table: 'M06',
  sequence: 'M06',
  function: 'M09',
};

async function manifestAcls(
  client: ClientBase,
  checkpoint: Checkpoint,
  scope: Scope,
  inDatabase: boolean
): Promise<Observation[]> {
  const out: Observation[] = [];
  for (const object of manifest(checkpoint.major, checkpoint.database)) {
    if (!inDatabase && object.kind !== 'database') continue;
    const actual = (await rows<AclRow>(client, ACL_SOURCE[object.kind]!, [object.identity])).map(
      (row) => aclText(object.kind, object.identity, row)
    );
    const wanted = isExpected(object, checkpoint);
    const grants =
      checkpoint.databaseState === 'created-empty' && object.since === INIT
        ? createdEmptyGrants(object, checkpoint.major)
        : object.grants;
    out.push({
      mechanism: ACL_MECHANISM[object.kind]!,
      actual,
      expected: wanted ? expectedAcl(object, checkpoint, scope, grants) : [],
    });
  }
  return out;
}

async function roleAttributes(client: ClientBase, checkpoint: Checkpoint): Promise<Observation> {
  const found = await rows<Record<string, unknown>>(
    client,
    `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
            rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil::text AS validuntil,
            CASE WHEN rolpassword IS NULL THEN 'none'
                 WHEN rolpassword ~ '^SCRAM-SHA-256\\$[0-9]+:[A-Za-z0-9+/=]+\\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'
                 THEN 'scram' ELSE 'other' END AS password
       FROM pg_authid WHERE rolname = ANY($1) ORDER BY rolname`,
    [PRINCIPALS.map((p) => checkpoint.names[p])]
  );
  const text = (r: Record<string, unknown>): string =>
    `role ${String(r['rolname'])}: superuser=${String(r['rolsuper'])} inherit=${String(r['rolinherit'])} ` +
    `createrole=${String(r['rolcreaterole'])} createdb=${String(r['rolcreatedb'])} ` +
    `login=${String(r['rolcanlogin'])} replication=${String(r['rolreplication'])} ` +
    `bypassrls=${String(r['rolbypassrls'])} connlimit=${String(r['rolconnlimit'])} ` +
    `validuntil=${String(r['validuntil'])} password=${String(r['password'])}`;
  const expected = PRINCIPALS.filter((p) => checkpoint.present.has(p)).map((p) => {
    const want = ROLE_ATTRIBUTES[p];
    return text({
      rolname: checkpoint.names[p],
      rolsuper: false,
      rolinherit: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolcanlogin: want.canLogin,
      rolreplication: false,
      rolbypassrls: want.bypassRls,
      rolconnlimit: -1,
      validuntil: null,
      password: want.canLogin ? 'scram' : 'none',
    });
  });
  return { mechanism: 'M01', actual: found.map(text), expected };
}

async function membership(
  client: ClientBase,
  checkpoint: Checkpoint,
  scope: Scope
): Promise<Observation[]> {
  const options = checkpoint.major >= 16 ? ', a.inherit_option, a.set_option' : '';
  const edges = await rows<Record<string, unknown>>(
    client,
    `SELECT pg_get_userbyid(a.member) AS member, pg_get_userbyid(a.roleid) AS role,
            a.admin_option ${options},
            CASE WHEN g.rolsuper THEN 'a superuser' WHEN g.oid IS NULL THEN 'a dropped role'
                 ELSE g.rolname END AS grantor
       FROM pg_auth_members a LEFT JOIN pg_roles g ON g.oid = a.grantor
      WHERE a.member = ANY($1) OR a.roleid = ANY($1)`,
    [scope.roleOids]
  );
  const edgeText = (e: Record<string, unknown>): string => {
    const extra =
      checkpoint.major >= 16
        ? ` inherit=${String(e['inherit_option'])} set=${String(e['set_option'])}`
        : '';
    return `${String(e['member'])} is a member of ${String(e['role'])}: admin=${String(e['admin_option'])}${extra} granted by ${String(e['grantor'])}`;
  };
  const expectedEdges: string[] = [];
  const expectedReach: string[] = [];
  for (const [login, role] of MEMBERSHIPS) {
    if (!checkpoint.present.has(login) || !checkpoint.present.has(role)) continue;
    expectedEdges.push(
      edgeText({
        member: checkpoint.names[login],
        role: checkpoint.names[role],
        admin_option: false,
        inherit_option: false,
        set_option: true,
        grantor: 'a superuser',
      })
    );
    expectedReach.push(`${checkpoint.names[login]} reaches ${checkpoint.names[role]}`);
    expectedReach.push(`${checkpoint.names[role]} is reached by ${checkpoint.names[login]}`);
  }
  const present = PRINCIPALS.filter((p) => checkpoint.present.has(p)).map(
    (p) => checkpoint.names[p]
  );
  const reach = await rows<{ text: string }>(
    client,
    `SELECT p.rolname || ' reaches ' || r.rolname AS text FROM pg_roles p, pg_roles r
      WHERE p.rolname = ANY($1) AND r.oid <> p.oid AND pg_has_role(p.oid, r.oid, 'MEMBER')
     UNION ALL
     SELECT r.rolname || ' is reached by ' || m.rolname FROM pg_roles r, pg_roles m
      WHERE r.rolname = ANY($1) AND m.oid <> r.oid AND NOT m.rolsuper
        AND pg_has_role(m.oid, r.oid, 'MEMBER')`,
    [present]
  );
  return [
    { mechanism: 'M02', actual: edges.map(edgeText), expected: expectedEdges },
    { mechanism: 'M02', actual: reach.map((r) => r.text), expected: expectedReach },
  ];
}

async function settings(client: ClientBase, scope: Scope): Promise<Observation> {
  const found = await rows<{ text: string }>(
    client,
    `SELECT 'setting for ' || CASE WHEN s.setrole = 0 THEN 'every role' ELSE pg_get_userbyid(s.setrole) END
            || ' in ' || CASE WHEN s.setdatabase = 0 THEN 'every database'
                              ELSE coalesce((SELECT datname FROM pg_database WHERE oid = s.setdatabase), '?') END
            || ': ' || array_to_string(s.setconfig, ', ') AS text
       FROM pg_db_role_setting s
      WHERE s.setrole = ANY($1) OR (s.setrole = 0 AND s.setdatabase IN (0, $2))`,
    [scope.roleOids, scope.databaseOid ?? -1]
  );
  return { mechanism: 'M03', actual: found.map((r) => r.text), expected: [] };
}

async function otherDatabases(
  client: ClientBase,
  checkpoint: Checkpoint,
  scope: Scope
): Promise<Observation> {
  const found = await rows<AclRow & { datname: string }>(
    client,
    `SELECT o.datname, ${ACL_COLUMNS} FROM pg_database o, aclexplode(o.datacl) x
      WHERE o.datname <> $1 AND x.grantee = ANY($2)`,
    [checkpoint.database, scope.roleOids]
  );
  return {
    mechanism: 'M04',
    actual: found.map((r) => aclText('database', r.datname, r)),
    expected: [],
  };
}

async function sharedAcls(client: ClientBase, checkpoint: Checkpoint, scope: Scope) {
  const out: Observation[] = [];
  const spaces = await rows<AclRow & { name: string }>(
    client,
    `SELECT o.spcname AS name, ${ACL_COLUMNS} FROM pg_tablespace o, aclexplode(o.spcacl) x
      WHERE x.grantee = ANY($1)`,
    [scope.withPublic]
  );
  out.push({
    mechanism: 'M14',
    actual: spaces.map((r) => aclText('tablespace', r.name, r)),
    expected: [],
  });
  if (checkpoint.major >= 15) {
    const params = await rows<AclRow & { name: string }>(
      client,
      `SELECT o.parname AS name, ${ACL_COLUMNS} FROM pg_parameter_acl o, aclexplode(o.paracl) x
        WHERE x.grantee = ANY($1)`,
      [scope.withPublic]
    );
    out.push({
      mechanism: 'M16',
      actual: params.map((r) => aclText('parameter', r.name, r)),
      expected: [],
    });
  }
  return out;
}

/** Every row naming a role in scope through a catalog column that references pg_authid. */
async function ownership(
  client: ClientBase,
  checkpoint: Checkpoint,
  scope: Scope,
  inDatabase: boolean
): Promise<Observation[]> {
  const actual: string[] = [];
  const refs = AUTHID_REFERENCES[checkpoint.major] ?? {};
  for (const [column, mechanism] of Object.entries(refs)) {
    if (mechanism !== 'M18') continue;
    const [table, col] = column.split('.') as [string, string];
    const shared = await rows<{ s: boolean }>(
      client,
      'SELECT relisshared AS s FROM pg_class WHERE oid = $1::regclass',
      [`pg_catalog.${table}`]
    );
    if (!inDatabase && !shared[0]?.s) continue;
    const found = await rows<{ text: string }>(
      client,
      `SELECT pg_get_userbyid(c.${col}) || ' owns ' || (o).type || ' ' || coalesce((o).identity, '?') AS text
         FROM pg_catalog.${table} c, pg_identify_object('pg_catalog.${table}'::regclass, c.oid, 0) o
        WHERE c.${col} = ANY($1)`,
      [scope.roleOids]
    );
    actual.push(...found.map((r) => r.text));
  }
  const deps = await rows<{ text: string }>(
    client,
    `SELECT pg_get_userbyid(s.refobjid) || ' owns ' ||
            CASE WHEN s.dbid IN (0, $2) THEN (pg_identify_object(s.classid, s.objid, s.objsubid)).type
                   || ' ' || coalesce((pg_identify_object(s.classid, s.objid, s.objsubid)).identity, '?')
                 ELSE s.classid::regclass::text || ' ' || s.objid || ' in database '
                   || coalesce((SELECT datname FROM pg_database WHERE oid = s.dbid), '?') END AS text
       FROM pg_shdepend s
      WHERE s.refclassid = 'pg_authid'::regclass AND s.deptype = 'o' AND s.refobjid = ANY($1)
        AND ($3 OR s.dbid <> $2)`,
    [scope.roleOids, scope.databaseOid ?? -1, inDatabase]
  );
  actual.push(...deps.map((r) => r.text));
  const owners: Observation = { mechanism: 'M18', actual, expected: [] };
  const admin: Observation = {
    mechanism: 'M18',
    actual: [
      `administrator ${scope.administrator} superuser=${String(scope.administratorIsSuperuser)}`,
    ],
    expected: [`administrator ${scope.administrator} superuser=true`],
  };
  const manifestOwners: string[] = [];
  const expectedOwners: string[] = [];
  const OWNER_SOURCE: Record<string, string> = {
    database: 'SELECT pg_get_userbyid(datdba) AS o FROM pg_database WHERE datname = $1',
    schema: 'SELECT pg_get_userbyid(nspowner) AS o FROM pg_namespace WHERE nspname = $1',
    table: 'SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = to_regclass($1)',
    sequence: 'SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = to_regclass($1)',
    function: 'SELECT pg_get_userbyid(proowner) AS o FROM pg_proc WHERE oid = to_regprocedure($1)',
  };
  for (const object of manifest(checkpoint.major, checkpoint.database)) {
    if (!inDatabase && object.kind !== 'database') continue;
    const found = await rows<{ o: string }>(client, OWNER_SOURCE[object.kind]!, [object.identity]);
    for (const row of found)
      manifestOwners.push(`${object.kind} ${object.identity} is owned by ${row.o}`);
    if (isExpected(object, checkpoint)) {
      expectedOwners.push(
        `${object.kind} ${object.identity} is owned by ${ownerOf(object, scope)}`
      );
    }
  }
  return [owners, admin, { mechanism: 'M18', actual: manifestOwners, expected: expectedOwners }];
}

/** pg_shdepend's explicit mentions of a role in scope, in every database. */
async function mentions(
  client: ClientBase,
  checkpoint: Checkpoint,
  scope: Scope,
  inDatabase: boolean
): Promise<Observation[]> {
  const known = KNOWN_SHDEPEND_DEPTYPES;
  const found = await rows<{ text: string; deptype: string }>(
    client,
    `SELECT s.deptype::text AS deptype,
            s.deptype || ' ' ||
            CASE WHEN s.classid = 0 THEN 'no object' WHEN s.dbid IN (0, $2) THEN (pg_identify_object(s.classid, s.objid, s.objsubid)).type
                   || ' ' || coalesce((pg_identify_object(s.classid, s.objid, s.objsubid)).identity, '?')
                 ELSE s.classid::regclass::text || ' ' || s.objid || ' in database '
                   || coalesce((SELECT datname FROM pg_database WHERE oid = s.dbid), '?') END
            || ' -> ' || pg_get_userbyid(s.refobjid) AS text
       FROM pg_shdepend s
      WHERE s.refclassid = 'pg_authid'::regclass AND s.deptype NOT IN ('o', 'p') AND s.refobjid = ANY($1)
        AND ($3 OR s.dbid <> $2)`,
    [scope.roleOids, scope.databaseOid ?? -1, inDatabase]
  );
  const unknown = found
    .filter((row) => !known.includes(row.deptype))
    .map((row) => `unknown pg_shdepend deptype '${row.deptype}': ${row.text}`);
  const expected: string[] = [];
  for (const object of expectedObjects(checkpoint)) {
    if (!inDatabase && object.kind !== 'database') continue;
    const grants =
      checkpoint.databaseState === 'created-empty' && object.since === INIT ? [] : object.grants;
    for (const grant of grants) {
      if (grant.grantee === 'PUBLIC' || !checkpoint.present.has(grant.grantee)) continue;
      expected.push(`a ${object.kind} ${object.identity} -> ${checkpoint.names[grant.grantee]}`);
    }
  }
  if (inDatabase && checkpoint.present.has('tenantRole')) {
    for (const policy of POLICIES) {
      if (checkpoint.applied.includes(policy.since)) {
        expected.push(
          `r policy ${policy.name} on ${policy.table} -> ${checkpoint.names.tenantRole}`
        );
      }
    }
  }
  return [
    { mechanism: 'M19', actual: found.map((row) => row.text), expected },
    { mechanism: 'M19', actual: unknown, expected: [] },
  ];
}

async function clusterSubscriptions(client: ClientBase, scope: Scope): Promise<Observation> {
  const found = await rows<{ text: string }>(
    client,
    `SELECT 'subscription ' || subname AS text FROM pg_subscription WHERE subdbid = $1`,
    [scope.databaseOid ?? -1]
  );
  return { mechanism: 'M23', actual: found.map((r) => r.text), expected: [] };
}

async function serverSettings(client: ClientBase): Promise<Observation> {
  const names = Object.keys(SETTINGS);
  const live = await rows<{ text: string }>(
    client,
    `SELECT 'setting ' || n || ' = ' || current_setting(n) AS text FROM unnest($1::text[]) n`,
    [names]
  );
  // A value written by ALTER SYSTEM or into a file is applied on the next
  // reload; the file's view catches it before then.
  const files = await rows<{ name: string; setting: string; text: string }>(
    client,
    `SELECT name, setting, 'file setting ' || name || ' = ' || coalesce(setting, '') || ' in '
            || coalesce(sourcefile, '?') || ':' || coalesce(sourceline::text, '?') AS text
       FROM pg_file_settings WHERE name = ANY($1)`,
    [names]
  );
  const pending = files.filter((row) => row.setting !== SETTINGS[row.name]).map((r) => r.text);
  return {
    mechanism: 'M27',
    actual: [...live.map((r) => r.text), ...pending],
    expected: names.map((n) => `setting ${n} = ${SETTINGS[n]!}`),
  };
}

/** Observations that read only shared catalogs and server state. */
async function clusterObservations(
  client: ClientBase,
  checkpoint: Checkpoint,
  scope: Scope,
  inDatabase: boolean
): Promise<Observation[]> {
  return [
    await roleAttributes(client, checkpoint),
    ...(await membership(client, checkpoint, scope)),
    await settings(client, scope),
    await otherDatabases(client, checkpoint, scope),
    ...(await sharedAcls(client, checkpoint, scope)),
    ...(await ownership(client, checkpoint, scope, inDatabase)),
    ...(await mentions(client, checkpoint, scope, inDatabase)),
    await clusterSubscriptions(client, scope),
    await serverSettings(client),
  ];
}

function relationList(checkpoint: Checkpoint): string[] {
  return expectedObjects(checkpoint)
    .filter((o) => o.kind === 'table' || o.kind === 'sequence')
    .map((o) => o.identity);
}

function manifestRelations(checkpoint: Checkpoint): string[] {
  return manifest(checkpoint.major, checkpoint.database)
    .filter((o) => o.kind === 'table' || o.kind === 'sequence')
    .map((o) => o.identity);
}

async function columnAcls(client: ClientBase, checkpoint: Checkpoint): Promise<Observation> {
  const found = await rows<AclRow & { identity: string }>(
    client,
    `SELECT c.oid::regclass::text || '.' || a.attname AS identity, ${ACL_COLUMNS}
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid, aclexplode(a.attacl) x
      WHERE c.oid = ANY(ARRAY(SELECT to_regclass(r) FROM unnest($1::text[]) r))
        AND a.attacl IS NOT NULL`,
    [manifestRelations(checkpoint)]
  );
  return {
    mechanism: 'M07',
    actual: found.map((r) => aclText('column', r.identity, r)),
    expected: [],
  };
}

async function rowSecurity(client: ClientBase, checkpoint: Checkpoint): Promise<Observation> {
  const tables = Object.keys(ROW_SECURITY);
  const found = await rows<{ text: string }>(
    client,
    `SELECT 'row security on ' || t || ': enabled=' || c.relrowsecurity || ' forced='
            || c.relforcerowsecurity AS text
       FROM unnest($1::text[]) t JOIN pg_class c ON c.oid = to_regclass(t)`,
    [tables]
  );
  const present = new Set(relationList(checkpoint));
  const expected = tables
    .filter((t) => present.has(t))
    .map((t) => {
      const want = ROW_SECURITY[t]!;
      return `row security on ${t}: enabled=${String(want.enabled)} forced=${String(want.forced)}`;
    });
  return { mechanism: 'M08', actual: found.map((r) => r.text), expected };
}

async function functionDefinitions(
  client: ClientBase,
  checkpoint: Checkpoint
): Promise<Observation[]> {
  const names = Object.keys(FUNCTIONS);
  const found = await rows<{ text: string }>(
    client,
    `SELECT 'definition of ' || f || ': src=' || encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex')
            || ' lang=' || l.lanname || ' volatile=' || p.provolatile || ' secdef=' || p.prosecdef
            || ' leakproof=' || p.proleakproof || ' config=' || coalesce(array_to_string(p.proconfig, ','), 'null')
            AS text
       FROM unnest($1::text[]) f JOIN pg_proc p ON p.oid = to_regprocedure(f)
       JOIN pg_language l ON l.oid = p.prolang`,
    [names]
  );
  const expected = names
    .filter((n) => checkpoint.applied.includes(FUNCTIONS[n]!.since))
    .map((n) => `definition of ${n}: ${FUNCTIONS[n]!.fingerprint}`);
  const definers = await rows<{ text: string }>(
    client,
    "SELECT 'SECURITY DEFINER function ' || oid::regprocedure::text AS text FROM pg_proc WHERE prosecdef"
  );
  return [
    { mechanism: 'M09', actual: found.map((r) => r.text), expected },
    { mechanism: 'M10', actual: definers.map((r) => r.text), expected: [] },
  ];
}

async function typeAcls(client: ClientBase, checkpoint: Checkpoint): Promise<Observation> {
  const found = await rows<{ text: string }>(
    client,
    `SELECT 'type ' || t.oid::regtype::text || ' has an ACL: ' || t.typacl::text AS text
       FROM pg_type t
      WHERE t.typacl IS NOT NULL AND (t.typrelid = ANY(ARRAY(SELECT to_regclass(r) FROM unnest($1::text[]) r))
         OR t.oid IN (SELECT e.typarray FROM pg_type e
                       WHERE e.typrelid = ANY(ARRAY(SELECT to_regclass(r) FROM unnest($1::text[]) r))))`,
    [manifestRelations(checkpoint)]
  );
  return { mechanism: 'M11', actual: found.map((r) => r.text), expected: [] };
}

async function largeObjects(client: ClientBase): Promise<Observation> {
  // No OID filter: a client may choose any OID for a large object.
  const found = await rows<{ text: string }>(
    client,
    `SELECT 'large object ' || oid || ' owned by ' || pg_get_userbyid(lomowner) AS text
       FROM pg_largeobject_metadata`
  );
  return { mechanism: 'M13', actual: found.map((r) => r.text), expected: [] };
}

async function foreignData(client: ClientBase): Promise<Observation> {
  const found = await rows<{ text: string }>(
    client,
    `SELECT 'foreign-data wrapper ' || fdwname AS text FROM pg_foreign_data_wrapper
     UNION ALL SELECT 'foreign server ' || srvname FROM pg_foreign_server
     UNION ALL SELECT 'user mapping for ' || CASE WHEN umuser = 0 THEN 'PUBLIC'
                                                  ELSE pg_get_userbyid(umuser) END
       FROM pg_user_mapping`
  );
  return { mechanism: 'M15', actual: found.map((r) => r.text), expected: [] };
}

async function defaultAcls(client: ClientBase): Promise<Observation> {
  const found = await rows<{ text: string }>(
    client,
    `SELECT 'default privileges of ' || pg_get_userbyid(defaclrole) || ' in '
            || CASE WHEN defaclnamespace = 0 THEN 'every schema' ELSE defaclnamespace::regnamespace::text END
            || ' for ' || defaclobjtype || ': ' || defaclacl::text AS text
       FROM pg_default_acl`
  );
  return { mechanism: 'M17', actual: found.map((r) => r.text), expected: [] };
}

async function policies(client: ClientBase, checkpoint: Checkpoint): Promise<Observation> {
  const found = await rows<{ text: string }>(
    client,
    `SELECT 'policy ' || p.polname || ' on ' || p.polrelid::regclass::text || ': cmd=' || p.polcmd
            || ' permissive=' || p.polpermissive || ' roles='
            || array_to_string(ARRAY(SELECT CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END
                                       FROM unnest(p.polroles) r ORDER BY 1), ',')
            || ' using=' || coalesce(pg_get_expr(p.polqual, p.polrelid), 'null')
            || ' check=' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), 'null') AS text
       FROM pg_policy p
      WHERE p.polrelid = ANY(ARRAY(SELECT to_regclass(r) FROM unnest($1::text[]) r))`,
    [manifestRelations(checkpoint)]
  );
  const expected = POLICIES.filter((p) => checkpoint.applied.includes(p.since)).map((p) => p.text);
  return { mechanism: 'M20', actual: found.map((r) => r.text), expected };
}

async function tableShapes(client: ClientBase, checkpoint: Checkpoint): Promise<Observation> {
  const tables = Object.keys(TABLE_SHAPES);
  const found = await rows<{ text: string }>(
    client,
    `WITH t AS (SELECT name, to_regclass(name) AS oid FROM unnest($1::text[]) name)
     SELECT t.name || ' column ' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
            || ' notnull=' || a.attnotnull || ' generated=' || coalesce(nullif(a.attgenerated::text, ''), '-')
            || ' identity=' || coalesce(nullif(a.attidentity::text, ''), '-') AS text
       FROM t JOIN pg_attribute a ON a.attrelid = t.oid WHERE a.attnum > 0 AND NOT a.attisdropped
     UNION ALL
     SELECT t.name || ' default ' || a.attname || ' ' || pg_get_expr(d.adbin, d.adrelid)
       FROM t JOIN pg_attrdef d ON d.adrelid = t.oid
       JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
     UNION ALL
     SELECT t.name || ' constraint ' || c.conname || ' ' || pg_get_constraintdef(c.oid)
       FROM t JOIN pg_constraint c ON c.conrelid = t.oid
     UNION ALL
     SELECT t.name || ' index ' || i.indexrelid::regclass::text || ' ' || pg_get_indexdef(i.indexrelid)
       FROM t JOIN pg_index i ON i.indrelid = t.oid
     UNION ALL
     SELECT t.name || ' trigger ' || g.tgname || ' ' || pg_get_triggerdef(g.oid)
       FROM t JOIN pg_trigger g ON g.tgrelid = t.oid WHERE NOT g.tgisinternal
     UNION ALL
     SELECT t.name || ' rule ' || r.rulename FROM t JOIN pg_rewrite r ON r.ev_class = t.oid
     UNION ALL
     SELECT t.name || ' inherits ' || i.inhparent::regclass::text
       FROM t JOIN pg_inherits i ON i.inhrelid = t.oid
     UNION ALL
     SELECT t.name || ' is inherited by ' || i.inhrelid::regclass::text
       FROM t JOIN pg_inherits i ON i.inhparent = t.oid
     UNION ALL
     SELECT t.name || ' statistics ' || s.stxname FROM t JOIN pg_statistic_ext s ON s.stxrelid = t.oid`,
    [tables]
  );
  const present = new Set(relationList(checkpoint));
  const expected = tables
    .filter((t) => present.has(t))
    .flatMap((t) => TABLE_SHAPES[t]!.lines.map((line) => `${t} ${line}`));
  return { mechanism: 'M21', actual: found.map((r) => r.text), expected };
}

async function eventTriggers(client: ClientBase): Promise<Observation> {
  const found = await rows<{ text: string }>(
    client,
    "SELECT 'event trigger ' || evtname AS text FROM pg_event_trigger"
  );
  return { mechanism: 'M22', actual: found.map((r) => r.text), expected: [] };
}

async function publications(client: ClientBase): Promise<Observation> {
  const found = await rows<{ text: string }>(
    client,
    "SELECT 'publication ' || pubname AS text FROM pg_publication"
  );
  return { mechanism: 'M23', actual: found.map((r) => r.text), expected: [] };
}

async function extensions(client: ClientBase): Promise<Observation> {
  const found = await rows<{ text: string }>(
    client,
    "SELECT 'extension ' || extname AS text FROM pg_extension"
  );
  return {
    mechanism: 'M24',
    actual: found.map((r) => r.text),
    expected: EXTENSIONS.map((e) => `extension ${e}`),
  };
}

/**
 * How a row with an OID of 16384 or more is classified, per non-shared
 * catalog. A row no rule claims is unclassified, and refuses. `m` holds the
 * manifest relations, functions, schemas and policies (`table:name`)
 * expected now.
 */
const DERIVED: Record<string, string> = {
  pg_namespace: `c.nspname = ANY(m.schemas)
    OR (c.nspname ~ '^pg_(toast_)?temp_[0-9]+$' AND c.nspowner = 10)`,
  pg_class: `c.oid = ANY(m.rels)
    OR c.oid IN (SELECT reltoastrelid FROM pg_class WHERE oid = ANY(m.rels))
    OR (c.relkind = 'i' AND c.oid IN (SELECT conindid FROM pg_constraint WHERE conrelid = ANY(m.rels)))
    OR (c.relkind = 'i' AND c.oid IN (SELECT indexrelid FROM pg_index WHERE indrelid IN
          (SELECT reltoastrelid FROM pg_class WHERE oid = ANY(m.rels))))`,
  pg_type: `c.oid IN (SELECT reltype FROM pg_class WHERE oid = ANY(m.rels) AND reltype <> 0)
    OR c.oid IN (SELECT t.typarray FROM pg_type t JOIN pg_class r ON r.reltype = t.oid
                  WHERE r.oid = ANY(m.rels))`,
  pg_proc: 'c.oid = ANY(m.funcs)',
  pg_constraint: 'c.conrelid = ANY(m.rels)',
  pg_trigger: `c.tgisinternal AND c.tgconstraint IN
    (SELECT oid FROM pg_constraint WHERE contype = 'f' AND conrelid = ANY(m.rels))`,
  pg_policy: "(c.polrelid::regclass::text || ':' || c.polname) = ANY(m.pols)",
  pg_attrdef: 'c.adrelid = ANY(m.rels)',
};

/** Catalogs whose rows `pg_identify_object` and `pg_init_privs` know by another class. */
const IDENTIFY_AS: Record<string, string> = {
  pg_attribute: 'pg_class',
  pg_largeobject_metadata: 'pg_largeobject',
};

async function catchAll(client: ClientBase, checkpoint: Checkpoint): Promise<Observation> {
  const expected = expectedObjects(checkpoint);
  const rels = relationList(checkpoint);
  const funcs = expected.filter((o) => o.kind === 'function').map((o) => o.identity);
  const schemas = expected.filter((o) => o.kind === 'schema').map((o) => o.identity);
  const pols = POLICIES.filter((p) => checkpoint.applied.includes(p.since)).map(
    (p) => `${p.table}:${p.name}`
  );
  const catalogs = await rows<{ relname: string }>(
    client,
    `SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'oid'
      WHERE c.relnamespace = 'pg_catalog'::regnamespace AND c.relkind = 'r' AND NOT c.relisshared
      ORDER BY 1`
  );
  const unclassified: string[] = [];
  for (const { relname } of catalogs) {
    const rule = DERIVED[relname] ?? 'false';
    const found = await rows<{ text: string }>(
      client,
      `WITH m AS (SELECT ARRAY(SELECT to_regclass(r) FROM unnest($1::text[]) r)::oid[] AS rels,
                         ARRAY(SELECT to_regprocedure(f) FROM unnest($2::text[]) f)::oid[] AS funcs,
                         $3::text[] AS schemas, $4::text[] AS pols)
       SELECT '${relname} ' || coalesce((o).type, '?') || ' ' || coalesce((o).identity, c.oid::text) AS text
         FROM m, pg_catalog.${relname} c,
              LATERAL pg_identify_object('pg_catalog.${IDENTIFY_AS[relname] ?? relname}'::regclass, c.oid, 0) o
        WHERE c.oid >= 16384 AND NOT (${rule})`,
      [rels, funcs, schemas, pols]
    );
    unclassified.push(...found.map((r) => `unclassified ${r.text}`));
  }
  // Every manifest object expected now must exist.
  const existing = await rows<{ text: string }>(
    client,
    `SELECT 'schema ' || nspname AS text FROM pg_namespace WHERE nspname = ANY($1)
     UNION ALL SELECT 'relation ' || r FROM unnest($2::text[]) r WHERE to_regclass(r) IS NOT NULL
     UNION ALL SELECT 'function ' || f FROM unnest($3::text[]) f WHERE to_regprocedure(f) IS NOT NULL
     UNION ALL SELECT 'policy ' || p FROM unnest($4::text[]) p
       WHERE EXISTS (SELECT 1 FROM pg_policy WHERE (polrelid::regclass::text || ':' || polname) = p)`,
    [schemas, rels, funcs, pols]
  );
  const want = [
    ...schemas.map((s) => `schema ${s}`),
    ...rels.map((r) => `relation ${r}`),
    ...funcs.map((f) => `function ${f}`),
    ...pols.map((p) => `policy ${p}`),
  ];
  return {
    mechanism: 'M25',
    actual: [...unclassified, ...existing.map((r) => r.text)],
    expected: want,
  };
}

/**
 * Objects present at initdb (OID below 16384) whose ACL differs, for a role in
 * scope or PUBLIC, from `pg_init_privs` or, without a row there, from the
 * built-in default. Large objects are left to M13 and schema `public` to M05.
 */
async function baselineDrift(
  client: ClientBase,
  scope: Scope,
  only?: string
): Promise<Observation> {
  const actual: string[] = [];
  for (const spec of BASELINE_ACL_CATALOGS) {
    if (only !== undefined && spec.catalog !== only) continue;
    const sub = spec.catalog === 'pg_attribute' ? 'c.attnum' : '0';
    const objid = spec.catalog === 'pg_attribute' ? 'c.attrelid' : 'c.oid';
    const classoid = `'${IDENTIFY_AS[spec.catalog] ?? spec.catalog}'::regclass`;
    const filter = spec.catalog === 'pg_namespace' ? "AND c.nspname <> 'public'" : '';
    // initdb grants information_schema to PUBLIC without a pg_init_privs row
    // (PostgreSQL 14): SELECT on its relations and USAGE on the schema.
    const initdbGrant =
      spec.informationSchema === undefined
        ? ''
        : `|| CASE WHEN ${spec.informationSchema.namespace} = 'information_schema'::regnamespace
                   THEN ARRAY[makeaclitem(0, ${spec.owner}, '${spec.informationSchema.privilege}', false)]
                   ELSE '{}'::aclitem[] END`;
    const found = await rows<{ text: string }>(
      client,
      `WITH o AS (
         SELECT ${objid} AS objid, ${sub} AS sub,
                coalesce(c.${spec.acl}, acldefault(${spec.kind}, ${spec.owner})) AS cur,
                coalesce((SELECT i.initprivs FROM pg_init_privs i
                           WHERE i.objoid = ${objid} AND i.classoid = ${classoid} AND i.objsubid = ${sub}
                           LIMIT 1), acldefault(${spec.kind}, ${spec.owner}) ${initdbGrant}) AS base
           FROM pg_catalog.${spec.catalog} c ${spec.join ?? ''}
          WHERE ${objid} < 16384 ${filter}
            AND (c.${spec.acl} IS NOT NULL OR EXISTS (SELECT 1 FROM pg_init_privs i
                  WHERE i.objoid = ${objid} AND i.classoid = ${classoid} AND i.objsubid = ${sub})))
       SELECT x.kind || ' ' || x.privilege_type || CASE WHEN x.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
              || ' on ' || (pg_identify_object(${classoid}, o.objid, o.sub)).type || ' '
              || coalesce((pg_identify_object(${classoid}, o.objid, o.sub)).identity, o.objid::text)
              || ' to ' || CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END
              || ' (grantor ' || pg_get_userbyid(x.grantor) || ')' AS text
         FROM o, LATERAL (
           SELECT 'added' AS kind, e.* FROM (SELECT * FROM aclexplode(o.cur) EXCEPT SELECT * FROM aclexplode(o.base)) e
           UNION ALL
           SELECT 'removed', e.* FROM (SELECT * FROM aclexplode(o.base) EXCEPT SELECT * FROM aclexplode(o.cur)) e
         ) x (kind, grantor, grantee, privilege_type, is_grantable)
        WHERE x.grantee = ANY($1)`,
      [scope.withPublic]
    );
    actual.push(...found.map((r) => r.text));
  }
  return { mechanism: only === 'pg_language' ? 'M12' : 'M29', actual, expected: [] };
}

/** Every observation the check makes inside the portal database. */
async function databaseObservations(
  client: ClientBase,
  checkpoint: Checkpoint,
  scope: Scope
): Promise<Observation[]> {
  return [
    await columnAcls(client, checkpoint),
    await rowSecurity(client, checkpoint),
    ...(await functionDefinitions(client, checkpoint)),
    await typeAcls(client, checkpoint),
    await baselineDrift(client, scope, 'pg_language'),
    await largeObjects(client),
    await foreignData(client),
    await defaultAcls(client),
    await policies(client, checkpoint),
    await tableShapes(client, checkpoint),
    await eventTriggers(client),
    await publications(client),
    await extensions(client),
    await catchAll(client, checkpoint),
    await baselineDrift(client, scope),
  ];
}

/**
 * The complete difference between the server and the manifest at this
 * checkpoint. `inDatabase` says the client is connected to the portal
 * database; without it only the cluster-wide mechanisms run (the database
 * does not exist yet).
 */
export async function checkAgainstManifest(
  client: ClientBase,
  checkpoint: Checkpoint,
  inDatabase: boolean
): Promise<Difference[]> {
  const scope = await scopeOf(client, checkpoint);
  const observations = [
    ...(await clusterObservations(client, checkpoint, scope, inDatabase)),
    ...(await manifestAcls(client, checkpoint, scope, inDatabase)),
    ...(inDatabase ? await databaseObservations(client, checkpoint, scope) : []),
  ];
  return differences(observations);
}

/** Everything the check reads, as one comparable value: proof that a refusal wrote nothing. */
export async function snapshot(client: ClientBase, checkpoint: Checkpoint): Promise<string[]> {
  const scope = await scopeOf(client, checkpoint);
  const observations = [
    ...(await clusterObservations(client, checkpoint, scope, true)),
    ...(await manifestAcls(client, checkpoint, scope, true)),
    ...(await databaseObservations(client, checkpoint, scope)),
  ];
  const passwords = await rows<{ text: string }>(
    client,
    `SELECT rolname || ' ' || coalesce(rolpassword, '-') AS text FROM pg_authid
      WHERE rolname = ANY($1) ORDER BY 1`,
    [PRINCIPALS.map((p) => checkpoint.names[p])]
  );
  return [
    ...observations.flatMap((o) => [...o.actual].map((t) => `${o.mechanism} ${t}`)).sort(),
    ...passwords.map((r) => r.text),
  ];
}
