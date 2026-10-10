import { readFileSync } from 'node:fs';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { bind, connect, enterRole, type Tx } from '../src/db.js';
import { documentAcceptance, healthReading, tenantRegister } from '../src/schema.js';
import {
  checkAgainstManifest,
  formatDifference,
  type Checkpoint,
  type Difference,
} from './catalog.js';
import { SUPPORTED_MAJORS } from './catalogSnapshot.js';
import { hbaProblems, probeOtherDatabases } from './hba.js';
import { manifest, principalNames, type Names, type Principal } from './manifest.js';
import {
  appliedMigrations,
  readMigrations,
  replayMigrations,
  type Migration,
} from './migrations.js';
import {
  createPrincipal,
  grantMemberships,
  grantStatements,
  ident,
  rotatePassword,
} from './provision.js';
import { scramVerifier } from './scram.js';

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
  read: Read = (path) => readFileSync(path, 'utf8'),
  withPasswords = true
): ProvisionConfig {
  if (argv.length > 0) {
    throw new Error(
      'takes no arguments but --migrate-only: every input is a file named by an environment variable'
    );
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
  // `--migrate-only` sets no password, so it reads no password file.
  const tenantPassword = withPasswords ? secretFile(env, 'PORTAL_TENANT_PASSWORD_FILE', read) : '';
  const ownerPassword = withPasswords ? secretFile(env, 'PORTAL_OWNER_PASSWORD_FILE', read) : '';
  if (withPasswords)
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
export function connectionOptions(url: string, rawPassword?: string): pg.ClientConfig {
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
  return {
    host: parsed.hostname.replace(/^\[|\]$/g, ''),
    port: parsed.port === '' ? 5432 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    password: () => Promise.resolve(password),
    ssl: mode === 'disable' ? false : true,
  };
}

/** A one-connection pool built by `connectionOptions`. */
export function poolFor(url: string, rawPassword?: string): pg.Pool {
  const pool = new pg.Pool({ ...connectionOptions(url, rawPassword), max: 1 });
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
 * bound fails instead of returning rows. A behavioural smoke test after the
 * check has passed, not the control. `tables` names the portal tables the
 * applied migrations have made; by default, all of them.
 */
export async function verifyBoundary(
  config: ProvisionConfig,
  tables: readonly string[] = Object.keys(PORTAL_TABLES)
): Promise<void> {
  const present = tables.map((name) => PORTAL_TABLES[name]!);
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
      for (const table of present) {
        await expectOutcome(
          pool,
          'tenant read with no tenant bound',
          NO_TENANT_BOUND,
          async (tx) => {
            await asTenant(tx);
            return tx.select().from(table);
          }
        );
      }
      await expectOutcome(pool, 'tenant read with a tenant bound', 'ok', async (tx) => {
        await asTenant(tx);
        await bind(tx, 'portal.tenant_id', PROBE_TENANT);
        for (const table of present) await tx.select().from(table);
      });
    },
    config.tenantPassword
  );
  await withPool(
    urlFor(config, config.database, config.ownerLogin),
    async (pool) => {
      await expectOutcome(pool, 'owner login assumes portal_owner', 'ok', async (tx) => {
        await enterRole(tx, 'portal_owner');
        for (const table of present) await tx.select().from(table);
      });
      await expectOutcome(pool, 'owner login assumes portal_tenant', PERMISSION_DENIED, (tx) =>
        enterRole(tx, 'portal_tenant')
      );
    },
    config.ownerPassword
  );
}

/** The portal's tables by manifest identity, for the boundary smoke test. */
const PORTAL_TABLES: Record<
  string,
  typeof tenantRegister | typeof healthReading | typeof documentAcceptance
> = {
  'portal.tenant_register': tenantRegister,
  'portal.health_reading': healthReading,
  'portal.document_acceptance': documentAcceptance,
};

/**
 * A refusal: every difference found, already formatted, none of them
 * repaired. `written` says what this run had already done before it refused;
 * absent, the run had written nothing.
 */
export class ProvisionRefused extends Error {
  constructor(
    readonly lines: readonly string[],
    written?: string
  ) {
    super(
      `refused: ${lines.length} difference(s) from the manifest; ` +
        (written === undefined ? 'nothing was changed' : `already done by this run: ${written}`)
    );
    this.name = 'ProvisionRefused';
  }
}

const PRINCIPALS: readonly Principal[] = ['tenantRole', 'ownerRole', 'tenantLogin', 'ownerLogin'];
const LOGINS: readonly Principal[] = ['tenantLogin', 'ownerLogin'];
/**
 * Serialises runs of this command; any constant would do. PostgreSQL scopes
 * an advisory lock to one database, so the session lock serialises only runs
 * that name the same maintenance database. The portal transaction takes the
 * same key in the portal database and re-checks before it writes, so runs
 * through different maintenance databases still cannot interleave there.
 */
const LOCK_KEY = 735_501_873;

type Attempt = (database: string, login: string, password: string) => Promise<string>;

export interface ProvisionOptions {
  /** The migrations to apply, in order; by default the shipped ones. */
  migrations?: readonly Migration[];
  /** How the probe logs in to another database; returns `ok` or a SQLSTATE. */
  attempt?: Attempt;
}

function maintenanceDatabase(config: ProvisionConfig): string {
  const name = decodeURIComponent(new URL(config.adminUrl).pathname.replace(/^\//, ''));
  const database = name === '' ? 'postgres' : name;
  if (database === config.database) {
    throw new Error('the administrator URL must name a maintenance database, not the portal one');
  }
  return database;
}

function attemptWith(config: ProvisionConfig): Attempt {
  return async (database, login, password) => {
    const client = new pg.Client(connectionOptions(urlFor(config, database, login), password));
    client.on('error', () => undefined);
    try {
      await client.connect();
      return 'ok';
    } catch (error) {
      return sqlState(error) ?? 'no SQLSTATE';
    } finally {
      await client.end().catch(() => undefined);
    }
  };
}

interface State {
  checkpoint: Checkpoint;
  /** Differences found while reading the state itself. */
  history: Difference[];
}

/** Where the server stands: which principals exist, the database, the migrations applied. */
async function readState(
  client: pg.ClientBase,
  config: ProvisionConfig,
  names: Names,
  major: number,
  migrations: readonly Migration[],
  inDatabase: boolean
): Promise<State> {
  const roles = await client.query('SELECT rolname FROM pg_roles WHERE rolname = ANY($1)', [
    PRINCIPALS.map((p) => names[p]),
  ]);
  const existing = new Set((roles.rows as { rolname: string }[]).map((r) => r.rolname));
  const present = new Set(PRINCIPALS.filter((p) => existing.has(names[p])));
  const database = await client.query(
    'SELECT datacl IS NULL AS untouched FROM pg_database WHERE datname = $1',
    [config.database]
  );
  const row = database.rows[0] as { untouched: boolean } | undefined;
  const databaseState =
    row === undefined ? 'absent' : row.untouched ? 'created-empty' : 'initialised';
  const history: Difference[] = [];
  const applied: string[] = [];
  if (inDatabase && databaseState === 'initialised') {
    const rows = await appliedMigrations(client);
    rows.forEach((done, index) => {
      const shipped = migrations[index];
      if (
        shipped !== undefined &&
        shipped.hash === done.hash &&
        String(shipped.folderMillis) === done.createdAt &&
        applied.length === index
      ) {
        applied.push(shipped.tag);
      } else {
        history.push({
          kind: 'extra',
          mechanism: 'M25',
          text: `migration history row ${index + 1} (${done.hash.slice(0, 12)}) is not a shipped migration`,
        });
      }
    });
  }
  return {
    checkpoint: { major, database: config.database, names, present, databaseState, applied },
    history,
  };
}

/** Every difference at this checkpoint, from the portal database when it exists. */
async function check(client: pg.ClientBase, state: State, inDatabase: boolean): Promise<string[]> {
  const found = await checkAgainstManifest(client, state.checkpoint, inDatabase);
  return [...state.history, ...found].map(formatDifference);
}

async function hbaCheck(client: pg.ClientBase, config: ProvisionConfig, names: Names) {
  const logins = [];
  for (const [login, role] of [
    ['tenantLogin', 'tenantRole'],
    ['ownerLogin', 'ownerRole'],
  ] as const) {
    const reach = await client.query(
      `SELECT r.rolname FROM pg_roles l, pg_roles r
        WHERE l.rolname = $1 AND pg_has_role(l.oid, r.oid, 'MEMBER')`,
      [names[login]]
    );
    const names_ = (reach.rows as { rolname: string }[]).map((r) => r.rolname);
    logins.push({ name: names[login], reaches: [...names_, names[role]] });
  }
  const problems = await hbaProblems(client, { database: config.database, logins });
  return problems.map((text) => `extra M28: ${text}`);
}

/**
 * A connection whose search path is pg_catalog alone, so every name the check
 * prints, and every expression the server deparses, is fully qualified and
 * does not depend on the administrator's settings.
 */
async function pinned(pool: pg.Pool): Promise<pg.PoolClient> {
  const client = await pool.connect();
  await client.query('SET search_path = pg_catalog');
  return client;
}

async function inTransaction<T>(
  client: pg.ClientBase,
  mode: string,
  work: () => Promise<T>
): Promise<T> {
  await client.query(`BEGIN ${mode}`);
  try {
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/**
 * Step 5, shared by the full command and `--migrate-only`: in the portal database, one
 * transaction that checks again, creates what is absent and applies pending
 * migrations with their manifest grants, and checks the whole manifest.
 */
async function applyInPortal(
  config: ProvisionConfig,
  names: Names,
  major: number,
  migrations: readonly Migration[],
  created: ReadonlySet<Principal>,
  log: (line: string) => void
): Promise<void> {
  await withPool(urlFor(config, config.database), async (pool) => {
    const client = await pinned(pool);
    try {
      await inTransaction(client, '', async () => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
        const state = await readState(client, config, names, major, migrations, true);
        const again = await check(client, state, true);
        if (again.length > 0) throw new ProvisionRefused(again);
        const objects = manifest(major, config.database);
        if (state.checkpoint.databaseState === 'created-empty') {
          for (const object of objects.filter((o) => o.since === 'init')) {
            for (const statement of grantStatements(object, names, major)) {
              await client.query(statement);
            }
          }
        } else {
          for (const login of LOGINS.filter((p) => created.has(p))) {
            await client.query(
              `GRANT CONNECT ON DATABASE ${ident(config.database)} TO ${ident(names[login])}`
            );
          }
        }
        const pending = migrations.slice(state.checkpoint.applied.length);
        await replayMigrations(client, pending, async (migration) => {
          for (const object of objects.filter((o) => o.since === migration.tag)) {
            for (const statement of grantStatements(object, names, major)) {
              await client.query(statement);
            }
          }
          log(`applied migration ${migration.tag}`);
        });
        const final: State = {
          history: [],
          checkpoint: {
            ...state.checkpoint,
            present: new Set(PRINCIPALS),
            databaseState: 'initialised',
            applied: migrations.map((m) => m.tag),
          },
        };
        const after = await check(client, final, true);
        if (after.length > 0) throw new ProvisionRefused(after);
      });
    } finally {
      client.release();
    }
  });
}

/**
 * Creates what is absent, checks everything, and alters nothing that already
 * existed (a login's password aside). Before any write it compares the whole
 * privilege state of the server with the manifest and refuses, listing every
 * difference, when anything is missing or extra beyond what this run would
 * create. The same comparison runs again inside the portal transaction, and
 * once more against the full manifest before that transaction commits.
 */
export async function provisionPortal(
  config: ProvisionConfig,
  log: (line: string) => void = () => undefined,
  options: ProvisionOptions = {}
): Promise<void> {
  const migrations = options.migrations ?? readMigrations();
  const names = principalNames(config.tenantLogin, config.ownerLogin);
  const maintenance = poolFor(urlFor(config, maintenanceDatabase(config)));
  const lock = await pinned(maintenance);
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    const server = await lock.query(
      `SELECT current_setting('server_version_num')::int / 10000 AS major,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`
    );
    const { major, superuser } = server.rows[0] as { major: number; superuser: boolean };
    if (!SUPPORTED_MAJORS.includes(major)) {
      throw new Error(`PostgreSQL ${major} is not supported: no committed catalog snapshot`);
    }
    if (!superuser) throw new Error('the administrator URL must name a superuser');

    // 1. The whole check, read-only, before any write.
    const outside = await readState(lock, config, names, major, migrations, false);
    let refusals = await hbaCheck(lock, config, names);
    if (outside.checkpoint.databaseState === 'absent') {
      refusals.push(...(await inTransaction(lock, 'READ ONLY', () => check(lock, outside, false))));
    } else {
      await withPool(urlFor(config, config.database), async (pool) => {
        const client = await pinned(pool);
        try {
          const state = await readState(client, config, names, major, migrations, true);
          refusals.push(
            ...(await inTransaction(client, 'ISOLATION LEVEL REPEATABLE READ READ ONLY', () =>
              check(client, state, true)
            ))
          );
        } finally {
          client.release();
        }
      });
    }
    if (refusals.length > 0) throw new ProvisionRefused(refusals);
    log('pre-check passed: no difference from the manifest');

    // 2. Principals: create the absent ones, rotate the logins' passwords.
    const created = new Set(PRINCIPALS.filter((p) => !outside.checkpoint.present.has(p)));
    const passwords: Record<string, string> = {
      tenantLogin: config.tenantPassword,
      ownerLogin: config.ownerPassword,
    };
    await inTransaction(lock, '', async () => {
      for (const principal of PRINCIPALS) {
        if (created.has(principal)) {
          await createPrincipal(lock, names, principal, passwords[principal]);
        } else if (LOGINS.includes(principal)) {
          await rotatePassword(lock, names[principal], passwords[principal]!);
        }
      }
      await grantMemberships(lock, names, created);
    });
    log(
      created.size > 0
        ? `created ${[...created].map((p) => names[p]).join(', ')}`
        : 'passwords rotated'
    );

    // 3. The database, outside any transaction, as PostgreSQL requires.
    const done = [
      created.size > 0 ? `created ${[...created].map((p) => names[p]).join(', ')}` : undefined,
      LOGINS.some((p) => !created.has(p))
        ? `rotated the password of ${LOGINS.filter((p) => !created.has(p))
            .map((p) => names[p])
            .join(', ')}`
        : undefined,
    ];
    if (outside.checkpoint.databaseState === 'absent') {
      await lock.query(`CREATE DATABASE ${ident(config.database)}`);
      log(`created database ${config.database}`);
      done.push(`created database ${config.database} (empty)`);
    }

    // 4. The loaded pg_hba rules, observed: every other database refuses both logins.
    const others = await lock.query(
      'SELECT datname FROM pg_database WHERE datallowconn AND datname <> $1 ORDER BY 1',
      [config.database]
    );
    refusals = (
      await probeOtherDatabases(
        (others.rows as { datname: string }[]).map((r) => r.datname),
        LOGINS.map((p) => ({ name: names[p], password: passwords[p]! })),
        options.attempt ?? attemptWith(config)
      )
    ).map((text) => `extra M28: ${text}`);
    if (refusals.length > 0) {
      throw new ProvisionRefused(refusals, done.filter((d) => d !== undefined).join('; '));
    }

    // 5. In the portal database, one transaction: check again, create, check all.
    await applyInPortal(config, names, major, migrations, created, log);
    log('post-check passed: the server matches the manifest');
  } finally {
    await lock.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
    lock.release();
    await maintenance.end();
  }
  const tags = migrations.map((m) => m.tag);
  await verifyBoundary(
    config,
    Object.keys(PORTAL_TABLES).filter((name) =>
      manifest(14, config.database).some((o) => o.identity === name && tags.includes(o.since))
    )
  );
  log('boundary verified');
}

/** The refusal of `--migrate-only` when what it needs is not already there. */
export class MigrateRefused extends Error {
  constructor(reason: string) {
    super(`migrate refused: ${reason}`);
    this.name = 'MigrateRefused';
  }
}

/**
 * Applies the pending migrations, with their manifest grants and the whole
 * manifest check, to a portal database that is already provisioned. It creates
 * no role and no database and sets no password: it refuses, naming what is
 * absent, when a role or the initialised database is missing. It needs the
 * administrator connection alone, no login password, so it does not probe the
 * other databases or smoke-test the logins (both need a login password).
 */
export async function migratePortal(
  config: ProvisionConfig,
  log: (line: string) => void = () => undefined,
  options: ProvisionOptions = {}
): Promise<void> {
  const migrations = options.migrations ?? readMigrations();
  const names = principalNames(config.tenantLogin, config.ownerLogin);
  const maintenance = poolFor(urlFor(config, maintenanceDatabase(config)));
  const lock = await pinned(maintenance);
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    const server = await lock.query(
      `SELECT current_setting('server_version_num')::int / 10000 AS major,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`
    );
    const { major, superuser } = server.rows[0] as { major: number; superuser: boolean };
    if (!SUPPORTED_MAJORS.includes(major)) {
      throw new Error(`PostgreSQL ${major} is not supported: no committed catalog snapshot`);
    }
    if (!superuser) throw new Error('the administrator URL must name a superuser');

    const outside = await readState(lock, config, names, major, migrations, false);
    const absent = PRINCIPALS.filter((p) => !outside.checkpoint.present.has(p));
    if (absent.length > 0) {
      throw new MigrateRefused(
        `role ${absent.map((p) => names[p]).join(', ')} is absent; --migrate-only creates no role, run the full provision first`
      );
    }
    if (outside.checkpoint.databaseState !== 'initialised') {
      throw new MigrateRefused(
        `database ${config.database} is ${outside.checkpoint.databaseState}, not provisioned; --migrate-only creates no database, run the full provision first`
      );
    }
    const refusals = await hbaCheck(lock, config, names);
    const pending = await withPool(urlFor(config, config.database), async (pool) => {
      const client = await pinned(pool);
      try {
        const state = await readState(client, config, names, major, migrations, true);
        refusals.push(
          ...(await inTransaction(client, 'ISOLATION LEVEL REPEATABLE READ READ ONLY', () =>
            check(client, state, true)
          ))
        );
        return migrations.length - state.checkpoint.applied.length;
      } finally {
        client.release();
      }
    });
    if (refusals.length > 0) throw new ProvisionRefused(refusals);
    log('pre-check passed: no difference from the manifest');
    if (pending === 0) log('no pending migrations');
    await applyInPortal(config, names, major, migrations, new Set(), log);
    log('post-check passed: the server matches the manifest');
  } finally {
    await lock.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
    lock.release();
    await maintenance.end();
  }
}

/** The one argument the command accepts. */
export const MIGRATE_ONLY = '--migrate-only';

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

/**
 * The command's whole behaviour, returning its exit code. Every line it prints
 * passes through `redact`, so a driver error that quotes a connection string
 * cannot carry a secret into a log. A refusal prints every difference.
 */
export async function runProvision(
  env: Env,
  argv: readonly string[],
  io: Io,
  read?: Read,
  options: ProvisionOptions = {}
): Promise<number> {
  let config: ProvisionConfig | undefined;
  try {
    const migrateOnly = argv.length === 1 && argv[0] === MIGRATE_ONLY;
    config = loadConfig(env, migrateOnly ? [] : argv, read, !migrateOnly);
    const loaded = config;
    const say = (line: string): void => io.out(redact(line, loaded));
    if (migrateOnly) {
      await migratePortal(loaded, say, options);
      io.out('portal database migrated');
      return 0;
    }
    await provisionPortal(loaded, say, options);
    io.out('portal database provisioned');
    return 0;
  } catch (error) {
    const safe = config ?? {};
    if (error instanceof ProvisionRefused) {
      for (const line of error.lines) io.err(redact(line, safe));
    }
    const message = error instanceof Error ? error.message : String(error);
    io.err(`provision failed: ${redact(message, safe)}`);
    return 1;
  }
}
