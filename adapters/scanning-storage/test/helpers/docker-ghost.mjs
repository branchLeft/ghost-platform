// Docker plumbing for the storage contract test: a labelled network, the
// recording S3 double (a container from the Ghost image running
// recording-s3-double.cjs) and a Ghost container. Every resource carries the
// branchleft.agent label so a leftover is attributable, and every teardown
// removes its container with its anonymous volumes.
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DOUBLE_SCRIPT = path.join(HERE, 'recording-s3-double.cjs');

export const LABEL = 'branchleft.component=storage-contract-test';
export const SITE_URL = 'http://localhost:2368';
const BOOT_TIMEOUT_MS = 90_000;
const OWNER_EMAIL = 'owner@example.com';
const OWNER_PASSWORD = crypto.randomBytes(24).toString('hex');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function dockerOk(...args) {
  return spawnSync('docker', args, { encoding: 'utf8' });
}

export function uniqueName(prefix) {
  return `${prefix}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
}

export function createNetwork(name) {
  docker('network', 'create', '--label', LABEL, name);
}

export function removeNetwork(name) {
  dockerOk('network', 'rm', name);
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

export class RecordingDouble {
  static async start(image, network, bucket) {
    const s3Port = await freePort();
    const name = uniqueName('contract-double');
    docker(
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '--label',
      LABEL,
      '--network',
      network,
      '-p',
      `127.0.0.1:${s3Port}:9090`,
      '-e',
      `DOUBLE_BUCKET=${bucket}`,
      '-v',
      `${DOUBLE_SCRIPT}:/double.cjs:ro`,
      '--entrypoint',
      'node',
      image,
      '/double.cjs'
    );
    const double = new RecordingDouble(name, s3Port, bucket);
    await double.waitForReady();
    return double;
  }

  constructor(name, s3Port, bucket) {
    this.name = name;
    this.bucket = bucket;
    this.control = `http://127.0.0.1:${s3Port}/__control`;
    this.s3Endpoint = `http://${name}:9090`;
  }

  async waitForReady() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.control}/requests`);
        if (res.status === 200) return;
      } catch {
        // not listening yet
      }
      await sleep(300);
    }
    throw new Error('the recording double did not become ready in time');
  }

  async requests() {
    const res = await fetch(`${this.control}/requests`);
    return res.json();
  }

  async mark() {
    return (await this.requests()).length;
  }

  // Requests recorded after `mark`, polled until `done(list)` or the timeout.
  async since(mark, { done = () => true, timeoutMs = 8_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let list = [];
    do {
      list = (await this.requests()).slice(mark);
      if (done(list)) return list;
      await sleep(250);
    } while (Date.now() < deadline);
    return list;
  }

  async setFailParts(on) {
    await fetch(`${this.control}/fail-parts/${on ? 'on' : 'off'}`, { method: 'POST' });
  }

  stop() {
    dockerOk('rm', '-f', '-v', this.name);
  }
}

export class GhostContainer {
  // Ghost is configured with its own site address `http://localhost:2368`
  // (its in-container port) while the harness reaches it on a published
  // port. Ghost refuses to fetch from private addresses except its own site
  // host, so a fetch of its own pages and assets is the one remote fetch
  // allowed in production mode: that is how the inliner and oEmbed scenarios
  // run without development mode (which breaks uploads).
  static async start(image, env, { network, volumes = [] }) {
    const port = await freePort();
    const name = uniqueName('contract-ghost');
    const fullEnv = {
      url: SITE_URL,
      database__client: 'sqlite3',
      database__connection__filename: '/var/lib/ghost/content/data/ghost.db',
      privacy__useUpdateCheck: 'false',
      mail__transport: 'stub',
      imageOptimization__resize: 'false',
      ...env,
    };
    const envArgs = Object.entries(fullEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const volumeArgs = volumes.flatMap(({ host, container }) => ['-v', `${host}:${container}`]);
    docker(
      'create',
      '--name',
      name,
      '--label',
      LABEL,
      '--network',
      network,
      '-p',
      `127.0.0.1:${port}:2368`,
      ...envArgs,
      ...volumeArgs,
      image
    );
    const ghost = new GhostContainer(name, port);
    docker('start', name);
    ghost.booted = await ghost.waitForHome();
    return ghost;
  }

  constructor(name, port) {
    this.name = name;
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
      const state = dockerOk('inspect', '-f', '{{.State.Running}}', this.name).stdout?.trim();
      if (state !== 'true') return false;
      await sleep(500);
    }
    return false;
  }

  logs() {
    const out = spawnSync('docker', ['logs', this.name], { encoding: 'utf8' });
    return `${out.stdout}${out.stderr}`;
  }

  ghostVersion() {
    return docker(
      'exec',
      this.name,
      'node',
      '-p',
      "require('/var/lib/ghost/current/package.json').version"
    ).trim();
  }

  async setupOwner() {
    const res = await fetch(`${this.base}/ghost/api/admin/authentication/setup/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: SITE_URL },
      body: JSON.stringify({
        setup: [{ name: 'Owner', email: OWNER_EMAIL, password: OWNER_PASSWORD, blogTitle: 'Site' }],
      }),
    });
    assert.equal(res.status, 201, `owner setup: ${await res.text()}`);
  }

  async login() {
    const res = await fetch(`${this.base}/ghost/api/admin/session/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: SITE_URL },
      body: JSON.stringify({ username: OWNER_EMAIL, password: OWNER_PASSWORD }),
    });
    assert.equal(res.status, 201, `login: ${await res.text()}`);
    this.cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
  }

  // A multipart upload to an admin endpoint, as the admin client sends it.
  async upload(endpoint, parts, { method = 'POST' } = {}) {
    const form = new FormData();
    for (const part of parts) {
      if (part.bytes) {
        form.append(part.field, new Blob([part.bytes], { type: part.type }), part.filename);
      } else {
        form.append(part.field, part.value);
      }
    }
    const res = await fetch(`${this.base}/ghost/api/admin/${endpoint}`, {
      method,
      headers: { origin: SITE_URL, cookie: this.cookie },
      body: form,
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  async json(method, endpoint, payload) {
    const res = await fetch(`${this.base}/ghost/api/admin/${endpoint}`, {
      method,
      headers: { origin: SITE_URL, cookie: this.cookie, 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  async get(endpoint) {
    const res = await fetch(`${this.base}/ghost/api/admin/${endpoint}`, {
      headers: { origin: SITE_URL, cookie: this.cookie },
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  // One unfollowed request: the status and where it redirects, if it does.
  async probe(urlPath) {
    const res = await fetch(`${this.base}${urlPath}`, { redirect: 'manual' });
    return { status: res.status, location: res.headers.get('location') };
  }

  stop() {
    dockerOk('rm', '-f', '-v', this.name);
  }
}
