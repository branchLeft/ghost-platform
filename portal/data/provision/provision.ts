import type { ClientBase } from 'pg';
import {
  INIT,
  MEMBERSHIPS,
  ROLE_ATTRIBUTES,
  type ManifestObject,
  type Names,
  type Principal,
} from './manifest.js';
import { scramVerifier } from './scram.js';

// The statements the command writes. Each creates something absent, or
// grants on an object created in the same transaction; none alters an object
// that already existed. The one exception is a login's password, an input the
// command rotates on every run.

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
  const word = OBJECT_WORD[object.kind];
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
    out.push(
      `GRANT ${grant.privileges.join(', ')} ON ${word} ${target} TO ${ident(names[grant.grantee])}`
    );
  }
  return out;
}
