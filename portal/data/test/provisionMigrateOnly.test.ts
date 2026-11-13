import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { checkpointFor, inspectManifest } from '../provision/catalog.js';
import { principalNames } from '../provision/manifest.js';
import { readMigrations } from '../provision/migrations.js';
import {
  connectionOptions,
  loadConfig,
  migratePortal,
  runProvision,
} from '../provision/provisionPortal.js';
import { testPool, testUrl } from './helpers.js';
import { withHba } from './hbaFile.js';
import {
  MIGRATOR,
  OTHER_DB,
  OWNER,
  PROV_DB,
  PROVISIONER,
  PROSPECT,
  TENANT,
  TENANT_PW,
  MIGRATOR_PW,
  admin,
  migratorUrl,
  provConfig,
  resetServer,
  run,
  serverMajor,
  stateSnapshot,
  type Run,
} from './provisionSetup.js';

// `--migrate-only`: pending migrations with their grants and the manifest
// check, and nothing else, as the migrator login. No role is created, no
// password is set, and no file but the migrator's own URL is read: the
// administrator URL is not opened at all.

const ADMIN_URL = process.env['PORTAL_TEST_DATABASE_URL'];
const ENV = {
  PORTAL_MIGRATOR_URL_FILE: 'migrator-url',
  PORTAL_DATABASE_NAME: PROV_DB,
  PORTAL_TENANT_LOGIN: TENANT,
  PORTAL_OWNER_LOGIN: OWNER,
  PORTAL_PROVISIONER_LOGIN: PROVISIONER,
  PORTAL_PROSPECT_LOGIN: PROSPECT,
  PORTAL_MIGRATOR_LOGIN: MIGRATOR,
};

/** Every file the command opened, to show it never opens the administrator's. */
const opened: string[] = [];

/**
 * The flag run with the migrator URL file alone: any other file read throws,
 * and the administrator URL file is named in the environment to show that it
 * is not opened.
 */
async function migrate(
  argv: readonly string[] = ['--migrate-only'],
  url: string = migratorUrl()
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runProvision(
    { ...ENV, PORTAL_ADMIN_URL_FILE: 'admin' },
    argv,
    { out: (line) => out.push(line), err: (line) => err.push(line) },
    (path) => {
      opened.push(path);
      if (path !== 'migrator-url') throw new Error(`read a file it should not: ${path}`);
      return url;
    }
  );
  return { code, out, err };
}

const NOT_OBSERVED = ['M01', 'M27', 'M28'].map((id) =>
  expect.stringMatching(new RegExp(`^not observed as ${MIGRATOR}, ${id}: `))
);

/** Every role's stored password verifier and identity: a rotation changes a row here. */
async function logins(): Promise<string[]> {
  const [result] = await admin(
    'postgres',
    `SELECT rolname || ' ' || oid || ' ' || coalesce(rolpassword, '-') AS line
       FROM pg_authid WHERE rolname LIKE 'portal%' ORDER BY rolname`
  );
  return result!.rows.map((row: { line: string }) => row.line);
}

async function connectAs(login: string, password: string): Promise<void> {
  const client = new pg.Client(connectionOptions(testUrl(PROV_DB, login), password));
  client.on('error', () => undefined);
  try {
    await client.connect();
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function documentTable(): Promise<unknown> {
  const [result] = await admin(PROV_DB, "SELECT to_regclass('portal.document_version') AS t");
  return result!.rows[0].t;
}

/** Undoes the rename whatever state a failing run left: a created owner must not mask the assertion. */
async function restoreRenamedOwner(): Promise<void> {
  await admin('postgres', `DROP ROLE IF EXISTS ${OWNER}`).catch(() => undefined);
  await admin('postgres', 'ALTER ROLE portal_prov_renamed RENAME TO ' + OWNER).catch(
    () => undefined
  );
  await admin('postgres', 'DROP ROLE IF EXISTS portal_prov_renamed');
}

async function history(): Promise<string[]> {
  const [result] = await admin(
    PROV_DB,
    'SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id'
  );
  return result!.rows.map((row: { hash: string }) => row.hash);
}

describe('--migrate-only without a server', () => {
  it('reads the migrator URL and no administrator or password file', () => {
    const read = (path: string): string => {
      if (path !== 'migrator-url') throw new Error(`read ${path}`);
      return `postgres://${MIGRATOR}:${MIGRATOR_PW}@db.invalid:5432/portal`;
    };
    const config = loadConfig(ENV, [], read, true);
    expect(config.adminUrl).toBe('');
    expect(config.migratorPassword).toBe(MIGRATOR_PW);
    expect(config.tenantPassword).toBe('');
    expect(config.ownerPassword).toBe('');
    expect(config.provisionerPassword).toBe('');
    expect(config.prospectPassword).toBe('');
    expect(() => loadConfig(ENV, [], read)).toThrow(/PORTAL_ADMIN_URL_FILE/);
  });

  it('takes no argument but its own flag', async () => {
    const result = await migrate(['--migrate-only', '--rotate']);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(/takes no arguments but --migrate-only/);
    expect((await migrate(['--rotate'])).code).toBe(1);
  });
});

describe('--migrate-only on a real server', () => {
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

  async function provisionedBeforeDocuments(): Promise<void> {
    const older = await run({ migrations: readMigrations().slice(0, 3) });
    expect(older.err).toEqual([]);
    expect(older.code).toBe(0);
    expect(await documentTable()).toBeNull();
  }

  it('applies the pending migration with its grants and changes no password or role', async () => {
    await provisionedBeforeDocuments();
    const before = await logins();
    expect(before).toHaveLength(9);
    const result = await migrate();
    expect(result.err).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      'pre-check passed: no difference from the manifest',
      'applied migration 0003_versioned_documents',
      'applied migration 0004_moderation_setting',
      'applied migration 0005_tenant_kind',
      'applied migration 0006_demo_lifecycle_register',
      'applied migration 0007_demo_rebuild_extended',
      'applied migration 0008_tenant_name',
      'applied migration 0009_custom_domain',
      'applied migration 0010_demo_request',
      ...NOT_OBSERVED,
      'post-check passed: the server matches the manifest',
      'portal database migrated',
    ]);
    expect(await documentTable()).not.toBeNull();
    const [grant] = await admin(
      PROV_DB,
      `SELECT has_table_privilege('portal_tenant', 'portal.document_acceptance', 'INSERT') AS t,
              has_table_privilege('portal_owner', 'portal.document_version', 'INSERT') AS o`
    );
    expect(grant!.rows[0]).toEqual({ t: true, o: true });
    // The stored verifiers are byte for byte the ones from before: nothing rotated.
    expect(await logins()).toEqual(before);
    await connectAs(TENANT, TENANT_PW);
  });

  it('is a no-op the second time and writes nothing', async () => {
    await provisionedBeforeDocuments();
    expect((await migrate()).code).toBe(0);
    const verifiers = await logins();
    const state = await stateSnapshot();
    const second = await migrate();
    expect(second.err).toEqual([]);
    expect(second.code).toBe(0);
    expect(second.out).toEqual([
      'pre-check passed: no difference from the manifest',
      'no pending migrations',
      ...NOT_OBSERVED,
      'post-check passed: the server matches the manifest',
      'portal database migrated',
    ]);
    expect(await logins()).toEqual(verifiers);
    expect(await stateSnapshot()).toEqual(state);
  });

  it('refuses, naming the role, when a role is absent, and creates nothing', async () => {
    await provisionedBeforeDocuments();
    await admin('postgres', `ALTER ROLE ${OWNER} RENAME TO portal_prov_renamed`);
    try {
      const result = await migrate();
      expect(result.code).toBe(1);
      expect(result.err).toEqual([
        `provision failed: migrate refused: role ${OWNER} is absent; --migrate-only creates no role, run the full provision first`,
      ]);
      expect(await documentTable()).toBeNull();
    } finally {
      await restoreRenamedOwner();
    }
  });

  it('refuses a server provisioned before the provisioner role existed, creating nothing', async () => {
    await provisionedBeforeDocuments();
    // What a server provisioned before this role existed looks like: the role and
    // its login absent, nothing of theirs granted.
    await admin(PROV_DB, 'REVOKE USAGE ON SCHEMA portal FROM portal_provisioner');
    await admin(
      'postgres',
      `REVOKE CONNECT ON DATABASE ${PROV_DB} FROM ${PROVISIONER}`,
      `DROP ROLE ${PROVISIONER}`,
      'DROP ROLE portal_provisioner'
    );
    const result = await migrate();
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      `provision failed: migrate refused: role portal_provisioner, ${PROVISIONER} is absent; --migrate-only creates no role, run the full provision first`,
    ]);
    const [rows] = await admin(
      'postgres',
      `SELECT count(*)::int AS n FROM pg_roles WHERE rolname IN ('portal_provisioner', '${PROVISIONER}')`
    );
    expect(rows!.rows[0].n).toBe(1);
  });

  it('refuses a server provisioned before the prospect role existed, creating nothing', async () => {
    await provisionedBeforeDocuments();
    // What a server provisioned before the front door existed looks like: the
    // role and its login absent, nothing of theirs granted.
    await admin(PROV_DB, 'REVOKE USAGE ON SCHEMA portal FROM portal_prospect');
    await admin(
      'postgres',
      `REVOKE CONNECT ON DATABASE ${PROV_DB} FROM ${PROSPECT}`,
      `DROP ROLE ${PROSPECT}`,
      'DROP ROLE portal_prospect'
    );
    const result = await migrate();
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      `provision failed: migrate refused: role portal_prospect, ${PROSPECT} is absent; --migrate-only creates no role, run the full provision first`,
    ]);
    const [rows] = await admin(
      'postgres',
      `SELECT count(*)::int AS n FROM pg_roles WHERE rolname IN ('portal_prospect', '${PROSPECT}')`
    );
    expect(rows!.rows[0].n).toBe(0);
  });

  it('adds the demo request table to a server that has the lifecycle, with the front door insert-only', async () => {
    const all = readMigrations();
    const index = all.findIndex((m) => m.tag === '0010_demo_request');
    expect(index).toBeGreaterThan(0);
    const before = await run({ migrations: all.slice(0, index) });
    expect(before.err).toEqual([]);
    expect(before.code).toBe(0);
    const table = "SELECT to_regclass('portal.demo_request') AS t";
    expect((await admin(PROV_DB, table))[0]!.rows[0].t).toBeNull();
    const result = await migrate();
    expect(result.err).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('applied migration 0010_demo_request');
    expect((await admin(PROV_DB, table))[0]!.rows[0].t).toBe('portal.demo_request');
    const [grants] = await admin(
      PROV_DB,
      `SELECT has_table_privilege('portal_prospect', 'portal.demo_request', 'INSERT') AS i,
              has_table_privilege('portal_prospect', 'portal.demo_request', 'SELECT') AS s,
              has_table_privilege('portal_provisioner', 'portal.demo_request', 'SELECT') AS p`
    );
    expect(grants!.rows[0]).toEqual({ i: true, s: false, p: true });
    // Widening the front door's grant is a difference the post-check names.
    await admin(PROV_DB, 'GRANT SELECT ON portal.demo_request TO portal_prospect');
    const widened = await migrate();
    expect(widened.code).toBe(1);
    expect(widened.err.join('\n')).toMatch(
      /extra M06: SELECT on table portal\.demo_request to portal_prospect/
    );
  });

  it('refuses on a bare server: no migrator to connect as, creating neither roles nor the database', async () => {
    const result = await migrate();
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      `provision failed: migrate refused: cannot connect to database ${PROV_DB} as ${MIGRATOR} (28P01); --migrate-only creates no role and no database, run the full provision first`,
    ]);
    expect(result.err.join('\n')).not.toContain(MIGRATOR_PW);
    const [rows] = await admin(
      'postgres',
      `SELECT count(*)::int AS n FROM pg_roles WHERE rolname LIKE 'portal%'`
    );
    expect(rows!.rows[0].n).toBe(0);
  });

  it('refuses, naming the database, when the roles exist and the database does not', async () => {
    await admin(
      'postgres',
      'CREATE ROLE portal_tenant NOLOGIN',
      'CREATE ROLE portal_owner NOLOGIN',
      `CREATE ROLE ${TENANT} LOGIN`,
      `CREATE ROLE ${OWNER} LOGIN`,
      'CREATE ROLE portal_provisioner NOLOGIN',
      `CREATE ROLE ${PROVISIONER} LOGIN`,
      'CREATE ROLE portal_prospect NOLOGIN',
      `CREATE ROLE ${PROSPECT} LOGIN`,
      `CREATE ROLE ${MIGRATOR} LOGIN`
    );
    const result = await migrate();
    expect(result.code).toBe(1);
    // The migrator has no database to log in to: the server refuses it first.
    expect(result.err).toHaveLength(1);
    expect(result.err[0]).toMatch(
      new RegExp(
        `^provision failed: migrate refused: cannot connect to database ${PROV_DB} as ${MIGRATOR} \\(`
      )
    );
    expect(result.err[0]).toContain('--migrate-only creates no role and no database');
  });

  it('refuses a created-empty database, not provisioned, without writing', async () => {
    // The full provision stopped after creating the database: nothing is in it.
    const stopped = await run({ attempt: () => Promise.resolve('ok') });
    expect(stopped.code).toBe(1);
    const verifiers = await logins();
    const result = await migrate();
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      `provision failed: migrate refused: database ${PROV_DB} is created-empty, not provisioned; --migrate-only creates no database, run the full provision first`,
    ]);
    expect(await logins()).toEqual(verifiers);
  });

  it('still refuses a history it did not ship, writing nothing', async () => {
    await provisionedBeforeDocuments();
    await admin(
      PROV_DB,
      "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('f00d', 1)"
    );
    const verifiers = await logins();
    const result = await migrate();
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(/extra M25: migration history row 4 \(f00d\)/);
    expect(await documentTable()).toBeNull();
    expect(await logins()).toEqual(verifiers);
  });

  it('applies the pending migrations in journal order, and a second run is clean', async () => {
    const all = readMigrations();
    expect((await run({ migrations: all.slice(0, 2) })).code).toBe(0);
    const first = await migrate();
    expect(first.err).toEqual([]);
    expect(first.out.filter((line) => line.startsWith('applied'))).toEqual(
      all.slice(2).map((m) => `applied migration ${m.tag}`)
    );
    expect(await history()).toEqual(all.map((m) => m.hash));
    expect((await migrate()).code).toBe(0);
  });

  it('adds the tenant kind to a register that already exists, and checks it in the manifest', async () => {
    const all = readMigrations();
    const kindIndex = all.findIndex((migration) => migration.tag === '0005_tenant_kind');
    expect(kindIndex).toBeGreaterThan(0);
    // A database at the migration before the kind passes the manifest check
    // without the column: the column is expected only once its migration is.
    const before = await run({ migrations: all.slice(0, kindIndex) });
    expect(before.err).toEqual([]);
    expect(before.code).toBe(0);
    const [absent] = await admin(
      PROV_DB,
      `SELECT count(*) AS n FROM information_schema.columns
        WHERE table_schema = 'portal' AND table_name = 'tenant_register' AND column_name = 'kind'`
    );
    expect(absent!.rows[0].n).toBe('0');
    const result = await migrate();
    expect(result.err).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('applied migration 0005_tenant_kind');
    expect(result.out).toContain('post-check passed: the server matches the manifest');
    const [present] = await admin(
      PROV_DB,
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'portal' AND table_name = 'tenant_register' AND column_name = 'kind'`
    );
    expect(present!.rows).toEqual([{ is_nullable: 'NO', column_default: null }]);
    expect((await migrate()).code).toBe(0);
  });

  it('expects the old transition rule at 0006 and the rebuild rule only from 0007', async () => {
    const all = readMigrations();
    const rebuildIndex = all.findIndex((m) => m.tag === '0007_demo_rebuild_extended');
    expect(rebuildIndex).toBeGreaterThan(0);
    // Held back at 0006: the old constraint text is what the manifest expects.
    const held = await run({ migrations: all.slice(0, rebuildIndex) });
    expect(held.err).toEqual([]);
    expect(held.code).toBe(0);
    const [old] = await admin(
      PROV_DB,
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'demo_state_event_transition_allowed'`
    );
    const extendedExits =
      "(from_state = 'EXTENDED'::text) AND (to_state = ANY (ARRAY['EXPIRING'::text, 'PROMOTING'::text, ";
    expect(old!.rows[0].def).toContain(`${extendedExits}'KILLED'::text`);
    expect(old!.rows[0].def).not.toContain(`${extendedExits}'REBUILDING'::text`);
    const result = await migrate();
    expect(result.err).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('applied migration 0007_demo_rebuild_extended');
    expect(result.out).toContain('post-check passed: the server matches the manifest');
    // At 0007 the revised text is expected: the old text left in place is a difference.
    await admin(
      PROV_DB,
      'ALTER TABLE portal.demo_state_event DROP CONSTRAINT demo_state_event_transition_allowed',
      `ALTER TABLE portal.demo_state_event ADD CONSTRAINT demo_state_event_transition_allowed
         CHECK (from_state IS NULL AND sequence = 1 AND to_state = 'VERIFIED')`
    );
    const drifted = await migrate();
    expect(drifted.code).toBe(1);
    expect(drifted.err.join('\n')).toMatch(
      /M21: portal\.demo_state_event constraint demo_state_event_transition_allowed/
    );
  });

  it('adds the tenant name to a register that already exists, unique and a slug', async () => {
    const all = readMigrations();
    const nameIndex = all.findIndex((m) => m.tag === '0008_tenant_name');
    expect(nameIndex).toBeGreaterThan(0);
    const before = await run({ migrations: all.slice(0, nameIndex) });
    expect(before.err).toEqual([]);
    expect(before.code).toBe(0);
    const columns = `SELECT count(*) AS n FROM information_schema.columns
        WHERE table_schema = 'portal' AND table_name = 'tenant_register' AND column_name = 'tenant_name'`;
    expect((await admin(PROV_DB, columns))[0]!.rows[0].n).toBe('0');
    const result = await migrate();
    expect(result.err).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('applied migration 0008_tenant_name');
    expect(result.out).toContain('post-check passed: the server matches the manifest');
    expect((await admin(PROV_DB, columns))[0]!.rows[0].n).toBe('1');
    // Dropping the unique constraint is a difference the post-check names.
    await admin(
      PROV_DB,
      'ALTER TABLE portal.tenant_register DROP CONSTRAINT tenant_register_tenant_name_unique'
    );
    const dropped = await migrate();
    expect(dropped.code).toBe(1);
    expect(dropped.err.join('\n')).toMatch(
      /missing M21: portal\.tenant_register constraint tenant_register_tenant_name_unique/
    );
  });

  it('refuses a kind column the manifest does not describe, and a missing one', async () => {
    expect((await run()).code).toBe(0);
    await admin(
      PROV_DB,
      'ALTER TABLE portal.tenant_register ALTER COLUMN kind SET DEFAULT $$REAL$$'
    );
    const defaulted = await migrate();
    expect(defaulted.code).toBe(1);
    expect(defaulted.err.join('\n')).toMatch(/M21: portal\.tenant_register default kind/);
    await admin(PROV_DB, 'ALTER TABLE portal.tenant_register ALTER COLUMN kind DROP DEFAULT');
    await admin(
      PROV_DB,
      'ALTER TABLE portal.tenant_register DROP CONSTRAINT tenant_register_kind_known'
    );
    const unchecked = await migrate();
    expect(unchecked.code).toBe(1);
    expect(unchecked.err.join('\n')).toMatch(
      /missing M21: portal\.tenant_register constraint tenant_register_kind_known/
    );
  });

  it('refuses before commit a migration whose object the manifest does not grant, writing nothing', async () => {
    const all = readMigrations();
    expect((await run({ migrations: all.slice(0, 3) })).code).toBe(0);
    const before = await history();
    const rogue = {
      ...all[3]!,
      statements: [...all[3]!.statements, 'CREATE TABLE portal.rogue (id integer)'],
    };
    await expect(
      migratePortal(
        {
          ...provConfig(),
          adminUrl: '',
          migratorUrl: migratorUrl(),
          tenantPassword: '',
          ownerPassword: '',
          provisionerPassword: '',
        },
        () => undefined,
        { migrations: [...all.slice(0, 3), rogue] }
      )
    ).rejects.toThrow(/refused/);
    expect(await history()).toEqual(before);
    const [tables] = await admin(
      PROV_DB,
      "SELECT to_regclass('portal.rogue') AS r, to_regclass('portal.document_version') AS d"
    );
    expect(tables!.rows[0]).toEqual({ r: null, d: null });
  });

  it('runs as the compiled command and sets no password', async () => {
    const dist = join(import.meta.dirname, '../dist/provision/provisionMain.js');
    if (!existsSync(dist))
      throw new Error('run `pnpm run build` first: the compiled command is missing');
    await provisionedBeforeDocuments();
    const before = await logins();
    const dir = mkdtempSync(join(tmpdir(), 'portal-migrate-'));
    try {
      const file = join(dir, 'migrator-url');
      writeFileSync(file, migratorUrl());
      const result = spawnSync(process.execPath, [dist, '--migrate-only'], {
        env: {
          PATH: process.env['PATH'] ?? '',
          PORTAL_MIGRATOR_URL_FILE: file,
          PORTAL_DATABASE_NAME: PROV_DB,
          PORTAL_TENANT_LOGIN: TENANT,
          PORTAL_OWNER_LOGIN: OWNER,
          PORTAL_PROVISIONER_LOGIN: PROVISIONER,
          PORTAL_PROSPECT_LOGIN: PROSPECT,
          PORTAL_MIGRATOR_LOGIN: MIGRATOR,
        },
        encoding: 'utf8',
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('applied migration 0003_versioned_documents');
      expect(result.stdout).toContain('portal database migrated');
    } finally {
      rmSync(dir, { recursive: true });
    }
    expect(await logins()).toEqual(before);
  });
});

// The migrator is the login the routine path runs as, so everything that would
// make it more than a database owner must turn the command away: each case
// below changes the server and expects both the full provision and
// `--migrate-only` to refuse, writing nothing.
describe('the migrator login is held to the manifest', () => {
  if (ADMIN_URL === undefined) return;

  beforeEach(async () => {
    await resetServer();
    opened.length = 0;
  }, 60000);

  afterAll(async () => {
    await resetServer();
  }, 60000);

  /** A provisioned server one migration batch behind, so a refusal has something it did not write. */
  async function provisioned(): Promise<void> {
    const older = await run({ migrations: readMigrations().slice(0, 3) });
    expect(older.err).toEqual([]);
    expect(older.code).toBe(0);
  }

  /** Both paths refuse with `pattern`, and neither writes a migration or a verifier. */
  async function bothRefuse(pattern: RegExp): Promise<void> {
    const verifiers = await logins();
    const before = await history();
    const routine = await migrate();
    expect(routine.code).toBe(1);
    expect(routine.err.join('\n')).toMatch(pattern);
    const full = await run();
    expect(full.code).toBe(1);
    expect(full.err.join('\n')).toMatch(pattern);
    expect(full.err.at(-1)).toContain('nothing was changed');
    expect(await history()).toEqual(before);
    expect(await logins()).toEqual(verifiers);
  }

  it('applies pending migrations as a non-superuser that owns what it makes, opening no administrator file', async () => {
    await provisioned();
    const before = await logins();
    const result = await migrate();
    expect(result.err).toEqual([]);
    expect(result.code).toBe(0);
    expect(opened).toEqual(['migrator-url']);
    const [owner] = await admin(
      PROV_DB,
      `SELECT pg_get_userbyid(relowner) AS o FROM pg_class
        WHERE oid = to_regclass('portal.document_version')`
    );
    expect(owner!.rows[0].o).toBe(MIGRATOR);
    expect(await logins()).toEqual(before);
  });

  it('is judged from the migrator vantage, and names what it cannot see', async () => {
    await provisioned();
    const major = await serverMajor();
    const checkpoint = checkpointFor(
      major,
      PROV_DB,
      principalNames(TENANT, OWNER, PROVISIONER, PROSPECT, MIGRATOR),
      readMigrations()
        .slice(0, 3)
        .map((m) => m.tag)
    );
    const inspect = async (user?: string, password?: string) => {
      const pool = testPool(PROV_DB, user, password, 1);
      const client = await pool.connect();
      try {
        await client.query('SET search_path = pg_catalog');
        return await inspectManifest(client, checkpoint, true);
      } finally {
        client.release();
        await pool.end();
      }
    };
    const asMigrator = await inspect(MIGRATOR, MIGRATOR_PW);
    expect(asMigrator.vantage).toBe('migrator');
    expect(asMigrator.differences).toEqual([]);
    expect(asMigrator.unobserved.map((u) => u.mechanism)).toEqual(['M01', 'M27', 'M28']);
    const asAdministrator = await inspect();
    expect(asAdministrator.vantage).toBe('superuser');
    expect(asAdministrator.differences).toEqual([]);
    expect(asAdministrator.unobserved).toEqual([]);
  });

  it('refuses a migrator that has become a superuser, and a connection that is one', async () => {
    await provisioned();
    await admin('postgres', `ALTER ROLE ${MIGRATOR} SUPERUSER`);
    try {
      await bothRefuse(new RegExp(`extra M01: role ${MIGRATOR}: superuser=true`));
      const routine = await migrate();
      expect(routine.err.join('\n')).toContain(
        `extra M01: connected as ${MIGRATOR}, which is a superuser`
      );
    } finally {
      await admin('postgres', `ALTER ROLE ${MIGRATOR} NOSUPERUSER`);
    }
  });

  it('refuses a migrator that has become able to bypass row-level policies', async () => {
    await provisioned();
    await admin('postgres', `ALTER ROLE ${MIGRATOR} BYPASSRLS`);
    try {
      await bothRefuse(new RegExp(`extra M01: role ${MIGRATOR}: .* bypassrls=true`));
    } finally {
      await admin('postgres', `ALTER ROLE ${MIGRATOR} NOBYPASSRLS`);
    }
  });

  it.each([
    ['CREATEROLE', 'createrole=true'],
    ['CREATEDB', 'createdb=true'],
    ['REPLICATION', 'replication=true'],
  ])('refuses a migrator given %s', async (attribute, shown) => {
    await provisioned();
    await admin('postgres', `ALTER ROLE ${MIGRATOR} ${attribute}`);
    try {
      await bothRefuse(new RegExp(`extra M01: role ${MIGRATOR}: .*${shown}`));
    } finally {
      await admin('postgres', `ALTER ROLE ${MIGRATOR} NO${attribute}`);
    }
  });

  it('refuses a migrator that is a member of a portal role', async () => {
    await provisioned();
    await admin('postgres', `GRANT portal_owner TO ${MIGRATOR}`);
    try {
      await bothRefuse(new RegExp(`extra M02: ${MIGRATOR} is a member of portal_owner`));
    } finally {
      await admin('postgres', `REVOKE portal_owner FROM ${MIGRATOR}`);
    }
  });

  it('refuses a migrator that owns another database', async () => {
    await provisioned();
    await admin(
      'postgres',
      `CREATE DATABASE ${OTHER_DB}`,
      `ALTER DATABASE ${OTHER_DB} OWNER TO ${MIGRATOR}`
    );
    await bothRefuse(new RegExp(`extra M18: ${MIGRATOR} owns database ${OTHER_DB}`));
  });

  it('refuses a migrator that owns an object the manifest does not name', async () => {
    await provisioned();
    await admin(
      PROV_DB,
      'CREATE TABLE public.stray (id integer)',
      `ALTER TABLE public.stray OWNER TO ${MIGRATOR}`
    );
    await bothRefuse(new RegExp(`extra M18: ${MIGRATOR} owns table public.stray`));
  });

  it('refuses a pg_hba rule that admits the migrator to another database, by reading it and by trying it', async () => {
    await provisioned();
    await admin('postgres', `CREATE DATABASE ${OTHER_DB}`);
    const verifiers = await logins();
    const rule = (original: string): string =>
      original.replace(
        'local all all reject',
        `host ${OTHER_DB} ${MIGRATOR} all scram-sha-256\nlocal all all reject`
      );
    await withHba(rule, true, async () => {
      // The routine path cannot read the rules; it logs in to every other
      // database as itself and requires the refusal.
      const routine = await migrate();
      expect(routine.code).toBe(1);
      expect(routine.err.join('\n')).toContain(
        `extra M28: login ${MIGRATOR} was not refused by pg_hba at database ${OTHER_DB} (got ok)`
      );
      // The full provision reads the loaded rules as the administrator.
      const full = await run();
      expect(full.code).toBe(1);
      expect(full.err.join('\n')).toMatch(
        new RegExp(
          `extra M28: pg_hba rule at .* lets ${MIGRATOR} \\(as ${MIGRATOR}\\) reach database ${OTHER_DB} by scram-sha-256`
        )
      );
      expect(full.err.at(-1)).toContain('nothing was changed');
    });
    expect(await logins()).toEqual(verifiers);
    expect((await migrate()).code).toBe(0);
  });

  // The routine path has no password for these logins, so it probes with a wrong
  // one: an admitting rule reaches the check and fails it (28P01), a refusal does not.
  it.each([TENANT, OWNER, PROVISIONER, PROSPECT])(
    'refuses, from the routine path, a pg_hba rule that admits %s to another database',
    async (login) => {
      await provisioned();
      await admin('postgres', `CREATE DATABASE ${OTHER_DB}`);
      const verifiers = await logins();
      const rule = (original: string): string =>
        original.replace(
          'local all all reject',
          `host ${OTHER_DB} ${login} all scram-sha-256\nlocal all all reject`
        );
      await withHba(rule, true, async () => {
        const routine = await migrate();
        expect(routine.code).toBe(1);
        expect(routine.err.join('\n')).toContain(
          `extra M28: login ${login} was not refused by pg_hba at database ${OTHER_DB} (got 28P01)`
        );
      });
      expect(await logins()).toEqual(verifiers);
      expect((await migrate()).code).toBe(0);
    }
  );
});
