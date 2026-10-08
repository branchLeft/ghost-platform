// The minter, the two grant lanes and the four-hour clock against the built
// Ghost image. Usage:
//   IMAGE=ghost-platform:ci npm --prefix adapters/sso run test:image
// See break-glass-lanes.image.test.md for what each case proves and why the
// minter runs in a container here.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultDeps,
  expire,
  grant,
  GRANT_WINDOW_SECONDS,
  GrantRefusedError,
  revoke,
  status,
} from '../../scripts/break-glass-grant.mjs';
import { provisionSupportAccount } from '../../scripts/provision-support-account.mjs';

const IMAGE = process.env.IMAGE;
if (!IMAGE) {
  throw new Error('IMAGE must name the built Ghost image, e.g. IMAGE=ghost-platform:ci');
}
// The Node image the minter runs in on ops1 (break-glass-mint.md, "Running it").
const NODE_IMAGE =
  process.env.NODE_IMAGE ??
  'node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb';
const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts');

const TENANT = `bg-lanes-${crypto.randomBytes(3).toString('hex')}`;
const SUPPORT = 'support@platform.example';
const OWNER = 'owner@example.com';
const STAFF = 'staff-admin@tenant.example';
const BOOT_TIMEOUT_MS = 90_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-lanes-'));
const keyDirs = { a: path.join(work, 'key-a'), b: path.join(work, 'key-b') };
const auditDir = path.join(work, 'audit');
for (const d of [...Object.values(keyDirs), auditDir]) fs.mkdirSync(d, { mode: 0o700 });
/** Creates the key as ops1 does (runbook A step 4): the minter's own keygen, as root, in the pinned image. */
function containerKeygen(keyDir) {
  const out = docker(
    'run',
    '--rm',
    '--network',
    'none',
    '-v',
    `${keyDir}:/etc/branchleft/break-glass`,
    '-v',
    `${SCRIPTS}:/usr/local/lib/branchleft/break-glass:ro`,
    NODE_IMAGE,
    'node',
    '/usr/local/lib/branchleft/break-glass/break-glass-mint.mjs',
    'keygen'
  );
  return /^public key (\S+)$/m.exec(out)[1];
}
const publicKeys = { a: containerKeygen(keyDirs.a), b: containerKeygen(keyDirs.b) };
const volume = `${TENANT}-content`;

/** Runs the real minter CLI exactly as ops1 does: pinned Node, no network, key read-only. */
function mintCli(keyName, ...args) {
  const r = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `${keyDirs[keyName]}:/etc/branchleft/break-glass:ro`,
      '-v',
      `${auditDir}:/var/log/branchleft`,
      '-v',
      `${SCRIPTS}:/usr/local/lib/branchleft/break-glass:ro`,
      NODE_IMAGE,
      'node',
      '/usr/local/lib/branchleft/break-glass/break-glass-mint.mjs',
      ...args,
    ],
    { encoding: 'utf8' }
  );
  return { code: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

/** The audit file is root's and 0600, as on ops1, so it is read as root too. */
function readMintAudit() {
  return docker(
    'run',
    '--rm',
    '--network',
    'none',
    '-v',
    `${auditDir}:/var/log/branchleft:ro`,
    NODE_IMAGE,
    'cat',
    '/var/log/branchleft/break-glass-mint.jsonl'
  );
}

function mintToken(keyName = 'a', ttl = '600') {
  const r = mintCli(
    keyName,
    'mint',
    '--tenant',
    TENANT,
    '--identity',
    SUPPORT,
    '--reason',
    'image test',
    '--ttl',
    ttl
  );
  assert.equal(r.code, 0, `mint failed: ${r.stderr}`);
  return r.stdout;
}

class Tenant {
  async start(keyName) {
    this.port = this.port ?? (await freePort());
    this.base = `http://localhost:${this.port}`;
    this.name = `${TENANT}-ghost-a-1`;
    const env = {
      url: this.base,
      database__client: 'sqlite3',
      database__connection__filename: '/var/lib/ghost/content/data/ghost.db',
      privacy__useUpdateCheck: 'false',
      mail__transport: 'stub',
      BRANCHLEFT_ALLOW_LOCAL_STORAGE: 'true',
      adapters__sso__active: 'BreakGlassSSO',
      adapters__sso__BreakGlassSSO__publicKey: publicKeys[keyName],
      adapters__sso__BreakGlassSSO__tenant: TENANT,
      adapters__sso__BreakGlassSSO__supportIdentity: SUPPORT,
    };
    for (const feature of ['images', 'media', 'files']) {
      const wrapped = {
        images: 'LocalImagesStorage',
        media: 'LocalMediaStorage',
        files: 'LocalFilesStorage',
      }[feature];
      env[`storage__${feature}__adapter`] = 'ScanningStorageAdapter';
      env[`storage__${feature}__wraps`] = wrapped;
      env[`storage__${feature}__quarantinePath`] = '/var/lib/ghost/content/quarantine';
    }
    docker(
      'run',
      '-d',
      '--name',
      this.name,
      '--label',
      `com.docker.compose.project=${TENANT}`,
      '--label',
      'com.docker.compose.service=ghost-a',
      '-v',
      `${volume}:/var/lib/ghost/content`,
      '-p',
      `127.0.0.1:${this.port}:2368`,
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      IMAGE
    );
    await this.waitForHome();
  }

  async waitForHome() {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${this.base}/`)).status === 200) return;
      } catch {
        // not listening yet
      }
      await sleep(500);
    }
    throw new Error(`Ghost did not boot:\n${this.logs().slice(-40).join('\n')}`);
  }

  remove() {
    spawnSync('docker', ['rm', '-f', this.name], { stdio: 'ignore' });
  }

  logs() {
    const out = spawnSync('docker', ['logs', this.name], { encoding: 'utf8' });
    return `${out.stdout}${out.stderr}`.split('\n');
  }

  adapterReasons() {
    return this.logs()
      .map((l) => l.replace(/\u001b\[[0-9;]*m/g, ''))
      .filter((l) => l.includes('break-glass: token'))
      .map((l) => l.slice(l.indexOf('break-glass: token')));
  }

  sql(statement, ...params) {
    const script = `
      const Database = require(require.resolve('better-sqlite3', { paths: ['/var/lib/ghost/current'] }));
      const db = new Database('/var/lib/ghost/content/data/ghost.db');
      const [statement, ...params] = JSON.parse(process.argv[1]);
      const stmt = db.prepare(statement);
      console.log(JSON.stringify(stmt.reader ? stmt.all(...params) : stmt.run(...params)));`;
    return JSON.parse(
      docker('exec', this.name, 'node', '-e', script, JSON.stringify([statement, ...params]))
    );
  }

  support() {
    return this.sql('select id, status from users where email = ?', SUPPORT)[0] ?? null;
  }

  sessions() {
    const row = this.support();
    return row ? this.sql('select count(*) as n from sessions where user_id = ?', row.id)[0].n : 0;
  }

  setStatus(value) {
    this.sql('update users set status = ? where email = ?', value, SUPPORT);
  }

  statusOf(email) {
    return this.sql('select status from users where email = ?', email)[0]?.status ?? null;
  }

  setStatusOf(email, value) {
    this.sql('update users set status = ? where email = ?', value, email);
  }

  /** A staff Administrator of the tenant's own, with a password hash nobody holds. */
  addStaffAdministrator(email, status) {
    const id = crypto.randomBytes(12).toString('hex');
    this.sql(
      `insert into users (id, name, slug, password, email, status, visibility, comment_notifications,
        free_member_signup_notification, paid_subscription_started_notification,
        paid_subscription_canceled_notification, mention_notifications, recommendation_notifications,
        milestone_notifications, donation_notifications, gift_subscription_notifications, created_at)
       values (?, 'Staff', 'staff', ?, ?, ?, 'public', 1, 1, 1, 1, 1, 1, 1, 1, 1, ?)`,
      id,
      `$2a$10$${crypto.randomBytes(30).toString('hex').slice(0, 53)}`,
      email,
      status,
      new Date().toISOString().replace('T', ' ').slice(0, 19)
    );
    const [{ id: roleId }] = this.sql(`select id from roles where name = 'Administrator'`);
    this.sql(
      'insert into roles_users (id, role_id, user_id) values (?, ?, ?)',
      crypto.randomBytes(12).toString('hex'),
      roleId,
      id
    );
  }

  setSupportRole(name) {
    const [{ id: roleId }] = this.sql('select id from roles where name = ?', name);
    this.sql('update roles_users set role_id = ? where user_id = ?', roleId, this.support().id);
  }

  deleteSupport() {
    const row = this.support();
    this.sql('delete from sessions where user_id = ?', row.id);
    this.sql('delete from roles_users where user_id = ?', row.id);
    this.sql('delete from users where id = ?', row.id);
  }

  async setupOwner() {
    const res = await fetch(`${this.base}/ghost/api/admin/authentication/setup/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: this.base },
      body: JSON.stringify({
        setup: [
          {
            name: 'Owner',
            email: OWNER,
            password: crypto.randomBytes(24).toString('hex'),
            blogTitle: 'Site',
          },
        ],
      }),
    });
    assert.equal(res.status, 201, 'owner setup');
  }

  async me(cookie) {
    const res = await fetch(`${this.base}/ghost/api/admin/users/me/`, {
      headers: { origin: this.base, ...(cookie ? { cookie } : {}) },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, email: body?.users?.[0]?.email ?? null };
  }

  /** Opens /ghost/ with the token, as the operator's browser would. */
  async open(token) {
    const before = this.adapterReasons().length;
    const res = await fetch(`${this.base}/ghost/?bl_break_glass=${encodeURIComponent(token)}`, {
      redirect: 'manual',
    });
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const me = await this.me(cookie || undefined);
    await sleep(300);
    return { ...me, cookie, adapter: this.adapterReasons().slice(before) };
  }
}

describe(
  'break-glass minting, the two lanes and the four-hour clock (LLD-5 §05)',
  { timeout: 600_000 },
  () => {
    const tenant = new Tenant();
    let clock = Date.now();
    const deps = {
      ...defaultDeps(),
      stateDir: path.join(work, 'grants'),
      recordLog: path.join(work, 'grants.jsonl'),
      now: () => clock,
      // No systemd here: the timer's presence is a unit-tested refusal.
      timerActive: () => true,
    };
    const records = () =>
      fs
        .readFileSync(deps.recordLog, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
    const atDeadline = () => {
      clock = Date.parse(status(deps)[0].deadline);
    };

    before(async () => {
      docker('volume', 'create', volume);
      await tenant.start('a');
      await tenant.setupOwner();
      const created = provisionSupportAccount({ container: tenant.name, email: SUPPORT });
      assert.equal(created.status, 'inactive');
    });

    after(() => {
      tenant.remove();
      spawnSync('docker', ['volume', 'rm', '-f', volume], { stdio: 'ignore' });
      fs.rmSync(work, { recursive: true, force: true });
    });

    it('the minter refuses a lifetime over 600 seconds, and its tokens carry at most 600', () => {
      const refused = mintCli(
        'a',
        'mint',
        '--tenant',
        TENANT,
        '--identity',
        SUPPORT,
        '--reason',
        'r',
        '--ttl',
        '601'
      );
      assert.equal(refused.code, 2, refused.stderr);
      assert.match(refused.stderr, /--ttl must be a whole number of seconds from 1 to 600/);
      const token = mintToken('a', '600');
      const claims = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
      assert.equal(claims.exp - claims.iat, 600);
      const audit = readMintAudit();
      assert.ok(audit.includes(claims.jti), 'the mint is recorded by jti');
      assert.ok(!audit.includes(token.split('.')[1]), 'the record never holds the token');
    });

    it('the minter refuses a key any other user could read', () => {
      // The key is copied onto the container's own filesystem and its mode set
      // there: a desktop Docker's file sharing can cache a bind mount's modes.
      const r = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '-v',
          `${keyDirs.a}:/src:ro`,
          '-v',
          `${SCRIPTS}:/usr/local/lib/branchleft/break-glass:ro`,
          NODE_IMAGE,
          'sh',
          '-c',
          'install -d -m 700 /etc/branchleft/break-glass /var/log/branchleft && ' +
            'install -m 644 /src/signing-key.pem /etc/branchleft/break-glass/ && ' +
            'node /usr/local/lib/branchleft/break-glass/break-glass-mint.mjs mint ' +
            `--tenant ${TENANT} --identity ${SUPPORT} --reason r`,
        ],
        { encoding: 'utf8' }
      );
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /readable by its owner only/);
      assert.equal(r.stdout, '', 'nothing was minted');
    });

    it('suspended at rest: a minted token opens nothing', async () => {
      const r = await tenant.open(mintToken());
      assert.equal(r.status, 403);
      assert.deepEqual(r.adapter, ['break-glass: token refused (account not active)']);
    });

    it('consented lane: refused until the tenant un-suspends, and nothing is left open', async () => {
      await assert.rejects(
        grant(
          { lane: 'consented', tenant: TENANT, identity: SUPPORT, reason: 'r', reference: 'ref' },
          deps
        ),
        (e) => e instanceof GrantRefusedError && /has not un-suspended/.test(e.message)
      );
      assert.deepEqual(status(deps), []);
    });

    it('incident lane: a deleted account is recreated; the session dies at the end of the window and a fresh login is refused', async () => {
      tenant.deleteSupport();
      assert.equal(tenant.support(), null);
      const opened = await grant(
        {
          lane: 'incident',
          tenant: TENANT,
          identity: SUPPORT,
          reason: 'readers see errors',
          reference: 'incident-1',
        },
        deps
      );
      assert.equal(opened.recreated, true);
      assert.equal(tenant.support().status, 'active');
      assert.equal(Date.parse(opened.deadline) - clock, GRANT_WINDOW_SECONDS * 1000);

      const session = await tenant.open(mintToken());
      assert.equal(session.status, 200, JSON.stringify(session.adapter));
      assert.equal(session.email, SUPPORT);

      clock = Date.parse(opened.deadline) - 1000;
      assert.deepEqual((await expire(deps)).closed, [], 'nothing closes before the deadline');
      assert.equal((await tenant.me(session.cookie)).status, 200);

      atDeadline();
      const { closed, failed } = await expire(deps);
      assert.deepEqual(failed, []);
      assert.equal(
        closed.length,
        1,
        'SESSION DIES AT THE END OF THE WINDOW: the timer closed the grant'
      );
      assert.equal(tenant.support().status, 'inactive');
      assert.equal(tenant.sessions(), 0);
      assert.equal((await tenant.me(session.cookie)).status, 403, 'the open session is dead');
      const fresh = await tenant.open(mintToken());
      assert.equal(fresh.status, 403, 'a fresh login is refused');
      assert.deepEqual(fresh.adapter, ['break-glass: token refused (account not active)']);
      assert.deepEqual(
        records().map((r) => [r.event, r.lane, r.cause ?? null]),
        [
          ['opened', 'incident', null],
          ['closed', 'incident', 'timer'],
        ]
      );
    });

    it('requirement 2: the timer purges sessions even when the tenant already re-suspended, so nothing wakes', async () => {
      tenant.setStatus('active'); // the tenant un-suspends from the Staff screen
      await grant(
        {
          lane: 'consented',
          tenant: TENANT,
          identity: SUPPORT,
          reason: 'r',
          reference: 'activity log',
        },
        deps
      );
      const session = await tenant.open(mintToken());
      assert.equal(session.status, 200, JSON.stringify(session.adapter));
      tenant.setStatus('inactive'); // the tenant closes the door early
      assert.ok(tenant.sessions() >= 1, 'a dormant session row survives the re-suspend');

      atDeadline();
      const { closed } = await expire(deps);
      assert.equal(closed.length, 1);
      assert.equal(closed[0].previousStatus, 'inactive');
      assert.equal(tenant.sessions(), 0, 'the dormant session was purged');
      tenant.setStatus('active'); // un-suspended again, months later
      assert.equal((await tenant.me(session.cookie)).status, 403, 'nothing woke');
      tenant.setStatus('inactive');
    });

    it('requirement 1: revoke purges twice, so a session written after the first purge is gone too', async () => {
      tenant.setStatus('active');
      await grant(
        {
          lane: 'consented',
          tenant: TENANT,
          identity: SUPPORT,
          reason: 'r',
          reference: 'activity log',
        },
        deps
      );
      const session = await tenant.open(mintToken());
      assert.equal(session.status, 200);
      const [row] = tenant.sql('select * from sessions where user_id = ?', tenant.support().id);
      const late = async () => {
        // The race: Ghost writes a session the adapter admitted before the revoke landed.
        tenant.sql(
          'insert into sessions (id, session_id, user_id, session_data, created_at, updated_at) values (?, ?, ?, ?, ?, ?)',
          crypto.randomBytes(12).toString('hex'),
          crypto.randomBytes(16).toString('hex'),
          row.user_id,
          row.session_data,
          row.created_at,
          row.updated_at
        );
      };
      const closing = await revoke(
        { tenant: TENANT, reason: 'done' },
        { ...deps, betweenPurges: late }
      );
      assert.deepEqual(closing.sessionsPurged, [1, 1]);
      assert.equal(tenant.sessions(), 0);
    });

    it('a grant never acts on the Owner: a typed Owner email is refused and nothing is written', async () => {
      await assert.rejects(
        grant(
          { lane: 'incident', tenant: TENANT, identity: OWNER, reason: 'r', reference: 'ref' },
          deps
        ),
        /is not this tenant's configured support identity/
      );
      assert.deepEqual(status(deps), []);
      assert.equal(tenant.statusOf(OWNER), 'active');
    });

    it("a grant never acts on the tenant's own staff Administrator, whichever lane", async () => {
      tenant.addStaffAdministrator(STAFF, 'inactive'); // a departed colleague, suspended by the tenant
      await assert.rejects(
        grant(
          { lane: 'incident', tenant: TENANT, identity: STAFF, reason: 'r', reference: 'ref' },
          deps
        ),
        /is not this tenant's configured support identity/
      );
      assert.equal(tenant.statusOf(STAFF), 'inactive', 'STAFF NOT ACTIVATED');
      assert.deepEqual(status(deps), []);

      tenant.setStatusOf(STAFF, 'active'); // a working colleague
      await assert.rejects(
        grant(
          { lane: 'consented', tenant: TENANT, identity: STAFF, reason: 'r', reference: 'ref' },
          deps
        ),
        /is not this tenant's configured support identity/
      );
      // With no identity typed, the lanes act on the configured support account only.
      tenant.setStatus('active');
      await grant({ lane: 'consented', tenant: TENANT, reason: 'r', reference: 'ref' }, deps);
      const closing = await revoke({ tenant: TENANT, reason: 'done' }, deps);
      assert.equal(closing.identity, SUPPORT);
      assert.equal(tenant.statusOf(STAFF), 'active', 'STAFF NOT SUSPENDED');
      assert.equal(tenant.support().status, 'inactive');
    });

    it('activate refuses a support account the tenant moved to another role', async () => {
      tenant.setSupportRole('Editor');
      try {
        await assert.rejects(
          grant({ lane: 'incident', tenant: TENANT, reason: 'r', reference: 'ref' }, deps),
          /not the support Administrator/
        );
        assert.equal(tenant.support().status, 'inactive', 'ROLE-CHANGED ACCOUNT NOT ACTIVATED');
      } finally {
        // An incident grant that fails keeps its clock; revoke closes it.
        await revoke({ tenant: TENANT, reason: 'tidy' }, deps);
        tenant.setSupportRole('Administrator');
      }
    });

    it('expire closes a grant whose state file is corrupt: suspended and purged', async () => {
      tenant.setStatus('active');
      await grant({ lane: 'consented', tenant: TENANT, reason: 'r', reference: 'ref' }, deps);
      const session = await tenant.open(mintToken());
      assert.equal(session.status, 200, JSON.stringify(session.adapter));
      fs.writeFileSync(path.join(deps.stateDir, `${TENANT}.json`), '{"tenant":"trunc');
      const { closed, failed } = await expire(deps);
      assert.deepEqual(failed, []);
      assert.equal(closed.length, 1, 'CORRUPT STATE CLOSED');
      assert.match(closed[0].stateUnreadable, /not JSON/);
      assert.equal(tenant.support().status, 'inactive');
      assert.equal(tenant.sessions(), 0);
      assert.equal((await tenant.me(session.cookie)).status, 403);
    });

    it('revoke closes the support account with no state file at all', async () => {
      tenant.setStatus('active');
      await grant({ lane: 'consented', tenant: TENANT, reason: 'r', reference: 'ref' }, deps);
      const session = await tenant.open(mintToken());
      assert.equal(session.status, 200, JSON.stringify(session.adapter));
      fs.rmSync(path.join(deps.stateDir, `${TENANT}.json`));
      const closing = await revoke({ tenant: TENANT, reason: 'state lost' }, deps);
      assert.equal(closing.stateFound, false);
      assert.equal(tenant.support().status, 'inactive', 'CLOSED WITHOUT STATE');
      assert.equal(tenant.sessions(), 0);
    });

    it('requirement 5: a Ghost restart voids every outstanding token; a fresh mint works', async () => {
      tenant.setStatus('active');
      const beforeRestart = mintToken('a');
      docker('restart', tenant.name);
      await tenant.waitForHome();
      await sleep(1500); // the adapter compares whole seconds against its own start
      const stale = await tenant.open(beforeRestart);
      assert.equal(stale.status, 403);
      assert.deepEqual(stale.adapter, [
        'break-glass: token refused (issued before this process started)',
      ]);
      const fresh = await tenant.open(mintToken('a'));
      assert.equal(fresh.status, 200, JSON.stringify(fresh.adapter));
      tenant.setStatus('inactive');
    });

    it('key rotation, rehearsed: after the public half is rotated in the rendered config, the old key is refused and the new one accepted', async () => {
      tenant.setStatus('active');
      tenant.remove();
      await tenant.start('b'); // the rendered config now carries key B's public half
      await sleep(1500);
      const oldKey = await tenant.open(mintToken('a'));
      assert.equal(oldKey.status, 403);
      assert.deepEqual(oldKey.adapter, ['break-glass: token refused (signature)']);
      const newKey = await tenant.open(mintToken('b'));
      assert.equal(newKey.status, 200, JSON.stringify(newKey.adapter));
      tenant.setStatus('inactive');
    });
  }
);
