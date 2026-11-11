import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeStorageBase } from '../helpers/fake-storage-base.mjs';
import { makeLoadWrappedAdapterClass } from '../helpers/fake-wrapped-adapter.mjs';
import { DirectoryBucketAdapter } from '../helpers/directory-bucket-adapter.mjs';

const require = createRequire(import.meta.url);
const { defineScanningStorageAdapter } = require('../../src/scanning-storage.js');
const { FakeVerdictClient } = require('../../src/verdict-client.js');
const { SafetyPolicy } = require('../../src/policy.js');
const { createPdqKnownMaterialCheck } = require('../../src/checks.js');
const { digestBytes } = require('../../src/pdq.js');
const GhostErrors = require('@tryghost/errors');

// The backup is the real media_backup_restore module, driven over fixture
// directories by this driver: no bucket, host or network is reached.
const DRIVER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../infra/provisioning/scripts/media_backup_held_proof.py'
);
const TENANT = 'fixture-tenant';
const WAIT = { timeout: 5000, interval: 10 };

const CLEAN = { name: 'clean', bytes: Buffer.from('clean-media-bytes-already-live') };
const HELD = { name: 'held', bytes: Buffer.from('held-media-bytes-awaiting-a-verdict') };
const REFUSED = { name: 'refused', bytes: Buffer.from('refused-media-bytes-known-bad') };
for (const upload of [CLEAN, HELD, REFUSED]) {
  upload.digest = digestBytes(upload.bytes);
}

function toolsMissing() {
  const missing = [];
  for (const [cmd, args] of [
    ['python3', ['--version']],
    ['age', ['--version']],
    ['age-keygen', ['--version']],
  ]) {
    if (spawnSync(cmd, args, { stdio: 'ignore' }).status !== 0) missing.push(cmd);
  }
  return missing;
}

const MISSING = toolsMissing();
// In CI a missing tool must fail the run, not skip the proof.
const runnable = MISSING.length === 0;
if (!runnable && process.env.CI) {
  describe('held media and backups', () => {
    it('has python3, age and age-keygen on PATH', () => {
      expect(MISSING).toEqual([]);
    });
  });
}

let root;
let dirs;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'held-media-backup-'));
  dirs = {
    bucket: path.join(root, 'live-bucket'),
    hostQuarantine: path.join(root, 'host', 'quarantine'),
    backups: path.join(root, 'backup-bucket'),
    keys: path.join(root, 'keys'),
    uploads: path.join(root, 'uploads'),
  };
  await fs.mkdir(dirs.bucket, { recursive: true });
  await fs.mkdir(dirs.uploads, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function buildAdapter(quarantinePath) {
  const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
    loadWrappedAdapterClass: makeLoadWrappedAdapterClass({
      DirectoryBucket: DirectoryBucketAdapter,
    }),
    GhostErrors,
  });
  const verdictClient = new FakeVerdictClient({
    refuse: new Map([[REFUSED.digest, { classification: 'csam', matchType: 'exact' }]]),
    unavailable: [HELD.digest],
  });
  const instance = new Adapter({
    wraps: 'DirectoryBucket',
    wrappedConfig: {
      storagePath: 'content/media',
      bucketDir: dirs.bucket,
      bucket: 'fixture-bucket',
      cdnUrl: 'https://cdn.example.test',
    },
    quarantinePath,
    checks: [createPdqKnownMaterialCheck(verdictClient, { computeDigest: digestBytes })],
    policy: new SafetyPolicy(),
    computeDigest: digestBytes,
    holdRetryMs: 20,
    holdLogger: { error: () => {} },
  });
  return { instance, verdictClient };
}

async function upload(adapter, { name, bytes }) {
  const filePath = path.join(dirs.uploads, `${name}-${Math.random().toString(16).slice(2)}`);
  await fs.writeFile(filePath, bytes);
  return adapter.save({ name: `${name}.png`, path: filePath, type: 'image/png' });
}

// The bucket key an upload's returned URL names.
function keyOfUrl(url) {
  return url.replace('https://cdn.example.test/', '');
}

async function filesUnder(dir) {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

async function keysIn(dir) {
  return (await filesUnder(dir))
    .map((file) => path.relative(dir, file).split(path.sep).join('/'))
    .sort();
}

function driver(command, args) {
  const result = spawnSync('python3', ['-I', DRIVER, command, '--key-dir', dirs.keys, ...args], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

const backup = () =>
  driver('backup', ['--tenant', TENANT, '--backup-dir', dirs.backups, '--live-dir', dirs.bucket]);

async function restore(label, runId) {
  const restoreDir = path.join(root, `restore-${label}`);
  const args = ['--tenant', TENANT, '--backup-dir', dirs.backups, '--restore-dir', restoreDir];
  if (runId) args.push('--run-id', runId);
  const result = driver('restore', args);
  return { ...result, restoreDir };
}

// Every trace of `secret` in a restored tree and in the backup itself: a
// restored file with its bytes, or named for its digest, or a decrypted
// backup object or manifest that carries its digest.
async function tracesOf(secret, restoreDir, { inspectBackup = true } = {}) {
  const traces = [];
  for (const file of await filesUnder(restoreDir)) {
    const content = await fs.readFile(file);
    if (content.includes(secret.bytes) || file.includes(secret.digest)) {
      traces.push(`restored file ${path.relative(restoreDir, file)}`);
    }
  }
  const blobs = inspectBackup ? driver('inspect', ['--backup-dir', dirs.backups]).blobs : [];
  for (const blob of blobs) {
    if (blob.sha256 === secret.digest) traces.push(`backup object ${blob.path}`);
    if (blob.manifest_text && blob.manifest_text.includes(secret.digest)) {
      traces.push(`manifest ${blob.path} names its digest`);
    }
  }
  return traces;
}

async function restoredBytes(restoreDir, key) {
  return fs.readFile(path.join(restoreDir, key));
}

describe.skipIf(!runnable)('held media and backups', () => {
  it('a backup taken while media is held or quarantined lacks it, and one taken after promotion has it', async () => {
    // The held area is the host's own directory, outside the bucket.
    const quarantinePath = dirs.hostQuarantine;
    const { instance: adapter, verdictClient } = buildAdapter(quarantinePath);
    const cleanKey = keyOfUrl(await upload(adapter, CLEAN));
    const promisedKey = keyOfUrl(await upload(adapter, HELD));
    await expect(upload(adapter, REFUSED)).rejects.toThrow();

    // Precondition: the held and refused bytes exist, in the held area, so
    // their absence from the backup is not an absence of data.
    const quarantined = await keysIn(quarantinePath);
    expect(quarantined).toContain(HELD.digest);
    expect(quarantined).toContain(REFUSED.digest);

    // A backup while held, restored into an empty tree.
    const whileHeld = backup();
    expect(whileHeld.backed_up).toEqual([cleanKey]);
    const restoredHeld = await restore('while-held', whileHeld.run_id);
    expect(restoredHeld.restored).toEqual([cleanKey]);
    expect(await restoredBytes(restoredHeld.restoreDir, cleanKey)).toEqual(CLEAN.bytes);
    expect(await tracesOf(HELD, restoredHeld.restoreDir)).toEqual([]);
    expect(await tracesOf(REFUSED, restoredHeld.restoreDir)).toEqual([]);

    // The verdict arrives and the held object is promoted into the bucket.
    verdictClient.deliverVerdict(HELD.digest, { classification: 'no-known-match' });
    await vi.waitFor(() => expect(adapter.hold.isPending(HELD.digest)).toBe(false), WAIT);

    // A backup after promotion, restored into a second empty tree.
    const afterPromotion = backup();
    expect(afterPromotion.backed_up).toEqual([cleanKey, promisedKey].sort());
    const restoredPromoted = await restore('after-promotion', afterPromotion.run_id);
    expect(restoredPromoted.restored).toEqual([cleanKey, promisedKey].sort());
    expect(await restoredBytes(restoredPromoted.restoreDir, promisedKey)).toEqual(HELD.bytes);
    expect(await restoredBytes(restoredPromoted.restoreDir, cleanKey)).toEqual(CLEAN.bytes);

    // Refused material is never promoted, so no backup ever carries it.
    expect(await tracesOf(REFUSED, restoredPromoted.restoreDir)).toEqual([]);

    // The earlier generation still lacks the object: promotion does not
    // rewrite history.
    const earlier = await restore('earlier-generation', whileHeld.run_id);
    expect(earlier.restored).toEqual([cleanKey]);
    expect(await keysIn(earlier.restoreDir)).toEqual([cleanKey]);
    expect(await tracesOf(HELD, earlier.restoreDir, { inspectBackup: false })).toEqual([]);
  }, 60_000);

  it('control: with the held area inside the bucket the backup reads, the assertion fails', async () => {
    const { instance: adapter } = buildAdapter(path.join(dirs.bucket, 'quarantine'));
    await upload(adapter, CLEAN);
    await upload(adapter, HELD);
    await expect(upload(adapter, REFUSED)).rejects.toThrow();

    const whileHeld = backup();
    const restored = await restore('sabotaged', whileHeld.run_id);

    expect(await tracesOf(HELD, restored.restoreDir)).not.toEqual([]);
    expect(await tracesOf(REFUSED, restored.restoreDir)).not.toEqual([]);
  }, 60_000);
});
