// Drives the built Ghost image through the real adapter manager, the real
// session middleware and a real database. Usage:
//   IMAGE=ghost-platform:ci npm --prefix adapters/sso run test:image
//
// Every refusal is asserted twice: Ghost's answer (no Administrator session)
// and the adapter's own reason in the container log. Ghost swallows adapter
// errors and falls through to the login page, so a 403 alone cannot tell a
// refusing adapter from one that is not wired in at all.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { claimsFor, generateKeyPair, mint } from '../helpers/token.mjs';

const IMAGE = process.env.IMAGE;
if (!IMAGE) {
  throw new Error('IMAGE must name the built Ghost image, e.g. IMAGE=ghost-platform:ci');
}

const TENANT = 'tenant-zero';
const SUPPORT = 'support@platform.example';
const OWNER = 'owner@example.com';
const BOOT_TIMEOUT_MS = 90_000;

const tenantKey = generateKeyPair();
const otherKey = generateKeyPair();

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
  static async start({ adapterConfig, active = 'BreakGlassSSO', plant } = {}) {
    const port = await freePort();
    const name = `bg-sso-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const env = {
      url: `http://localhost:${port}`,
      database__client: 'sqlite3',
      database__connection__filename: '/var/lib/ghost/content/data/ghost.db',
      privacy__useUpdateCheck: 'false',
      mail__transport: 'stub',
      BRANCHLEFT_ALLOW_LOCAL_STORAGE: 'true',
    };
    if (active) env.adapters__sso__active = active;
    for (const [key, value] of Object.entries(adapterConfig ?? {})) {
      env[`adapters__sso__BreakGlassSSO__${key}`] = value;
    }
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    docker('create', '--name', name, '-p', `127.0.0.1:${port}:2368`, ...envArgs, IMAGE);
    const container = new GhostContainer(name, port);
    if (plant) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-plant-'));
      fs.mkdirSync(path.join(dir, 'adapters', 'sso'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'adapters', 'sso', 'BreakGlassSSO.js'), plant);
      docker('cp', path.join(dir, 'adapters'), `${name}:/var/lib/ghost/content/`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  logs() {
    const out = spawnSync('docker', ['logs', this.name], { encoding: 'utf8' });
    return `${out.stdout}${out.stderr}`.split('\n');
  }

  // The adapter's own lines, colour codes stripped, per stream: Ghost writes
  // warnings and info to different streams, so one combined count would shift.
  adapterLines() {
    const out = spawnSync('docker', ['logs', this.name], { encoding: 'utf8' });
    const pick = (text) =>
      text
        .split('\n')
        .map((line) => line.replace(/\u001b\[[0-9;]*m/g, ''))
        .filter((line) => line.includes('break-glass:'))
        .map((line) => line.slice(line.indexOf('break-glass:')));
    return { out: pick(out.stdout), err: pick(out.stderr) };
  }

  mark() {
    const { out, err } = this.adapterLines();
    return { out: out.length, err: err.length };
  }

  // Waits briefly for the log to settle, then returns what the adapter said.
  async adapterLinesSince(mark = { out: 0, err: 0 }) {
    let previous = -1;
    for (let i = 0; i < 8; i += 1) {
      await sleep(250);
      const { out, err } = this.adapterLines();
      const lines = [...out.slice(mark.out), ...err.slice(mark.err)];
      if (lines.length > 0 && lines.length === previous) return lines;
      previous = lines.length;
    }
    const { out, err } = this.adapterLines();
    return [...out.slice(mark.out), ...err.slice(mark.err)];
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

  // An Administrator whose password is a hash of nothing anyone holds.
  createSupportUser(status) {
    const id = crypto.randomBytes(12).toString('hex');
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const unusable = `$2a$10$${crypto
      .randomBytes(40)
      .toString('base64')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 53)}`;
    this.sql(
      `insert into users (id, name, slug, password, email, status, visibility, comment_notifications,
        free_member_signup_notification, paid_subscription_started_notification,
        paid_subscription_canceled_notification, mention_notifications, recommendation_notifications,
        milestone_notifications, donation_notifications, gift_subscription_notifications, created_at)
       values (?, 'Support', 'support', ?, ?, ?, 'public', 1, 1, 1, 1, 1, 1, 1, 1, 1, ?)`,
      id,
      unusable,
      SUPPORT,
      status,
      now
    );
    const [{ id: roleId }] = this.sql(`select id from roles where name = 'Administrator'`);
    this.sql(
      'insert into roles_users (id, role_id, user_id) values (?, ?, ?)',
      crypto.randomBytes(12).toString('hex'),
      roleId,
      id
    );
    return id;
  }

  setSupportStatus(status) {
    this.sql('update users set status = ? where email = ?', status, SUPPORT);
  }

  // What the incident lane's revoke does: suspend, then destroy sessions.
  revokeSupport(userId) {
    this.setSupportStatus('inactive');
    this.sql('delete from sessions where user_id = ?', userId);
  }

  async me(cookie) {
    const res = await fetch(`${this.base}/ghost/api/admin/users/me/`, {
      headers: { origin: this.base, ...(cookie ? { cookie } : {}) },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, email: body?.users?.[0]?.email ?? null };
  }

  // Opens /ghost/ as a fresh browser would, with or without a token.
  async attempt(token) {
    const mark = this.mark();
    const query = token === undefined ? '' : `?bl_break_glass=${encodeURIComponent(token)}`;
    const res = await fetch(`${this.base}/ghost/${query}`, { redirect: 'manual' });
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const me = await this.me(cookie || undefined);
    return { ...me, cookie, adapter: await this.adapterLinesSince(mark) };
  }

  remove() {
    spawnSync('docker', ['rm', '-f', this.name], { stdio: 'ignore' });
  }
}

const goodConfig = {
  publicKey: tenantKey.publicKeyBase64,
  tenant: TENANT,
  supportIdentity: SUPPORT,
};
const validToken = (overrides = {}, key = tenantKey.privateKey) =>
  mint(key, { ...claimsFor({ sub: SUPPORT, aud: TENANT }), ...overrides });

describe('break-glass against a real Ghost (LLD-5 B3, B4)', { timeout: 300_000 }, () => {
  let ghost;
  let supportId;

  before(async () => {
    ghost = await GhostContainer.start({ adapterConfig: goodConfig });
    assert.ok(ghost.booted, `Ghost did not boot:\n${ghost.logs().slice(-40).join('\n')}`);
    await ghost.setupOwner();
    supportId = ghost.createSupportUser('inactive');
  });

  after(() => ghost?.remove());

  it('no token: no session', async () => {
    const r = await ghost.attempt();
    assert.equal(r.status, 403);
    assert.equal(r.cookie, '');
    assert.deepEqual(r.adapter, []);
  });

  it('support SUSPENDED + valid token: no Administrator session', async () => {
    const r = await ghost.attempt(validToken());
    assert.equal(r.status, 403);
    assert.equal(r.email, null);
    ghost.sql('delete from sessions where user_id = ?', supportId);
  });

  let liveToken;
  let liveCookie;

  it('support ACTIVE + valid token: an Administrator session as the support identity', async () => {
    ghost.setSupportStatus('active');
    liveToken = validToken();
    const r = await ghost.attempt(liveToken);
    assert.deepEqual(r.adapter, ['break-glass: token accepted for the configured identity']);
    assert.equal(r.status, 200);
    assert.equal(r.email, SUPPORT);
    liveCookie = r.cookie;
  });

  for (const [name, build, reason] of [
    [
      'tampered signature',
      () => {
        const [body, sig] = validToken().split('.');
        const i = 20;
        return `${body}.${sig.slice(0, i)}${sig[i] === 'A' ? 'B' : 'A'}${sig.slice(i + 1)}`;
      },
      'signature',
    ],
    [
      'signed by a key that is not this tenant’s',
      () => validToken({}, otherKey.privateKey),
      'signature',
    ],
    ['expired token', () => validToken({ exp: Math.floor(Date.now() / 1000) - 60 }), 'expired'],
    ['token minted for another tenant', () => validToken({ aud: 'tenant-one' }), 'audience'],
    ['token naming the tenant OWNER (B4)', () => validToken({ sub: OWNER }), 'subject'],
    ['replay of a token already used', () => liveToken, 'replay'],
  ]) {
    it(`${name}: refused, while the support account is active`, async () => {
      const r = await ghost.attempt(build());
      assert.deepEqual(r.adapter, [`break-glass: token refused (${reason})`]);
      assert.equal(r.status, 403);
      assert.equal(r.email, null);
    });
  }

  it('the owner exists and is active, so the B4 refusal is not a missing account', () => {
    assert.deepEqual(ghost.sql('select status from users where email = ?', OWNER), [
      { status: 'active' },
    ]);
  });

  it('revoke (suspend + destroy sessions): the live cookie dies and the token cannot be replayed', async () => {
    assert.equal((await ghost.me(liveCookie)).status, 200);
    ghost.revokeSupport(supportId);
    assert.equal((await ghost.me(liveCookie)).status, 403);
    const replay = await ghost.attempt(liveToken);
    assert.equal(replay.status, 403);
    assert.deepEqual(replay.adapter, ['break-glass: token refused (replay)']);
  });

  it('a fresh grant and a fresh token work again, so every refusal above was specific', async () => {
    ghost.setSupportStatus('active');
    const r = await ghost.attempt(validToken());
    assert.equal(r.status, 200);
    assert.equal(r.email, SUPPORT);
  });
});

describe('the adapter on the boot path (LLD-5 B5)', { timeout: 600_000 }, () => {
  const cases = [
    ['a malformed public key', { ...goodConfig, publicKey: 'AAAAAAAA' }, 'publicKey is malformed'],
    ['no public key', { tenant: TENANT, supportIdentity: SUPPORT }, 'publicKey missing'],
    [
      'no tenant',
      { publicKey: tenantKey.publicKeyBase64, supportIdentity: SUPPORT },
      'tenant missing',
    ],
    [
      'no support identity',
      { publicKey: tenantKey.publicKeyBase64, tenant: TENANT },
      'supportIdentity missing',
    ],
    // Ghost parses env values: this arrives as a number, not a string.
    ['a tenant name Ghost parses as a number', { ...goodConfig, tenant: '2024' }, 'tenant missing'],
  ];
  for (const [name, adapterConfig, reason] of cases) {
    it(`boots and serves 200 with ${name}, and refuses every token`, async () => {
      const ghost = await GhostContainer.start({ adapterConfig });
      try {
        assert.ok(ghost.booted, `Ghost did not boot:\n${ghost.logs().slice(-40).join('\n')}`);
        const r = await ghost.attempt(validToken());
        assert.equal(r.status, 403);
        const lines = await ghost.adapterLinesSince();
        assert.ok(
          lines.includes(`break-glass: disabled (${reason}); every token will be refused`),
          lines.join('\n')
        );
        assert.deepEqual(r.adapter, ['break-glass: token refused (disabled)']);
      } finally {
        ghost.remove();
      }
    });
  }
});

describe('the adapter ships in the image, not the content directory', { timeout: 300_000 }, () => {
  // A tenant can write to content/. An adapter planted there under the same
  // name, accepting anything and producing the owner, must never be the one
  // Ghost loads.
  const planted = `
    const path = require.resolve('@tryghost/adapter-base-sso', { paths: ['/var/lib/ghost/current'] });
    const { SSOBase } = require(path);
    module.exports = class BreakGlassSSO extends SSOBase {
      async getRequestCredentials(req) { return req.query.bl_break_glass || null; }
      async getIdentityFromCredentials() { console.log('break-glass: PLANTED adapter ran'); return 'owner'; }
      async getUserForIdentity() { return this.getOwnerUser(); }
    };`;

  it('a planted content adapter is ignored in favour of the image’s', async () => {
    const ghost = await GhostContainer.start({ adapterConfig: goodConfig, plant: planted });
    try {
      assert.ok(ghost.booted, `Ghost did not boot:\n${ghost.logs().slice(-40).join('\n')}`);
      await ghost.setupOwner();
      const r = await ghost.attempt(validToken({ sub: OWNER }, otherKey.privateKey));
      assert.deepEqual(r.adapter, ['break-glass: token refused (signature)']);
      assert.equal(r.status, 403);
      assert.equal(r.email, null);
    } finally {
      ghost.remove();
    }
  });
});
