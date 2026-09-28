// The mysql2 half of `provision-support-account.mjs`'s own proof: sqlite
// alone does not prove the fix portable across both database backends, so
// this drives the same script against a real MySQL 8 server and a real
// Ghost 6.55.0 booted with `database__client: 'mysql'`. See
// provision-support-account-mysql.image.test.md.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import {
  PartialRowMismatchError,
  provisionSupportAccount,
  SUSPENDED_STATUS,
} from '../../scripts/provision-support-account.mjs';

const IMAGE = process.env.IMAGE;
if (!IMAGE) {
  throw new Error('IMAGE must name the built Ghost image, e.g. IMAGE=ghost-platform:ci');
}

// The estate's own db stack (`db/README.md`) runs MySQL 8; a specific,
// already-supported patch release rather than a floating tag.
const MYSQL_IMAGE = 'mysql:8.0.46';
const BOOT_TIMEOUT_MS = 120_000;
const RUN_ID = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const NETWORK = `provision-mysql-${RUN_ID}`;
const MYSQL_NAME = `provision-mysql-db-${RUN_ID}`;
const GHOST_NAME = `provision-mysql-ghost-${RUN_ID}`;
const DB_NAME = 'ghost_test';
const DB_USER = 'ghost_test';
// Generated in-process, once, for this run only -- never printed, never
// derived from the ambient shell environment, only ever handed to `docker`
// as an explicit `-e` value for these two throwaway containers.
const ROOT_PASSWORD = crypto.randomBytes(24).toString('hex');
const DB_PASSWORD = crypto.randomBytes(24).toString('hex');

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The official mysql image starts in two phases: a temporary, socket-only
// bootstrap server that runs init scripts (creating MYSQL_DATABASE and
// MYSQL_USER), then a restart onto the real, TCP-reachable server -- both
// log "ready for connections", and `mysqladmin ping` against the same
// container succeeds in the first phase too, since it needs no TCP. Ghost
// (a different container) connects over TCP as DB_USER, so readiness has
// to mean *that* specific path is up, not merely "something is listening
// locally" -- proven by forcing `-h 127.0.0.1` (TCP, never the socket) with
// the actual application credential, from inside the MySQL container
// itself (no port needs publishing to the host for this check).
async function waitForMysqlReady() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      docker(
        'exec',
        '-e',
        `MYSQL_PWD=${DB_PASSWORD}`,
        MYSQL_NAME,
        'mysql',
        '-h',
        '127.0.0.1',
        '-P',
        '3306',
        `-u${DB_USER}`,
        DB_NAME,
        '-e',
        'SELECT 1'
      );
      return true;
    } catch {
      await sleep(1000);
    }
  }
  return false;
}

async function waitForGhostHome(base) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/`);
      if (res.status === 200) return true;
    } catch {
      // not listening yet
    }
    const state = docker('inspect', '-f', '{{.State.Running}}', GHOST_NAME).trim();
    if (state !== 'true') return false;
    await sleep(1000);
  }
  return false;
}

function sqlOnGhost(statement, ...params) {
  // Mirrors provision-support-account.mjs's own sslOptionFromEnv() exactly
  // -- this helper reaches the same real, require_secure_transport=ON
  // MySQL server the script does, from inside the same Ghost container, so
  // a plaintext connection here would fail for the identical reason.
  const script = `
    (async () => {
      const mysql = require(require.resolve('mysql2/promise', { paths: ['/var/lib/ghost/current'] }));
      const sslPrefix = 'database__connection__ssl__';
      const ssl = {};
      let anySsl = false;
      for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith(sslPrefix)) continue;
        anySsl = true;
        try {
          ssl[key.slice(sslPrefix.length)] = JSON.parse(value);
        } catch {
          ssl[key.slice(sslPrefix.length)] = value;
        }
      }
      const conn = await mysql.createConnection({
        host: process.env.database__connection__host,
        port: Number(process.env.database__connection__port),
        database: process.env.database__connection__database,
        user: process.env.database__connection__user,
        password: process.env.database__connection__password,
        ...(anySsl ? { ssl } : {}),
      });
      const [statement, ...params] = JSON.parse(process.argv[1]);
      const [rows] = await conn.execute(statement, params);
      console.log(JSON.stringify(rows));
      await conn.end();
    })();`;
  const output = docker(
    'exec',
    GHOST_NAME,
    'node',
    '-e',
    script,
    JSON.stringify([statement, ...params])
  );
  return JSON.parse(output);
}

let ghostBase;

before(async () => {
  docker('network', 'create', NETWORK);
  docker(
    'run',
    '-d',
    '--name',
    MYSQL_NAME,
    '--network',
    NETWORK,
    '-e',
    `MYSQL_ROOT_PASSWORD=${ROOT_PASSWORD}`,
    '-e',
    `MYSQL_DATABASE=${DB_NAME}`,
    '-e',
    `MYSQL_USER=${DB_USER}`,
    '-e',
    `MYSQL_PASSWORD=${DB_PASSWORD}`,
    MYSQL_IMAGE,
    // db1 runs with this set (db/stack/conf.d/branchleft.cnf) -- every TCP
    // connection must be TLS. The official image auto-generates a
    // self-signed cert pair on first start when none is supplied, so TLS
    // is available without any extra setup here; this only turns on the
    // *requirement*, matching production rather than the plaintext default
    // cycle-2's fixture ran against.
    '--require-secure-transport=ON'
  );
  const mysqlReady = await waitForMysqlReady();
  assert.equal(mysqlReady, true, 'MySQL failed to become ready');

  const port = await freePort();
  const env = {
    url: `http://localhost:${port}`,
    database__client: 'mysql',
    database__connection__host: MYSQL_NAME,
    database__connection__port: '3306',
    database__connection__database: DB_NAME,
    database__connection__user: DB_USER,
    database__connection__password: DB_PASSWORD,
    // The one ssl key render-core renders for every real MySQL tenant
    // (render-core/src/environment.ts's databaseEnvironment) -- with
    // --require-secure-transport=ON above, a fixture missing this key
    // reproduces exactly the failure a paying tenant would hit.
    database__connection__ssl__rejectUnauthorized: 'false',
    privacy__useUpdateCheck: 'false',
    mail__transport: 'stub',
    // This test never uploads or reads media -- it exists to prove the
    // provisioning script against a real MySQL backend, not to prove
    // storage. The local-dev hatch (docker-entrypoint.branchleft.sh)
    // waives only durability now, not the scanning decorator itself, so
    // the decorator still has to be named per feature even though this
    // test never exercises it.
    BRANCHLEFT_ALLOW_LOCAL_STORAGE: 'true',
    storage__images__adapter: 'ScanningStorageAdapter',
    storage__images__wraps: 'LocalImagesStorage',
    storage__images__quarantinePath: '/var/lib/ghost/content/quarantine',
    storage__media__adapter: 'ScanningStorageAdapter',
    storage__media__wraps: 'LocalMediaStorage',
    storage__media__quarantinePath: '/var/lib/ghost/content/quarantine',
    storage__files__adapter: 'ScanningStorageAdapter',
    storage__files__wraps: 'LocalFilesStorage',
    storage__files__quarantinePath: '/var/lib/ghost/content/quarantine',
  };
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  docker(
    'run',
    '-d',
    '--name',
    GHOST_NAME,
    '--network',
    NETWORK,
    '-p',
    `127.0.0.1:${port}:2368`,
    ...envArgs,
    IMAGE
  );
  ghostBase = `http://localhost:${port}`;
  const ghostReady = await waitForGhostHome(ghostBase);
  assert.equal(ghostReady, true, 'Ghost failed to boot against MySQL');
});

after(() => {
  spawnSync('docker', ['rm', '-f', GHOST_NAME]);
  spawnSync('docker', ['rm', '-f', MYSQL_NAME]);
  spawnSync('docker', ['network', 'rm', NETWORK]);
});

describe('provision-support-account.mjs, against a real MySQL 8 backend', () => {
  it('creates the row suspended, with an Administrator role, and no usable password', () => {
    const result = provisionSupportAccount({
      container: GHOST_NAME,
      email: 'support-mysql@platform.example',
    });
    assert.equal(result.created, true);
    assert.equal(result.status, SUSPENDED_STATUS);

    const [row] = sqlOnGhost(
      'select id, status, password from users where email = ?',
      'support-mysql@platform.example'
    );
    assert.equal(row.status, 'inactive');
    assert.match(row.password, /^\$2a\$10\$[A-Za-z0-9]+$/);

    const [role] = sqlOnGhost(
      `select r.name from roles r
         join roles_users ru on ru.role_id = r.id
        where ru.user_id = ?`,
      row.id
    );
    assert.equal(role.name, 'Administrator');
  });

  it('is idempotent: a second run leaves the existing, complete row exactly as it found it', () => {
    const [before_] = sqlOnGhost(
      'select id, password from users where email = ?',
      'support-mysql@platform.example'
    );
    const result = provisionSupportAccount({
      container: GHOST_NAME,
      email: 'support-mysql@platform.example',
    });
    assert.equal(result.created, false);
    assert.equal(result.repaired, false);
    assert.equal(result.id, before_.id);
    const [after_] = sqlOnGhost(
      'select id, password from users where email = ?',
      'support-mysql@platform.example'
    );
    assert.equal(after_.password, before_.password);
  });

  it("inactive-without-role: repairs a row that is exactly this script's own interrupted write", () => {
    const email = 'support-mysql-partial@platform.example';
    const id = 'b'.repeat(24);
    sqlOnGhost(
      `insert into users (id, name, slug, password, email, status, visibility,
        comment_notifications, free_member_signup_notification,
        paid_subscription_started_notification, paid_subscription_canceled_notification,
        mention_notifications, recommendation_notifications, milestone_notifications,
        donation_notifications, gift_subscription_notifications, created_at)
       values (?, 'Support', 'support-mysql-partial', ?, ?, 'inactive', 'public', 1, 1, 1, 1, 1, 1, 1, 1, 1, ?)`,
      id,
      '$2a$10$unusable',
      email,
      new Date().toISOString().slice(0, 19).replace('T', ' ')
    );

    const result = provisionSupportAccount({ container: GHOST_NAME, email });
    assert.equal(result.created, false);
    assert.equal(result.repaired, true);
    assert.equal(result.status, 'inactive');

    const [role] = sqlOnGhost(
      `select r.name from roles r
         join roles_users ru on ru.role_id = r.id
        where ru.user_id = ?`,
      id
    );
    assert.equal(role.name, 'Administrator');
  });

  it('active-without-role: refuses rather than granting Administrator, and changes nothing', () => {
    const email = 'support-mysql-active@platform.example';
    const id = 'c'.repeat(24);
    sqlOnGhost(
      `insert into users (id, name, slug, password, email, status, visibility,
        comment_notifications, free_member_signup_notification,
        paid_subscription_started_notification, paid_subscription_canceled_notification,
        mention_notifications, recommendation_notifications, milestone_notifications,
        donation_notifications, gift_subscription_notifications, created_at)
       values (?, 'Support', 'support-mysql-active', ?, ?, 'active', 'public', 1, 1, 1, 1, 1, 1, 1, 1, 1, ?)`,
      id,
      '$2a$10$unusable',
      email,
      new Date().toISOString().slice(0, 19).replace('T', ' ')
    );

    assert.throws(
      () => provisionSupportAccount({ container: GHOST_NAME, email }),
      PartialRowMismatchError
    );

    // Nothing was granted: still no role link, and status untouched.
    const linked = sqlOnGhost(
      `select r.name from roles r
         join roles_users ru on ru.role_id = r.id
        where ru.user_id = ?`,
      id
    );
    assert.equal(linked.length, 0, 'RED: Administrator must not have been granted');
    const [row] = sqlOnGhost('select status from users where id = ?', id);
    assert.equal(row.status, 'active', 'status must be untouched');
  });
});
