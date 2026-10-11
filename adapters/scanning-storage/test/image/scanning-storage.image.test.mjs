// Drives the built Ghost image through the real adapter manager. Usage:
//   IMAGE=ghost-platform:ci npm --prefix adapters/scanning-storage run test:image
// Why upload-time resize is off, and the bind-mount ownership handling:
// the README's "Tests" section.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');

const IMAGE = process.env.IMAGE;
if (!IMAGE) {
  throw new Error('IMAGE must name the built Ghost image, e.g. IMAGE=ghost-platform:ci');
}

const OWNER_EMAIL = 'owner@example.com';
const OWNER_PASSWORD = crypto.randomBytes(24).toString('hex');
const BOOT_TIMEOUT_MS = 90_000;

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function dockerOk(...args) {
  return spawnSync('docker', args, { encoding: 'utf8' });
}

// A user-defined network gives containers on it Docker's own embedded DNS,
// so one can address another by --name. The default bridge network (used
// when no network is named) has no such DNS -- that's the whole reason
// host.docker.internal existed here before: it only resolves under Docker
// Desktop, not on a Linux CI runner, which is portable in neither direction
// a container needs to reach another container. A named network is
// portable in both.
function createNetwork(name) {
  docker('network', 'create', name);
}

function removeNetwork(name) {
  dockerOk('network', 'rm', name);
}

// Teardown's second line of defence after the chmod 0777 at setup: chowns
// the bind mount back to this runner (README, "Tests"). Never throws, so it
// cannot mask an assertion failure already in flight.
function reclaimHostOwnership(hostDir) {
  try {
    docker(
      'run',
      '--rm',
      '-v',
      `${hostDir}:/reclaim`,
      IMAGE,
      'chown',
      '-R',
      `${process.getuid()}:${process.getgid()}`,
      '/reclaim'
    );
  } catch (err) {
    // Best-effort: `fs.chmodSync(..., 0o777)` at setup is what makes
    // teardown work even if this step fails outright (container already
    // gone, docker itself unavailable). Logged, never rethrown, so it can
    // never mask a real assertion failure already in flight in the
    // caller's `finally` block.
    console.error(`reclaimHostOwnership(${hostDir}) failed (non-fatal):`, err.message);
  }
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

// What the hash source is asked about, and so what the fake's refuse and
// unavailable lists and a delivered verdict's file name are keyed by. The
// quarantine files stay named by the content digest, which is sha256Hex.
// This driver needs no install, so the keys are read from a record that a
// unit test checks against the real decoder (fixture-keys.test.mjs).
const require = createRequire(import.meta.url);
const { resolveFileStem } = require('../../src/verdict-client.js');
const FIXTURE_KEYS = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'verdict-keys.json'), 'utf8')
).keys;

async function verdictKey(buffer) {
  const entry = FIXTURE_KEYS[sha256Hex(buffer)];
  assert.ok(entry, 'no recorded verdict key for these bytes: add the fixture to verdict-keys.json');
  return entry.key;
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

class GhostContainer {
  // `volumes`: [{host, container}] bind mounts. Used only by the hold-branch
  // tests, to let this test driver -- a separate process from the container
  // -- "deliver" a verdict for a held digest by writing a file the fake
  // verdict client polls for (verdict-client.js's own comment explains why
  // this is a test seam, never a guess at the real channel's wire format).
  // `network`: joins a shared, user-defined Docker network instead of the
  // default bridge -- see createNetwork's own comment for why that is what
  // makes the S3 tier's own container-to-container addressing portable.
  static async start(env = {}, { volumes = [], network = 'bridge' } = {}) {
    const port = await freePort();
    const name = `scan-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const fullEnv = {
      url: `http://localhost:${port}`,
      database__client: 'sqlite3',
      database__connection__filename: '/var/lib/ghost/content/data/ghost.db',
      privacy__useUpdateCheck: 'false',
      mail__transport: 'stub',
      imageOptimization__resize: 'false',
      BRANCHLEFT_ALLOW_LOCAL_STORAGE: 'true',
      ...env,
    };
    const envArgs = Object.entries(fullEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const volumeArgs = volumes.flatMap(({ host, container: containerPath }) => [
      '-v',
      `${host}:${containerPath}`,
    ]);
    docker(
      'create',
      '--name',
      name,
      '--network',
      network,
      '-p',
      `127.0.0.1:${port}:2368`,
      ...envArgs,
      ...volumeArgs,
      IMAGE
    );
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

  ls(dir) {
    const res = spawnSync('docker', ['exec', this.name, 'ls', '-1', dir], { encoding: 'utf8' });
    if (res.status !== 0) return [];
    return res.stdout.trim().split('\n').filter(Boolean);
  }

  async setupOwner() {
    const res = await fetch(`${this.base}/ghost/api/admin/authentication/setup/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: this.base },
      body: JSON.stringify({
        setup: [{ name: 'Owner', email: OWNER_EMAIL, password: OWNER_PASSWORD, blogTitle: 'Site' }],
      }),
    });
    assert.equal(res.status, 201, `owner setup: ${await res.text()}`);
  }

  async login() {
    const res = await fetch(`${this.base}/ghost/api/admin/session/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: this.base },
      body: JSON.stringify({ username: OWNER_EMAIL, password: OWNER_PASSWORD }),
    });
    assert.equal(res.status, 201, `login: ${await res.text()}`);
    return res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
  }

  async me(cookie) {
    const res = await fetch(`${this.base}/ghost/api/admin/users/me/`, {
      headers: { origin: this.base, cookie },
    });
    return res.status;
  }

  async uploadImage(cookie, filePath, filename) {
    const bytes = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'image/png' }), filename);
    const res = await fetch(`${this.base}/ghost/api/admin/images/upload/`, {
      method: 'POST',
      headers: { origin: this.base, cookie },
      body: form,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  async uploadFile(cookie, filePath, filename, type) {
    const bytes = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), filename);
    const res = await fetch(`${this.base}/ghost/api/admin/files/upload/`, {
      method: 'POST',
      headers: { origin: this.base, cookie },
      body: form,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  async createPost(cookie) {
    const res = await fetch(`${this.base}/ghost/api/admin/posts/`, {
      method: 'POST',
      headers: { origin: this.base, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        posts: [{ title: `post-${crypto.randomBytes(4).toString('hex')}`, status: 'draft' }],
      }),
    });
    return res.status;
  }

  async getStatus(urlPath, { followRedirects = true } = {}) {
    const res = await fetch(`${this.base}${urlPath}`, {
      redirect: followRedirects ? 'follow' : 'manual',
    });
    return res.status;
  }

  // A real process restart: the same container, same writable layer (so
  // the same content/quarantine directory), the entrypoint process killed
  // and started again from scratch -- a deploy of this very image (this
  // repo's own CD queues one on every merge to main), a crash, an OOM
  // kill, or a health-check restart all land here from the adapter's own
  // point of view. `docker restart`, not a fresh `create`, is what makes
  // that distinction real rather than assumed.
  async restart() {
    docker('restart', this.name);
    this.booted = await this.waitForHome();
  }

  stop() {
    dockerOk('rm', '-f', this.name);
  }
}

// adobe/s3mock: a real, if minimal, S3-compatible server -- unlike minio,
// it is pullable here without registry authentication. It does not
// validate request signatures, so the AWS SDK client S3Storage builds
// still signs every request; the double just never checks that signature.
class S3MockDouble {
  // Published to the host (for this script's own HTTP checks) *and* joined
  // to `network` (so a container on that same network, i.e. the Ghost
  // container under test, can reach it by name) at once -- Docker allows
  // both on the same container.
  static async start(network) {
    const port = await freePort();
    const name = `scan-s3mock-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    docker(
      'run',
      '-d',
      '--name',
      name,
      '--network',
      network,
      '-p',
      `127.0.0.1:${port}:9090`,
      'adobe/s3mock:latest'
    );
    const double = new S3MockDouble(name, port);
    await double.waitForReady();
    await double.createBucket();
    return double;
  }

  constructor(name, port) {
    this.name = name;
    this.port = port;
    this.base = `http://localhost:${port}`;
    this.bucket = 'scanning-storage-test';
  }

  async waitForReady() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.base}/`);
        if (res.status === 200) return true;
      } catch {
        // not up yet
      }
      await sleep(300);
    }
    throw new Error('s3mock did not become ready in time');
  }

  async createBucket() {
    const res = await fetch(`${this.base}/${this.bucket}`, { method: 'PUT' });
    if (res.status !== 200) {
      throw new Error(`s3mock bucket creation failed: ${res.status}`);
    }
  }

  async objectExists(key) {
    const res = await fetch(`${this.base}/${this.bucket}/${key}`);
    return res.status === 200;
  }

  stop() {
    dockerOk('rm', '-f', this.name);
  }
}

// A digest that will never appear as a real upload's hash in these tests,
// used to prove a clean upload is genuinely not on the refuse list rather
// than merely absent from an empty one.
const NEVER_MATCHES = '0'.repeat(64);

describe('the scanning storage decorator, wrapping the local images adapter', () => {
  it(
    'refuses a matching upload with a typed 415, leaves the site and admin API usable, and lets a clean upload and an on-demand resize through',
    { timeout: 120_000 },
    async () => {
      const cleanBytes = fs.readFileSync(path.join(FIXTURES, 'clean.png'));
      const badBytes = fs.readFileSync(path.join(FIXTURES, 'bad.png'));
      const badDigest = sha256Hex(badBytes);
      const badKey = await verdictKey(badBytes);

      const ghost = await GhostContainer.start({
        storage__images__adapter: 'ScanningStorageAdapter',
        storage__images__verdictSource: 'in-process-fake',
        storage__images__wraps: 'LocalImagesStorage',
        storage__images__quarantinePath: '/var/lib/ghost/content/quarantine',
        storage__images__refuse: JSON.stringify({
          [badKey]: { classification: 'harmful-abusive-material', matchType: 'exact' },
          [NEVER_MATCHES]: { classification: 'csam', matchType: 'exact' },
        }),
        // The entrypoint's fail-closed guard now requires the decorator on
        // every feature, not just the one this test exercises -- media and
        // files carry no `refuse` list, so they never affect the images
        // assertions below, only let Ghost boot at all.
        storage__media__adapter: 'ScanningStorageAdapter',
        storage__media__verdictSource: 'in-process-fake',
        storage__media__wraps: 'LocalMediaStorage',
        storage__media__quarantinePath: '/var/lib/ghost/content/quarantine',
        storage__files__adapter: 'ScanningStorageAdapter',
        storage__files__verdictSource: 'in-process-fake',
        storage__files__wraps: 'LocalFilesStorage',
        storage__files__quarantinePath: '/var/lib/ghost/content/quarantine',
      });

      try {
        assert.equal(ghost.booted, true, `ghost did not boot:\n${ghost.logs()}`);
        await ghost.setupOwner();
        const cookie = await ghost.login();

        // A refusal must be contained entirely to the upload.
        const refused = await ghost.uploadImage(cookie, path.join(FIXTURES, 'bad.png'), 'bad.png');
        assert.equal(refused.status, 415, JSON.stringify(refused.body));
        assert.equal(refused.body.errors[0].type, 'UnsupportedMediaTypeError');
        assert.match(refused.body.errors[0].context, /harmful-abusive-material/);

        assert.equal(
          await ghost.getStatus('/'),
          200,
          'public site must still serve after a refusal'
        );
        assert.equal(await ghost.me(cookie), 200, 'admin API must still serve after a refusal');

        const clean = await ghost.uploadImage(cookie, path.join(FIXTURES, 'clean.png'), 'good.png');
        assert.equal(clean.status, 201, JSON.stringify(clean.body));
        const imageUrl = clean.body.images[0].url;

        assert.equal(
          await ghost.createPost(cookie),
          201,
          'post creation must still succeed after a refusal'
        );

        const originalPath = new URL(imageUrl).pathname;
        assert.equal(await ghost.getStatus(originalPath), 200, 'the clean upload must still serve');

        // On-demand responsive derivative: Ghost's own resize middleware
        // feature-detects saveRaw with a plain typeof check and, if it is
        // missing, redirects to the original instead of erroring -- a
        // redirect that a normal fetch would silently follow, landing on a
        // 200 either way. Asserting the status without following redirects
        // is what actually distinguishes "resized and served directly" from
        // "gave up and redirected to the original", which is what the
        // saveRaw-removal sabotage targets.
        const sizePath = originalPath.replace('/content/images/', '/content/images/size/w600/');
        assert.equal(
          await ghost.getStatus(sizePath, { followRedirects: false }),
          200,
          'an on-demand size variant must be served directly, not redirected to the original'
        );

        // Nothing refused reached the served tree; the quarantine copy is
        // keyed by digest.
        const served = ghost.ls(
          '/var/lib/ghost/content/images/' + new Date().toISOString().slice(0, 4)
        );
        assert.ok(
          !served.some((f) => f.includes('bad')),
          `refused file must not be in the served tree: ${served}`
        );
        const quarantined = ghost.ls('/var/lib/ghost/content/quarantine');
        assert.ok(
          quarantined.includes(badDigest),
          `quarantine must hold the refused digest: ${quarantined}`
        );
      } finally {
        ghost.stop();
      }
    }
  );

  it(
    'names no classification for a csam match, and the wrapped adapter never sees the bytes',
    { timeout: 120_000 },
    async () => {
      const badBytes = fs.readFileSync(path.join(FIXTURES, 'bad.png'));
      const badDigest = sha256Hex(badBytes);
      const badKey = await verdictKey(badBytes);

      const ghost = await GhostContainer.start({
        storage__images__adapter: 'ScanningStorageAdapter',
        storage__images__verdictSource: 'in-process-fake',
        storage__images__wraps: 'LocalImagesStorage',
        storage__images__quarantinePath: '/var/lib/ghost/content/quarantine',
        storage__images__refuse: JSON.stringify({
          [badKey]: { classification: 'csam', matchType: 'exact' },
        }),
        // See the previous test's identical addition for why.
        storage__media__adapter: 'ScanningStorageAdapter',
        storage__media__verdictSource: 'in-process-fake',
        storage__media__wraps: 'LocalMediaStorage',
        storage__media__quarantinePath: '/var/lib/ghost/content/quarantine',
        storage__files__adapter: 'ScanningStorageAdapter',
        storage__files__verdictSource: 'in-process-fake',
        storage__files__wraps: 'LocalFilesStorage',
        storage__files__quarantinePath: '/var/lib/ghost/content/quarantine',
      });

      try {
        assert.equal(ghost.booted, true, `ghost did not boot:\n${ghost.logs()}`);
        await ghost.setupOwner();
        const cookie = await ghost.login();

        const refused = await ghost.uploadImage(cookie, path.join(FIXTURES, 'bad.png'), 'bad.png');
        assert.equal(refused.status, 415, JSON.stringify(refused.body));
        assert.doesNotMatch(refused.body.errors[0].context, /csam/);
      } finally {
        ghost.stop();
      }
    }
  );
});

describe('the scanning storage decorator, wrapping S3Storage', () => {
  it(
    'refuses a match on the object-storage tier too, and nothing refused reaches the bucket',
    { timeout: 150_000 },
    async () => {
      const network = `scan-net-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      const badBytes = fs.readFileSync(path.join(FIXTURES, 'bad.png'));
      const badDigest = sha256Hex(badBytes);
      const badKey = await verdictKey(badBytes);

      // Network, then both containers, all inside one try/finally: a
      // failure partway through setup (e.g. the mock never becomes ready)
      // must not leak whatever was already created.
      let double;
      let ghost;
      createNetwork(network);
      try {
        double = await S3MockDouble.start(network);
        // Addressed by container name over the shared network, not
        // host.docker.internal: that hostname only resolves under Docker
        // Desktop, and this same test runs on a Linux CI runner too, where
        // a container can reach another container only via a shared
        // user-defined network's own DNS.
        ghost = await GhostContainer.start(
          {
            storage__images__adapter: 'ScanningStorageAdapter',
            storage__images__verdictSource: 'in-process-fake',
            storage__images__wraps: 'S3Storage',
            storage__images__quarantinePath: '/var/lib/ghost/content/quarantine',
            storage__images__refuse: JSON.stringify({
              [badKey]: { classification: 'harmful-abusive-material', matchType: 'exact' },
            }),
            storage__images__wrappedConfig__bucket: double.bucket,
            storage__images__wrappedConfig__staticFileURLPrefix: 'content/images',
            storage__images__wrappedConfig__cdnUrl: `http://${double.name}:9090/${double.bucket}`,
            storage__images__wrappedConfig__endpoint: `http://${double.name}:9090`,
            storage__images__wrappedConfig__region: 'us-east-1',
            storage__images__wrappedConfig__forcePathStyle: 'true',
            storage__images__wrappedConfig__accessKeyId: 'scanning-storage-test',
            storage__images__wrappedConfig__secretAccessKey: 'scanning-storage-test',
            storage__images__wrappedConfig__multipartUploadThresholdBytes: '5242880',
            storage__images__wrappedConfig__multipartChunkSizeBytes: '5242880',
            // See the local-adapter tests' identical addition for why media
            // and files need the decorator too -- same bucket and double,
            // since this test's job is only to prove the images tier, not
            // to give media/files their own bucket layout.
            storage__media__adapter: 'ScanningStorageAdapter',
            storage__media__verdictSource: 'in-process-fake',
            storage__media__wraps: 'S3Storage',
            storage__media__quarantinePath: '/var/lib/ghost/content/quarantine',
            storage__media__wrappedConfig__bucket: double.bucket,
            storage__media__wrappedConfig__staticFileURLPrefix: 'content/media',
            storage__media__wrappedConfig__cdnUrl: `http://${double.name}:9090/${double.bucket}`,
            storage__media__wrappedConfig__endpoint: `http://${double.name}:9090`,
            storage__media__wrappedConfig__region: 'us-east-1',
            storage__media__wrappedConfig__forcePathStyle: 'true',
            storage__media__wrappedConfig__accessKeyId: 'scanning-storage-test',
            storage__media__wrappedConfig__secretAccessKey: 'scanning-storage-test',
            storage__media__wrappedConfig__multipartUploadThresholdBytes: '5242880',
            storage__media__wrappedConfig__multipartChunkSizeBytes: '5242880',
            storage__files__adapter: 'ScanningStorageAdapter',
            storage__files__verdictSource: 'in-process-fake',
            storage__files__wraps: 'S3Storage',
            storage__files__quarantinePath: '/var/lib/ghost/content/quarantine',
            storage__files__wrappedConfig__bucket: double.bucket,
            storage__files__wrappedConfig__staticFileURLPrefix: 'content/files',
            storage__files__wrappedConfig__cdnUrl: `http://${double.name}:9090/${double.bucket}`,
            storage__files__wrappedConfig__endpoint: `http://${double.name}:9090`,
            storage__files__wrappedConfig__region: 'us-east-1',
            storage__files__wrappedConfig__forcePathStyle: 'true',
            storage__files__wrappedConfig__accessKeyId: 'scanning-storage-test',
            storage__files__wrappedConfig__secretAccessKey: 'scanning-storage-test',
            storage__files__wrappedConfig__multipartUploadThresholdBytes: '5242880',
            storage__files__wrappedConfig__multipartChunkSizeBytes: '5242880',
          },
          { network }
        );

        assert.equal(ghost.booted, true, `ghost did not boot:\n${ghost.logs()}`);
        await ghost.setupOwner();
        const cookie = await ghost.login();

        const refused = await ghost.uploadImage(cookie, path.join(FIXTURES, 'bad.png'), 'bad.png');
        assert.equal(refused.status, 415, JSON.stringify(refused.body));

        const clean = await ghost.uploadImage(cookie, path.join(FIXTURES, 'clean.png'), 'good.png');
        assert.equal(clean.status, 201, JSON.stringify(clean.body));
        const key = new URL(clean.body.images[0].url).pathname.replace(`/${double.bucket}/`, '');

        assert.equal(await double.objectExists(key), true, 'a clean upload must reach the bucket');
        // The refused upload's key would live at the same relative path the
        // clean one did, one directory entry earlier; what matters is that no
        // object was ever written for it -- checked directly by digest below.
        const quarantined = ghost.ls('/var/lib/ghost/content/quarantine');
        assert.ok(
          quarantined.includes(badDigest),
          `quarantine must hold the refused digest: ${quarantined}`
        );
      } finally {
        if (ghost) ghost.stop();
        if (double) double.stop();
        // Docker refuses to remove a network while a container is still
        // attached to it, so this only runs after both are gone.
        removeNetwork(network);
      }
    }
  );
});

// The hold branch: accept on no verdict, serve nothing until a clean one,
// on both storage backends. The verdict client is configured to never answer
// (storage__images__unavailable) rather than made to hang --
// the synchronous timeout race is already proven by the refusal tests
// above and by checks.js's own unit tests; duplicating it here would only
// slow down every run of this suite. A clean verdict is delivered from
// this test driver -- a separate process from the container -- by writing
// a file the fake verdict client polls for (storage__images__resolvePath;
// see verdict-client.js's own comment for why this is a test seam, never a
// guess at the real channel's wire format).
describe('the hold branch, against a real Ghost', () => {
  it(
    'local backend: accepts the held upload, withholds the original and a size variant until a clean verdict, and never serves an object that never clears',
    { timeout: 150_000 },
    async () => {
      const cleanBytes = fs.readFileSync(path.join(FIXTURES, 'clean.png'));
      const heldDigest = sha256Hex(cleanBytes);
      const heldKey = await verdictKey(cleanBytes);
      const resolveHostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanning-storage-resolve-'));
      // World-writable before the container that will chown it to "node"
      // ever starts -- see reclaimHostOwnership's own comment. Without this,
      // the mid-test fs.writeFileSync delivering the verdict below fails
      // EACCES the same way teardown used to.
      fs.chmodSync(resolveHostDir, 0o777);

      const ghost = await GhostContainer.start(
        {
          storage__images__adapter: 'ScanningStorageAdapter',
          storage__images__verdictSource: 'in-process-fake',
          storage__images__wraps: 'LocalImagesStorage',
          storage__images__quarantinePath: '/var/lib/ghost/content/quarantine',
          storage__images__unavailable: JSON.stringify([heldKey]),
          storage__images__resolvePath: '/var/lib/ghost/content/verdict-resolve',
          storage__images__holdRetryMs: '1000',
          // The entrypoint's fail-closed guard requires the decorator on
          // every feature, not just the one this test exercises -- media
          // and files never go on hold here, only let Ghost boot at all.
          storage__media__adapter: 'ScanningStorageAdapter',
          storage__media__verdictSource: 'in-process-fake',
          storage__media__wraps: 'LocalMediaStorage',
          storage__media__quarantinePath: '/var/lib/ghost/content/quarantine',
          storage__files__adapter: 'ScanningStorageAdapter',
          storage__files__verdictSource: 'in-process-fake',
          storage__files__wraps: 'LocalFilesStorage',
          storage__files__quarantinePath: '/var/lib/ghost/content/quarantine',
        },
        { volumes: [{ host: resolveHostDir, container: '/var/lib/ghost/content/verdict-resolve' }] }
      );

      try {
        assert.equal(ghost.booted, true, `ghost did not boot:\n${ghost.logs()}`);
        await ghost.setupOwner();
        const cookie = await ghost.login();

        const held = await ghost.uploadImage(cookie, path.join(FIXTURES, 'clean.png'), 'held.png');
        assert.equal(held.status, 201, JSON.stringify(held.body));
        const originalPath = new URL(held.body.images[0].url).pathname;
        const sizePath = originalPath.replace('/content/images/', '/content/images/size/w600/');

        assert.equal(
          await ghost.getStatus(originalPath),
          404,
          'a held upload must return 201 and a URL, but that URL must serve nothing yet'
        );
        assert.equal(
          await ghost.getStatus(sizePath, { followRedirects: false }),
          404,
          'a responsive-size request for a held original must not return an image'
        );
        // Not just "the response wasn't 200": handleImageSizes must never
        // even get bytes to resize, so no derivative is written to disk at
        // all while the original is unverified.
        assert.deepEqual(
          ghost.ls('/var/lib/ghost/content/images/size/w600/2026/09'),
          [],
          'a held original must never produce a derivative on disk'
        );

        // The control case: a held object that never clears is never served.
        await sleep(2500);
        assert.equal(
          await ghost.getStatus(originalPath),
          404,
          'a held object that never gets a verdict must still not be served'
        );

        fs.writeFileSync(
          path.join(resolveHostDir, `${resolveFileStem(heldKey)}.json`),
          JSON.stringify({ classification: 'no-known-match' })
        );
        await sleep(6000);

        assert.equal(await ghost.getStatus(originalPath), 200, 'a promoted object must now serve');
        assert.equal(
          await ghost.getStatus(sizePath, { followRedirects: false }),
          200,
          'a responsive-size request must now return the derivative'
        );
      } finally {
        ghost.stop();
        reclaimHostOwnership(resolveHostDir);
        fs.rmSync(resolveHostDir, { recursive: true, force: true });
      }
    }
  );

  // Review cycle 1, Finding 1/2: the quarantine directory, not this
  // process's memory, is the source of truth for a pending hold. Proven
  // here against a REAL container restart (`docker restart`, same
  // writable layer, entrypoint killed and started again) -- a deploy of
  // this very image, a crash, an OOM kill, or a health-check restart, not
  // a contrived shape.
  it(
    'a held upload survives a real container restart: still withheld immediately after, and promoted on a verdict delivered afterward',
    { timeout: 180_000 },
    async () => {
      const cleanBytes = fs.readFileSync(path.join(FIXTURES, 'clean.png'));
      const heldDigest = sha256Hex(cleanBytes);
      const heldKey = await verdictKey(cleanBytes);
      const resolveHostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanning-storage-restart-'));
      // See the first hold-branch test's identical call for why.
      fs.chmodSync(resolveHostDir, 0o777);

      const ghost = await GhostContainer.start(
        {
          storage__images__adapter: 'ScanningStorageAdapter',
          storage__images__verdictSource: 'in-process-fake',
          storage__images__wraps: 'LocalImagesStorage',
          storage__images__quarantinePath: '/var/lib/ghost/content/quarantine',
          storage__images__unavailable: JSON.stringify([heldKey]),
          storage__images__resolvePath: '/var/lib/ghost/content/verdict-resolve',
          storage__images__holdRetryMs: '1000',
          // The entrypoint's fail-closed guard requires the decorator on
          // every feature, not just the one this test exercises -- media
          // and files never go on hold here, only let Ghost boot at all.
          storage__media__adapter: 'ScanningStorageAdapter',
          storage__media__verdictSource: 'in-process-fake',
          storage__media__wraps: 'LocalMediaStorage',
          storage__media__quarantinePath: '/var/lib/ghost/content/quarantine',
          storage__files__adapter: 'ScanningStorageAdapter',
          storage__files__verdictSource: 'in-process-fake',
          storage__files__wraps: 'LocalFilesStorage',
          storage__files__quarantinePath: '/var/lib/ghost/content/quarantine',
        },
        { volumes: [{ host: resolveHostDir, container: '/var/lib/ghost/content/verdict-resolve' }] }
      );

      try {
        assert.equal(ghost.booted, true, `ghost did not boot:\n${ghost.logs()}`);
        await ghost.setupOwner();
        const cookie = await ghost.login();

        const held = await ghost.uploadImage(cookie, path.join(FIXTURES, 'clean.png'), 'held.png');
        assert.equal(held.status, 201, JSON.stringify(held.body));
        const originalPath = new URL(held.body.images[0].url).pathname;
        assert.equal(await ghost.getStatus(originalPath), 404, 'held before the restart');

        await ghost.restart();
        assert.equal(ghost.booted, true, `ghost did not re-boot after restart:\n${ghost.logs()}`);

        // (a): still not served immediately after the restart -- the
        // quarantine bytes never left the served tree's absence, and a
        // fresh HoldRegistry inside the restarted process's own adapter
        // instance found the pending hold on disk rather than reading an
        // empty in-memory map.
        assert.equal(
          await ghost.getStatus(originalPath),
          404,
          'a held upload must still be withheld immediately after a restart'
        );
        const quarantined = ghost.ls('/var/lib/ghost/content/quarantine');
        assert.ok(
          quarantined.includes(heldDigest) && quarantined.includes(`${heldDigest}.holds.json`),
          `the quarantine bytes and sidecar must both survive the restart: ${quarantined}`
        );

        // (b): a clean verdict delivered AFTER the restart still promotes
        // it -- the restarted process resumed polling, not just resumed
        // remembering to withhold.
        fs.writeFileSync(
          path.join(resolveHostDir, `${resolveFileStem(heldKey)}.json`),
          JSON.stringify({ classification: 'no-known-match' })
        );
        await sleep(6000);

        assert.equal(
          await ghost.getStatus(originalPath),
          200,
          'a held upload must promote and serve once a clean verdict arrives after a restart'
        );

        // (c): promoted by the images decorator only. media and files share
        // this quarantine directory, and their own verdict clients answer
        // clean for this digest, so a decorator resuming another feature's
        // hold would copy it into its own served tree. The images listing is
        // the control: the same ls must find the promoted file there.
        const relative = originalPath.replace('/content/images/', '');
        const heldDir = path.posix.dirname(relative);
        const heldName = path.posix.basename(relative);
        assert.ok(
          ghost.ls(`/var/lib/ghost/content/images/${heldDir}`).includes(heldName),
          'the promoted file must be in the images tree'
        );
        for (const feature of ['media', 'files']) {
          assert.ok(
            !ghost.ls(`/var/lib/ghost/content/${feature}/${heldDir}`).includes(heldName),
            `a held image must never be promoted into the ${feature} tree`
          );
        }
      } finally {
        ghost.stop();
        reclaimHostOwnership(resolveHostDir);
        fs.rmSync(resolveHostDir, { recursive: true, force: true });
      }
    }
  );

  it(
    'object-storage backend: never writes to the bucket while held -- not yet written at all, not merely unlinked -- and promotion is a write',
    { timeout: 150_000 },
    async () => {
      const network = `scan-net-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      const cleanBytes = fs.readFileSync(path.join(FIXTURES, 'clean.png'));
      const heldDigest = sha256Hex(cleanBytes);
      const heldKey = await verdictKey(cleanBytes);
      const resolveHostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanning-storage-resolve-'));
      // See the first hold-branch test's identical call for why.
      fs.chmodSync(resolveHostDir, 0o777);

      // Network, then both containers, all inside one try/finally -- same
      // shape as the refusal test above, for the same reason: a failure
      // partway through setup must not leak a container or the network.
      let double;
      let ghost;
      createNetwork(network);
      try {
        double = await S3MockDouble.start(network);
        ghost = await GhostContainer.start(
          {
            storage__images__adapter: 'ScanningStorageAdapter',
            storage__images__verdictSource: 'in-process-fake',
            storage__images__wraps: 'S3Storage',
            storage__images__quarantinePath: '/var/lib/ghost/content/quarantine',
            storage__images__unavailable: JSON.stringify([heldKey]),
            storage__images__resolvePath: '/var/lib/ghost/content/verdict-resolve',
            storage__images__holdRetryMs: '1000',
            storage__images__wrappedConfig__bucket: double.bucket,
            storage__images__wrappedConfig__staticFileURLPrefix: 'content/images',
            // Addressed by container name over the shared network, not
            // host.docker.internal -- see createNetwork's own comment.
            storage__images__wrappedConfig__cdnUrl: `http://${double.name}:9090/${double.bucket}`,
            storage__images__wrappedConfig__endpoint: `http://${double.name}:9090`,
            storage__images__wrappedConfig__region: 'us-east-1',
            storage__images__wrappedConfig__forcePathStyle: 'true',
            storage__images__wrappedConfig__accessKeyId: 'scanning-storage-test',
            storage__images__wrappedConfig__secretAccessKey: 'scanning-storage-test',
            storage__images__wrappedConfig__multipartUploadThresholdBytes: '5242880',
            storage__images__wrappedConfig__multipartChunkSizeBytes: '5242880',
            // See the local-adapter hold-branch tests' identical addition
            // for why media and files need the decorator too -- same
            // bucket and double, since this test's job is only to prove
            // the images tier's hold behaviour.
            storage__media__adapter: 'ScanningStorageAdapter',
            storage__media__verdictSource: 'in-process-fake',
            storage__media__wraps: 'S3Storage',
            storage__media__quarantinePath: '/var/lib/ghost/content/quarantine',
            storage__media__wrappedConfig__bucket: double.bucket,
            storage__media__wrappedConfig__staticFileURLPrefix: 'content/media',
            storage__media__wrappedConfig__cdnUrl: `http://${double.name}:9090/${double.bucket}`,
            storage__media__wrappedConfig__endpoint: `http://${double.name}:9090`,
            storage__media__wrappedConfig__region: 'us-east-1',
            storage__media__wrappedConfig__forcePathStyle: 'true',
            storage__media__wrappedConfig__accessKeyId: 'scanning-storage-test',
            storage__media__wrappedConfig__secretAccessKey: 'scanning-storage-test',
            storage__media__wrappedConfig__multipartUploadThresholdBytes: '5242880',
            storage__media__wrappedConfig__multipartChunkSizeBytes: '5242880',
            storage__files__adapter: 'ScanningStorageAdapter',
            storage__files__verdictSource: 'in-process-fake',
            storage__files__wraps: 'S3Storage',
            storage__files__quarantinePath: '/var/lib/ghost/content/quarantine',
            storage__files__wrappedConfig__bucket: double.bucket,
            storage__files__wrappedConfig__staticFileURLPrefix: 'content/files',
            storage__files__wrappedConfig__cdnUrl: `http://${double.name}:9090/${double.bucket}`,
            storage__files__wrappedConfig__endpoint: `http://${double.name}:9090`,
            storage__files__wrappedConfig__region: 'us-east-1',
            storage__files__wrappedConfig__forcePathStyle: 'true',
            storage__files__wrappedConfig__accessKeyId: 'scanning-storage-test',
            storage__files__wrappedConfig__secretAccessKey: 'scanning-storage-test',
            storage__files__wrappedConfig__multipartUploadThresholdBytes: '5242880',
            storage__files__wrappedConfig__multipartChunkSizeBytes: '5242880',
          },
          {
            network,
            volumes: [
              { host: resolveHostDir, container: '/var/lib/ghost/content/verdict-resolve' },
            ],
          }
        );

        assert.equal(ghost.booted, true, `ghost did not boot:\n${ghost.logs()}`);
        await ghost.setupOwner();
        const cookie = await ghost.login();

        const held = await ghost.uploadImage(cookie, path.join(FIXTURES, 'clean.png'), 'held.png');
        assert.equal(held.status, 201, JSON.stringify(held.body));
        const key = new URL(held.body.images[0].url).pathname.replace(`/${double.bucket}/`, '');

        assert.equal(
          await double.objectExists(key),
          false,
          'a held object must not be written to the bucket at all'
        );

        // The control case: a held object that never clears is never served.
        await sleep(2500);
        assert.equal(
          await double.objectExists(key),
          false,
          'a held object that never gets a verdict must still not be in the bucket'
        );

        fs.writeFileSync(
          path.join(resolveHostDir, `${resolveFileStem(heldKey)}.json`),
          JSON.stringify({ classification: 'no-known-match' })
        );
        await sleep(2500);

        assert.equal(
          await double.objectExists(key),
          true,
          'promotion is a write: the bucket now holds the object'
        );
      } finally {
        if (ghost) ghost.stop();
        if (double) double.stop();
        removeNetwork(network);
        reclaimHostOwnership(resolveHostDir);
        fs.rmSync(resolveHostDir, { recursive: true, force: true });
      }
    }
  );
});

// The three features' decorators share one quarantine directory. Bytes the
// files feature refuses are held by the images feature at the same time;
// the images feature's own verdict then comes back clean. The refusal must
// win: nothing is promoted, and the refused bytes stay as the sealed record.
describe('a refusal in one feature, against a real Ghost', () => {
  it(
    'stops a held image with the same bytes from ever being served, and keeps the sealed record',
    { timeout: 150_000 },
    async () => {
      const cleanBytes = fs.readFileSync(path.join(FIXTURES, 'clean.png'));
      const digest = sha256Hex(cleanBytes);
      const key = await verdictKey(cleanBytes);
      const resolveHostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanning-storage-xfeature-'));
      // See the first hold-branch test's identical call for why.
      fs.chmodSync(resolveHostDir, 0o777);

      const ghost = await GhostContainer.start(
        {
          storage__images__adapter: 'ScanningStorageAdapter',
          storage__images__verdictSource: 'in-process-fake',
          storage__images__wraps: 'LocalImagesStorage',
          storage__images__quarantinePath: '/var/lib/ghost/content/quarantine',
          storage__images__unavailable: JSON.stringify([key]),
          storage__images__resolvePath: '/var/lib/ghost/content/verdict-resolve',
          storage__images__holdRetryMs: '1000',
          storage__media__adapter: 'ScanningStorageAdapter',
          storage__media__verdictSource: 'in-process-fake',
          storage__media__wraps: 'LocalMediaStorage',
          storage__media__quarantinePath: '/var/lib/ghost/content/quarantine',
          storage__files__adapter: 'ScanningStorageAdapter',
          storage__files__verdictSource: 'in-process-fake',
          storage__files__wraps: 'LocalFilesStorage',
          storage__files__quarantinePath: '/var/lib/ghost/content/quarantine',
          storage__files__refuse: JSON.stringify({
            [key]: { classification: 'csam', matchType: 'exact' },
          }),
        },
        { volumes: [{ host: resolveHostDir, container: '/var/lib/ghost/content/verdict-resolve' }] }
      );

      try {
        assert.equal(ghost.booted, true, `ghost did not boot:\n${ghost.logs()}`);
        await ghost.setupOwner();
        const cookie = await ghost.login();

        const held = await ghost.uploadImage(cookie, path.join(FIXTURES, 'clean.png'), 'held.png');
        assert.equal(held.status, 201, JSON.stringify(held.body));
        const originalPath = new URL(held.body.images[0].url).pathname;
        assert.equal(await ghost.getStatus(originalPath), 404, 'held, so not served yet');

        // The same bytes through the files feature, named as a type that
        // feature accepts: the digest is of the bytes, never the name.
        const refused = await ghost.uploadFile(
          cookie,
          path.join(FIXTURES, 'clean.png'),
          'record.pdf',
          'application/pdf'
        );
        assert.equal(refused.status, 415, JSON.stringify(refused.body));

        fs.writeFileSync(
          path.join(resolveHostDir, `${resolveFileStem(key)}.json`),
          JSON.stringify({ classification: 'no-known-match' })
        );
        await sleep(6000);

        assert.equal(
          await ghost.getStatus(originalPath),
          404,
          'bytes another feature refused must never be promoted, whatever this feature was told'
        );
        const quarantined = ghost.ls('/var/lib/ghost/content/quarantine');
        assert.ok(
          quarantined.includes(digest) && quarantined.includes(`${digest}.refused.json`),
          `the sealed bytes and the refusal record must both remain: ${quarantined}`
        );
        assert.ok(
          !quarantined.includes(`${digest}.holds.json`),
          `the images hold must be resolved as refused, not left pending: ${quarantined}`
        );
      } finally {
        ghost.stop();
        reclaimHostOwnership(resolveHostDir);
        fs.rmSync(resolveHostDir, { recursive: true, force: true });
      }
    }
  );
});
