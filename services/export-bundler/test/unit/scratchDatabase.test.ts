import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CleanupRegistry } from '../../src/cleanup.js';
import {
  assertColourOnScratch,
  buildDumpArgs,
  buildImportArgs,
  buildRunNetworkArgs,
  mysqlErrorSummary,
  buildScratchMysqlRunArgs,
  buildSqliteBackupArgs,
  createFloorWatcher,
  createMysqlScratch,
  createSqliteScratch,
  databaseTargetOf,
  LiveDatabaseTargetError,
  pointAtScratch,
  SCRATCH_MYSQL_IMAGE,
  SCRATCH_SQLITE_DIR,
  ScratchCopyError,
  SQLITE_BACKUP_SCRIPT,
  type DatabaseTarget,
  type MysqlScratchSpec,
  type ScratchCopy,
  type SqliteScratchSpec,
} from '../../src/scratchDatabase.js';

const LIVE_MYSQL_ENV = {
  database__client: 'mysql',
  database__connection__host: '10.0.0.5',
  database__connection__port: '3306',
  database__connection__user: 'ghost_acme',
  database__connection__password: 'synthetic-live-password',
  database__connection__database: 'ghost_acme',
  database__connection__ssl__rejectUnauthorized: 'false',
  url: 'https://acme.example',
};

const live: Extract<DatabaseTarget, { kind: 'mysql' }> = {
  kind: 'mysql',
  host: '10.0.0.5',
  port: 3306,
  database: 'ghost_acme',
};

const mysqlSpec: MysqlScratchSpec = {
  runId: 'acme-export-42',
  live,
  liveUser: 'ghost_acme',
  livePassword: 'synthetic-live-password',
  liveUsesTls: true,
};

const scratchCopy: ScratchCopy = {
  target: { kind: 'mysql', host: 'acme-export-42-db', port: 3306, database: 'ghost_acme' },
  colourDatabaseEnv: {
    database__client: 'mysql',
    database__connection__host: 'acme-export-42-db',
    database__connection__port: '3306',
    database__connection__user: 'root',
    database__connection__password: 'scratch-pw',
    database__connection__database: 'ghost_acme',
  },
  colourVolumes: [],
  network: 'acme-export-42-net',
};

describe('SCRATCH_MYSQL_IMAGE', () => {
  it("is the server image db/RUNBOOK-db.md pins for db1, so the copy is made by the tenant's own MySQL", async () => {
    const runbook = await readFile(
      new URL('../../../../db/RUNBOOK-db.md', import.meta.url),
      'utf8'
    );
    const pins = new Set(runbook.match(/mysql:8\.0@sha256:[0-9a-f]{64}/g));
    expect([...pins]).toEqual([SCRATCH_MYSQL_IMAGE]);
  });
});

describe('databaseTargetOf', () => {
  it("reads a mysql target from Ghost's own env keys, defaulting the port", () => {
    expect(databaseTargetOf(LIVE_MYSQL_ENV)).toEqual(live);
    const { database__connection__port: _drop, ...noPort } = LIVE_MYSQL_ENV;
    expect(databaseTargetOf(noPort)).toEqual(live);
  });

  it.each([['sqlite3'], ['better-sqlite3']])('reads a %s target by filename', (client) => {
    expect(
      databaseTargetOf({ database__client: client, database__connection__filename: '/d/ghost.db' })
    ).toEqual({ kind: 'sqlite', filename: '/d/ghost.db' });
  });

  it.each([
    ['no client', {}],
    ['an unknown client', { database__client: 'postgres' }],
    ['mysql without a host', { database__client: 'mysql', database__connection__database: 'x' }],
    ['mysql without a database', { database__client: 'mysql', database__connection__host: 'h' }],
    ['sqlite without a filename', { database__client: 'sqlite3' }],
  ])('refuses %s', (_label, env) => {
    expect(() => databaseTargetOf(env)).toThrow(ScratchCopyError);
  });
});

describe('pointAtScratch', () => {
  it("replaces every database__ key with the copy's, and keeps everything else", () => {
    const env = pointAtScratch(LIVE_MYSQL_ENV, scratchCopy);
    expect(env).toEqual({ url: 'https://acme.example', ...scratchCopy.colourDatabaseEnv });
    expect(Object.values(env)).not.toContain('synthetic-live-password');
    expect(env).not.toHaveProperty('database__connection__ssl__rejectUnauthorized');
  });
});

describe('assertColourOnScratch', () => {
  it('passes a colour pointed at the copy', () => {
    expect(() =>
      assertColourOnScratch(pointAtScratch(LIVE_MYSQL_ENV, scratchCopy), scratchCopy.target, live)
    ).not.toThrow();
  });

  it('REFUSES a colour pointed at the live database', () => {
    expect(() => assertColourOnScratch(LIVE_MYSQL_ENV, scratchCopy.target, live)).toThrow(
      /its database is the tenant's live one/
    );
  });

  it.each([
    ['another host', { database__connection__host: 'somewhere-else' }],
    ['another port', { database__connection__port: '3307' }],
    ['another schema', { database__connection__database: 'ghost_other' }],
    ['no database at all', { database__client: '' }],
    ['a sqlite file', { database__client: 'sqlite3', database__connection__filename: '/x.db' }],
  ])('refuses a colour pointed at %s', (_label, change) => {
    const env = { ...pointAtScratch(LIVE_MYSQL_ENV, scratchCopy), ...change };
    expect(() => assertColourOnScratch(env, scratchCopy.target, live)).toThrow(
      LiveDatabaseTargetError
    );
  });

  it('refuses a sqlite colour on the live file, and passes it on the copy', () => {
    const liveFile: DatabaseTarget = {
      kind: 'sqlite',
      filename: '/var/lib/ghost/content/data/ghost.db',
    };
    const copyFile: DatabaseTarget = { kind: 'sqlite', filename: `${SCRATCH_SQLITE_DIR}/ghost.db` };
    expect(() =>
      assertColourOnScratch(
        { database__client: 'sqlite3', database__connection__filename: liveFile.filename },
        copyFile,
        liveFile
      )
    ).toThrow(LiveDatabaseTargetError);
    expect(() =>
      assertColourOnScratch(
        { database__client: 'sqlite3', database__connection__filename: copyFile.filename },
        copyFile,
        liveFile
      )
    ).not.toThrow();
  });
});

describe('MySQL argv', () => {
  it('starts the scratch server on the run network, with its root password from an env file', () => {
    expect(buildScratchMysqlRunArgs('acme-export-42', '/tmp/e/tenant.env')).toEqual([
      'run',
      '-d',
      '--name',
      'acme-export-42-db',
      '--network',
      'acme-export-42-net',
      '--log-driver',
      'none',
      '--env-file',
      '/tmp/e/tenant.env',
      SCRATCH_MYSQL_IMAGE,
    ]);
  });

  it('makes the run network --internal: nothing on it has a route out of the host', () => {
    expect(buildRunNetworkArgs('acme-export-42')).toEqual([
      'network',
      'create',
      '--internal',
      'acme-export-42-net',
    ]);
  });

  it('names the dump container, so cleanup can remove it by name mid-dump', () => {
    const args = buildDumpArgs(mysqlSpec, 'f');
    expect(args.slice(0, 4)).toEqual(['run', '--rm', '--name', 'acme-export-42-dump']);
  });

  it("dumps one schema, consistently, with dump_tenant.py's flags, and no password in argv", () => {
    const args = buildDumpArgs(mysqlSpec, '/tmp/e/tenant.env');
    expect(args).toContain('--single-transaction');
    expect(args).toContain('--routines');
    expect(args).toContain('--triggers');
    expect(args).toContain('--set-gtid-purged=OFF');
    expect(args).toContain('--no-tablespaces');
    expect(args).toContain('--ssl-mode=REQUIRED');
    expect(args.slice(-2)).toEqual(['--databases', 'ghost_acme']);
    expect(args).not.toContain('--all-databases');
    expect(args.join(' ')).not.toContain('synthetic-live-password');
    expect(args[args.indexOf('--env-file') + 1]).toBe('/tmp/e/tenant.env');
    expect(buildDumpArgs({ ...mysqlSpec, liveUsesTls: false }, 'f')).toContain(
      '--ssl-mode=PREFERRED'
    );
  });

  it('imports through the scratch container, over TCP, as its root', () => {
    const args = buildImportArgs('acme-export-42');
    expect(args.slice(0, 3)).toEqual(['exec', '-i', 'acme-export-42-db']);
    expect(args[args.length - 1]).toContain('--protocol=TCP');
  });
});

describe('createFloorWatcher', () => {
  it('sees a floor table row even when the marker straddles two chunks', () => {
    const floor = createFloorWatcher();
    floor.observe(Buffer.from('...INSERT INTO `us'));
    floor.observe(Buffer.from('ers` VALUES (1);\nINSERT INTO `settings` VALUES (2);'));
    expect(floor.missing()).toEqual([]);
  });

  it('names the floor tables no row was seen for', () => {
    const floor = createFloorWatcher();
    floor.observe(Buffer.from('INSERT INTO `posts` VALUES (1);'));
    expect(floor.missing()).toEqual(['users', 'settings']);
  });
});

/**
 * A stand-in for `docker` that plays each step of a MySQL scratch run:
 * network create, run, the readiness and SHOW DATABASES queries, the dump
 * (printing `dumpLines`), and the import (reading stdin into `importLog`).
 */
async function writeFakeDocker(
  dir: string,
  opts: {
    dumpLines?: string;
    dumpExit?: number;
    importExit?: number;
    extraDatabase?: string;
    neverReady?: boolean;
  }
): Promise<{ path: string; argvLog: string; importLog: string }> {
  const argvLog = join(dir, 'argv.log');
  const importLog = join(dir, 'import.log');
  const path = join(dir, 'fake-docker.sh');
  const lines = [
    '#!/bin/sh',
    `echo "$*" >> '${argvLog}'`,
    'case "$1 $2" in',
    `  "exec -i") cat > '${importLog}'; ${opts.importExit ? 'echo "ERROR 1064 (42000) at line 3: syntax near \'reader@member.example\'" >&2; ' : ''}exit ${opts.importExit ?? 0} ;;`,
    'esac',
    'last=""; for a in "$@"; do last="$a"; done',
    'case "$1" in',
    '  exec)',
    '    case "$last" in',
    `      *"SELECT 1"*) ${opts.neverReady ? 'exit 1' : 'echo 1'} ;;`,
    `      *"SHOW DATABASES"*) printf 'information_schema\\nmysql\\nperformance_schema\\nsys\\n${opts.extraDatabase ?? ''}\\n' ;;`,
    '    esac ;;',
    '  run)',
    '    case "$*" in',
    `      *mysqldump*) printf '%s' '${opts.dumpLines ?? 'INSERT INTO `users` VALUES (1);\\nINSERT INTO `settings` VALUES (1);\\n'}'; exit ${opts.dumpExit ?? 0} ;;`,
    '    esac ;;',
    'esac',
    'exit 0',
  ];
  await writeFile(path, lines.join('\n') + '\n');
  await chmod(path, 0o755);
  return { path, argvLog, importLog };
}

describe('createMysqlScratch', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-scratch-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('makes the network and server, waits for it, checks it is empty, streams the dump in, and returns the copy', async () => {
    const fake = await writeFakeDocker(dir, {});
    const registry = new CleanupRegistry();
    const scratch = createMysqlScratch(mysqlSpec, {
      dockerCommand: fake.path,
      registry,
      scratchPassword: 'scratch-pw',
      pollMs: 1,
    });
    const copy = await scratch.prepare();
    expect(copy).toEqual(scratchCopy);
    expect(registry.labels).toEqual(['scratch database acme-export-42-db']);
    const argv = await readFile(fake.argvLog, 'utf8');
    expect(argv).toContain('network create --internal acme-export-42-net');
    expect(argv).toMatch(
      /run --rm --name acme-export-42-dump --log-driver none --env-file \S+ mysql:8\.0@\S+ mysqldump /
    );
    expect(argv).toMatch(
      /run -d --name acme-export-42-db --network acme-export-42-net --log-driver none --env-file \S+ mysql:8\.0@/
    );
    expect(argv).not.toContain('scratch-pw');
    expect(argv).not.toContain('synthetic-live-password');
    expect(await readFile(fake.importLog, 'utf8')).toContain('INSERT INTO `users` VALUES');

    await scratch.destroy();
    expect(registry.labels).toEqual([]);
    const after = await readFile(fake.argvLog, 'utf8');
    expect(after).toContain('rm -f acme-export-42-dump');
    expect(after).toContain('rm -fv acme-export-42-db');
    expect(after).toContain('network rm acme-export-42-net');
  });

  it("a signal's cleanup removes a dump still running, before the scratch server and network", async () => {
    const fake = await writeFakeDocker(dir, {});
    const registry = new CleanupRegistry();
    const scratch = createMysqlScratch(mysqlSpec, {
      dockerCommand: fake.path,
      registry,
      pollMs: 1,
    });
    await scratch.prepare();
    await writeFile(fake.argvLog, '');
    expect(registry.runAll()).toEqual([]);
    expect((await readFile(fake.argvLog, 'utf8')).trim().split('\n')).toEqual([
      'rm -f acme-export-42-dump',
      'rm -fv acme-export-42-db',
      'network rm acme-export-42-net',
    ]);
  });

  /**
   * A fake `docker` for the "signal before the dump exists" case: `network
   * create` -- the run's very first docker command -- touches a marker and
   * then sleeps, giving the test a window to fire a signal while it is
   * still in flight and nothing at all has been created yet. The three
   * removal commands each answer the way a real `docker rm`/`network rm`
   * does against a name that was never created: a non-zero exit with a
   * "No such ..." stderr, not a bare success -- so the test proves the
   * catch in scratchDatabase.ts's removeSync is what makes cleanup
   * idempotent, not a fake that always says yes.
   */
  async function writeSignalTimingFakeDocker(
    signalDir: string
  ): Promise<{ path: string; argvLog: string; marker: string }> {
    const argvLog = join(signalDir, 'argv.log');
    const marker = join(signalDir, 'network-create-started');
    const path = join(signalDir, 'fake-docker-signal-timing.sh');
    const lines = [
      '#!/bin/sh',
      `echo "$*" >> '${argvLog}'`,
      'case "$*" in',
      `  "network create --internal acme-export-42-net") touch '${marker}'; sleep 0.3; exit 0 ;;`,
      '  "rm -f acme-export-42-dump")',
      '    echo "Error: No such container: acme-export-42-dump" >&2; exit 1 ;;',
      '  "rm -fv acme-export-42-db")',
      '    echo "Error: No such container: acme-export-42-db" >&2; exit 1 ;;',
      '  "network rm acme-export-42-net")',
      '    echo "Error: No such network: acme-export-42-net" >&2; exit 1 ;;',
      'esac',
      'exit 0',
    ];
    await writeFile(path, lines.join('\n') + '\n');
    await chmod(path, 0o755);
    return { path, argvLog, marker };
  }

  async function waitForFile(path: string, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (existsSync(path)) return;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path} to exist`);
      await sleep(5);
    }
  }

  it("registers the dump container for cleanup before the run's first docker command, not after it -- a signal firing before the dump (or anything else) exists is a safe no-op, never an orphan", async () => {
    const fake = await writeSignalTimingFakeDocker(dir);
    const registry = new CleanupRegistry();
    const scratch = createMysqlScratch(mysqlSpec, {
      dockerCommand: fake.path,
      registry,
      pollMs: 1,
      readyTimeoutMs: 50,
    });

    const prepared = scratch.prepare();
    // `network create` -- the very first docker command this run issues --
    // is still in flight (asleep). Nothing has been created: not the
    // network, not the scratch server, and not the dump.
    await waitForFile(fake.marker);
    expect(registry.labels).toEqual(['scratch database acme-export-42-db']);
    expect(await readFile(fake.argvLog, 'utf8')).not.toContain('mysqldump');

    // The signal: every remover runs now, while the dump container has
    // never existed and the fake docker answers each removal the way a
    // real one would -- "No such container" / "No such network" -- proving
    // the removeSync catch is what makes this a no-op, not a fake that
    // always reports success.
    expect(registry.runAll()).toEqual([]);
    const argv = await readFile(fake.argvLog, 'utf8');
    expect(argv).toContain('rm -f acme-export-42-dump');
    expect(argv).toContain('rm -fv acme-export-42-db');
    expect(argv).toContain('network rm acme-export-42-net');

    await prepared.catch(() => undefined);
  });

  it('refuses a scratch target that already holds a database, before importing anything', async () => {
    const fake = await writeFakeDocker(dir, { extraDatabase: 'ghost_acme' });
    const scratch = createMysqlScratch(mysqlSpec, {
      dockerCommand: fake.path,
      registry: new CleanupRegistry(),
      pollMs: 1,
    });
    await expect(scratch.prepare()).rejects.toThrow(/the scratch target is not empty: ghost_acme/);
    expect(await readFile(fake.argvLog, 'utf8')).not.toContain('mysqldump');
  });

  it('refuses when the scratch server never answers', async () => {
    const fake = await writeFakeDocker(dir, { neverReady: true });
    const scratch = createMysqlScratch(mysqlSpec, {
      dockerCommand: fake.path,
      registry: new CleanupRegistry(),
      readyTimeoutMs: 20,
      pollMs: 5,
    });
    await expect(scratch.prepare()).rejects.toThrow(/never answered/);
  });

  it.each([
    ['the dump fails', { dumpExit: 2 }, /mysqldump exited 2/],
    [
      'the import fails',
      { importExit: 1 },
      /the import exited 1: MySQL error 1064 \(42000\) at line 3\)$/,
    ],
    [
      'the dump carries no floor rows',
      { dumpLines: 'CREATE TABLE x (a int);' },
      /no rows for users, settings/,
    ],
  ])('refuses when %s', async (_label, opts, message) => {
    const fake = await writeFakeDocker(dir, opts);
    const scratch = createMysqlScratch(mysqlSpec, {
      dockerCommand: fake.path,
      registry: new CleanupRegistry(),
      pollMs: 1,
    });
    await expect(scratch.prepare()).rejects.toThrow(message);
  });

  it('destroy() is safe when nothing was created', async () => {
    const fake = await writeFakeDocker(dir, {});
    const registry = new CleanupRegistry();
    const scratch = createMysqlScratch(mysqlSpec, {
      dockerCommand: join(dir, 'no-such-docker'),
      registry,
    });
    await expect(scratch.destroy()).resolves.toBeUndefined();
    void fake;
  });
});

describe('SQLite scratch', () => {
  const sqliteSpec: SqliteScratchSpec = {
    runId: 'demo-export-7',
    image: 'ghost-platform@sha256:abc',
    tenantVolumes: [{ volume: 'ghost-demo-content', mountPath: '/var/lib/ghost/content' }],
    live: { kind: 'sqlite', filename: '/var/lib/ghost/content/data/ghost.db' },
    owner: '1001:1001',
  };

  it("backs up with SQLite's online backup API, reading the tenant's volumes read-only", () => {
    const args = buildSqliteBackupArgs(sqliteSpec);
    expect(args).toContain(
      'type=volume,src=ghost-demo-content,dst=/var/lib/ghost/content,readonly'
    );
    expect(args).toContain(`type=volume,src=demo-export-7-data,dst=${SCRATCH_SQLITE_DIR}`);
    expect(args).toContain('none');
    expect(args.slice(-4)).toEqual([
      SQLITE_BACKUP_SCRIPT,
      '/var/lib/ghost/content/data/ghost.db',
      `${SCRATCH_SQLITE_DIR}/ghost.db`,
      '1001:1001',
    ]);
    expect(SQLITE_BACKUP_SCRIPT).toContain('db.backup(dst)');
    expect(SQLITE_BACKUP_SCRIPT).toContain('readonly: true');
  });

  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-sqlite-scratch-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function fake(ok: boolean): Promise<{ path: string; log: string }> {
    const log = join(dir, 'argv.log');
    const path = join(dir, 'fake-docker.sh');
    await writeFile(
      path,
      [
        '#!/bin/sh',
        `echo "$*" >> '${log}'`,
        ok ? 'case "$1" in run) echo "BL_SQLITE_COPY ok" ;; esac' : 'true',
        'exit 0',
      ].join('\n') + '\n'
    );
    await chmod(path, 0o755);
    return { path, log };
  }

  it('makes the volume, copies into it, and points the colour at the copy', async () => {
    const f = await fake(true);
    const registry = new CleanupRegistry();
    const scratch = createSqliteScratch(sqliteSpec, { dockerCommand: f.path, registry });
    const copy = await scratch.prepare();
    expect(copy).toEqual({
      target: { kind: 'sqlite', filename: `${SCRATCH_SQLITE_DIR}/ghost.db` },
      colourDatabaseEnv: {
        database__client: 'sqlite3',
        database__connection__filename: `${SCRATCH_SQLITE_DIR}/ghost.db`,
      },
      colourVolumes: [{ volume: 'demo-export-7-data', mountPath: SCRATCH_SQLITE_DIR }],
      network: 'demo-export-7-net',
    });
    await scratch.destroy();
    expect(registry.labels).toEqual([]);
    const log = await readFile(f.log, 'utf8');
    expect(log).toContain('network create --internal demo-export-7-net');
    expect(log).toContain('volume rm -f demo-export-7-data');
    expect(log).toContain('network rm demo-export-7-net');
  });

  it('refuses when the backup does not report completion', async () => {
    const f = await fake(false);
    const scratch = createSqliteScratch(sqliteSpec, {
      dockerCommand: f.path,
      registry: new CleanupRegistry(),
    });
    await expect(scratch.prepare()).rejects.toThrow(ScratchCopyError);
  });
});

describe('mysqlErrorSummary', () => {
  it('keeps the error code, state and line, and drops the quoted row data', () => {
    const stderr =
      "ERROR 1064 (42000) at line 57: You have an error in your SQL syntax near 'reader@member.example','Reader'";
    const summary = mysqlErrorSummary(stderr);
    expect(summary).toBe('MySQL error 1064 (42000) at line 57');
    expect(summary).not.toContain('reader@member.example');
  });

  it('keeps an error with no line', () => {
    expect(mysqlErrorSummary('ERROR 2003 (HY000): cannot connect')).toBe(
      'MySQL error 2003 (HY000)'
    );
  });

  it('says so when there is no MySQL error code at all, and repeats nothing', () => {
    expect(mysqlErrorSummary('some output with reader@member.example')).toBe(
      'no MySQL error code in its output'
    );
  });
});
