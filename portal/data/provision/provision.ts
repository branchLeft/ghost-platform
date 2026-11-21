import type { ClientBase } from 'pg';
import {
  INIT,
  MEMBERSHIPS,
  grantsAt,
  ROLE_ATTRIBUTES,
  type Grant,
  type ManifestObject,
  type Names,
  type Principal,
} from './manifest.js';
import { scramVerifier } from './scram.js';

// The statements the command writes. Each creates something absent, or
// grants on an object created in the same transaction; none alters an object
// that already existed. The exceptions are a login's password, an input the
// command rotates on every run, and the owner of schema `public` in a database
// the command has just created (`initOwnershipStatements`).

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function ident(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`not a plain identifier: ${value}`);
  return `"${value}"`;
}

const QUALIFIED = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?(\(\))?$/;

/** A manifest identity, checked to be plain before it reaches SQL text. */
function identity(value: string): string {
  if (!QUALIFIED.test(value)) throw new Error(`not a plain manifest identity: ${value}`);
  return value;
}

/** Creates one principal with exactly its manifest attributes (M01). */
export async function createPrincipal(
  client: ClientBase,
  names: Names,
  principal: Principal,
  password?: string
): Promise<void> {
  const want = ROLE_ATTRIBUTES[principal];
  const attributes = [
    want.canLogin ? 'LOGIN' : 'NOLOGIN',
    'NOINHERIT',
    'NOSUPERUSER',
    'NOCREATEDB',
    'NOCREATEROLE',
    'NOREPLICATION',
    want.bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS',
  ];
  // The server receives a salted verifier, never the password, so a statement
  // that fails and is logged cannot disclose it.
  const secret = want.canLogin ? ` PASSWORD '${scramVerifier(password ?? '')}'` : '';
  await client.query(`CREATE ROLE ${ident(names[principal])} ${attributes.join(' ')}${secret}`);
}

/**
 * What the administrator does to a database it has just created, owned by the
 * migrator: before PostgreSQL 15 schema `public` belongs to the bootstrap
 * superuser, so it is handed to the migrator, who then owns everything the
 * migrations create there. From 15 it belongs to `pg_database_owner`, which is
 * the migrator already. Run once, at init, by the administrator.
 */
export function initOwnershipStatements(names: Names, major: number): string[] {
  return major < 15 ? [`ALTER SCHEMA public OWNER TO ${ident(names.migratorLogin)}`] : [];
}

/** Grants each login its one role, when either side was created on this run. */
export async function grantMemberships(
  client: ClientBase,
  names: Names,
  created: ReadonlySet<Principal>
): Promise<void> {
  for (const [login, role] of MEMBERSHIPS) {
    if (created.has(login) || created.has(role)) {
      await client.query(`GRANT ${ident(names[role])} TO ${ident(names[login])}`);
    }
  }
}

/** Sets a new password on a login that already existed. */
export async function rotatePassword(
  client: ClientBase,
  login: string,
  password: string
): Promise<void> {
  await client.query(`ALTER ROLE ${ident(login)} PASSWORD '${scramVerifier(password)}'`);
}

const OBJECT_WORD: Record<ManifestObject['kind'], string> = {
  database: 'DATABASE',
  schema: 'SCHEMA',
  table: 'TABLE',
  sequence: 'SEQUENCE',
  function: 'FUNCTION',
};

/** The privileges PostgreSQL lets a column carry. */
const COLUMN_PRIVILEGES: readonly string[] = ['INSERT', 'REFERENCES', 'SELECT', 'UPDATE'];

/**
 * One manifest grant as a GRANT statement. A grant naming `columns` is a
 * column-level grant: each privilege is limited to those columns, so the
 * grantee holds nothing on a column the list leaves out. It is a table's alone.
 */
function grantStatement(object: ManifestObject, grant: Grant, names: Names): string {
  const word = OBJECT_WORD[object.kind];
  const target = object.kind === 'database' ? ident(object.identity) : identity(object.identity);
  const grantee = ident(names[grant.grantee as Principal]);
  if (grant.columns === undefined) {
    return `GRANT ${grant.privileges.join(', ')} ON ${word} ${target} TO ${grantee}`;
  }
  if (object.kind !== 'table') {
    throw new Error(`a column grant is a table's alone: ${object.identity} is a ${object.kind}`);
  }
  if (grant.columns.length === 0) {
    throw new Error(`a column grant names no column: ${object.identity}`);
  }
  const bad = grant.privileges.filter((privilege) => !COLUMN_PRIVILEGES.includes(privilege));
  if (bad.length > 0) {
    throw new Error(`not a column privilege: ${bad.join(', ')} on ${object.identity}`);
  }
  const columns = grant.columns.map(ident).join(', ');
  const privileges = grant.privileges.map((privilege) => `${privilege} (${columns})`).join(', ');
  return `GRANT ${privileges} ON ${word} ${target} TO ${grantee}`;
}

/**
 * The statements that give a just-created object its manifest ACL: PUBLIC's
 * creation defaults revoked where the manifest gives PUBLIC nothing, then the
 * grants to the principals `only` admits.
 */
export function grantStatements(
  object: ManifestObject,
  names: Names,
  major: number,
  only: (grantee: Principal) => boolean = () => true
): string[] {
  const target = object.kind === 'database' ? ident(object.identity) : identity(object.identity);
  const out: string[] = [];
  if (object.since === INIT && object.kind === 'database') {
    out.push(`REVOKE ALL ON DATABASE ${target} FROM PUBLIC`);
  } else if (object.since === INIT && object.kind === 'schema' && major < 15) {
    out.push(`REVOKE CREATE ON SCHEMA ${target} FROM PUBLIC`);
  } else if (object.kind === 'function') {
    out.push(`REVOKE ALL ON FUNCTION ${target} FROM PUBLIC`);
  }
  for (const grant of object.grants) {
    if (grant.grantee === 'PUBLIC' || !only(grant.grantee)) continue;
    out.push(grantStatement(object, grant, names));
  }
  return out;
}

/**
 * The grants a principal created on a database that is already initialised
 * must be given: whatever the manifest gives it on the objects `applied`
 * migrations (and init) made, so the check that follows finds it complete.
 * Nothing is revoked and no other principal's grant is touched.
 */
export function catchUpGrantStatements(
  object: ManifestObject,
  applied: readonly string[],
  created: ReadonlySet<Principal>,
  names: Names
): string[] {
  if (object.since !== INIT && !applied.includes(object.since)) return [];
  return grantsAt(object, applied)
    .filter((grant) => grant.grantee !== 'PUBLIC' && created.has(grant.grantee as Principal))
    .map((grant) => grantStatement(object, grant, names));
}

/**
 * The statements for what migration `tag` added to an object an earlier
 * migration made: only the grants the manifest records as added by `tag`.
 */
export function addedGrantStatements(object: ManifestObject, tag: string, names: Names): string[] {
  return (object.added ?? [])
    .filter((later) => later.since === tag)
    .flatMap((later) => later.grants)
    .filter((grant) => grant.grantee !== 'PUBLIC')
    .map((grant) => grantStatement(object, grant, names));
}
