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
export const PROVISIONER = 'portal_prov_provisioner';
export const PROSPECT = 'portal_prov_prospect';
export const MIGRATOR = 'portal_prov_migrator';
export const TENANT_PW = 'tenant-secret-9f2c41';
export const OWNER_PW = 'owner-secret-77ab03';
export const PROVISIONER_PW = 'provisioner-secret-5d19e8';
export const PROSPECT_PW = 'prospect-secret-c41a7d';
export const MIGRATOR_PW = 'migrator-secret-3b8e72';

export function provConfig(): ProvisionConfig {
  return {
    adminUrl: testUrl('postgres'),
    migratorUrl: '',
    database: PROV_DB,
    tenantLogin: TENANT,
    tenantPassword: TENANT_PW,
    ownerLogin: OWNER,
    ownerPassword: OWNER_PW,
    provisionerLogin: PROVISIONER,
    provisionerPassword: PROVISIONER_PW,
    prospectLogin: PROSPECT,
    prospectPassword: PROSPECT_PW,
    migratorLogin: MIGRATOR,
    migratorPassword: MIGRATOR_PW,
  };
}

/** The migrator's connection URL, with its password in it as `--migrate-only` reads it. */
export function migratorUrl(login: string = MIGRATOR, password: string = MIGRATOR_PW): string {
  const url = new URL(testUrl(PROV_DB, login));
  url.password = password;
  return url.toString();
}

export interface Run {
  code: number;
  out: string[];
  err: string[];
}

/** The command's whole behaviour, in process, from its file inputs. */
export async function run(
  options: ProvisionOptions = {},
  passwords: {
    tenant?: string;
    owner?: string;
    provisioner?: string;
    prospect?: string;
    migrator?: string;
  } = {}
): Promise<Run> {
  const files: Record<string, string> = {
    admin: testUrl('postgres'),
    tenant: passwords.tenant ?? TENANT_PW,
    owner: passwords.owner ?? OWNER_PW,
    provisioner: passwords.provisioner ?? PROVISIONER_PW,
    prospect: passwords.prospect ?? PROSPECT_PW,
    migrator: passwords.migrator ?? MIGRATOR_PW,
  };
  const out: string[] = [];
  const err: string[] = [];
  const code = await runProvision(
    {
      PORTAL_ADMIN_URL_FILE: 'admin',
      PORTAL_TENANT_PASSWORD_FILE: 'tenant',
      PORTAL_OWNER_PASSWORD_FILE: 'owner',
      PORTAL_PROVISIONER_PASSWORD_FILE: 'provisioner',
      PORTAL_PROSPECT_PASSWORD_FILE: 'prospect',
      PORTAL_MIGRATOR_PASSWORD_FILE: 'migrator',
      PORTAL_DATABASE_NAME: PROV_DB,
      PORTAL_TENANT_LOGIN: TENANT,
      PORTAL_OWNER_LOGIN: OWNER,
      PORTAL_PROVISIONER_LOGIN: PROVISIONER,
      PORTAL_PROSPECT_LOGIN: PROSPECT,
      PORTAL_MIGRATOR_LOGIN: MIGRATOR,
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
    for (const role of [
      TENANT,
      OWNER,
      PROVISIONER,
      PROSPECT,
      MIGRATOR,
      'portal_tenant',
      'portal_owner',
      'portal_provisioner',
      'portal_prospect',
    ]) {
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
      principalNames(TENANT, OWNER, PROVISIONER, PROSPECT, MIGRATOR),
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
