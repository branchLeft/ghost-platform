import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readMigrations } from '../provision/migrations.js';
import {
  connectionOptions,
  loadConfig,
  migratePortal,
  runProvision,
} from '../provision/provisionPortal.js';
import { testUrl } from './helpers.js';
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
  type Run,
} from './provisionSetup.js';

// `--migrate-only`: pending migrations with their grants and the manifest
// check, and nothing else. No role is created, no password is set, and no
// password file is read.

const ADMIN_URL = process.env['PORTAL_TEST_DATABASE_URL'];
const ENV = {
  PORTAL_ADMIN_URL_FILE: 'admin',
  PORTAL_DATABASE_NAME: PROV_DB,
  PORTAL_TENANT_LOGIN: TENANT,
  PORTAL_OWNER_LOGIN: OWNER,
};

/** The flag run with the administrator URL file alone: any other file read throws. */
async function migrate(argv: readonly string[] = ['--migrate-only']): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runProvision(
    ENV,
    argv,
    { out: (line) => out.push(line), err: (line) => err.push(line) },
    (path) => {
      if (path !== 'admin') throw new Error(`read a file it should not: ${path}`);
      return testUrl('postgres');
    }
  );
  return { code, out, err };
}

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
  it('reads the administrator URL and no password file', () => {
    const read = (path: string): string => {
      if (path !== 'admin') throw new Error(`read ${path}`);
      return 'postgres://postgres@db:5432/postgres';
    };
    const config = loadConfig(ENV, [], read, false);
    expect(config.tenantPassword).toBe('');
    expect(config.ownerPassword).toBe('');
    expect(() => loadConfig(ENV, [], read)).toThrow(/PORTAL_TENANT_PASSWORD_FILE/);
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
    expect(before).toHaveLength(4);
    const result = await migrate();
    expect(result.err).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      'pre-check passed: no difference from the manifest',
      'applied migration 0003_versioned_documents',
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

  it('refuses on a bare server: roles first, creating neither them nor the database', async () => {
    const result = await migrate();
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(
      /migrate refused: role portal_tenant, portal_owner, .* is absent/
    );
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
      `CREATE ROLE ${OWNER} LOGIN`
    );
    const result = await migrate();
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      `provision failed: migrate refused: database ${PROV_DB} is absent, not provisioned; --migrate-only creates no database, run the full provision first`,
    ]);
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

  it('applies two pending migrations in journal order, and a second run is clean', async () => {
    const all = readMigrations();
    expect((await run({ migrations: all.slice(0, 2) })).code).toBe(0);
    const first = await migrate();
    expect(first.err).toEqual([]);
    expect(first.out.filter((line) => line.startsWith('applied'))).toEqual([
      `applied migration ${all[2]!.tag}`,
      `applied migration ${all[3]!.tag}`,
    ]);
    expect(await history()).toEqual(all.map((m) => m.hash));
    expect((await migrate()).code).toBe(0);
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
      migratePortal({ ...provConfig(), tenantPassword: '', ownerPassword: '' }, () => undefined, {
        migrations: [...all.slice(0, 3), rogue],
      })
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
      throw new Error('run `npm run build` first: the compiled command is missing');
    await provisionedBeforeDocuments();
    const before = await logins();
    const dir = mkdtempSync(join(tmpdir(), 'portal-migrate-'));
    try {
      const file = join(dir, 'admin-url');
      writeFileSync(file, testUrl('postgres'));
      const result = spawnSync(process.execPath, [dist, '--migrate-only'], {
        env: {
          PATH: process.env['PATH'] ?? '',
          PORTAL_ADMIN_URL_FILE: file,
          PORTAL_DATABASE_NAME: PROV_DB,
          PORTAL_TENANT_LOGIN: TENANT,
          PORTAL_OWNER_LOGIN: OWNER,
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
