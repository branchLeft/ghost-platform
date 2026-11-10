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
  MIGRATOR,
  MIGRATOR_PW,
  OWNER,
  PROV_DB,
  PROSPECT,
  PROVISIONER,
  TENANT,
  TENANT_PW,
  admin,
  provConfig,
  resetServer,
  run,
  serverMajor,
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
      `created portal_tenant, portal_owner, portal_provisioner, portal_prospect, ${TENANT}, ${OWNER}, ${PROVISIONER}, ${PROSPECT}, ${MIGRATOR}`,
      `created database ${PROV_DB}`,
      'applied migration 0000_binding_functions',
      'applied migration 0001_tenant_register',
      'applied migration 0002_health_reading',
      'applied migration 0003_versioned_documents',
      'applied migration 0004_moderation_setting',
      'applied migration 0005_tenant_kind',
      'applied migration 0006_demo_lifecycle_register',
      'applied migration 0007_demo_rebuild_extended',
      'applied migration 0008_tenant_name',
      'applied migration 0009_demo_request',
      // The post-check ran as the migrator, which cannot read everything: it
      // names, per mechanism, what it did not observe.
      expect.stringMatching(new RegExp(`^not observed as ${MIGRATOR}, M01: `)),
      expect.stringMatching(new RegExp(`^not observed as ${MIGRATOR}, M27: `)),
      expect.stringMatching(new RegExp(`^not observed as ${MIGRATOR}, M28: `)),
      'post-check passed: the server matches the manifest',
      'boundary verified',
      'portal database provisioned',
    ]);
    // The migrator, not the administrator, owns the database and what the
    // migrations made in it: step 5 ran as the migrator.
    const [owners] = await admin(
      PROV_DB,
      `SELECT pg_get_userbyid(d.datdba) AS database,
              pg_get_userbyid((SELECT nspowner FROM pg_namespace WHERE nspname = 'public')) AS public_schema,
              pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = to_regclass('portal.tenant_register'))) AS "table",
              pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = to_regclass('drizzle.__drizzle_migrations'))) AS history,
              pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = to_regprocedure('public.bound_tenant()'))) AS "function"
         FROM pg_database d WHERE d.datname = '${PROV_DB}'`
    );
    const major = await serverMajor();
    expect(owners!.rows[0]).toEqual({
      database: MIGRATOR,
      public_schema: major >= 15 ? 'pg_database_owner' : MIGRATOR,
      table: MIGRATOR,
      history: MIGRATOR,
      function: MIGRATOR,
    });
    const [attributes] = await admin(
      'postgres',
      `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin
         FROM pg_roles WHERE rolname = '${MIGRATOR}'`
    );
    expect(attributes!.rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolcanlogin: true,
    });
    const [members] = await admin(
      'postgres',
      `SELECT count(*)::int AS n FROM pg_auth_members WHERE member = '${MIGRATOR}'::regrole`
    );
    expect(members!.rows[0].n).toBe(0);
    await connectAs(MIGRATOR, MIGRATOR_PW);
    // Nothing deletes, and nothing updates a registration.
    expect(await privilege('portal_owner', 'portal.tenant_register', 'DELETE')).toBe(false);
    expect(await privilege('portal_owner', 'portal.tenant_register', 'UPDATE')).toBe(false);
    // A tenant cannot set or change its own kind: it holds SELECT on the
    // register and nothing that writes it. Only the owner role inserts one.
    expect(await privilege('portal_tenant', 'portal.tenant_register', 'SELECT')).toBe(true);
    expect(await privilege('portal_tenant', 'portal.tenant_register', 'INSERT')).toBe(false);
    expect(await privilege('portal_tenant', 'portal.tenant_register', 'UPDATE')).toBe(false);
    expect(await privilege('portal_tenant', 'portal.tenant_register', 'DELETE')).toBe(false);
    expect(await privilege('portal_owner', 'portal.tenant_register', 'INSERT')).toBe(true);
    expect(await privilege('portal_owner', 'portal.health_reading', 'DELETE')).toBe(false);
    expect(await privilege('portal_owner', 'portal.health_reading', 'UPDATE')).toBe(true);
    // A published version and an acceptance are never changed or removed.
    for (const table of ['portal.document_version', 'portal.document_acceptance']) {
      for (const role of ['portal_owner', 'portal_tenant']) {
        expect(await privilege(role, table, 'UPDATE')).toBe(false);
        expect(await privilege(role, table, 'DELETE')).toBe(false);
      }
    }
    expect(await privilege('portal_tenant', 'portal.document_version', 'INSERT')).toBe(false);
    expect(await privilege('portal_owner', 'portal.document_acceptance', 'INSERT')).toBe(false);
    // A tenant saves and changes its own moderation settings; nothing deletes one.
    expect(await privilege('portal_tenant', 'portal.moderation_setting', 'INSERT')).toBe(true);
    expect(await privilege('portal_tenant', 'portal.moderation_setting', 'UPDATE')).toBe(true);
    expect(await privilege('portal_tenant', 'portal.moderation_setting', 'DELETE')).toBe(false);
    expect(await privilege('portal_owner', 'portal.moderation_setting', 'SELECT')).toBe(false);
    // The provisioner role appends and reads the register and the events; it
    // changes and removes nothing, and no other role writes them.
    for (const table of [
      'portal.demo_state_event',
      'portal.hostname_register',
      'portal.hostname_retirement',
    ]) {
      expect(await privilege('portal_provisioner', table, 'INSERT')).toBe(true);
      expect(await privilege('portal_provisioner', table, 'SELECT')).toBe(true);
      expect(await privilege('portal_provisioner', table, 'UPDATE')).toBe(false);
      expect(await privilege('portal_provisioner', table, 'DELETE')).toBe(false);
      expect(await privilege('portal_owner', table, 'SELECT')).toBe(true);
      expect(await privilege('portal_owner', table, 'INSERT')).toBe(false);
      expect(await privilege('portal_tenant', table, 'SELECT')).toBe(false);
    }
    // The front door inserts a request and does nothing else: it cannot read
    // one back, change one or remove one. The lifecycle worker and the owner
    // console read what it wrote and write nothing to it.
    expect(await privilege('portal_prospect', 'portal.demo_request', 'INSERT')).toBe(true);
    for (const what of ['SELECT', 'UPDATE', 'DELETE']) {
      expect(await privilege('portal_prospect', 'portal.demo_request', what)).toBe(false);
    }
    for (const role of ['portal_provisioner', 'portal_owner']) {
      expect(await privilege(role, 'portal.demo_request', 'SELECT')).toBe(true);
      for (const what of ['INSERT', 'UPDATE', 'DELETE']) {
        expect(await privilege(role, 'portal.demo_request', what)).toBe(false);
      }
    }
    expect(await privilege('portal_tenant', 'portal.demo_request', 'SELECT')).toBe(false);
    // The front door holds nothing on any other portal table.
    for (const table of [
      'portal.tenant_register',
      'portal.demo_state_event',
      'portal.hostname_register',
      'portal.hostname_retirement',
    ]) {
      expect(await privilege('portal_prospect', table, 'SELECT')).toBe(false);
      expect(await privilege('portal_prospect', table, 'INSERT')).toBe(false);
    }
    // A bare login session, with no SET ROLE, holds nothing in the portal schema.
    expect(await privilege(TENANT, 'portal.tenant_register', 'SELECT')).toBe(false);
  });

  it('changes nothing but the passwords on a second run', async () => {
    expect((await run()).code).toBe(0);
    const before = await stateSnapshot();
    const second = await run(
      {},
      {
        tenant: 'rotated-tenant-1',
        owner: 'rotated-owner-1',
        provisioner: 'rotated-prov-1',
        prospect: 'rotated-prospect-1',
        migrator: 'rotated-migrator-1',
      }
    );
    expect(second.err).toEqual([]);
    expect(second.code).toBe(0);
    expect(second.out).toContain('passwords rotated');
    expect(second.out.some((line) => line.startsWith('applied migration'))).toBe(false);
    const after = await stateSnapshot();
    const strip = (lines: string[]): string[] =>
      lines.filter(
        (line) =>
          ![TENANT, OWNER, PROVISIONER, PROSPECT, MIGRATOR].some((login) =>
            line.startsWith(`${login} `)
          )
      );
    expect(strip(after)).toEqual(strip(before));
    expect(after).not.toEqual(before);
    await connectAs(TENANT, 'rotated-tenant-1');
    await expect(connectAs(TENANT, TENANT_PW)).rejects.toThrow();
    await connectAs(MIGRATOR, 'rotated-migrator-1');
    await expect(connectAs(MIGRATOR, MIGRATOR_PW)).rejects.toThrow();
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
    // The state a run leaves when it stops after step 3: the logins and the
    // database exist, owned by the migrator, and nothing is in the database.
    const stopped = await run({ attempt: () => Promise.resolve('ok') });
    expect(stopped.code).toBe(1);
    const [empty] = await admin(PROV_DB, "SELECT to_regnamespace('portal') AS n");
    expect(empty!.rows[0].n).toBeNull();
    const result = await run();
    expect(result.err).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain(`created database ${PROV_DB}`);
  });

  it('finishes handing schema public to the migrator after a stop between the two steps', async () => {
    const major = await serverMajor();
    const stopped = await run({ attempt: () => Promise.resolve('ok') });
    expect(stopped.code).toBe(1);
    if (major < 15) {
      // Before 15 the schema is the bootstrap superuser's until the command hands it over.
      await admin(PROV_DB, 'ALTER SCHEMA public OWNER TO postgres');
    }
    const result = await run();
    expect(result.err).toEqual([]);
    expect(result.code).toBe(0);
    const [owner] = await admin(
      PROV_DB,
      "SELECT pg_get_userbyid(nspowner) AS o FROM pg_namespace WHERE nspname = 'public'"
    );
    expect(owner!.rows[0].o).toBe(major >= 15 ? 'pg_database_owner' : MIGRATOR);
  });

  it('refuses a database the administrator owns, as one provisioned before the migrator, and writes nothing', async () => {
    // What a control-plane database looks like if it was provisioned under the
    // superuser: the program refuses it and repairs nothing (a hand step).
    await admin('postgres', `CREATE DATABASE ${PROV_DB}`);
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(
      new RegExp(`extra M18: database ${PROV_DB} is owned by postgres`)
    );
    expect(result.err.join('\n')).toMatch(
      new RegExp(`missing M18: database ${PROV_DB} is owned by ${MIGRATOR}`)
    );
    expect(result.err.at(-1)).toContain('nothing was changed');
    const [roles] = await admin(
      'postgres',
      `SELECT count(*)::int AS n FROM pg_roles WHERE rolname = '${MIGRATOR}'`
    );
    expect(roles!.rows[0].n).toBe(0);
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
    expect(result.err.join('\n')).toMatch(/extra M25: migration history row 11 \(f00d\)/);
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
    // The probe runs after the logins and the database exist: the refusal says
    // so rather than claiming nothing changed.
    expect(result.err).toContain(
      `extra M28: login ${MIGRATOR} was not refused by pg_hba at database postgres (got ok)`
    );
    const major = await serverMajor();
    expect(result.err.at(-1)).toBe(
      'provision failed: refused: 10 difference(s) from the manifest; already done by this run: ' +
        `created portal_tenant, portal_owner, portal_provisioner, portal_prospect, ${TENANT}, ${OWNER}, ${PROVISIONER}, ${PROSPECT}, ${MIGRATOR}; ` +
        `created database ${PROV_DB} (empty)` +
        (major < 15 ? `; handed schema public of ${PROV_DB} to ${MIGRATOR}` : '')
    );
    expect(result.err.join('\n')).not.toContain('nothing was changed');
  });

  it("accepts initdb's own information_schema grants, PUBLIC holding nothing on seven relations", async () => {
    expect((await run()).code).toBe(0);
    const [result] = await admin(
      PROV_DB,
      `SELECT has_table_privilege('public', 'information_schema._pg_user_mappings', 'SELECT') AS m,
              has_table_privilege('public', 'information_schema.tables', 'SELECT') AS t`
    );
    expect(result!.rows[0]).toEqual({ m: false, t: true });
    const second = await run();
    expect(second.err).toEqual([]);
    expect(second.code).toBe(0);
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

  it('the boundary smoke test fails when the provisioner login holds the owner role', async () => {
    expect((await run()).code).toBe(0);
    await admin('postgres', `GRANT portal_owner TO ${PROVISIONER}`);
    try {
      await expect(verifyBoundary(provConfig())).rejects.toThrow(
        'provisioner login assumes portal_owner: expected 42501, got ok'
      );
    } finally {
      await admin('postgres', `REVOKE portal_owner FROM ${PROVISIONER}`);
    }
  });

  it('the boundary smoke test fails when the provisioner role could update the register', async () => {
    expect((await run()).code).toBe(0);
    await admin(PROV_DB, 'GRANT UPDATE ON portal.hostname_register TO portal_provisioner');
    try {
      await expect(verifyBoundary(provConfig())).rejects.toThrow(
        'provisioner updates portal.hostname_register: expected 42501, got ok'
      );
    } finally {
      await admin(PROV_DB, 'REVOKE UPDATE ON portal.hostname_register FROM portal_provisioner');
    }
  });

  it('the boundary smoke test fails when the prospect login holds the owner role', async () => {
    expect((await run()).code).toBe(0);
    await admin('postgres', `GRANT portal_owner TO ${PROSPECT}`);
    try {
      await expect(verifyBoundary(provConfig())).rejects.toThrow(
        'prospect login assumes portal_owner: expected 42501, got ok'
      );
    } finally {
      await admin('postgres', `REVOKE portal_owner FROM ${PROSPECT}`);
    }
  });

  it.each([
    ['SELECT', 'reads', 'prospect reads portal.demo_request: expected 42501, got ok'],
    ['UPDATE', 'updates', 'prospect updates portal.demo_request: expected 42501, got ok'],
    ['DELETE', 'deletes', 'prospect deletes from portal.demo_request: expected 42501, got ok'],
  ])(
    'the boundary smoke test fails when the prospect role could %s a request (%s)',
    async (privilegeName, _verb, message) => {
      expect((await run()).code).toBe(0);
      await admin(PROV_DB, `GRANT ${privilegeName} ON portal.demo_request TO portal_prospect`);
      try {
        await expect(verifyBoundary(provConfig())).rejects.toThrow(message);
      } finally {
        await admin(PROV_DB, `REVOKE ${privilegeName} ON portal.demo_request FROM portal_prospect`);
      }
    }
  );

  it('the boundary smoke test fails when the prospect role could no longer insert a request', async () => {
    expect((await run()).code).toBe(0);
    await admin(PROV_DB, 'REVOKE INSERT ON portal.demo_request FROM portal_prospect');
    try {
      await expect(verifyBoundary(provConfig())).rejects.toThrow(
        'prospect inserts into portal.demo_request: expected ok, got 42501'
      );
    } finally {
      await admin(PROV_DB, 'GRANT INSERT ON portal.demo_request TO portal_prospect');
    }
  });

  it('the boundary smoke test fails when the migrator login holds a portal role, or may create roles', async () => {
    expect((await run()).code).toBe(0);
    await admin('postgres', `GRANT portal_owner TO ${MIGRATOR}`);
    try {
      await expect(verifyBoundary(provConfig())).rejects.toThrow(
        'migrator login assumes portal_owner: expected 42501, got ok'
      );
    } finally {
      await admin('postgres', `REVOKE portal_owner FROM ${MIGRATOR}`);
    }
    await admin('postgres', `ALTER ROLE ${MIGRATOR} CREATEROLE`);
    try {
      await expect(verifyBoundary(provConfig())).rejects.toThrow(
        'migrator login creates a role: expected 42501, got ok'
      );
    } finally {
      await admin('postgres', `ALTER ROLE ${MIGRATOR} NOCREATEROLE`);
    }
    // A probe that was allowed to create a role still leaves none behind.
    const [left] = await admin(
      'postgres',
      "SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'portal_provision_probe'"
    );
    expect(left!.rows[0].n).toBe(0);
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

  function compiled(
    tenantPassword: string,
    ownerPassword: string,
    provisionerPassword = 'prov-pw',
    prospectPassword = 'prospect-pw'
  ) {
    if (!existsSync(dist))
      throw new Error('run `pnpm run build` first: the compiled command is missing');
    const dir = mkdtempSync(join(tmpdir(), 'portal-provision-'));
    const env: Record<string, string> = {};
    for (const [name, content] of Object.entries({
      PORTAL_ADMIN_URL_FILE: testUrl('postgres'),
      PORTAL_TENANT_PASSWORD_FILE: tenantPassword,
      PORTAL_OWNER_PASSWORD_FILE: ownerPassword,
      PORTAL_PROVISIONER_PASSWORD_FILE: provisionerPassword,
      PORTAL_PROSPECT_PASSWORD_FILE: prospectPassword,
      PORTAL_MIGRATOR_PASSWORD_FILE: MIGRATOR_PW,
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
          PORTAL_PROVISIONER_LOGIN: PROVISIONER,
          PORTAL_PROSPECT_LOGIN: PROSPECT,
          PORTAL_MIGRATOR_LOGIN: MIGRATOR,
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
      const result = compiled(password, `${password}-owner`, 'prov-pw', `${password}-prospect`);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('portal database provisioned');
      expect(result.stdout).not.toContain(password);
      await connectAs(TENANT, password);
      await connectAs(OWNER, `${password}-owner`);
      await connectAs(PROSPECT, `${password}-prospect`);
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
