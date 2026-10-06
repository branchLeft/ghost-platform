import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PORTAL_TABLES,
  loadConfig,
  poolFor,
  provisionPortal,
  redact,
  runProvision,
  sqlState,
  verifyBoundary,
  type ProvisionConfig,
} from '../src/provisionPortal.js';
import { createLogin, dropDatabase, grantRole, lockDatabase } from '../src/provision.js';
import { scramVerifier } from '../src/scram.js';
import {
  createInPublic,
  loginAttributes,
  provisionedState,
  storedVerifier,
} from '../provision/inspect.js';

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

describe('login passwords never reach the SQL text', () => {
  const nasty = "pa$$word'; DROP ROLE x; --";

  it('sends a verifier, not the password, in every statement', async () => {
    const seen: string[] = [];
    const fake = { query: (text: string) => Promise.resolve(void seen.push(text)) } as never;
    await createLogin(fake, 'a_login', nasty);
    expect(seen.length).toBe(2);
    for (const text of seen) {
      expect(text).not.toContain(nasty);
      expect(text).not.toContain('pa$$word');
      expect(text).toContain("PASSWORD 'SCRAM-SHA-256$4096:");
    }
  });

  it('refuses a password the server would normalise differently', () => {
    expect(() => scramVerifier('caf\u00e9')).toThrow('printable ASCII');
    expect(() => scramVerifier('')).toThrow('printable ASCII');
  });

  it('produces a different salt each time and the documented shape', () => {
    const a = scramVerifier('x');
    expect(a).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(scramVerifier('x')).not.toBe(a);
  });
});

describe('the connection never takes a password from outside its files', () => {
  it('gives the driver an explicit password function when the URL has none', async () => {
    const pool = poolFor('postgres://someone@127.0.0.1:1/db');
    const option = (pool as unknown as { options: { password: unknown } }).options.password;
    await pool.end();
    expect(typeof option).toBe('function');
    expect(await (option as () => Promise<string>)()).toBe('');
  });

  it('decodes the password the URL carries', async () => {
    const pool = poolFor(`postgres://someone:p%40ss@127.0.0.1:1/db`);
    const option = (pool as unknown as { options: { password: unknown } }).options.password;
    await pool.end();
    expect(typeof option === 'function' ? await (option as () => Promise<string>)() : option).toBe(
      'p@ss'
    );
  });

  it('refuses a URL that leaves the host or user to the environment', () => {
    expect(() => poolFor('postgres://127.0.0.1:1/db')).toThrow('must name its host and user');
    expect(() => poolFor('postgres://:pw@127.0.0.1/db')).toThrow('must name its host and user');
  });
});

describe('sqlState', () => {
  it('reads the code through the ORM wrapper and ignores anything else', () => {
    expect(sqlState({ code: '42501' })).toBe('42501');
    expect(sqlState({ message: 'wrapped', cause: { code: '28000' } })).toBe('28000');
    expect(sqlState({ code: 'ECONNREFUSED' })).toBeUndefined();
    expect(sqlState('text')).toBeUndefined();
    expect(sqlState(null)).toBeUndefined();
  });
});

describe('loadConfig names', () => {
  it.each([
    ['PORTAL_DATABASE_NAME', 'a"b'],
    ['PORTAL_TENANT_LOGIN', 'Upper'],
    ['PORTAL_OWNER_LOGIN', 'x; drop'],
  ])('refuses %s=%s before anything touches a server', (name, value) => {
    const { dir, env } = files(GOOD);
    expect(() => loadConfig({ ...env, [name]: value }, [])).toThrow(
      `${name} must be a plain lower-case identifier`
    );
    rmSync(dir, { recursive: true });
  });

  it('refuses one login for both roles', () => {
    const { dir, env } = files(GOOD);
    expect(() =>
      loadConfig({ ...env, PORTAL_TENANT_LOGIN: 'same', PORTAL_OWNER_LOGIN: 'same' }, [])
    ).toThrow('must differ');
    rmSync(dir, { recursive: true });
  });

  it('refuses a password the verifier cannot carry', () => {
    const { dir, env } = files({ ...GOOD, PORTAL_TENANT_PASSWORD_FILE: 'caf\u00e9' });
    expect(() => loadConfig(env, [])).toThrow('printable ASCII');
    rmSync(dir, { recursive: true });
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

  async function withLogin<T>(login: string, password: string, work: (p: pg.Pool) => Promise<T>) {
    const url = new URL(dbUrl());
    url.username = login;
    url.password = password;
    const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
    pool.on('error', () => undefined);
    try {
      return await work(pool);
    } finally {
      await pool.end();
    }
  }

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

  async function state(): Promise<unknown> {
    return withAdmin((pool) =>
      provisionedState(pool, database, [config.tenantLogin, config.ownerLogin])
    );
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
    const acceptsAnyPassword = await probe.connect().then(
      (client) => {
        client.release();
        return true;
      },
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
    await expect(verifyBoundary(config)).rejects.toThrow(
      'tenant login assumes portal_owner: expected 42501, got ok'
    );
    await provisionPortal(config);
  });

  it('the boundary check refuses an owner login that holds the tenant role', async () => {
    await withAdmin((pool) => grantRole(pool, 'portal_tenant', config.ownerLogin));
    await expect(verifyBoundary(config)).rejects.toThrow(
      'owner login assumes portal_tenant: expected 42501, got ok'
    );
    await provisionPortal(config);
  });

  it('the boundary check refuses a tenant login with no role at all', async () => {
    await withAdmin((pool) => pool.query(`REVOKE portal_tenant FROM "${config.tenantLogin}"`));
    await expect(verifyBoundary(config)).rejects.toThrow(
      'tenant login assumes portal_tenant: expected ok, got 42501'
    );
    await provisionPortal(config);
  });

  it('the boundary check refuses an owner login with no role at all', async () => {
    await withAdmin((pool) => pool.query(`REVOKE portal_owner FROM "${config.ownerLogin}"`));
    await expect(verifyBoundary(config)).rejects.toThrow(
      'owner login assumes portal_owner: expected ok, got 42501'
    );
    await provisionPortal(config);
  });

  it('the boundary proof fails on a database whose table grants were deleted', async () => {
    await withAdmin(async (pool) => {
      for (const t of PORTAL_TABLES) {
        await pool.query(
          `REVOKE ALL ON "${t.schema}"."${t.table}" FROM portal_tenant, portal_owner`
        );
      }
    });
    await expect(verifyBoundary(config)).rejects.toThrow(
      'tenant read with a tenant bound: expected ok, got 42501'
    );
    await provisionPortal(config);
    await verifyBoundary(config);
  });

  it('the boundary proof names the SQLSTATE and refuses any other error', async () => {
    await withAdmin((pool) => pool.query('REVOKE USAGE ON SCHEMA portal FROM portal_tenant'));
    await expect(verifyBoundary(config)).rejects.toThrow(
      'tenant read with no tenant bound: expected 28000, got 42501'
    );
    await provisionPortal(config);
    expect(await state()).toEqual(afterFirst);
  });

  it('leaves only the two logins able to connect or create temporary tables', async () => {
    const s = (await state()) as {
      databaseAcl: { login: string; connect: boolean; temp: boolean }[];
    };
    expect(s.databaseAcl.map((a) => [a.connect, a.temp])).toEqual([
      [true, false],
      [true, false],
    ]);
    const stranger = `prov_stranger_${suffix}`;
    await createLogin(bootstrap, stranger, 'stranger-password-1');
    const strangerUrl = new URL(dbUrl());
    strangerUrl.username = stranger;
    strangerUrl.password = 'stranger-password-1';
    const pool = new pg.Pool({ connectionString: strangerUrl.toString(), max: 1 });
    pool.on('error', () => undefined);
    const error = await pool.connect().then(
      (client) => {
        client.release();
        return undefined;
      },
      (e: unknown) => e
    );
    await pool.end();
    await bootstrap.query(`DROP ROLE "${stranger}"`);
    expect((error as Error).message).toMatch(/permission denied for database/);
  });

  it('keeps the tenant login out of schema public', async () => {
    const error = await withLogin(config.tenantLogin, TENANT_PW, (pool) => createInPublic(pool));
    expect(sqlState(error)).toBe('42501');
  });

  it('computes the verifier the server itself would store', async () => {
    const role = `prov_verifier_${suffix}`;
    await bootstrap.query(`SET password_encryption = 'scram-sha-256'`);
    const client = await bootstrap.connect();
    try {
      await client.query(`SET password_encryption = 'scram-sha-256'`);
      await client.query(`CREATE ROLE "${role}" PASSWORD 'reference-password-1'`);
    } finally {
      client.release();
    }
    const stored = await storedVerifier(bootstrap, role);
    await bootstrap.query(`DROP ROLE "${role}"`);
    const salt = Buffer.from(/\$\d+:([^$]+)\$/.exec(stored)?.[1] ?? '', 'base64');
    expect(scramVerifier('reference-password-1', salt)).toBe(stored);
  });

  it('strips superuser, createrole, createdb and replication from an existing login', async () => {
    const login = `prov_priv_${suffix}`;
    await bootstrap.query(`CREATE ROLE "${login}" LOGIN SUPERUSER CREATEROLE CREATEDB REPLICATION`);
    await createLogin(bootstrap, login, 'priv-password-1');
    const flags = await loginAttributes(bootstrap, login);
    await bootstrap.query(`DROP ROLE "${login}"`);
    expect(flags).toEqual([
      {
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolcanlogin: true,
      },
    ]);
  });

  it('lockDatabase is idempotent', async () => {
    await lockDatabase(bootstrap, database, [config.tenantLogin, config.ownerLogin]);
    expect(await state()).toEqual(afterFirst);
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
