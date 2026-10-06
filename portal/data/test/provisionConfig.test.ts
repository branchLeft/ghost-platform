import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  ProvisionRefused,
  loadConfig,
  poolFor,
  redact,
  runProvision,
  sqlState,
  type ProvisionConfig,
} from '../provision/provisionPortal.js';
import { createPrincipal, grantStatements, ident, rotatePassword } from '../provision/provision.js';
import { manifest, principalNames } from '../provision/manifest.js';
import { scramVerifier } from '../provision/scram.js';

// The command's inputs, its redaction and its connections, without a server.

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

  it('removes a login password in every URL form, including the one URL writes itself', () => {
    const password = 'a b{c}|d^e$f&g+h,i%j#k';
    const cfg: Partial<ProvisionConfig> = {
      adminUrl: 'postgres://admin:x@host/postgres',
      tenantPassword: password,
      ownerPassword: 'owner|pw ok',
    };
    const url = new URL('postgres://login@host/portal');
    url.password = password;
    const encoded = [url.password, encodeURIComponent(password), escape(password)];
    const lower = encoded.map((e) => e.replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase()));
    const text = [url.toString(), ...encoded, ...lower, password, 'owner%7Cpw%20ok'].join(' ');
    const out = redact(text, cfg);
    for (const secret of [password, 'owner%7Cpw%20ok', ...encoded, ...lower]) {
      expect(out).not.toContain(secret);
    }
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

  it('sends a verifier, not the password, when it creates or rotates a login', async () => {
    const seen: string[] = [];
    const fake = { query: (text: string) => Promise.resolve(void seen.push(text)) } as never;
    const names = principalNames('a_login', 'b_login');
    await createPrincipal(fake, names, 'tenantLogin', nasty);
    await rotatePassword(fake, 'b_login', nasty);
    expect(seen.length).toBe(2);
    for (const text of seen) {
      expect(text).not.toContain(nasty);
      expect(text).not.toContain('pa$$word');
      expect(text).toContain("PASSWORD 'SCRAM-SHA-256$4096:");
    }
    expect(seen[0]).toMatch(/^CREATE ROLE "a_login" LOGIN NOINHERIT NOSUPERUSER .* NOBYPASSRLS /);
  });

  it('creates a role with no password and the owner role alone with BYPASSRLS', async () => {
    const seen: string[] = [];
    const fake = { query: (text: string) => Promise.resolve(void seen.push(text)) } as never;
    const names = principalNames('a_login', 'b_login');
    await createPrincipal(fake, names, 'tenantRole');
    await createPrincipal(fake, names, 'ownerRole');
    expect(seen).toEqual([
      'CREATE ROLE "portal_tenant" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
      'CREATE ROLE "portal_owner" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS',
    ]);
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

  it('keeps its password function when PGPASSWORD and a decoy .pgpass are present', async () => {
    const home = mkdtempSync(join(tmpdir(), 'portal-pgpass-'));
    const decoy = join(home, '.pgpass');
    writeFileSync(decoy, '*:*:*:*:decoy-pgpass-password\n', { mode: 0o600 });
    const saved = { ...process.env };
    process.env['PGPASSWORD'] = 'wrong-env-password';
    process.env['PGPASSFILE'] = decoy;
    process.env['HOME'] = home;
    try {
      const pool = poolFor('postgres://someone@127.0.0.1:1/db');
      const client = new pg.Client(pool.options);
      await pool.end();
      expect(typeof client.password).toBe('function');
      expect(await (client.password as unknown as () => Promise<string>)()).toBe('');
    } finally {
      process.env = saved;
      rmSync(home, { recursive: true });
    }
  });

  it('takes host, user, database and port from the URL alone', () => {
    const saved = { ...process.env };
    process.env['PGHOST'] = 'env-host';
    process.env['PGUSER'] = 'env-user';
    process.env['PGDATABASE'] = 'env-db';
    process.env['PGPORT'] = '9';
    try {
      const pool = poolFor('postgres://u%40x:p@127.0.0.1/some%20db');
      const options = (pool as unknown as { options: Record<string, unknown> }).options;
      void pool.end();
      expect([options['host'], options['user'], options['database'], options['port']]).toEqual([
        '127.0.0.1',
        'u@x',
        'some db',
        5432,
      ]);
    } finally {
      process.env = saved;
    }
  });

  it('refuses an sslmode it does not understand and turns TLS on for the others', async () => {
    expect(() => poolFor('postgres://u@127.0.0.1/db?sslmode=allow')).toThrow('not supported');
    const tls = poolFor('postgres://u@127.0.0.1/db?sslmode=verify-full');
    const plain = poolFor('postgres://u@127.0.0.1/db');
    const ssl = (p: pg.Pool): unknown =>
      (p as unknown as { options: { ssl: unknown } }).options.ssl;
    expect([ssl(tls), ssl(plain)]).toEqual([true, false]);
    await Promise.all([tls.end(), plain.end()]);
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

describe('the statements the command writes', () => {
  const names = principalNames('t_login', 'o_login');

  it('revokes PUBLIC from a new database and grants CONNECT to the two logins', () => {
    const database = manifest(17, 'portal').find((o) => o.kind === 'database')!;
    expect(grantStatements(database, names, 17)).toEqual([
      'REVOKE ALL ON DATABASE "portal" FROM PUBLIC',
      'GRANT CONNECT ON DATABASE "portal" TO "t_login"',
      'GRANT CONNECT ON DATABASE "portal" TO "o_login"',
    ]);
  });

  it('revokes CREATE on schema public before PostgreSQL 15 only', () => {
    const before = manifest(14, 'portal').find((o) => o.identity === 'public')!;
    const after = manifest(17, 'portal').find((o) => o.identity === 'public')!;
    expect(grantStatements(before, names, 14)).toEqual([
      'REVOKE CREATE ON SCHEMA public FROM PUBLIC',
      'GRANT USAGE ON SCHEMA public TO "portal_tenant"',
    ]);
    expect(grantStatements(after, names, 17)).toEqual([
      'GRANT USAGE ON SCHEMA public TO "portal_tenant"',
    ]);
  });

  it("revokes PUBLIC's EXECUTE from a new function", () => {
    const fn = manifest(14, 'portal').find((o) => o.identity === 'public.bound_tenant()')!;
    expect(grantStatements(fn, names, 14)).toEqual([
      'REVOKE ALL ON FUNCTION public.bound_tenant() FROM PUBLIC',
      'GRANT EXECUTE ON FUNCTION public.bound_tenant() TO "portal_tenant"',
    ]);
  });

  it('grants no DELETE anywhere and no UPDATE on the register', () => {
    const all = manifest(14, 'portal').flatMap((o) => grantStatements(o, names, 14));
    expect(all.filter((s) => s.includes('DELETE'))).toEqual([]);
    expect(all.filter((s) => s.includes('UPDATE'))).toEqual([
      'GRANT INSERT, SELECT, UPDATE ON TABLE portal.health_reading TO "portal_owner"',
    ]);
  });

  it('leaves out a grantee the caller excludes, and refuses an identity that is not plain', () => {
    const table = manifest(14, 'portal').find((o) => o.identity === 'portal.tenant_register')!;
    expect(grantStatements(table, names, 14, (p) => p !== 'tenantRole')).toEqual([
      'GRANT INSERT, SELECT ON TABLE portal.tenant_register TO "portal_owner"',
    ]);
    expect(() => grantStatements({ ...table, identity: 'portal.x; DROP' }, names, 14)).toThrow(
      'not a plain manifest identity'
    );
    expect(() => ident('Upper')).toThrow('not a plain identifier');
  });

  it('a refusal names how many differences it found and that nothing changed', () => {
    const error = new ProvisionRefused(['extra M06: a', 'missing M04: b']);
    expect(error.message).toBe('refused: 2 difference(s) from the manifest; nothing was changed');
    expect(error.lines).toEqual(['extra M06: a', 'missing M04: b']);
  });
});
