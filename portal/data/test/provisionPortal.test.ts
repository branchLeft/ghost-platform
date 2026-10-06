import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateSchema } from '../src/migrate.js';
import { readMigrations, replayMigrations } from '../provision/migrations.js';
import {
  connectionOptions,
  poolFor,
  provisionPortal,
  verifyBoundary,
} from '../provision/provisionPortal.js';
import { dropDatabase, testPool, testUrl } from './helpers.js';
import {
  OWNER,
  PROV_DB,
  TENANT,
  TENANT_PW,
  admin,
  provConfig,
  resetServer,
  run,
  stateSnapshot,
} from './provisionSetup.js';

// The command's lifecycle on a real server: a fresh database, a second run, a
// pending migration, the one crash state CREATE DATABASE can leave, and the
// compiled entry point. Refusals on tampered state are in closedWorld.test.ts.

const ADMIN_URL = process.env['PORTAL_TEST_DATABASE_URL'];

async function connectAs(login: string, password: string, database = PROV_DB): Promise<void> {
  const client = new pg.Client(connectionOptions(testUrl(database, login), password));
  client.on('error', () => undefined);
  try {
    await client.connect();
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function privilege(role: string, table: string, what: string): Promise<boolean> {
  const [result] = await admin(
    PROV_DB,
    `SELECT has_table_privilege('${role}', '${table}', '${what}') AS p`
  );
  return Boolean(result!.rows[0].p);
}

describe('the provisioning lifecycle', () => {
  if (ADMIN_URL === undefined) {
    it('needs PORTAL_TEST_DATABASE_URL', () => {
      throw new Error('PORTAL_TEST_DATABASE_URL must name a PostgreSQL superuser connection');
    });
    return;
  }

  beforeEach(async () => {
    await resetServer();
  }, 60000);

  afterAll(async () => {
    await resetServer();
  }, 60000);

  it('creates exactly the manifest on a fresh server and verifies the boundary', async () => {
    const result = await run();
    expect(result.err).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      'pre-check passed: no difference from the manifest',
      `created portal_tenant, portal_owner, ${TENANT}, ${OWNER}`,
      `created database ${PROV_DB}`,
      'applied migration 0000_binding_functions',
      'applied migration 0001_tenant_register',
      'applied migration 0002_health_reading',
      'post-check passed: the server matches the manifest',
      'boundary verified',
      'portal database provisioned',
    ]);
    // Nothing deletes, and nothing updates a registration.
    expect(await privilege('portal_owner', 'portal.tenant_register', 'DELETE')).toBe(false);
    expect(await privilege('portal_owner', 'portal.tenant_register', 'UPDATE')).toBe(false);
    expect(await privilege('portal_owner', 'portal.health_reading', 'DELETE')).toBe(false);
    expect(await privilege('portal_owner', 'portal.health_reading', 'UPDATE')).toBe(true);
    // A bare login session, with no SET ROLE, holds nothing in the portal schema.
    expect(await privilege(TENANT, 'portal.tenant_register', 'SELECT')).toBe(false);
  });

  it('changes nothing but the passwords on a second run', async () => {
    expect((await run()).code).toBe(0);
    const before = await stateSnapshot();
    const second = await run({}, { tenant: 'rotated-tenant-1', owner: 'rotated-owner-1' });
    expect(second.err).toEqual([]);
    expect(second.code).toBe(0);
    expect(second.out).toContain('passwords rotated');
    expect(second.out.some((line) => line.startsWith('applied migration'))).toBe(false);
    const after = await stateSnapshot();
    const strip = (lines: string[]): string[] =>
      lines.filter((line) => !line.startsWith(`${TENANT} `) && !line.startsWith(`${OWNER} `));
    expect(strip(after)).toEqual(strip(before));
    expect(after).not.toEqual(before);
    await connectAs(TENANT, 'rotated-tenant-1');
    await expect(connectAs(TENANT, TENANT_PW)).rejects.toThrow();
  });

  it('applies a pending migration and grants what it made, in one transaction', async () => {
    const all = readMigrations();
    const older = await run({ migrations: all.slice(0, 2) });
    expect(older.err).toEqual([]);
    expect(older.code).toBe(0);
    const [absent] = await admin(PROV_DB, "SELECT to_regclass('portal.health_reading') AS t");
    expect(absent!.rows[0].t).toBeNull();
    const upgrade = await run();
    expect(upgrade.err).toEqual([]);
    expect(upgrade.code).toBe(0);
    expect(upgrade.out).toContain('applied migration 0002_health_reading');
    expect(await privilege('portal_owner', 'portal.health_reading', 'INSERT')).toBe(true);
  });

  it('completes a database that was created and left empty (the CREATE DATABASE crash state)', async () => {
    await admin('postgres', `CREATE DATABASE ${PROV_DB}`);
    const result = await run();
    expect(result.err).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain(`created database ${PROV_DB}`);
  });

  it('refuses a migration history it did not ship, writing nothing', async () => {
    expect((await run()).code).toBe(0);
    await admin(
      PROV_DB,
      "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('f00d', 1)"
    );
    const before = await stateSnapshot();
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(/extra M25: migration history row 4 \(f00d\)/);
    expect(await stateSnapshot()).toEqual(before);
  });

  it('refuses when the probe finds another database that lets a login in', async () => {
    const result = await run({ attempt: () => Promise.resolve('ok') });
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(
      new RegExp(
        `extra M28: login ${TENANT} was not refused by pg_hba at database postgres \\(got ok\\)`
      )
    );
  });

  it('refuses an administrator URL that names the portal database itself', async () => {
    await expect(provisionPortal({ ...provConfig(), adminUrl: testUrl(PROV_DB) })).rejects.toThrow(
      'must name a maintenance database'
    );
  });

  it('the boundary smoke test fails when a login holds the other role', async () => {
    expect((await run()).code).toBe(0);
    await admin('postgres', `GRANT portal_owner TO ${TENANT}`);
    try {
      await expect(verifyBoundary(provConfig())).rejects.toThrow(
        'tenant login assumes portal_owner: expected 42501, got ok'
      );
    } finally {
      await admin('postgres', `REVOKE portal_owner FROM ${TENANT}`);
    }
  });

  it('never takes PGPASSWORD or a .pgpass password when the file supplies none', async () => {
    expect((await run()).code).toBe(0);
    const home = mkdtempSync(join(tmpdir(), 'portal-pgpass-'));
    const decoy = join(home, '.pgpass');
    writeFileSync(decoy, `*:*:*:*:${TENANT_PW}\n`, { mode: 0o600 });
    const saved = { ...process.env };
    try {
      process.env['PGPASSWORD'] = TENANT_PW;
      process.env['PGPASSFILE'] = decoy;
      process.env['HOME'] = home;
      // One client, always ended: a client that gives up part-way through
      // SCRAM must not leave a half-authenticated backend behind.
      const client = new pg.Client(poolFor(testUrl(PROV_DB, TENANT)).options);
      client.on('error', () => undefined);
      const error = await client.connect().then(
        () => undefined,
        (e: unknown) => e
      );
      await client.end().catch(() => undefined);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/password|authentication/i);
    } finally {
      process.env = saved;
      rmSync(home, { recursive: true });
    }
  });
});

describe("the replay of drizzle's migrator", () => {
  if (ADMIN_URL === undefined) return;
  const viaDrizzle = 'portal_prov_drizzle';
  const viaReplay = 'portal_prov_replay';

  beforeAll(async () => {
    await resetServer();
    // The policies name the portal roles, so they must exist.
    await admin(
      'postgres',
      'CREATE ROLE portal_tenant NOLOGIN',
      'CREATE ROLE portal_owner NOLOGIN'
    );
  }, 60000);

  afterAll(async () => {
    const pool = testPool('postgres', undefined, undefined, 1);
    for (const database of [viaDrizzle, viaReplay]) await dropDatabase(pool, database);
    await pool.end();
    await resetServer();
  }, 60000);

  it('writes the same history rows as migrate(), inside a transaction it does not commit', async () => {
    await admin('postgres', `CREATE DATABASE ${viaDrizzle}`, `CREATE DATABASE ${viaReplay}`);
    const drizzlePool = testPool(viaDrizzle);
    await migrateSchema(drizzlePool);
    await drizzlePool.end();
    const pool = testPool(viaReplay, undefined, undefined, 1);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await replayMigrations(client, readMigrations());
      await client.query('ROLLBACK');
      const [gone] = await admin(viaReplay, "SELECT to_regnamespace('drizzle') AS n");
      expect(gone!.rows[0].n).toBeNull();
      await client.query('BEGIN');
      await replayMigrations(client, readMigrations());
      await client.query('COMMIT');
    } finally {
      client.release();
      await pool.end();
    }
    const rows = 'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id';
    const [fromDrizzle] = await admin(viaDrizzle, rows);
    const [fromReplay] = await admin(viaReplay, rows);
    expect(fromReplay!.rows).toEqual(fromDrizzle!.rows);
    expect(fromReplay!.rows.length).toBe(readMigrations().length);
  });
});

describe('the compiled command', () => {
  const dist = join(import.meta.dirname, '../dist/provision/provisionMain.js');
  const passwords = ['pa%ss', '%41', '%zz', 'x%', 'a@b', 'a:b', 'a/b', 'a$$b', "it's", '%'];

  if (ADMIN_URL === undefined) {
    it('needs PORTAL_TEST_DATABASE_URL', () => {
      throw new Error('PORTAL_TEST_DATABASE_URL must name a PostgreSQL superuser connection');
    });
    return;
  }

  afterAll(async () => {
    await resetServer();
  }, 60000);

  function compiled(tenantPassword: string, ownerPassword: string) {
    if (!existsSync(dist))
      throw new Error('run `npm run build` first: the compiled command is missing');
    const dir = mkdtempSync(join(tmpdir(), 'portal-provision-'));
    const env: Record<string, string> = {};
    for (const [name, content] of Object.entries({
      PORTAL_ADMIN_URL_FILE: testUrl('postgres'),
      PORTAL_TENANT_PASSWORD_FILE: tenantPassword,
      PORTAL_OWNER_PASSWORD_FILE: ownerPassword,
    })) {
      env[name] = join(dir, name);
      writeFileSync(env[name], content);
    }
    try {
      return spawnSync(process.execPath, [dist], {
        env: {
          PATH: process.env['PATH'] ?? '',
          ...env,
          PORTAL_DATABASE_NAME: PROV_DB,
          PORTAL_TENANT_LOGIN: TENANT,
          PORTAL_OWNER_LOGIN: OWNER,
        },
        encoding: 'utf8',
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  }

  it.each(passwords)(
    'provisions with the password %j and the logins connect with it',
    async (password) => {
      await resetServer();
      const result = compiled(password, `${password}-owner`);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('portal database provisioned');
      expect(result.stdout).not.toContain(password);
      await connectAs(TENANT, password);
      await connectAs(OWNER, `${password}-owner`);
    },
    60000
  );

  it('exits 1 and prints each difference on stderr when the server was tampered with', async () => {
    await resetServer();
    expect(compiled('first-tenant', 'first-owner').status).toBe(0);
    await admin(PROV_DB, 'GRANT TRUNCATE ON portal.tenant_register TO portal_tenant');
    const result = compiled('second-tenant', 'second-owner');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'extra M06: TRUNCATE on table portal.tenant_register to portal_tenant'
    );
    expect(result.stderr).not.toContain('second-tenant');
    // Nothing was written: the old password still works.
    await connectAs(TENANT, 'first-tenant');
  }, 60000);
});
