import type { Pool } from 'pg';
import { scramVerifier } from './scram.js';

// Provisioning and administration tooling, run by the operator as a database
// administrator, never by the portal at run time. It creates the server-level
// objects the ORM cannot model: the two roles, the privileges they hold, and
// the throwaway databases and logins the test suite uses.
//
// Order for a database: `createRoles`, then the ORM's migrations
// (`migrateSchema`), then `grantAccess` for each table.

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function ident(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`not a plain identifier: ${value}`);
  return `"${value}"`;
}

/**
 * Creates the two portal roles. `portal_owner` bypasses row security by
 * attribute, so no policy mentions it; `portal_tenant` is subject to every
 * policy. Neither can log in: a deployment grants each to its own login.
 */
export async function createRoles(admin: Pool): Promise<void> {
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_tenant') THEN
        CREATE ROLE portal_tenant NOLOGIN NOINHERIT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_owner') THEN
        CREATE ROLE portal_owner NOLOGIN NOINHERIT;
      END IF;
    END $$`);
  // Always applied, so a role that already existed ends up with the same
  // attributes as one created here.
  await admin.query('ALTER ROLE portal_tenant NOLOGIN NOINHERIT NOBYPASSRLS');
  await admin.query('ALTER ROLE portal_owner NOLOGIN NOINHERIT BYPASSRLS');
}

export interface TableAccess {
  schema: string;
  table: string;
  /** What `portal_tenant` may do to the table, e.g. `SELECT` or `SELECT, INSERT`. */
  tenant: 'SELECT' | 'SELECT, INSERT' | 'SELECT, INSERT, UPDATE, DELETE';
  /** The owner role holds everything the owner console needs. */
  owner: 'SELECT' | 'SELECT, INSERT, UPDATE, DELETE';
}

/** Grants schema usage and the table privileges for one table. */
export async function grantAccess(admin: Pool, access: TableAccess): Promise<void> {
  const schema = ident(access.schema);
  const table = `${schema}.${ident(access.table)}`;
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO portal_tenant, portal_owner`);
  await admin.query(`GRANT ${access.tenant} ON ${table} TO portal_tenant`);
  await admin.query(`GRANT ${access.owner} ON ${table} TO portal_owner`);
}

/** Lets a login assume exactly one portal role. */
export async function grantRole(
  admin: Pool,
  role: 'portal_tenant' | 'portal_owner',
  login: string
): Promise<void> {
  await admin.query(`GRANT ${role} TO ${ident(login)}`);
}

export async function createLogin(
  admin: Pool,
  login: string,
  password: string,
  options: { bypassRls?: boolean } = {}
): Promise<void> {
  // The server receives a salted verifier, never the password, so a statement
  // that fails and is logged cannot disclose it, and no password character can
  // end the dollar-quoted block.
  const verifier = scramVerifier(password);
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ident(login).slice(1, -1)}') THEN
        CREATE ROLE ${ident(login)} LOGIN PASSWORD '${verifier}';
      END IF;
    END $$`);
  // Always applied, so a login left over from an earlier run, or one that
  // existed before, ends up with exactly these attributes and this password.
  await admin.query(
    `ALTER ROLE ${ident(login)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION ` +
      `${options.bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS'} PASSWORD '${verifier}'`
  );
}

/**
 * Leaves the database connectable by the named logins alone. PUBLIC holds
 * CONNECT and TEMP on every new database, and CREATE on schema `public` before
 * PostgreSQL 15; none of that is wanted here. Other databases on the server are
 * outside this command's reach: a login keeps PUBLIC's CONNECT on them until
 * `pg_hba.conf` or a revoke there says otherwise.
 */
export async function lockDatabase(
  admin: Pool,
  database: string,
  logins: readonly string[]
): Promise<void> {
  await admin.query(`REVOKE ALL ON DATABASE ${ident(database)} FROM PUBLIC`);
  for (const login of logins) {
    await admin.query(`GRANT CONNECT ON DATABASE ${ident(database)} TO ${ident(login)}`);
  }
}

/** Run inside the database itself: no ordinary login may create objects in `public`. */
export async function lockPublicSchema(admin: Pool): Promise<void> {
  await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
}

export async function createDatabase(admin: Pool, name: string): Promise<void> {
  await admin.query(`CREATE DATABASE ${ident(name)}`);
}

/**
 * Leaves a login holding `keep` and no other role. A pre-existing login may
 * hold memberships this command never granted; any of them would widen what
 * the login can reach, so each is revoked. From PostgreSQL 16 a membership
 * records who granted it, and a plain REVOKE removes only the grants made by
 * the acting role, leaving the rest with a warning: each is revoked naming its
 * own grantor.
 */
export async function revokeOtherRoles(admin: Pool, login: string, keep: string): Promise<void> {
  // LEFT JOIN: before PostgreSQL 16 a dropped grantor leaves its id behind in
  // the membership, so an inner join would skip exactly the row to remove.
  const held = await admin.query(
    `SELECT r.rolname AS role, g.rolname AS grantor FROM pg_auth_members a
       JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
       LEFT JOIN pg_roles g ON g.oid = a.grantor
      WHERE m.rolname = $1 AND r.rolname <> $2`,
    [login, keep]
  );
  const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
  for (const row of held.rows as { role: string; grantor: string | null }[]) {
    const by = row.grantor === null ? '' : ` GRANTED BY ${quote(row.grantor)}`;
    await admin.query(`REVOKE ${quote(row.role)} FROM ${ident(login)}${by}`);
  }
}

/**
 * The postcondition of the membership steps: the login is a member of `role`
 * and of nothing else. A revoke that missed a row fails here, by name, instead
 * of passing on to a boundary check that cannot see every membership.
 */
export async function assertOnlyRole(admin: Pool, login: string, role: string): Promise<void> {
  const held = await admin.query(
    `SELECT r.rolname AS role FROM pg_auth_members a
       JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
      WHERE m.rolname = $1 ORDER BY 1`,
    [login]
  );
  const roles = [...new Set((held.rows as { role: string }[]).map((row) => row.role))];
  if (roles.length !== 1 || roles[0] !== role) {
    throw new Error(
      `login ${login} must be a member of ${role} only, but holds: ${roles.join(', ') || 'nothing'}`
    );
  }
}

/**
 * Creates the database when it is absent; a second call changes nothing. The
 * server's own "already exists" answer is the check, so two concurrent runs
 * cannot both pass a look-first test and then collide.
 */
export async function createDatabaseIfAbsent(admin: Pool, name: string): Promise<boolean> {
  try {
    await createDatabase(admin, name);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === '42P04') return false;
    throw error;
  }
}
