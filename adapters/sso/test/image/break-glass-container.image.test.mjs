// The containerised grant and expire tools against the built Ghost image: the
// real host wrapper and the real expire unit's command line, run in the pinned
// Node image with the Docker Engine socket, against a real Ghost. Usage:
//   IMAGE=ghost-platform:ci npm --prefix adapters/sso run test:image
// See break-glass-container.image.test.md for what each case proves.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { provisionSupportAccount } from '../../scripts/provision-support-account.mjs';

const IMAGE = process.env.IMAGE;
if (!IMAGE) {
  throw new Error('IMAGE must name the built Ghost image, e.g. IMAGE=ghost-platform:ci');
}
const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts');
const WRAPPER = fs.readFileSync(path.join(SCRIPTS, 'host/branchleft-break-glass.sh'), 'utf8');
const SERVICE = fs.readFileSync(
  path.join(SCRIPTS, 'systemd/branchleft-break-glass-expire.service'),
  'utf8'
);
const NODE_IMAGE = /^IMAGE='([^']+)'$/m.exec(WRAPPER)[1];

const TENANT = `bg-ctr-${crypto.randomBytes(3).toString('hex')}`;
const SUPPORT = 'support@platform.example';
const OWNER = 'owner@example.com';
const BOOT_TIMEOUT_MS = 90_000;
const LABEL = ['--label', 'branchleft.agent=break-glass-container-test'];
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-ctr-'));
const stateDir = path.join(work, 'grants');
const logDir = path.join(work, 'log');
const stubDir = path.join(work, 'stub');
// World-writable on purpose: the container's root has no CAP_DAC_OVERRIDE, so on a Linux
// runner it meets a directory owned by the runner's user as "other". On a host the
// directories are root-owned and 0700, which the container's root owns.
for (const d of [stateDir, logDir]) {
  fs.mkdirSync(d);
  fs.chmodSync(d, 0o777);
}
fs.mkdirSync(stubDir);
const volume = `${TENANT}-content`;

/** The same text with the three host directories swapped for temporary ones, each exactly once. */
function withTempDirectories(text, replace) {
  let out = text;
  for (const [from, to] of replace) {
    assert.equal(out.split(from).length - 1, 1, `${from} must appear exactly once`);
    out = out.replace(from, to);
  }
  return out;
}
const wrapperPath = path.join(work, 'branchleft-break-glass.sh');
fs.writeFileSync(
  wrapperPath,
  withTempDirectories(WRAPPER, [
    ['source=$TOOL_DIR,', `source=${SCRIPTS},`],
    ['source=$STATE_DIR,', `source=${stateDir},`],
    ['source=$LOG_DIR,', `source=${logDir},`],
  ])
);

/** The expire unit's own command line, with the same three directories swapped. */
function unitCommand() {
  const joined = SERVICE.split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n')
    .replace(/\\\n/g, ' ');
  const line = /^ExecStart=(.*)$/m.exec(joined)[1];
  const swapped = withTempDirectories(line, [
    ['source=/usr/local/lib/branchleft/break-glass,', `source=${SCRIPTS},`],
    ['source=/var/lib/branchleft/break-glass-grants,', `source=${stateDir},`],
    ['source=/var/log/branchleft,', `source=${logDir},`],
  ]);
  const tokens = swapped.trim().split(/\s+/);
  assert.equal(tokens[0], '/usr/bin/docker');
  return ['docker', ...tokens.slice(1)];
}

/** A `systemctl` that answers is-active with `exitCode`, ahead of the real PATH. */
function stubSystemctl(exitCode) {
  fs.writeFileSync(path.join(stubDir, 'systemctl'), `#!/bin/sh\nexit ${exitCode}\n`, {
    mode: 0o755,
  });
  return { ...process.env, PATH: `${stubDir}:${process.env.PATH}` };
}

function runWrapper(env, ...args) {
  const r = spawnSync('/bin/sh', [wrapperPath, ...args], { encoding: 'utf8', env });
  return { code: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

function runUnit() {
  const [cmd, ...args] = unitCommand();
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

/** Reads and writes the grant files as root, as the container does, so a Linux runner can too. */
function asRoot(script, ...args) {
  return docker(
    'run',
    '--rm',
    ...LABEL,
    '--network',
    'none',
    '-v',
    `${stateDir}:/state`,
    '-v',
    `${logDir}:/log`,
    NODE_IMAGE,
    'node',
    '-e',
    script,
    ...args
  );
}
const readRecords = () =>
  asRoot(
    "const f='/log/break-glass-grants.jsonl';" +
      "console.log(require('fs').existsSync(f)?require('fs').readFileSync(f,'utf8'):'')"
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const stateFiles = () =>
  JSON.parse(
    asRoot(
      "console.log(JSON.stringify(require('fs').readdirSync('/state').filter(n=>n.endsWith('.json'))))"
    )
  );
const readState = () =>
  JSON.parse(
    asRoot(`const fs=require('fs');console.log(fs.readFileSync('/state/${TENANT}.json','utf8'))`)
  );
const setDeadline = (iso) =>
  asRoot(
    `const fs=require('fs');const p='/state/${TENANT}.json';` +
      `const s=JSON.parse(fs.readFileSync(p,'utf8'));s.deadline=process.argv[1];` +
      'fs.writeFileSync(p,JSON.stringify(s)+"\\n")',
    iso
  );

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function mintToken() {
  const iat = Math.floor(Date.now() / 1000);
  const claims = {
    sub: SUPPORT,
    aud: TENANT,
    iat,
    exp: iat + 300,
    jti: crypto.randomBytes(16).toString('hex'),
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.sign(null, Buffer.from(body), privateKey).toString('base64url');
  return `${body}.${signature}`;
}

class Tenant {
  async start() {
    this.port = await freePort();
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
      adapters__sso__BreakGlassSSO__publicKey: PUBLIC_KEY,
      adapters__sso__BreakGlassSSO__tenant: TENANT,
      adapters__sso__BreakGlassSSO__supportIdentity: SUPPORT,
    };
    for (const [feature, wrapped] of [
      ['images', 'LocalImagesStorage'],
      ['media', 'LocalMediaStorage'],
      ['files', 'LocalFilesStorage'],
    ]) {
      env[`storage__${feature}__adapter`] = 'ScanningStorageAdapter';
      env[`storage__${feature}__wraps`] = wrapped;
      env[`storage__${feature}__quarantinePath`] = '/var/lib/ghost/content/quarantine';
    }
    docker(
      'run',
      '-d',
      '--name',
      this.name,
      ...LABEL,
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
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    for (;;) {
      try {
        if ((await fetch(`${this.base}/`)).status === 200) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error('Ghost did not boot');
      await sleep(500);
    }
    await sleep(1500); // the adapter compares whole seconds against its own start
  }

  remove() {
    spawnSync('docker', ['rm', '-f', '-v', this.name], { stdio: 'ignore' });
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

  /** Opens /ghost/ with a token, as the operator's browser would, and returns the session cookie. */
  async login() {
    const res = await fetch(
      `${this.base}/ghost/?bl_break_glass=${encodeURIComponent(mintToken())}`,
      {
        redirect: 'manual',
      }
    );
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    return { cookie, ...(await this.me(cookie || undefined)) };
  }
}

const GRANT = [
  'grant',
  '--lane',
  'incident',
  '--tenant',
  TENANT,
  '--reason',
  'image test',
  '--reference',
  'image-test',
];

describe(
  'the containerised grant and expire tools against a real Ghost',
  { timeout: 600_000 },
  () => {
    const tenant = new Tenant();

    before(async () => {
      docker('volume', 'create', ...LABEL, volume);
      await tenant.start();
      await tenant.setupOwner();
      const created = provisionSupportAccount({ container: tenant.name, email: SUPPORT });
      assert.equal(created.status, 'inactive');
    });

    after(() => {
      tenant.remove();
      spawnSync('docker', ['volume', 'rm', '-f', volume], { stdio: 'ignore' });
      fs.rmSync(work, { recursive: true, force: true });
    });

    it('the wrapper runs the tool in the pinned image: status reads the state directory', () => {
      const r = runWrapper(stubSystemctl(0), 'status');
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, '[]');
    });

    it('a grant is refused when the expire timer is not active: nothing is written, nothing opened', () => {
      const r = runWrapper(stubSystemctl(3), ...GRANT);
      assert.equal(r.code, 2, r.stderr);
      assert.match(
        r.stderr,
        /branchleft-break-glass-expire\.timer is not active, so nothing would close this grant/
      );
      assert.deepEqual(stateFiles(), [], 'NO CLOCK WRITTEN');
      assert.equal(tenant.support().status, 'inactive', 'ACCOUNT NOT OPENED');
      assert.deepEqual(readRecords(), []);
    });

    it('anti-lockout: a grant against a tenant that deleted the support account recreates it, then opens it', () => {
      tenant.deleteSupport();
      assert.equal(tenant.support(), null);
      const r = runWrapper(stubSystemctl(0), ...GRANT);
      assert.equal(r.code, 0, r.stderr);
      const opened = JSON.parse(r.stdout);
      assert.equal(opened.recreated, true, 'ACCOUNT RECREATED');
      assert.equal(opened.identity, SUPPORT);
      assert.equal(tenant.support().status, 'active');
      assert.equal(Date.parse(opened.deadline) - Date.parse(opened.grantedAt), 4 * 60 * 60 * 1000);
      assert.deepEqual(stateFiles(), [`${TENANT}.json`]);
      assert.deepEqual(
        readRecords().map((r2) => [r2.event, r2.lane, r2.recreated]),
        [['opened', 'incident', true]]
      );
    });

    it('a second grant for the same tenant is refused while one is open', () => {
      const r = runWrapper(stubSystemctl(0), ...GRANT);
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, /already open until/);
    });

    let session;
    it('a real session opens as the support account', async () => {
      session = await tenant.login();
      assert.equal(session.status, 200);
      assert.equal(session.email, SUPPORT);
      assert.ok(tenant.sessions() >= 1);
    });

    it('the expire unit leaves a grant that is not yet due', async () => {
      const r = runUnit();
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), { closed: [], failed: [] });
      assert.equal(tenant.support().status, 'active');
      assert.equal((await tenant.me(session.cookie)).status, 200);
    });

    it('the expire unit closes a grant past its deadline: re-suspended, sessions destroyed, closing record written', async () => {
      setDeadline(new Date(Date.now() - 1000).toISOString());
      const r = runUnit();
      assert.equal(r.code, 0, r.stderr);
      const { closed, failed } = JSON.parse(r.stdout);
      assert.deepEqual(failed, []);
      assert.equal(closed.length, 1, 'GRANT CLOSED BY THE UNIT');
      assert.equal(closed[0].cause, 'timer');
      assert.equal(tenant.support().status, 'inactive', 'ACCOUNT RE-SUSPENDED');
      assert.equal(tenant.sessions(), 0, 'SESSIONS DESTROYED');
      assert.equal((await tenant.me(session.cookie)).status, 403, 'the open session is dead');
      assert.deepEqual(stateFiles(), [], 'STATE REMOVED');
      const events = readRecords().map((r2) => [r2.event, r2.cause ?? null]);
      assert.deepEqual(events, [
        ['opened', null],
        ['closed', 'timer'],
      ]);
      const last = readRecords().at(-1);
      assert.equal(last.sessionsPurged.length, 2, 'purged twice');
    });

    it('revoke through the wrapper closes an open grant at once, and needs no state file', async () => {
      runWrapper(stubSystemctl(0), ...GRANT);
      assert.equal(tenant.support().status, 'active');
      const login = await tenant.login();
      assert.equal(login.status, 200);
      asRoot(`require('fs').rmSync('/state/${TENANT}.json')`);
      const r = runWrapper(stubSystemctl(0), 'revoke', '--tenant', TENANT, '--reason', 'done');
      assert.equal(r.code, 0, r.stderr);
      const closing = JSON.parse(r.stdout);
      assert.equal(closing.stateFound, false);
      assert.equal(tenant.support().status, 'inactive');
      assert.equal(tenant.sessions(), 0);
      assert.equal((await tenant.me(login.cookie)).status, 403);
    });

    it('the container has no network but lo, a read-only root, and still reaches the Engine socket', () => {
      // The wrapper's own options, taken from a recording docker, then run with a probe in place of the tool.
      const bin = path.join(work, 'record');
      fs.mkdirSync(bin, { recursive: true });
      const argvFile = path.join(work, 'argv');
      fs.writeFileSync(
        path.join(bin, 'docker'),
        `#!/bin/sh\nprintf '%s\\0' "$@" > '${argvFile}'\n`,
        { mode: 0o755 }
      );
      fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      spawnSync('/bin/sh', [wrapperPath, 'status'], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      const argv = fs.readFileSync(argvFile, 'utf8').split('\0').slice(0, -1);
      const at = argv.indexOf(NODE_IMAGE);
      assert.ok(at > 0, 'the pinned image is in the wrapper command');
      const probe = `
        const os = require('os'); const net = require('net'); const fs = require('fs'); const http = require('http');
        const out = { interfaces: Object.keys(os.networkInterfaces()) };
        try { fs.writeFileSync('/probe', 'x'); out.rootWrite = 'allowed'; } catch (e) { out.rootWrite = e.code; }
        const done = () => console.log(JSON.stringify(out));
        const socket = net.connect({ host: '1.1.1.1', port: 443, timeout: 3000 });
        socket.on('connect', () => { out.outbound = 'connected'; socket.destroy(); ping(); });
        socket.on('timeout', () => { out.outbound = 'timeout'; socket.destroy(); ping(); });
        socket.on('error', (e) => { out.outbound = e.code; ping(); });
        let pinged = false;
        function ping() {
          if (pinged) return; pinged = true;
          http.get({ socketPath: '/var/run/docker.sock', path: '/_ping' }, (res) => {
            let body = ''; res.on('data', (c) => (body += c));
            res.on('end', () => { out.socket = body; done(); });
          }).on('error', (e) => { out.socket = e.code; done(); });
        }`;
      const options = argv.slice(1, at).filter((a) => a !== '-e' && !a.startsWith('BL_EXPIRE'));
      const r = spawnSync('docker', ['run', ...options, NODE_IMAGE, 'node', '-e', probe], {
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr);
      const seen = JSON.parse(r.stdout.trim().split('\n').pop());
      assert.deepEqual(seen.interfaces, ['lo'], 'NO NETWORK BUT LOOPBACK');
      assert.notEqual(seen.outbound, 'connected');
      assert.notEqual(seen.outbound, undefined);
      assert.equal(seen.rootWrite, 'EROFS', 'READ-ONLY ROOT');
      assert.equal(seen.socket, 'OK', 'the Engine socket is reachable');
    });
  }
);
