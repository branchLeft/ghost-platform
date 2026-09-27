import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { dockerRemoveSync, processCleanup, type CleanupRegistry } from './cleanup.js';
import { NO_CONTAINER_LOGS, runDocker, type VolumeMount } from './containerRunner.js';
import { withEnvFile } from './envFile.js';

/**
 * The export colour never runs against the tenant's live database (owner
 * ruling, 2026-09-27: "the copy"). Each run takes a consistent snapshot of
 * the one tenant's database into a throwaway target that exists only for
 * the run, boots the colour against that, and removes it on every exit
 * path. Nothing is created on the tenant's database server; the snapshot is
 * a read.
 *
 * MySQL tier: `mysqldump --single-transaction` of the tenant's one schema,
 * streamed straight into a fresh MySQL 8.0 container on the run's own
 * network -- no dump file anywhere. SQLite tier: SQLite's online backup
 * API, into a volume that exists only for the run.
 */

export class ScratchCopyError extends Error {
  constructor(detail: string) {
    super(`the scratch copy of the tenant's database could not be made (${detail})`);
    this.name = 'ScratchCopyError';
  }
}

export class LiveDatabaseTargetError extends Error {
  constructor(detail: string) {
    super(
      `refused: the export colour is not pointed at this run's scratch copy (${detail}); ` +
        `it must never run against the tenant's live database`
    );
    this.name = 'LiveDatabaseTargetError';
  }
}

/**
 * The server image `db/RUNBOOK-db.md` pins for db1, so the copy is made and
 * restored by the same MySQL the tenant's data lives in.
 * test/unit/scratchDatabase.test.ts fails if the runbook's pin moves and this
 * does not.
 */
export const SCRATCH_MYSQL_IMAGE =
  'mysql:8.0@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b';

/** Where the SQLite copy is mounted in the colour. */
export const SCRATCH_SQLITE_DIR = '/var/lib/ghost/export-scratch';

/**
 * Mirrors db/recovery/restore_drained.py's SYSTEM_DATABASES: what every
 * MySQL 8.0 server carries before anything is provisioned on it. A scratch
 * target holding anything else is not fresh, and is refused before import.
 */
export const SYSTEM_DATABASES: ReadonlySet<string> = new Set([
  'information_schema',
  'mysql',
  'performance_schema',
  'sys',
]);

/**
 * Mirrors db/provision/dump_tenant.py's FLOOR_TABLES: tables a real Ghost
 * database never has empty. A copy whose stream carries no rows for them is
 * refused, rather than exported as an empty site.
 */
export const FLOOR_TABLES = ['users', 'settings'] as const;

export type DatabaseTarget =
  | {
      readonly kind: 'mysql';
      readonly host: string;
      readonly port: number;
      readonly database: string;
    }
  | { readonly kind: 'sqlite'; readonly filename: string };

/** Where an environment points Ghost's database, as Ghost reads it. */
export function databaseTargetOf(env: Readonly<Record<string, string>>): DatabaseTarget {
  const client = env.database__client;
  if (client === 'mysql') {
    const host = env.database__connection__host;
    const database = env.database__connection__database;
    if (!host || !database)
      throw new ScratchCopyError('the mysql connection has no host or database');
    return {
      kind: 'mysql',
      host,
      port: Number(env.database__connection__port ?? '3306'),
      database,
    };
  }
  if (client === 'sqlite3' || client === 'better-sqlite3') {
    const filename = env.database__connection__filename;
    if (!filename) throw new ScratchCopyError('the sqlite connection has no filename');
    return { kind: 'sqlite', filename };
  }
  throw new ScratchCopyError(`unsupported database client ${JSON.stringify(client)}`);
}

function sameTarget(a: DatabaseTarget, b: DatabaseTarget): boolean {
  if (a.kind === 'mysql' && b.kind === 'mysql') {
    return a.host === b.host && a.port === b.port && a.database === b.database;
  }
  if (a.kind === 'sqlite' && b.kind === 'sqlite') return a.filename === b.filename;
  return false;
}

/**
 * The control this module exists for. Run on the environment the colour is
 * about to be given, before it starts, and again on the environment Docker
 * reports the running colour actually has, before any export call.
 */
export function assertColourOnScratch(
  colourEnv: Readonly<Record<string, string>>,
  scratch: DatabaseTarget,
  live: DatabaseTarget
): void {
  let actual: DatabaseTarget;
  try {
    actual = databaseTargetOf(colourEnv);
  } catch (err) {
    throw new LiveDatabaseTargetError((err as Error).message);
  }
  if (sameTarget(actual, live)) {
    throw new LiveDatabaseTargetError("its database is the tenant's live one");
  }
  if (!sameTarget(actual, scratch)) {
    throw new LiveDatabaseTargetError("its database is not this run's scratch copy");
  }
}

export interface ScratchCopy {
  readonly target: DatabaseTarget;
  /** Replaces every `database__*` key in the colour's environment. */
  readonly colourDatabaseEnv: Readonly<Record<string, string>>;
  /** Mounted into the colour in addition to the tenant's own volumes. */
  readonly colourVolumes: readonly VolumeMount[];
  /** The network the colour must join to reach the copy, if any. */
  readonly network: string | null;
}

/** The colour's environment, with its database pointed at the copy and nothing else. */
export function pointAtScratch(
  env: Readonly<Record<string, string>>,
  copy: ScratchCopy
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('database__')) out[key] = value;
  }
  return { ...out, ...copy.colourDatabaseEnv };
}

export interface ScratchDatabase {
  prepare(): Promise<ScratchCopy>;
  /** Safe to call whether or not prepare() got as far as creating anything. */
  destroy(): Promise<void>;
}

// --- MySQL -------------------------------------------------------------------

export interface MysqlScratchSpec {
  /** Names the scratch container `<runId>-db` and the network `<runId>-net`. */
  readonly runId: string;
  /** The tenant's live connection, from its own rendered environment. */
  readonly live: Extract<DatabaseTarget, { kind: 'mysql' }>;
  readonly liveUser: string;
  readonly livePassword: string;
  /** db1 refuses plaintext TCP; Ghost's own env says whether TLS is in use. */
  readonly liveUsesTls: boolean;
}

const MYSQL_AS_ROOT =
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --protocol=TCP --host=127.0.0.1 --user=root';

export function mysqlScratchNames(runId: string): {
  container: string;
  network: string;
  dump: string;
} {
  return { container: `${runId}-db`, network: `${runId}-net`, dump: `${runId}-dump` };
}

/**
 * The run's own network. `--internal`: nothing on it -- the scratch
 * database, the export colour -- has any route out of the host.
 */
export function buildRunNetworkArgs(runId: string): readonly string[] {
  return ['network', 'create', '--internal', mysqlScratchNames(runId).network];
}

export function buildScratchMysqlRunArgs(runId: string, envFile: string): readonly string[] {
  const { container, network } = mysqlScratchNames(runId);
  return [
    'run',
    '-d',
    '--name',
    container,
    '--network',
    network,
    ...NO_CONTAINER_LOGS,
    '--env-file',
    envFile,
    SCRATCH_MYSQL_IMAGE,
  ];
}

/**
 * The same flags as db/provision/dump_tenant.py's per-tenant dump, over TCP
 * as the tenant's own account instead of db1's socket-only `backup`
 * account, which is unreachable from the app host. Two differ, both because
 * that account holds no global privilege: `--source-data=2` (a binlog
 * position, which only point-in-time recovery reads and which needs
 * RELOAD and REPLICATION CLIENT) is dropped, and `--no-tablespaces` (which
 * otherwise needs PROCESS) is added.
 *
 * `--log-driver none`: the whole database streams out of this container's
 * stdout, and Docker's default json-file driver would write every byte of
 * it to /var/lib/docker as it passed. Named, so cleanup can remove it by
 * name if the run is stopped mid-dump.
 */
export function buildDumpArgs(spec: MysqlScratchSpec, envFile: string): readonly string[] {
  return [
    'run',
    '--rm',
    '--name',
    mysqlScratchNames(spec.runId).dump,
    ...NO_CONTAINER_LOGS,
    '--env-file',
    envFile,
    SCRATCH_MYSQL_IMAGE,
    'mysqldump',
    '--host',
    spec.live.host,
    '--port',
    String(spec.live.port),
    '--user',
    spec.liveUser,
    `--ssl-mode=${spec.liveUsesTls ? 'REQUIRED' : 'PREFERRED'}`,
    '--single-transaction',
    '--routines',
    '--triggers',
    '--set-gtid-purged=OFF',
    '--no-tablespaces',
    '--databases',
    spec.live.database,
  ];
}

export function buildImportArgs(runId: string): readonly string[] {
  return ['exec', '-i', mysqlScratchNames(runId).container, 'sh', '-c', MYSQL_AS_ROOT];
}

export function buildScratchQueryArgs(runId: string, sql: string): readonly string[] {
  return [
    'exec',
    mysqlScratchNames(runId).container,
    'sh',
    '-c',
    `${MYSQL_AS_ROOT} -N -B -e "${sql}"`,
  ];
}

/** Watches a dump stream for a row of each floor table, across chunk boundaries. */
export function createFloorWatcher(): { observe(chunk: Buffer): void; missing(): string[] } {
  const patterns = FLOOR_TABLES.map((t) => ({ table: t, pattern: `INSERT INTO \`${t}\` VALUES` }));
  const seen = new Set<string>();
  const longest = Math.max(...patterns.map((p) => p.pattern.length));
  let carry = '';
  return {
    observe(chunk) {
      const text = carry + chunk.toString('latin1');
      for (const { table, pattern } of patterns) {
        if (!seen.has(table) && text.includes(pattern)) seen.add(table);
      }
      carry = text.slice(-longest);
    },
    missing() {
      return FLOOR_TABLES.filter((t) => !seen.has(t));
    },
  };
}

/**
 * The error code and line of a failed import, without the rest of the
 * message: MySQL's "near '...'" text can quote a fragment of row data.
 */
export function mysqlErrorSummary(stderr: string): string {
  const match = /ERROR (\d+) \(([0-9A-Z]{5})\)(?: at line (\d+))?/.exec(stderr);
  if (!match) return 'no MySQL error code in its output';
  return `MySQL error ${match[1]} (${match[2]})${match[3] ? ` at line ${match[3]}` : ''}`;
}

interface PipeResult {
  readonly dumpCode: number | null;
  readonly importCode: number | null;
  readonly dumpStderr: string;
  readonly importStderr: string;
}

/** Streams the dump's stdout straight into the import's stdin: nothing is written to disk. */
export function streamDumpIntoScratch(
  dockerCommand: string,
  dumpArgs: readonly string[],
  importArgs: readonly string[],
  onChunk: (chunk: Buffer) => void
): Promise<PipeResult> {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH ?? '' };
    const dump = spawn(dockerCommand, [...dumpArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const load = spawn(dockerCommand, [...importArgs], { env, stdio: ['pipe', 'ignore', 'pipe'] });
    let dumpStderr = '';
    let importStderr = '';
    let dumpCode: number | null | undefined;
    let importCode: number | null | undefined;
    const finish = () => {
      if (dumpCode !== undefined && importCode !== undefined) {
        resolve({ dumpCode, importCode, dumpStderr, importStderr });
      }
    };
    dump.stderr.on('data', (c: Buffer) => (dumpStderr = (dumpStderr + c.toString()).slice(-2000)));
    load.stderr.on(
      'data',
      (c: Buffer) => (importStderr = (importStderr + c.toString()).slice(-2000))
    );
    dump.stdout.on('data', onChunk);
    dump.stdout.pipe(load.stdin);
    load.stdin.on('error', () => undefined);
    dump.on('error', reject);
    load.on('error', reject);
    dump.on('close', (code) => {
      dumpCode = code;
      finish();
    });
    load.on('close', (code) => {
      importCode = code;
      finish();
    });
  });
}

export interface MysqlScratchOptions {
  readonly dockerCommand?: string;
  readonly registry?: CleanupRegistry;
  readonly readyTimeoutMs?: number;
  readonly pollMs?: number;
  readonly scratchPassword?: string;
}

export function createMysqlScratch(
  spec: MysqlScratchSpec,
  options: MysqlScratchOptions = {}
): ScratchDatabase {
  const docker = options.dockerCommand ?? 'docker';
  const registry = options.registry ?? processCleanup;
  const readyTimeoutMs = options.readyTimeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 1000;
  const password = options.scratchPassword ?? randomBytes(24).toString('hex');
  const { container, network, dump } = mysqlScratchNames(spec.runId);
  const removeSync = () => {
    for (const argv of [
      // A dump still running holds a transaction on the live server and
      // streams the database; it goes first.
      ['rm', '-f', dump],
      ['rm', '-fv', container],
      ['network', 'rm', network],
    ]) {
      try {
        dockerRemoveSync(argv, docker);
      } catch {
        // Already gone, or never created.
      }
    }
  };
  let unregister: (() => void) | undefined;

  async function query(sql: string): Promise<string> {
    return runDocker(docker, buildScratchQueryArgs(spec.runId, sql));
  }

  return {
    async prepare() {
      unregister = registry.register(`scratch database ${container}`, removeSync);
      await runDocker(docker, buildRunNetworkArgs(spec.runId));
      await withEnvFile(
        { MYSQL_ROOT_PASSWORD: password },
        (envFile) => runDocker(docker, buildScratchMysqlRunArgs(spec.runId, envFile)),
        registry
      );

      // A real `SELECT 1` over TCP, as restore_drained.py's
      // wait_for_mysql_ready does: the image's first-boot init server listens
      // on the socket only, so TCP answers only once the real server is up.
      const deadline = Date.now() + readyTimeoutMs;
      for (;;) {
        try {
          if ((await query('SELECT 1')).trim() === '1') break;
        } catch {
          // Not up yet.
        }
        if (Date.now() >= deadline) {
          throw new ScratchCopyError(`the scratch MySQL never answered within ${readyTimeoutMs}ms`);
        }
        await sleep(pollMs);
      }

      // restore_drained.py's assert_target_has_no_live_database: a dump's own
      // CREATE DATABASE IF NOT EXISTS / USE would restore into whatever is
      // already there.
      const present = (await query('SHOW DATABASES'))
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !SYSTEM_DATABASES.has(s));
      if (present.length > 0) {
        throw new ScratchCopyError(`the scratch target is not empty: ${present.join(', ')}`);
      }

      const floor = createFloorWatcher();
      const result = await withEnvFile(
        { MYSQL_PWD: spec.livePassword },
        (envFile) =>
          streamDumpIntoScratch(
            docker,
            buildDumpArgs(spec, envFile),
            buildImportArgs(spec.runId),
            (c) => floor.observe(c)
          ),
        registry
      );
      if (result.dumpCode !== 0) {
        throw new ScratchCopyError(
          `mysqldump exited ${String(result.dumpCode)}: ${result.dumpStderr}`
        );
      }
      if (result.importCode !== 0) {
        throw new ScratchCopyError(
          `the import exited ${String(result.importCode)}: ${mysqlErrorSummary(result.importStderr)}`
        );
      }
      const missing = floor.missing();
      if (missing.length > 0) {
        throw new ScratchCopyError(`the dump carried no rows for ${missing.join(', ')}`);
      }

      return {
        target: { kind: 'mysql', host: container, port: 3306, database: spec.live.database },
        colourDatabaseEnv: {
          database__client: 'mysql',
          database__connection__host: container,
          database__connection__port: '3306',
          database__connection__user: 'root',
          database__connection__password: password,
          database__connection__database: spec.live.database,
        },
        colourVolumes: [],
        network,
      };
    },
    async destroy() {
      removeSync();
      unregister?.();
    },
  };
}

// --- SQLite ------------------------------------------------------------------

export interface SqliteScratchSpec {
  readonly runId: string;
  readonly image: string;
  /** The tenant's own volumes, mounted read-only for the copy. */
  readonly tenantVolumes: readonly VolumeMount[];
  readonly live: Extract<DatabaseTarget, { kind: 'sqlite' }>;
  /** The tenant's `uid:gid`: the copy is handed to it so the colour can open it. */
  readonly owner: string | null;
}

const SQLITE_MARKER = 'BL_SQLITE_COPY ok';

/**
 * SQLite's online backup API, through the better-sqlite3 build inside
 * Ghost's own image: a consistent copy even while the live colour writes.
 * The source is opened read-only on a read-only mount.
 */
export const SQLITE_BACKUP_SCRIPT = [
  "const fs = require('fs');",
  "const path = require('path');",
  "const Database = require(require.resolve('better-sqlite3', { paths: ['/var/lib/ghost/current'] }));",
  'const [src, dst, owner] = process.argv.slice(1);',
  'const db = new Database(src, { readonly: true, fileMustExist: true });',
  'db.backup(dst)',
  '  .then(() => {',
  '    db.close();',
  "    if (owner) { const [u, g] = owner.split(':').map(Number); fs.chownSync(dst, u, g); fs.chownSync(path.dirname(dst), u, g); }",
  `    process.stdout.write('${SQLITE_MARKER}\\n');`,
  '  })',
  "  .catch((err) => { process.stderr.write(String(err && err.message) + '\\n'); process.exitCode = 2; });",
].join('\n');

export function sqliteScratchVolume(runId: string): string {
  return `${runId}-data`;
}

export function sqliteScratchFilename(): string {
  return `${SCRATCH_SQLITE_DIR}/ghost.db`;
}

export function buildSqliteBackupArgs(spec: SqliteScratchSpec): readonly string[] {
  const args = [
    'run',
    '--rm',
    '--user',
    '0:0',
    '--entrypoint',
    'node',
    '--network',
    'none',
    ...NO_CONTAINER_LOGS,
  ];
  for (const mount of spec.tenantVolumes) {
    args.push('--mount', `type=volume,src=${mount.volume},dst=${mount.mountPath},readonly`);
  }
  args.push(
    '--mount',
    `type=volume,src=${sqliteScratchVolume(spec.runId)},dst=${SCRATCH_SQLITE_DIR}`
  );
  args.push(spec.image, '-e', SQLITE_BACKUP_SCRIPT, spec.live.filename, sqliteScratchFilename());
  args.push(spec.owner ?? '');
  return args;
}

export function createSqliteScratch(
  spec: SqliteScratchSpec,
  options: { readonly dockerCommand?: string; readonly registry?: CleanupRegistry } = {}
): ScratchDatabase {
  const docker = options.dockerCommand ?? 'docker';
  const registry = options.registry ?? processCleanup;
  const volume = sqliteScratchVolume(spec.runId);
  const { network } = mysqlScratchNames(spec.runId);
  const removeSync = () => {
    for (const argv of [
      ['volume', 'rm', '-f', volume],
      ['network', 'rm', network],
    ]) {
      try {
        dockerRemoveSync(argv, docker);
      } catch {
        // Already gone, or never created.
      }
    }
  };
  let unregister: (() => void) | undefined;
  return {
    async prepare() {
      unregister = registry.register(`scratch volume ${volume}`, removeSync);
      // The same internal network the MySQL tier uses: the colour gets no
      // route out of the host on either tier.
      await runDocker(docker, buildRunNetworkArgs(spec.runId));
      await runDocker(docker, ['volume', 'create', volume]);
      const out = await runDocker(docker, buildSqliteBackupArgs(spec));
      if (!out.includes(SQLITE_MARKER)) {
        throw new ScratchCopyError('the SQLite backup did not report completion');
      }
      const filename = sqliteScratchFilename();
      return {
        target: { kind: 'sqlite', filename },
        colourDatabaseEnv: {
          database__client: 'sqlite3',
          database__connection__filename: filename,
        },
        colourVolumes: [{ volume, mountPath: SCRATCH_SQLITE_DIR }],
        network,
      };
    },
    async destroy() {
      removeSync();
      unregister?.();
    },
  };
}
