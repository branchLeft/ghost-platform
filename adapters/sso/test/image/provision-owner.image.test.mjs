// Drives the real, built Ghost image: a fresh tenant Ghost can be claimed by
// whoever reaches its setup route first, the provisioning script closes that
// by creating the real owner from the host, and the owner signs in through
// the emailed link. Mail goes to a local SMTP sink, so the link is the real
// one Ghost generated.
//
// Usage:
//   IMAGE=ghost-platform:ci npm --prefix adapters/sso run test:image
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { decodeMail, SmtpSink } from '../helpers/smtp-sink.mjs';
import { provisionOwner } from '../../scripts/provision-owner.mjs';

const IMAGE = process.env.IMAGE;
if (!IMAGE) {
  throw new Error('IMAGE must name the built Ghost image, e.g. IMAGE=ghost-platform:ci');
}

const SITE_URL = 'https://tenant.example.test';
const OWNER_EMAIL = 'owner@example.test';
const VISITOR_EMAIL = 'visitor@example.test';
const BOOT_TIMEOUT_MS = 90_000;
const LABEL = 'branchleft.agent=provision-owner-image-test';

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
  static async start(smtpPort) {
    const port = await freePort();
    const name = `provision-owner-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const env = {
      url: SITE_URL,
      database__client: 'sqlite3',
      database__connection__filename: '/var/lib/ghost/content/data/ghost.db',
      privacy__useUpdateCheck: 'false',
      mail__transport: 'SMTP',
      mail__from: 'noreply@example.test',
      mail__options__host: 'host.docker.internal',
      mail__options__port: String(smtpPort),
      mail__options__secure: 'false',
      mail__options__ignoreTLS: 'true',
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
      'create',
      '--name',
      name,
      '--label',
      LABEL,
      '--add-host',
      'host.docker.internal:host-gateway',
      '-p',
      `127.0.0.1:${port}:2368`,
      ...envArgs,
      IMAGE
    );
    const container = new GhostContainer(name, port);
    docker('start', name);
    assert.ok(await container.waitForHome(), `Ghost did not boot: ${container.logs()}`);
    return container;
  }

  constructor(name, port) {
    this.name = name;
    this.port = port;
  }

  async waitForHome() {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const res = await this.request('GET', '/');
        if (res.status === 200) return true;
      } catch {
        // not listening yet
      }
      if (docker('inspect', '-f', '{{.State.Running}}', this.name).trim() !== 'true') return false;
      await sleep(500);
    }
    return false;
  }

  logs() {
    try {
      return docker('logs', '--tail', '40', this.name);
    } catch {
      return '';
    }
  }

  // The request an outsider's browser would make, as the proxy would
  // forward it: the tenant's own host name and https.
  request(method, path, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          method,
          path,
          headers: {
            'content-type': 'application/json',
            host: new URL(SITE_URL).host,
            origin: SITE_URL,
            'x-forwarded-proto': 'https',
            ...extraHeaders,
          },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
        }
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  claim(email) {
    return this.request('POST', '/ghost/api/admin/authentication/setup/', {
      setup: [
        {
          name: 'Visitor',
          email,
          password: crypto.randomBytes(24).toString('hex'),
          blogTitle: 'Site',
        },
      ],
    });
  }

  async setupDone() {
    const res = await this.request('GET', '/ghost/api/admin/authentication/setup/');
    assert.equal(res.status, 200);
    return JSON.parse(res.text).setup[0].status;
  }

  signIn(email, password) {
    return this.request('POST', '/ghost/api/admin/session/', { username: email, password });
  }

  remove() {
    try {
      docker('rm', '-f', '-v', this.name);
    } catch {
      // already gone
    }
  }
}

const RESET_LINK = /https:\/\/tenant\.example\.test\/ghost\/reset\/([A-Za-z0-9%_=+-]+)\//;
const resetMails = () =>
  sink.messages.filter((m) => m.to.includes(OWNER_EMAIL) && RESET_LINK.test(decodeMail(m.data)));

const owner = {
  email: OWNER_EMAIL,
  name: 'OWNER_NAME',
  siteUrl: SITE_URL,
  siteTitle: 'SITE_TITLE',
};

let sink;

describe('a fresh tenant Ghost against a first visitor', { timeout: 600_000 }, () => {
  let unprovisioned;
  let provisioned;

  before(async () => {
    sink = await SmtpSink.start();
    [unprovisioned, provisioned] = await Promise.all([
      GhostContainer.start(sink.port),
      GhostContainer.start(sink.port),
    ]);
  });

  after(async () => {
    unprovisioned?.remove();
    provisioned?.remove();
    await sink?.stop();
  });

  it('CONTROL: with nothing in front of it, the first visitor claims an unprovisioned Ghost', async () => {
    assert.equal(await unprovisioned.setupDone(), false);
    const res = await unprovisioned.claim(VISITOR_EMAIL);
    assert.equal(
      res.status,
      201,
      'the claim must succeed here, or the refusals below prove nothing'
    );
    assert.equal(await unprovisioned.setupDone(), true);
  });

  it('creates the owner and asks Ghost to mail them a sign-in link, not a password', () => {
    const result = provisionOwner({ container: provisioned.name, ...owner });
    assert.deepEqual(result, { created: true, alreadySetUp: false, linkRequested: true });
  });

  it('delivers exactly one sign-in link to the owner', async () => {
    const deadline = Date.now() + 30_000;
    while (!resetMails().length && Date.now() < deadline) await sleep(250);
    assert.equal(resetMails().length, 1, 'one reset link for the owner');
  });

  it('refuses a visitor who now tries to claim the same Ghost', async () => {
    assert.equal(await provisioned.setupDone(), true);
    const res = await provisioned.claim(VISITOR_EMAIL);
    assert.ok(res.status >= 400 && res.status < 500, `expected a refusal, got ${res.status}`);
    const visitor = await provisioned.signIn(VISITOR_EMAIL, 'anything-at-all');
    assert.ok(visitor.status >= 400, 'the visitor has no account');
  });

  it('lets the owner sign in through the link, as the owner', async () => {
    const text = decodeMail(resetMails()[0].data);
    const token = decodeURIComponent(RESET_LINK.exec(text)[1]);
    const chosen = crypto.randomBytes(18).toString('hex');
    const reset = await provisioned.request(
      'PUT',
      '/ghost/api/admin/authentication/password_reset/',
      {
        password_reset: [{ token, newPassword: chosen, ne2Password: chosen }],
      }
    );
    assert.equal(reset.status, 200, reset.text);
    const session = await provisioned.signIn(OWNER_EMAIL, chosen);
    assert.equal(session.status, 201, session.text);
    const cookie = session.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
    const me = await provisioned.request(
      'GET',
      '/ghost/api/admin/users/me/?include=roles',
      undefined,
      {
        cookie,
      }
    );
    assert.equal(me.status, 200);
    const user = JSON.parse(me.text).users[0];
    assert.equal(user.email, OWNER_EMAIL);
    assert.deepEqual(
      user.roles.map((r) => r.name),
      ['Owner']
    );
  });

  it('is a no-op the second time: no new owner, no second email', async () => {
    const before = sink.messages.length;
    const result = provisionOwner({ container: provisioned.name, ...owner });
    assert.deepEqual(result, { created: false, alreadySetUp: true });
    await sleep(2000);
    assert.equal(sink.messages.length, before);
  });
});
