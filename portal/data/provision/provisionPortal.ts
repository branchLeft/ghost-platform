import { readFileSync } from 'node:fs';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { bind, connect, enterRole, type Tx } from '../src/db.js';
import { migrateSchema } from '../src/migrate.js';
import {
  createDatabaseIfAbsent,
  createLogin,
  createRoles,
  ident,
  lockDatabase,
  lockPublicSchema,
  grantAccess,
  grantRole,
  assertOnlyRole,
  revokeOtherRoles,
  type TableAccess,
} from './provision.js';
import { scramVerifier } from './scram.js';
import { healthReading, tenantRegister } from '../src/schema.js';

export interface ProvisionConfig {
  /** An administrator connection to a maintenance database, e.g. `postgres`. */
  adminUrl: string;
  database: string;
  tenantLogin: string;
  tenantPassword: string;
  ownerLogin: string;
  ownerPassword: string;
}

export const DEFAULT_DATABASE = 'portal';
export const DEFAULT_TENANT_LOGIN = 'portal_tenant_login';
export const DEFAULT_OWNER_LOGIN = 'portal_owner_login';

/** The portal's tables and what each role may do to them. */
export const PORTAL_TABLES: readonly TableAccess[] = [
  {
    schema: 'portal',
    table: 'tenant_register',
    tenant: 'SELECT',
    owner: 'SELECT, INSERT, UPDATE, DELETE',
  },
  {
    schema: 'portal',
    table: 'health_reading',
    tenant: 'SELECT',
    owner: 'SELECT, INSERT, UPDATE, DELETE',
  },
];

type Env = Record<string, string | undefined>;
type Read = (path: string) => string;

function secretFile(env: Env, name: string, read: Read): string {
  const path = env[name];
  if (path === undefined || path === '') {
    throw new Error(
      `${name} must name a file holding the value; it is never read from argv or the environment itself`
    );
  }
  let text: string;
  try {
    text = read(path);
  } catch {
    throw new Error(`${name}: cannot read the file at ${path}`);
  }
  const value = text.replace(/\r?\n$/, '');
  if (value === '') throw new Error(`${name}: the file at ${path} is empty`);
  return value;
}

/**
 * Reads the administrator connection and both login passwords from files named
 * by the environment. The environment holds paths only; a secret passed as an
 * argument or a variable is refused, because both are visible in `ps` and in
 * the container's inspect output.
 */
export function loadConfig(
  env: Env,
  argv: readonly string[],
  read: Read = (path) => readFileSync(path, 'utf8')
): ProvisionConfig {
  if (argv.length > 0) {
    throw new Error('takes no arguments: every input is a file named by an environment variable');
  }
  for (const name of ['PORTAL_ADMIN_URL', 'PORTAL_TENANT_PASSWORD', 'PORTAL_OWNER_PASSWORD']) {
    if (env[name] !== undefined) {
      throw new Error(`${name} is not read: use ${name}_FILE, a path to a file`);
    }
  }
  const adminUrl = secretFile(env, 'PORTAL_ADMIN_URL_FILE', read);
  try {
    new URL(adminUrl);
  } catch {
    throw new Error('PORTAL_ADMIN_URL_FILE: the file does not hold a connection URL');
  }
  const names = {
    PORTAL_DATABASE_NAME: env['PORTAL_DATABASE_NAME'] ?? DEFAULT_DATABASE,
    PORTAL_TENANT_LOGIN: env['PORTAL_TENANT_LOGIN'] ?? DEFAULT_TENANT_LOGIN,
    PORTAL_OWNER_LOGIN: env['PORTAL_OWNER_LOGIN'] ?? DEFAULT_OWNER_LOGIN,
  };
  for (const [name, value] of Object.entries(names)) {
    try {
      ident(value);
    } catch {
      throw new Error(`${name} must be a plain lower-case identifier`);
    }
  }
  if (names.PORTAL_TENANT_LOGIN === names.PORTAL_OWNER_LOGIN) {
    throw new Error('the tenant and owner logins must differ');
  }
  const tenantPassword = secretFile(env, 'PORTAL_TENANT_PASSWORD_FILE', read);
  const ownerPassword = secretFile(env, 'PORTAL_OWNER_PASSWORD_FILE', read);
  for (const password of [tenantPassword, ownerPassword]) scramVerifier(password);
  return {
    adminUrl,
    database: names.PORTAL_DATABASE_NAME,
    tenantLogin: names.PORTAL_TENANT_LOGIN,
    tenantPassword,
    ownerLogin: names.PORTAL_OWNER_LOGIN,
    ownerPassword,
  };
}

/** A password as `URL` writes it into the userinfo of a connection string. */
function urlUserinfo(value: string): string {
  const url = new URL('postgres://user@host/');
  url.password = value;
  return url.password;
}

/** Removes every secret in `config`, in raw and URL-encoded form, from a message. */
export function redact(message: string, config: Partial<ProvisionConfig>): string {
  const secrets = new Set<string>();
  for (const value of [config.adminUrl, config.tenantPassword, config.ownerPassword]) {
    if (value !== undefined && value !== '') {
      secrets.add(value);
      for (const form of [encodeURIComponent(value), urlUserinfo(value), escape(value)]) {
        secrets.add(form);
        secrets.add(form.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()));
      }
    }
  }
  if (config.adminUrl !== undefined) {
    try {
      const url = new URL(config.adminUrl);
      for (const part of [url.password, decodeURIComponent(url.password)]) {
        if (part !== '') secrets.add(part);
      }
    } catch {
      // not a URL; the whole value is already covered above
    }
  }
  let out = message;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

function urlFor(config: ProvisionConfig, database: string, login?: string): string {
  const url = new URL(config.adminUrl);
  url.pathname = `/${database}`;
  if (login !== undefined) {
    url.username = login;
    url.password = '';
  }
  return url.toString();
}

/**
 * A pool built from parsed fields, never from a connection string, with the
 * password as a function. The driver lets a parsed connection string overwrite
 * a password option and, left with no password, reads PGPASSWORD or the user's
 * `.pgpass`; a password function that returns a string, even an empty one, is
 * the one form it does not override. Host, user, database and port are explicit
 * too, so no PG* variable can supply them.
 */
export function poolFor(url: string, rawPassword?: string): pg.Pool {
  const parsed = new URL(url);
  if (parsed.hostname === '' || parsed.username === '') {
    throw new Error('a connection URL must name its host and user');
  }
  const mode = parsed.searchParams.get('sslmode') ?? 'disable';
  if (!['disable', 'require', 'verify-ca', 'verify-full'].includes(mode)) {
    throw new Error(`sslmode ${mode} is not supported`);
  }
  // A login's password arrives raw from its file and never rides in a URL,
  // where `%` would be decoded. Only the administrator URL carries one, and a
  // URL's own encoding is the right reading of that.
  const password = rawPassword ?? decodeURIComponent(parsed.password);
  const pool = new pg.Pool({
    host: parsed.hostname.replace(/^\[|\]$/g, ''),
    port: parsed.port === '' ? 5432 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    password: () => Promise.resolve(password),
    ssl: mode === 'disable' ? false : true,
    max: 1,
  });
  pool.on('error', () => undefined);
  return pool;
}

async function withPool<T>(
  url: string,
  work: (pool: pg.Pool) => Promise<T>,
  rawPassword?: string
): Promise<T> {
  const pool = poolFor(url, rawPassword);
  try {
    return await work(pool);
  } finally {
    await pool.end();
  }
}

/** The SQLSTATE of a driver error, looking through the ORM's wrapper. */
export function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** What the work did: `ok`, or the SQLSTATE of the error that stopped it. */
async function outcome(pool: pg.Pool, work: (tx: Tx) => Promise<unknown>): Promise<string> {
  try {
    await connect(pool).transaction(async (tx) => {
      await work(tx);
    });
    return 'ok';
  } catch (error) {
    return (
      sqlState(error) ??
      `error without a SQLSTATE: ${error instanceof Error ? error.name : 'unknown'}`
    );
  }
}

const PERMISSION_DENIED = '42501';
const NO_TENANT_BOUND = '28000';
const PROBE_TENANT = '00000000-0000-4000-8000-000000000000';

async function expectOutcome(
  pool: pg.Pool,
  label: string,
  expected: string,
  work: (tx: Tx) => Promise<unknown>
): Promise<void> {
  const got = await outcome(pool, work);
  if (got !== expected) throw new Error(`${label}: expected ${expected}, got ${got}`);
}

/**
 * Connects as each login and proves the boundary the data layer's guarantee
 * rests on: the tenant login can reach the tenant role and not the owner
 * role, the owner login the reverse, and a tenant-role read with no tenant
 * bound fails instead of returning rows.
 */
export async function verifyBoundary(config: ProvisionConfig): Promise<void> {
  await withPool(
    urlFor(config, config.database, config.tenantLogin),
    async (pool) => {
      const asTenant = async (tx: Tx): Promise<void> => enterRole(tx, 'portal_tenant');
      await expectOutcome(pool, 'tenant login assumes portal_tenant', 'ok', asTenant);
      await expectOutcome(pool, 'tenant login assumes portal_owner', PERMISSION_DENIED, (tx) =>
        enterRole(tx, 'portal_owner')
      );
      await expectOutcome(pool, 'tenant login creates in public', PERMISSION_DENIED, (tx) =>
        tx.execute(sql`CREATE TABLE public.portal_provision_probe (id integer)`)
      );
      await expectOutcome(pool, 'tenant read with no tenant bound', NO_TENANT_BOUND, async (tx) => {
        await asTenant(tx);
        return tx.select().from(tenantRegister);
      });
      await expectOutcome(pool, 'tenant read with a tenant bound', 'ok', async (tx) => {
        await asTenant(tx);
        await bind(tx, 'portal.tenant_id', PROBE_TENANT);
        await tx.select().from(tenantRegister);
        await tx.select().from(healthReading);
      });
    },
    config.tenantPassword
  );
  await withPool(
    urlFor(config, config.database, config.ownerLogin),
    async (pool) => {
      await expectOutcome(pool, 'owner login assumes portal_owner', 'ok', async (tx) => {
        await enterRole(tx, 'portal_owner');
        await tx.select().from(tenantRegister);
        await tx.select().from(healthReading);
      });
      await expectOutcome(pool, 'owner login assumes portal_tenant', PERMISSION_DENIED, (tx) =>
        enterRole(tx, 'portal_tenant')
      );
    },
    config.ownerPassword
  );
}

/**
 * Creates or migrates the portal database, in the data layer README's order:
 * the database, the two logins, the two roles, the ORM's migrations, the
 * per-table grants, one role per login, then the boundary check. Every step
 * converges on the same end state, so a second run changes nothing.
 */
export async function provisionPortal(
  config: ProvisionConfig,
  log: (line: string) => void = () => undefined,
  steps: { revokeOtherRoles?: typeof revokeOtherRoles } = {}
): Promise<void> {
  const revoke = steps.revokeOtherRoles ?? revokeOtherRoles;
  await withPool(urlFor(config, 'postgres'), async (bootstrap) => {
    const created = await createDatabaseIfAbsent(bootstrap, config.database);
    log(created ? `created database ${config.database}` : `database ${config.database} exists`);
    await createLogin(bootstrap, config.tenantLogin, config.tenantPassword);
    await createLogin(bootstrap, config.ownerLogin, config.ownerPassword);
    await lockDatabase(bootstrap, config.database, [config.tenantLogin, config.ownerLogin]);
    log('logins ready, database closed to everyone else');
  });
  await withPool(urlFor(config, config.database), async (admin) => {
    await lockPublicSchema(admin);
    await createRoles(admin);
    log('roles ready');
    await migrateSchema(admin);
    log('schema migrated');
    for (const access of PORTAL_TABLES) await grantAccess(admin, access);
    await revoke(admin, config.tenantLogin, 'portal_tenant');
    await revoke(admin, config.ownerLogin, 'portal_owner');
    await grantRole(admin, 'portal_tenant', config.tenantLogin);
    await grantRole(admin, 'portal_owner', config.ownerLogin);
    await assertOnlyRole(admin, config.tenantLogin, 'portal_tenant');
    await assertOnlyRole(admin, config.ownerLogin, 'portal_owner');
    log('grants applied');
  });
  await verifyBoundary(config);
  log('boundary verified');
}

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

/**
 * The command's whole behaviour, returning its exit code. Every line it prints
 * passes through `redact`, so a driver error that quotes a connection string
 * cannot carry a secret into a log.
 */
export async function runProvision(
  env: Env,
  argv: readonly string[],
  io: Io,
  read?: Read
): Promise<number> {
  let config: ProvisionConfig | undefined;
  try {
    config = loadConfig(env, argv, read);
    const loaded = config;
    await provisionPortal(loaded, (line) => io.out(redact(line, loaded)));
    io.out('portal database provisioned');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`provision failed: ${redact(message, config ?? {})}`);
    return 1;
  }
}
