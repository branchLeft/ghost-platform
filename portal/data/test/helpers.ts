import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { connect, type PortalDb } from '../src/db.js';
import { migrateSchema } from '../src/migrate.js';
import { tenantRegister } from '../src/schema.js';
import { provisionPortal } from '../provision/provisionPortal.js';
import {
  createLogin,
  dropDatabase,
  grantAccess,
  grantRole,
  lockDatabase,
} from '../provision/provision.js';

const ADMIN_URL = process.env['PORTAL_TEST_DATABASE_URL'];

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
  /** A login that holds both roles and can itself bypass row security. */
  dual: pg.Pool;
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
  // The database under test is the one the provisioning command builds: the
  // roles, the migrations, the grants and the two logins all come from it, so
  // the isolation suite proves what an operator would get, not a second copy.
  await provisionPortal({
    adminUrl: ADMIN_URL,
    database,
    tenantLogin: TENANT_LOGIN,
    tenantPassword: LOGIN_PASSWORD,
    ownerLogin: OWNER_LOGIN,
    ownerPassword: LOGIN_PASSWORD,
  });
  await createLogin(bootstrap, DUAL_LOGIN, LOGIN_PASSWORD, { bypassRls: true });
  await lockDatabase(bootstrap, database, [TENANT_LOGIN, OWNER_LOGIN, DUAL_LOGIN]);

  const admin = quiet(new pg.Pool({ connectionString: urlFor(ADMIN_URL, database) }));
  await migrateSchema(admin, {
    migrationsFolder: FIXTURE_MIGRATIONS,
    migrationsTable: '__fixture_migrations',
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
  await grantRole(admin, 'portal_tenant', DUAL_LOGIN);
  await grantRole(admin, 'portal_owner', DUAL_LOGIN);

  const adminDb = connect(admin);
  await adminDb.insert(tenantRegister).values([
    { tenantId: TENANT_A, zitadelOrgId: ORG_A },
    { tenantId: TENANT_B, zitadelOrgId: ORG_B },
  ]);

  const tenant = quiet(
    new pg.Pool({ connectionString: urlFor(ADMIN_URL, database, TENANT_LOGIN), max: 1 })
  );
  const owner = quiet(new pg.Pool({ connectionString: urlFor(ADMIN_URL, database, OWNER_LOGIN) }));
  const dual = quiet(
    new pg.Pool({ connectionString: urlFor(ADMIN_URL, database, DUAL_LOGIN), max: 1 })
  );
  return {
    admin,
    adminDb,
    tenant,
    owner,
    dual,
    async close() {
      await Promise.all([tenant.end(), owner.end(), dual.end(), admin.end()]);
      await dropDatabase(bootstrap, database);
      await bootstrap.end();
    },
  };
}
