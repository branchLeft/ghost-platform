// Drives the real, built Ghost image: the provisioning script creates the
// support account through the tenant's own running container, exactly as
// it would at real onboarding, and the account is then driven through the
// real break-glass login path -- the same adapter, the same image,
// `break-glass.image.test.mjs` already proves the adapter against.
//
// Usage:
//   IMAGE=ghost-platform:ci npm --prefix adapters/sso run test:image
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import { claimsFor, generateKeyPair, mint } from '../helpers/token.mjs';
import {
  provisionSupportAccount,
  SUSPENDED_STATUS,
} from '../../scripts/provision-support-account.mjs';

const IMAGE = process.env.IMAGE;
if (!IMAGE) {
  throw new Error('IMAGE must name the built Ghost image, e.g. IMAGE=ghost-platform:ci');
}

const TENANT = 'tenant-zero';
const SUPPORT = 'support-provisioned@platform.example';
const PARTIAL_SUPPORT = 'support-partial@platform.example';
const BOOT_TIMEOUT_MS = 90_000;
const key = generateKeyPair();

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

class GhostContainer {
  static async start() {
    const port = await freePort();
    const name = `provision-support-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const env = {
      url: `http://localhost:${port}`,
      database__client: 'sqlite3',
      database__connection__filename: '/var/lib/ghost/content/data/ghost.db',
      privacy__useUpdateCheck: 'false',
      mail__transport: 'stub',
      BRANCHLEFT_ALLOW_LOCAL_STORAGE: 'true',
      adapters__sso__active: 'BreakGlassSSO',
      adapters__sso__BreakGlassSSO__publicKey: key.publicKeyBase64,
      adapters__sso__BreakGlassSSO__tenant: TENANT,
      adapters__sso__BreakGlassSSO__supportIdentity: SUPPORT,
    };
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    docker('create', '--name', name, '-p', `127.0.0.1:${port}:2368`, ...envArgs, IMAGE);
    const container = new GhostContainer(name, port);
    docker('start', name);
    container.booted = await container.waitForHome();
    return container;
  }

  constructor(name, port) {
    this.name = name;
    this.port = port;
    this.base = `http://localhost:${port}`;
  }

  async waitForHome() {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.base}/`);
        if (res.status === 200) return true;
      } catch {
        // not listening yet
      }
      const state = docker('inspect', '-f', '{{.State.Running}}', this.name).trim();
      if (state !== 'true') return false;
      await sleep(500);
    }
    return false;
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

  async me(cookie) {
    const res = await fetch(`${this.base}/ghost/api/admin/users/me/`, {
      headers: { origin: this.base, ...(cookie ? { cookie } : {}) },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, email: body?.users?.[0]?.email ?? null };
  }

  async attempt(token) {
    const query = token === undefined ? '' : `?bl_break_glass=${encodeURIComponent(token)}`;
    const res = await fetch(`${this.base}/ghost/${query}`, { redirect: 'manual' });
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    return this.me(cookie || undefined);
  }

  destroy() {
    spawnSync('docker', ['rm', '-f', this.name]);
  }
}

let ghost;

before(async () => {
  ghost = await GhostContainer.start();
  assert.equal(ghost.booted, true, 'Ghost failed to boot');
});

after(() => {
  ghost?.destroy();
});

function freshToken() {
  return mint(key.privateKey, claimsFor({ sub: SUPPORT, aud: TENANT }));
}

describe('provision-support-account.mjs, against the real image', () => {
  it('creates the row suspended, with an Administrator role, and no usable password', () => {
    const result = provisionSupportAccount({ container: ghost.name, email: SUPPORT });
    assert.equal(result.created, true);
    assert.equal(result.status, SUSPENDED_STATUS);

    const [row] = ghost.sql('select id, status, password from users where email = ?', SUPPORT);
    assert.equal(row.status, 'inactive');
    assert.match(row.password, /^\$2a\$10\$[A-Za-z0-9]+$/);

    const [role] = ghost.sql(
      `select r.name from roles r
         join roles_users ru on ru.role_id = r.id
        where ru.user_id = ?`,
      row.id
    );
    assert.equal(role.name, 'Administrator');
  });

  it('is idempotent: a second run leaves the existing row exactly as it found it', () => {
    const [before_] = ghost.sql('select id, password from users where email = ?', SUPPORT);
    const result = provisionSupportAccount({ container: ghost.name, email: SUPPORT });
    assert.equal(result.created, false);
    assert.equal(result.repaired, false, 'a complete row must not be reported as repaired');
    assert.equal(result.id, before_.id);
    const [after_] = ghost.sql('select id, password from users where email = ?', SUPPORT);
    assert.equal(after_.password, before_.password);
  });

  it('repairs a partial row -- a user that exists with no Administrator link -- rather than skipping it', () => {
    // Simulates exactly what finding 2 of the first review round named: a
    // `docker exec` killed between the two inserts the pre-fix script made
    // as separate statements. Inserted directly, bypassing the script, so
    // this test does not depend on the script's own atomicity to produce
    // the partial state it exercises.
    const id = 'a'.repeat(24);
    ghost.sql(
      `insert into users (id, name, slug, password, email, status, visibility,
        comment_notifications, free_member_signup_notification,
        paid_subscription_started_notification, paid_subscription_canceled_notification,
        mention_notifications, recommendation_notifications, milestone_notifications,
        donation_notifications, gift_subscription_notifications, created_at)
       values (?, 'Support', 'support-partial', ?, ?, 'inactive', 'public', 1, 1, 1, 1, 1, 1, 1, 1, 1, ?)`,
      id,
      '$2a$10$unusable',
      PARTIAL_SUPPORT,
      new Date().toISOString().replace('T', ' ').slice(0, 19)
    );
    const [noLinkYet] = ghost.sql(
      `select r.name from roles r
         join roles_users ru on ru.role_id = r.id
        where ru.user_id = ?`,
      id
    );
    assert.equal(noLinkYet, undefined, 'the partial row must start with no Administrator link');

    const result = provisionSupportAccount({ container: ghost.name, email: PARTIAL_SUPPORT });
    assert.equal(result.created, false, 'the user row already existed');
    assert.equal(result.repaired, true, 'the missing link must be reported as repaired');
    assert.equal(result.id, id);
    assert.equal(result.status, 'inactive', 'repair must never touch status');

    const [role] = ghost.sql(
      `select r.name from roles r
         join roles_users ru on ru.role_id = r.id
        where ru.user_id = ?`,
      id
    );
    assert.equal(role.name, 'Administrator', 'the link must now exist');

    // Idempotent on the repaired row too: a third run neither re-inserts
    // the link (which would violate a unique constraint) nor reports it as
    // repaired again.
    const again = provisionSupportAccount({ container: ghost.name, email: PARTIAL_SUPPORT });
    assert.equal(again.repaired, false);
  });

  it('the provisioned account is inert on the break-glass login path -- suspended at rest, through the real entry point', async () => {
    const suspended = await ghost.attempt(freshToken());
    assert.equal(suspended.status, 403);
    assert.equal(suspended.email, null);
  });

  it('SABOTAGE: an account provisioned active (not suspended) is NOT inert -- the control this script exists to hold', async () => {
    // Simulates what a provisioning step that accepted (or defaulted to) an
    // "active" status would have produced -- never reachable through this
    // script's own argument surface (see provision-support-account.test.mjs's
    // "never passes a --status-like flag" case), reproduced here directly
    // against the row to prove what its absence protects against.
    ghost.sql('update users set status = ? where email = ?', 'active', SUPPORT);
    try {
      const activeResult = await ghost.attempt(freshToken());
      assert.equal(activeResult.status, 200, 'RED: an actively-provisioned account is not inert');
      assert.equal(activeResult.email, SUPPORT, 'RED: the break-glass path signed in as support');
    } finally {
      // Revert -- back to the suspended resting state this control provides.
      ghost.sql('update users set status = ? where email = ?', 'inactive', SUPPORT);
    }
    const resuspended = await ghost.attempt(freshToken());
    assert.equal(resuspended.status, 403, 'GREEN: suspended again, inert once more');
  });
});
