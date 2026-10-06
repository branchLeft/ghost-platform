import type { Pool } from 'pg';

// Operator-side catalog reads, used by the test suite to look at what the
// provisioning command left behind. Declared database tooling
// (`.standards-db-tooling`), never imported by the portal at run time.

export interface ProvisionedState {
  roles: unknown[];
  members: unknown[];
  grants: unknown[];
  migrations: unknown[];
  tables: unknown[];
  databaseAcl: unknown[];
}

/** Everything the command converges on, as comparable data. */
export async function provisionedState(
  pool: Pool,
  database: string,
  logins: readonly string[]
): Promise<ProvisionedState> {
  const roles = await pool.query(
    `SELECT rolname, rolcanlogin, rolbypassrls, rolinherit, rolsuper, rolcreaterole, rolcreatedb,
            rolreplication FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
    [['portal_tenant', 'portal_owner', ...logins]]
  );
  const members = await pool.query(
    `SELECT r.rolname AS role, m.rolname AS member, a.admin_option FROM pg_auth_members a
       JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
      WHERE m.rolname = ANY($1) ORDER BY 1, 2`,
    [['portal_tenant', 'portal_owner', ...logins]]
  );
  const grants = await pool.query(
    `SELECT grantee, table_schema, table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee IN ('portal_tenant', 'portal_owner') AND table_schema = 'portal' ORDER BY 1, 2, 3, 4`
  );
  const migrations = await pool.query(
    'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations'
  );
  const tables = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'portal' ORDER BY 1`
  );
  const databaseAcl = await pool.query(
    `SELECT l.rolname AS login, has_database_privilege(l.rolname, $1, 'CONNECT') AS connect,
            has_database_privilege(l.rolname, $1, 'TEMP') AS temp
       FROM pg_roles l WHERE l.rolname = ANY($2) ORDER BY 1`,
    [database, logins]
  );
  return {
    roles: roles.rows,
    members: members.rows,
    grants: grants.rows,
    migrations: migrations.rows,
    tables: tables.rows,
    databaseAcl: databaseAcl.rows,
  };
}

/** The stored password verifier of a role, for comparing with a computed one. */
export async function storedVerifier(pool: Pool, role: string): Promise<string> {
  const found = await pool.query('SELECT rolpassword FROM pg_authid WHERE rolname = $1', [role]);
  return String((found.rows[0] as { rolpassword: string }).rolpassword);
}

/** The error a login gets when it tries to create a table in `public`, if any. */
export async function createInPublic(pool: Pool): Promise<unknown> {
  try {
    await pool.query('CREATE TABLE public.portal_inspect_probe (id integer)');
    await pool.query('DROP TABLE public.portal_inspect_probe');
    return undefined;
  } catch (error) {
    return error;
  }
}

/** How many role-level setting rows (any database) the named roles still carry. */
export async function roleSettingCount(pool: Pool, roles: readonly string[]): Promise<number> {
  const found = await pool.query(
    `SELECT count(*)::int AS n FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole
      WHERE r.rolname = ANY($1)`,
    [roles]
  );
  return (found.rows[0] as { n: number }).n;
}

/** The roles, among those named, that own the database or a function in `public`. */
export async function owners(pool: Pool, database: string): Promise<unknown[]> {
  const found = await pool.query(
    `SELECT 'database' AS object, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1
     UNION ALL
     SELECT 'schema public', pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public'
     UNION ALL
     SELECT 'function ' || proname, pg_get_userbyid(proowner) FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace ORDER BY 1`,
    [database]
  );
  return found.rows;
}

/** The attributes of one login, as stored. */
export async function loginAttributes(pool: Pool, login: string): Promise<unknown[]> {
  const found = await pool.query(
    `SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin
       FROM pg_roles WHERE rolname = $1`,
    [login]
  );
  return found.rows;
}
