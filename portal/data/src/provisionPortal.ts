import { readFileSync } from 'node:fs';
import pg from 'pg';
import { connect, enterRole, type Tx } from './db.js';
import { migrateSchema } from './migrate.js';
import {
  createDatabaseIfAbsent,
  createLogin,
  createRoles,
  grantAccess,
  grantRole,
  revokeRole,
  setLoginPassword,
  type TableAccess,
} from './provision.js';
import { tenantRegister } from './schema.js';

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
  return {
    adminUrl,
    database: env['PORTAL_DATABASE_NAME'] ?? DEFAULT_DATABASE,
    tenantLogin: env['PORTAL_TENANT_LOGIN'] ?? DEFAULT_TENANT_LOGIN,
    tenantPassword: secretFile(env, 'PORTAL_TENANT_PASSWORD_FILE', read),
    ownerLogin: env['PORTAL_OWNER_LOGIN'] ?? DEFAULT_OWNER_LOGIN,
    ownerPassword: secretFile(env, 'PORTAL_OWNER_PASSWORD_FILE', read),
  };
}

/** Removes every secret in `config`, in raw and URL-encoded form, from a message. */
export function redact(message: string, config: Partial<ProvisionConfig>): string {
  const secrets = new Set<string>();
  for (const value of [config.adminUrl, config.tenantPassword, config.ownerPassword]) {
    if (value !== undefined && value !== '') {
      secrets.add(value);
      secrets.add(encodeURIComponent(value));
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
    url.password = login === config.tenantLogin ? config.tenantPassword : config.ownerPassword;
  }
  return url.toString();
}

async function withPool<T>(url: string, work: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  pool.on('error', () => undefined);
  try {
    return await work(pool);
  } finally {
    await pool.end();
  }
}

async function refuses(pool: pg.Pool, work: (tx: Tx) => Promise<unknown>): Promise<boolean> {
  try {
    await connect(pool).transaction(async (tx) => {
      await work(tx);
    });
    return false;
  } catch {
    return true;
  }
}

/**
 * Connects as each login and proves the boundary the data layer's guarantee
 * rests on: the tenant login can reach the tenant role and not the owner
 * role, the owner login the reverse, and a tenant-role read with no tenant
 * bound fails instead of returning rows.
 */
export async function verifyBoundary(config: ProvisionConfig): Promise<void> {
  await withPool(urlFor(config, config.database, config.tenantLogin), async (pool) => {
    if (await refuses(pool, (tx) => enterRole(tx, 'portal_tenant'))) {
      throw new Error('tenant login cannot assume portal_tenant');
    }
    if (!(await refuses(pool, (tx) => enterRole(tx, 'portal_owner')))) {
      throw new Error('tenant login can assume portal_owner');
    }
    const unbound = async (tx: Tx): Promise<unknown> => {
      await enterRole(tx, 'portal_tenant');
      return tx.select().from(tenantRegister);
    };
    if (!(await refuses(pool, unbound))) {
      throw new Error('a tenant-role read with no tenant bound did not fail');
    }
  });
  await withPool(urlFor(config, config.database, config.ownerLogin), async (pool) => {
    if (await refuses(pool, (tx) => enterRole(tx, 'portal_owner'))) {
      throw new Error('owner login cannot assume portal_owner');
    }
    if (!(await refuses(pool, (tx) => enterRole(tx, 'portal_tenant')))) {
      throw new Error('owner login can assume portal_tenant');
    }
  });
}

/**
 * Creates or migrates the portal database, in the data layer README's order:
 * the database, the two logins, the two roles, the ORM's migrations, the
 * per-table grants, one role per login, then the boundary check. Every step
 * converges on the same end state, so a second run changes nothing.
 */
export async function provisionPortal(
  config: ProvisionConfig,
  log: (line: string) => void = () => undefined
): Promise<void> {
  await withPool(urlFor(config, 'postgres'), async (bootstrap) => {
    const created = await createDatabaseIfAbsent(bootstrap, config.database);
    log(created ? `created database ${config.database}` : `database ${config.database} exists`);
    await createLogin(bootstrap, config.tenantLogin, config.tenantPassword);
    await setLoginPassword(bootstrap, config.tenantLogin, config.tenantPassword);
    await createLogin(bootstrap, config.ownerLogin, config.ownerPassword);
    await setLoginPassword(bootstrap, config.ownerLogin, config.ownerPassword);
    log('logins ready');
  });
  await withPool(urlFor(config, config.database), async (admin) => {
    await createRoles(admin);
    log('roles ready');
    await migrateSchema(admin);
    log('schema migrated');
    for (const access of PORTAL_TABLES) await grantAccess(admin, access);
    await revokeRole(admin, 'portal_owner', config.tenantLogin);
    await revokeRole(admin, 'portal_tenant', config.ownerLogin);
    await grantRole(admin, 'portal_tenant', config.tenantLogin);
    await grantRole(admin, 'portal_owner', config.ownerLogin);
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
