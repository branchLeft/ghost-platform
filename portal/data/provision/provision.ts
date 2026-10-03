import type { Pool } from 'pg';

// Provisioning and administration tooling, run by the operator as a database
// administrator, never by the portal at run time. It creates the server-level
// objects the ORM cannot model: the two roles, the privileges they hold, and
// the throwaway databases and logins the test suite uses.
//
// Order for a database: `createRoles`, then the ORM's migrations
// (`migrateSchema`), then `grantAccess` for each table.

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function ident(value: string): string {
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

export async function createLogin(admin: Pool, login: string, password: string): Promise<void> {
  if (password.includes("'")) throw new Error('password may not contain a quote');
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ident(login).slice(1, -1)}') THEN
        CREATE ROLE ${ident(login)} LOGIN PASSWORD '${password}';
      END IF;
    END $$`);
}

export async function createDatabase(admin: Pool, name: string): Promise<void> {
  await admin.query(`CREATE DATABASE ${ident(name)}`);
}

/** Retries: `Pool.end()` resolves before the server has seen every socket close. */
export async function dropDatabase(admin: Pool, name: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await admin.query(`DROP DATABASE ${ident(name)}`);
      return;
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
