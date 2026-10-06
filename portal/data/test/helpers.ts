import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { connect, type PortalDb } from '../src/db.js';
import { migrateSchema } from '../src/migrate.js';
import { tenantRegister } from '../src/schema.js';
import { connectionOptions, provisionPortal } from '../provision/provisionPortal.js';
import { scramVerifier } from '../provision/scram.js';

const ADMIN_URL = process.env['PORTAL_TEST_DATABASE_URL'];

// Fixed names: the test server's pg_hba.conf names this database and these
// logins, and the provisioning command requires that no rule lets a portal
// login reach any other database.
export const FIXTURE_DATABASE = 'portal_fixture';
const TENANT_LOGIN = 'portal_test_tenant_login';
const OWNER_LOGIN = 'portal_test_owner_login';
const DUAL_LOGIN = 'portal_test_dual_login';
const LOGIN_PASSWORD = 'test-only-not-a-secret';

export const TENANT_A = '11111111-1111-4111-8111-111111111111';
export const TENANT_B = '22222222-2222-4222-8222-222222222222';
export const ORG_A = 'org-a';
export const ORG_B = 'org-b';

export interface Fixture {
  /** Connected as the database's owner; applies migrations and fixtures. */
  admin: pg.Pool;
  /** The same connection through the ORM, for seeding rows. */
  adminDb: PortalDb;
  /** Connected as a login that is a member of `portal_tenant` alone. */
  tenant: pg.Pool;
  /** Connected as a login that is a member of `portal_owner` alone. */
  owner: pg.Pool;
  /** A login that holds both roles and can itself bypass row-level policies. */
  dual: pg.Pool;
  close(): Promise<void>;
}

/** The test server's URL for `database`, as `user` when given, with no password in it. */
export function testUrl(database: string, user?: string): string {
  if (ADMIN_URL === undefined) {
    throw new Error('PORTAL_TEST_DATABASE_URL must name a PostgreSQL superuser connection');
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  if (user !== undefined) {
    url.username = user;
    url.password = '';
  }
  return url.toString();
}

/** A pool on the test server; a login's password is passed raw, never in a URL. */
export function testPool(database: string, user?: string, password?: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ ...connectionOptions(testUrl(database, user), password), max });
  // A closing socket can still report an error after `end()` resolves.
  pool.on('error', () => undefined);
  return pool;
}

const FIXTURE_MIGRATIONS = fileURLToPath(new URL('./drizzle/', import.meta.url));

/** Retries: `Pool.end()` resolves before the server has seen every socket close. */
export async function dropDatabase(admin: pg.Pool, name: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      return;
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/**
 * A fresh database on the cluster named by PORTAL_TEST_DATABASE_URL, built by
 * the provisioning command, holding two tenants in the register. A missing
 * URL fails the suite rather than skipping it: isolation proven against
 * nothing is not proven.
 */
export async function createFixture(): Promise<Fixture> {
  const database = FIXTURE_DATABASE;
  const bootstrap = testPool('postgres', undefined, undefined, 1);
  // A fixture left behind by an interrupted run would make the command refuse.
  await dropDatabase(bootstrap, database);
  for (const login of [TENANT_LOGIN, OWNER_LOGIN, DUAL_LOGIN]) {
    await bootstrap.query(`DROP ROLE IF EXISTS "${login}"`);
  }
  // The database under test is the one the provisioning command builds: the
  // roles, the migrations, the grants and the two logins all come from it, so
  // the isolation suite proves what an operator would get, not a second copy.
  await provisionPortal({
    adminUrl: testUrl('postgres'),
    database,
    tenantLogin: TENANT_LOGIN,
    tenantPassword: LOGIN_PASSWORD,
    ownerLogin: OWNER_LOGIN,
    ownerPassword: LOGIN_PASSWORD,
  });
  // Test-only additions after the command has run: a login holding both roles
  // that bypasses row-level policies and, unlike the command's logins,
  // inherits them (role.test.ts shows what it could read without the switch),
  // and the fixture tables with their grants.
  await bootstrap.query(
    `CREATE ROLE "${DUAL_LOGIN}" LOGIN INHERIT BYPASSRLS PASSWORD '${scramVerifier(LOGIN_PASSWORD)}'`
  );
  await bootstrap.query(`GRANT CONNECT ON DATABASE "${database}" TO "${DUAL_LOGIN}"`);

  const admin = testPool(database);
  await migrateSchema(admin, {
    migrationsFolder: FIXTURE_MIGRATIONS,
    migrationsTable: '__fixture_migrations',
  });
  await admin.query('GRANT USAGE ON SCHEMA portal_test TO portal_tenant, portal_owner');
  await admin.query('GRANT SELECT, INSERT ON portal_test.note TO portal_tenant');
  await admin.query('GRANT SELECT ON portal_test.leaky TO portal_tenant');
  await admin.query('GRANT SELECT ON portal_test.note, portal_test.leaky TO portal_owner');
  await admin.query(`GRANT portal_tenant, portal_owner TO "${DUAL_LOGIN}"`);

  const adminDb = connect(admin);
  await adminDb.insert(tenantRegister).values([
    { tenantId: TENANT_A, zitadelOrgId: ORG_A },
    { tenantId: TENANT_B, zitadelOrgId: ORG_B },
  ]);

  const tenant = testPool(database, TENANT_LOGIN, LOGIN_PASSWORD, 1);
  const owner = testPool(database, OWNER_LOGIN, LOGIN_PASSWORD);
  const dual = testPool(database, DUAL_LOGIN, LOGIN_PASSWORD, 1);
  return {
    admin,
    adminDb,
    tenant,
    owner,
    dual,
    async close() {
      await Promise.all([tenant.end(), owner.end(), dual.end(), admin.end()]);
      await dropDatabase(bootstrap, database);
      // The portal roles are shared by the whole cluster, and the provisioning
      // command refuses a portal role held by a login it did not make, so a
      // fixture's logins go with its database.
      for (const login of [TENANT_LOGIN, OWNER_LOGIN, DUAL_LOGIN]) {
        await bootstrap.query(`DROP ROLE IF EXISTS "${login}"`);
      }
      await bootstrap.end();
    },
  };
}
