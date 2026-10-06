import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PORTAL_TABLES,
  loadConfig,
  provisionPortal,
  redact,
  runProvision,
  verifyBoundary,
  type ProvisionConfig,
} from '../src/provisionPortal.js';
import { dropDatabase, grantRole } from '../src/provision.js';

const ADMIN_URL = process.env['PORTAL_TEST_DATABASE_URL'];
const TENANT_PW = 'tenant-secret-9f2c41';
const OWNER_PW = 'owner-secret-77ab03';
const ADMIN_PW = 'admin-secret-c0ffee';

function files(entries: Record<string, string>): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'portal-provision-'));
  const env: Record<string, string> = {};
  for (const [name, content] of Object.entries(entries)) {
    const path = join(dir, name);
    writeFileSync(path, content);
    env[name] = path;
  }
  return { dir, env };
}

const GOOD = {
  PORTAL_ADMIN_URL_FILE: `postgres://admin:${ADMIN_PW}@db.invalid:5432/postgres\n`,
  PORTAL_TENANT_PASSWORD_FILE: `${TENANT_PW}\n`,
  PORTAL_OWNER_PASSWORD_FILE: `${OWNER_PW}\n`,
};

describe('loadConfig', () => {
  it('reads the connection and both passwords from files, trimming one newline', () => {
    const { dir, env } = files(GOOD);
    const config = loadConfig(env, []);
    rmSync(dir, { recursive: true });
    expect(config.adminUrl).toBe(`postgres://admin:${ADMIN_PW}@db.invalid:5432/postgres`);
    expect(config.tenantPassword).toBe(TENANT_PW);
    expect(config.ownerPassword).toBe(OWNER_PW);
    expect(config.database).toBe('portal');
    expect(config.tenantLogin).toBe('portal_tenant_login');
    expect(config.ownerLogin).toBe('portal_owner_login');
  });

  it('takes the database and login names from the environment when given', () => {
    const { dir, env } = files(GOOD);
    const config = loadConfig(
      { ...env, PORTAL_DATABASE_NAME: 'p2', PORTAL_TENANT_LOGIN: 't2', PORTAL_OWNER_LOGIN: 'o2' },
      []
    );
    rmSync(dir, { recursive: true });
    expect([config.database, config.tenantLogin, config.ownerLogin]).toEqual(['p2', 't2', 'o2']);
  });

  it.each(['PORTAL_ADMIN_URL_FILE', 'PORTAL_TENANT_PASSWORD_FILE', 'PORTAL_OWNER_PASSWORD_FILE'])(
    'refuses with a clear error when %s is missing',
    (name) => {
      const { dir, env } = files(GOOD);
      delete env[name];
      expect(() => loadConfig(env, [])).toThrow(new RegExp(`${name} must name a file`));
      rmSync(dir, { recursive: true });
    }
  );

  it('refuses an unreadable file by naming the path, not any content', () => {
    const { dir, env } = files(GOOD);
    env['PORTAL_TENANT_PASSWORD_FILE'] = join(dir, 'absent');
    expect(() => loadConfig(env, [])).toThrow(
      /PORTAL_TENANT_PASSWORD_FILE: cannot read the file at/
    );
    rmSync(dir, { recursive: true });
  });

  it('refuses an empty file', () => {
    const { dir, env } = files({ ...GOOD, PORTAL_OWNER_PASSWORD_FILE: '\n' });
    expect(() => loadConfig(env, [])).toThrow(/PORTAL_OWNER_PASSWORD_FILE: .* is empty/);
    rmSync(dir, { recursive: true });
  });

  it('refuses a file that is not a connection URL, without quoting it', () => {
    const { dir, env } = files({ ...GOOD, PORTAL_ADMIN_URL_FILE: `not-a-url ${ADMIN_PW}` });
    let message = '';
    try {
      loadConfig(env, []);
    } catch (error) {
      message = (error as Error).message;
    }
    rmSync(dir, { recursive: true });
    expect(message).toMatch(/does not hold a connection URL/);
    expect(message).not.toContain(ADMIN_PW);
  });

  it.each(['PORTAL_ADMIN_URL', 'PORTAL_TENANT_PASSWORD', 'PORTAL_OWNER_PASSWORD'])(
    'refuses a secret placed in %s itself',
    (name) => {
      const { dir, env } = files(GOOD);
      let message = '';
      try {
        loadConfig({ ...env, [name]: 'inline-secret-value' }, []);
      } catch (error) {
        message = (error as Error).message;
      }
      rmSync(dir, { recursive: true });
      expect(message).toContain(`use ${name}_FILE`);
      expect(message).not.toContain('inline-secret-value');
    }
  );

  it('refuses any argument, since argv is visible in the process list', () => {
    const { dir, env } = files(GOOD);
    expect(() => loadConfig(env, ['--password=hunter2'])).toThrow(/takes no arguments/);
    rmSync(dir, { recursive: true });
  });
});

describe('redact', () => {
  const config: Partial<ProvisionConfig> = {
    adminUrl: 'postgres://admin:p%40ss@host:5432/postgres',
    tenantPassword: 'tenant pw/1',
    ownerPassword: OWNER_PW,
  };

  it('removes the URL, its password decoded and encoded, and both login passwords', () => {
    const text = `a ${config.adminUrl} b p%40ss c p@ss d tenant pw/1 e tenant%20pw%2F1 f ${OWNER_PW}`;
    const out = redact(text, config);
    for (const secret of ['p%40ss', 'p@ss', 'tenant pw/1', 'tenant%20pw%2F1', OWNER_PW, 'admin:']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('[redacted]');
  });

  it('leaves text alone when there is nothing to hide', () => {
    expect(redact('plain', {})).toBe('plain');
    expect(redact('plain', { adminUrl: 'not a url' })).toBe('plain');
  });
});

describe('runProvision with no usable input', () => {
  it('exits 1 with a clear error on stderr and nothing on stdout', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runProvision({}, [], { out: (l) => out.push(l), err: (l) => err.push(l) });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('\n')).toMatch(/provision failed: PORTAL_ADMIN_URL_FILE must name a file/);
  });

  it('echoes no secret when the database cannot be reached', async () => {
    const { dir, env } = files({
      ...GOOD,
      PORTAL_ADMIN_URL_FILE: `postgres://admin:${ADMIN_PW}@127.0.0.1:1/postgres`,
    });
    const lines: string[] = [];
    const code = await runProvision(env, [], {
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    });
    rmSync(dir, { recursive: true });
    expect(code).toBe(1);
    const all = lines.join('\n');
    expect(all).toMatch(/provision failed: /);
    for (const secret of [ADMIN_PW, TENANT_PW, OWNER_PW]) expect(all).not.toContain(secret);
  });

  it('redacts a secret that a driver error quotes', async () => {
    const { dir, env } = files(GOOD);
    const err: string[] = [];
    const code = await runProvision(
      env,
      [],
      { out: () => undefined, err: (l) => err.push(l) },
      () => {
        throw new Error(`boom ${ADMIN_PW}`);
      }
    );
    rmSync(dir, { recursive: true });
    expect(code).toBe(1);
    expect(err.join('\n')).not.toContain(ADMIN_PW);
  });
});

describe('against a real PostgreSQL', () => {
  if (ADMIN_URL === undefined) {
    it('needs PORTAL_TEST_DATABASE_URL', () => {
      throw new Error('PORTAL_TEST_DATABASE_URL must name a PostgreSQL superuser connection');
    });
    return;
  }
  const suffix = randomBytes(5).toString('hex');
  const database = `portal_prov_${suffix}`;
  const config: ProvisionConfig = {
    adminUrl: ADMIN_URL,
    database,
    tenantLogin: `prov_tenant_${suffix}`,
    tenantPassword: TENANT_PW,
    ownerLogin: `prov_owner_${suffix}`,
    ownerPassword: OWNER_PW,
  };
  const bootstrap = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
  bootstrap.on('error', () => undefined);

  function dbUrl(): string {
    const url = new URL(ADMIN_URL as string);
    url.pathname = `/${database}`;
    return url.toString();
  }

  function urlWith(login: string, password: string): string {
    const url = new URL(dbUrl());
    url.username = login;
    url.password = password;
    return url.toString();
  }

  async function withAdmin<T>(work: (pool: pg.Pool) => Promise<T>): Promise<T> {
    const pool = new pg.Pool({ connectionString: dbUrl(), max: 1 });
    pool.on('error', () => undefined);
    try {
      return await work(pool);
    } finally {
      await pool.end();
    }
  }

  /** Everything the provisioning converges on, as comparable data. */
  async function state(): Promise<unknown> {
    return withAdmin(async (pool) => {
      const logins = [config.tenantLogin, config.ownerLogin];
      const roles = await pool.query(
        `SELECT rolname, rolcanlogin, rolbypassrls, rolinherit, rolsuper FROM pg_roles
         WHERE rolname = ANY($1) ORDER BY rolname`,
        [['portal_tenant', 'portal_owner', ...logins]]
      );
      const members = await pool.query(
        `SELECT r.rolname AS role, m.rolname AS member FROM pg_auth_members a
         JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
         WHERE m.rolname = ANY($1) ORDER BY 1, 2`,
        [logins]
      );
      const grants = await pool.query(
        `SELECT grantee, table_schema, table_name, privilege_type FROM information_schema.role_table_grants
         WHERE grantee IN ('portal_tenant', 'portal_owner') AND table_schema = 'portal' ORDER BY 1, 2, 3, 4`
      );
      const migrations = await pool.query(
        'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations'
      );
      const tables = await pool.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'portal' ORDER BY 1`
      );
      return {
        roles: roles.rows,
        members: members.rows,
        grants: grants.rows,
        migrations: migrations.rows,
        tables: tables.rows,
      };
    });
  }

  afterAll(async () => {
    await dropDatabase(bootstrap, database).catch(() => undefined);
    for (const login of [config.tenantLogin, config.ownerLogin]) {
      await bootstrap.query(`DROP ROLE IF EXISTS "${login}"`).catch(() => undefined);
    }
    await bootstrap.end();
  });

  const firstLog: string[] = [];
  const secondLog: string[] = [];
  let afterFirst: unknown;

  beforeAll(async () => {
    await provisionPortal(config, (line) => firstLog.push(line));
    afterFirst = await state();
  });

  it('creates the database, the schema, two logins in one role each, and the grants', () => {
    expect(firstLog[0]).toBe(`created database ${database}`);
    const s = afterFirst as {
      members: { role: string; member: string }[];
      tables: { tablename: string }[];
      grants: { grantee: string; table_name: string; privilege_type: string }[];
    };
    expect(s.members).toEqual([
      { role: 'portal_owner', member: config.ownerLogin },
      { role: 'portal_tenant', member: config.tenantLogin },
    ]);
    expect(s.tables.map((t) => t.tablename)).toEqual(
      expect.arrayContaining(PORTAL_TABLES.map((t) => t.table))
    );
    const tenantGrants = s.grants.filter((g) => g.grantee === 'portal_tenant');
    expect(tenantGrants.every((g) => g.privilege_type === 'SELECT')).toBe(true);
    expect(
      s.grants.some((g) => g.grantee === 'portal_owner' && g.privilege_type === 'INSERT')
    ).toBe(true);
  });

  it('is idempotent: a second run reports the database as existing and changes nothing', async () => {
    await provisionPortal(config, (line) => secondLog.push(line));
    expect(secondLog[0]).toBe(`database ${database} exists`);
    expect(await state()).toEqual(afterFirst);
  });

  it('prints no secret', () => {
    const all = [...firstLog, ...secondLog].join('\n');
    for (const secret of [TENANT_PW, OWNER_PW, ADMIN_URL]) expect(all).not.toContain(secret);
  });

  it('a rotated password takes effect on a re-run', async (ctx) => {
    const probe = new pg.Pool({
      connectionString: urlWith(config.tenantLogin, 'wrong-password'),
      max: 1,
    });
    probe.on('error', () => undefined);
    const acceptsAnyPassword = await probe.query('SELECT 1').then(
      () => true,
      () => false
    );
    await probe.end();
    if (acceptsAnyPassword) ctx.skip('server does not use password auth; this runs in CI');
    const rotated = { ...config, tenantPassword: 'rotated-secret-1234' };
    await provisionPortal(rotated);
    await verifyBoundary(rotated);
    await expect(verifyBoundary(config)).rejects.toThrow();
    await provisionPortal(config);
    await verifyBoundary(config);
  });

  it('repairs a login that was given the other role', async () => {
    await withAdmin((pool) => grantRole(pool, 'portal_owner', config.tenantLogin));
    await provisionPortal(config);
    expect(await state()).toEqual(afterFirst);
  });

  it('the boundary check refuses a tenant login that holds the owner role', async () => {
    await withAdmin((pool) => grantRole(pool, 'portal_owner', config.tenantLogin));
    await expect(verifyBoundary(config)).rejects.toThrow('tenant login can assume portal_owner');
    await provisionPortal(config);
  });

  it('the boundary check refuses an owner login that holds the tenant role', async () => {
    await withAdmin((pool) => grantRole(pool, 'portal_tenant', config.ownerLogin));
    await expect(verifyBoundary(config)).rejects.toThrow('owner login can assume portal_tenant');
    await provisionPortal(config);
  });

  it('the boundary check refuses a tenant login with no role at all', async () => {
    await withAdmin((pool) => pool.query(`REVOKE portal_tenant FROM "${config.tenantLogin}"`));
    await expect(verifyBoundary(config)).rejects.toThrow(
      'tenant login cannot assume portal_tenant'
    );
    await provisionPortal(config);
  });

  it('the boundary check refuses an owner login with no role at all', async () => {
    await withAdmin((pool) => pool.query(`REVOKE portal_owner FROM "${config.ownerLogin}"`));
    await expect(verifyBoundary(config)).rejects.toThrow('owner login cannot assume portal_owner');
    await provisionPortal(config);
  });

  it('runProvision succeeds end to end from files and prints no secret', async () => {
    const { dir, env } = files({
      PORTAL_ADMIN_URL_FILE: ADMIN_URL,
      PORTAL_TENANT_PASSWORD_FILE: TENANT_PW,
      PORTAL_OWNER_PASSWORD_FILE: OWNER_PW,
    });
    const lines: string[] = [];
    const code = await runProvision(
      {
        ...env,
        PORTAL_DATABASE_NAME: database,
        PORTAL_TENANT_LOGIN: config.tenantLogin,
        PORTAL_OWNER_LOGIN: config.ownerLogin,
      },
      [],
      { out: (l) => lines.push(l), err: (l) => lines.push(l) }
    );
    rmSync(dir, { recursive: true });
    expect(code).toBe(0);
    expect(lines.at(-1)).toBe('portal database provisioned');
    for (const secret of [TENANT_PW, OWNER_PW, ADMIN_URL]) {
      expect(lines.join('\n')).not.toContain(secret);
    }
  });
});
