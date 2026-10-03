import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { connect, type PortalDb } from '../src/db.js';
import { migrateSchema } from '../src/migrate.js';
import { tenantRegister } from '../src/schema.js';
import {
  createDatabase,
  createLogin,
  createRoles,
  dropDatabase,
  grantAccess,
  grantRole,
} from '../provision/provision.js';

const ADMIN_URL = process.env['PORTAL_TEST_DATABASE_URL'];

const TENANT_LOGIN = 'portal_test_tenant_login';
const OWNER_LOGIN = 'portal_test_owner_login';
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
  close(): Promise<void>;
}

function urlFor(base: string, database: string, user?: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  if (user !== undefined) {
    url.username = user;
    url.password = LOGIN_PASSWORD;
  }
  return url.toString();
}

/** A closing socket can still report an error after `end()` resolves. */
function quiet(pool: pg.Pool): pg.Pool {
  pool.on('error', () => undefined);
  return pool;
}

const FIXTURE_MIGRATIONS = fileURLToPath(new URL('./drizzle/', import.meta.url));

/**
 * A fresh database on the cluster named by PORTAL_TEST_DATABASE_URL, migrated,
 * holding two tenants in the register. A missing URL fails the suite rather
 * than skipping it: isolation proven against nothing is not proven.
 */
export async function createFixture(): Promise<Fixture> {
  if (ADMIN_URL === undefined) {
    throw new Error('PORTAL_TEST_DATABASE_URL must name a PostgreSQL superuser connection');
  }
  const database = `portal_test_${randomBytes(6).toString('hex')}`;
  const bootstrap = quiet(new pg.Pool({ connectionString: ADMIN_URL, max: 1 }));
  await createDatabase(bootstrap, database);
  await createLogin(bootstrap, TENANT_LOGIN, LOGIN_PASSWORD);
  await createLogin(bootstrap, OWNER_LOGIN, LOGIN_PASSWORD);

  const admin = quiet(new pg.Pool({ connectionString: urlFor(ADMIN_URL, database) }));
  await createRoles(admin);
  await migrateSchema(admin);
  await migrateSchema(admin, {
    migrationsFolder: FIXTURE_MIGRATIONS,
    migrationsTable: '__fixture_migrations',
  });
  await grantAccess(admin, {
    schema: 'portal',
    table: 'tenant_register',
    tenant: 'SELECT',
    owner: 'SELECT, INSERT, UPDATE, DELETE',
  });
  await grantAccess(admin, {
    schema: 'portal_test',
    table: 'note',
    tenant: 'SELECT, INSERT',
    owner: 'SELECT',
  });
  await grantAccess(admin, {
    schema: 'portal_test',
    table: 'leaky',
    tenant: 'SELECT',
    owner: 'SELECT',
  });
  await grantRole(admin, 'portal_tenant', TENANT_LOGIN);
  await grantRole(admin, 'portal_owner', OWNER_LOGIN);

  const adminDb = connect(admin);
  await adminDb.insert(tenantRegister).values([
    { tenantId: TENANT_A, zitadelOrgId: ORG_A },
    { tenantId: TENANT_B, zitadelOrgId: ORG_B },
  ]);

  const tenant = quiet(
    new pg.Pool({ connectionString: urlFor(ADMIN_URL, database, TENANT_LOGIN), max: 1 })
  );
  const owner = quiet(new pg.Pool({ connectionString: urlFor(ADMIN_URL, database, OWNER_LOGIN) }));
  return {
    admin,
    adminDb,
    tenant,
    owner,
    async close() {
      await Promise.all([tenant.end(), owner.end(), admin.end()]);
      await dropDatabase(bootstrap, database);
      await bootstrap.end();
    },
  };
}
