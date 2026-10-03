import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../src/migrate.js';

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
  const bootstrap = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
  await bootstrap.query(`CREATE DATABASE ${database}`);
  await bootstrap.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TENANT_LOGIN}') THEN
        CREATE ROLE ${TENANT_LOGIN} LOGIN PASSWORD '${LOGIN_PASSWORD}';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OWNER_LOGIN}') THEN
        CREATE ROLE ${OWNER_LOGIN} LOGIN PASSWORD '${LOGIN_PASSWORD}';
      END IF;
    END $$`);

  const admin = new pg.Pool({ connectionString: urlFor(ADMIN_URL, database) });
  await migrate(admin);
  await admin.query(`GRANT portal_tenant TO ${TENANT_LOGIN}`);
  await admin.query(`GRANT portal_owner TO ${OWNER_LOGIN}`);
  await admin.query(
    'INSERT INTO portal.tenant_register (tenant_id, zitadel_org_id) VALUES ($1, $2), ($3, $4)',
    [TENANT_A, ORG_A, TENANT_B, ORG_B]
  );

  const tenant = new pg.Pool({
    connectionString: urlFor(ADMIN_URL, database, TENANT_LOGIN),
    max: 1,
  });
  const owner = new pg.Pool({ connectionString: urlFor(ADMIN_URL, database, OWNER_LOGIN) });
  return {
    admin,
    tenant,
    owner,
    async close() {
      await Promise.all([tenant.end(), owner.end(), admin.end()]);
      await bootstrap.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await bootstrap.end();
    },
  };
}
