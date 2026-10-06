import pg from 'pg';
import { checkpointFor, snapshot } from '../provision/catalog.js';
import { principalNames } from '../provision/manifest.js';
import { readMigrations } from '../provision/migrations.js';
import {
  runProvision,
  type ProvisionConfig,
  type ProvisionOptions,
} from '../provision/provisionPortal.js';
import { dropDatabase, testPool, testUrl } from './helpers.js';

// Shared by the provisioning suites. The names are fixed because the test
// server's pg_hba.conf names them: these two logins may reach this database
// and no other.

export const PROV_DB = 'portal_prov';
export const OTHER_DB = 'portal_prov_other';
export const TENANT = 'portal_prov_tenant';
export const OWNER = 'portal_prov_owner';
export const TENANT_PW = 'tenant-secret-9f2c41';
export const OWNER_PW = 'owner-secret-77ab03';

export function provConfig(): ProvisionConfig {
  return {
    adminUrl: testUrl('postgres'),
    database: PROV_DB,
    tenantLogin: TENANT,
    tenantPassword: TENANT_PW,
    ownerLogin: OWNER,
    ownerPassword: OWNER_PW,
  };
}

export interface Run {
  code: number;
  out: string[];
  err: string[];
}

/** The command's whole behaviour, in process, from its file inputs. */
export async function run(
  options: ProvisionOptions = {},
  passwords: { tenant?: string; owner?: string } = {}
): Promise<Run> {
  const files: Record<string, string> = {
    admin: testUrl('postgres'),
    tenant: passwords.tenant ?? TENANT_PW,
    owner: passwords.owner ?? OWNER_PW,
  };
  const out: string[] = [];
  const err: string[] = [];
  const code = await runProvision(
    {
      PORTAL_ADMIN_URL_FILE: 'admin',
      PORTAL_TENANT_PASSWORD_FILE: 'tenant',
      PORTAL_OWNER_PASSWORD_FILE: 'owner',
      PORTAL_DATABASE_NAME: PROV_DB,
      PORTAL_TENANT_LOGIN: TENANT,
      PORTAL_OWNER_LOGIN: OWNER,
    },
    [],
    { out: (line) => out.push(line), err: (line) => err.push(line) },
    (path) => {
      const value = files[path];
      if (value === undefined) throw new Error('no such file');
      return value;
    },
    options
  );
  return { code, out, err };
}

/** Runs `sql` as the administrator in `database`. */
export async function admin(database: string, ...sql: string[]): Promise<pg.QueryResult[]> {
  const pool = testPool(database, undefined, undefined, 1);
  try {
    const results: pg.QueryResult[] = [];
    for (const text of sql) results.push(await pool.query(text));
    return results;
  } finally {
    await pool.end();
  }
}

/** Leaves the server with none of the provisioning suites' databases or roles. */
export async function resetServer(): Promise<void> {
  const pool = testPool('postgres', undefined, undefined, 1);
  try {
    // Fail with a diagnosis rather than hang until the hook times out.
    await pool.query("SET statement_timeout = '2s'");
    for (const database of [PROV_DB, OTHER_DB]) await dropDatabase(pool, database);
    for (const role of [TENANT, OWNER, 'portal_tenant', 'portal_owner']) {
      await pool.query(`DROP ROLE IF EXISTS "${role}"`);
    }
  } catch (error) {
    const seen = await pool
      .query(
        `SELECT datname, usename, state, backend_type, wait_event_type, wait_event, left(query, 80) AS q
           FROM pg_stat_activity WHERE pid <> pg_backend_pid()`
      )
      .then((r) => JSON.stringify(r.rows))
      .catch(() => 'unreadable');
    throw new Error(`reset failed: ${String(error)}; sessions: ${seen}`);
  } finally {
    await pool.end();
  }
}

/** Everything the check reads, from the portal database: equal before and after proves no write. */
export async function stateSnapshot(): Promise<string[]> {
  const pool = testPool(PROV_DB, undefined, undefined, 1);
  const client = await pool.connect();
  try {
    await client.query('SET search_path = pg_catalog');
    const major = Number(
      (await client.query("SELECT current_setting('server_version_num')::int / 10000 AS m")).rows[0]
        .m
    );
    const checkpoint = checkpointFor(
      major,
      PROV_DB,
      principalNames(TENANT, OWNER),
      readMigrations().map((m) => m.tag)
    );
    return await snapshot(client, checkpoint);
  } finally {
    client.release();
    await pool.end();
  }
}

/** The server's major version. */
export async function serverMajor(): Promise<number> {
  const [result] = await admin(
    'postgres',
    "SELECT current_setting('server_version_num')::int AS v"
  );
  return Math.floor(Number(result!.rows[0].v) / 10000);
}
