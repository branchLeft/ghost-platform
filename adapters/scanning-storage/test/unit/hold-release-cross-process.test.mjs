import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { holdersOf } from '../helpers/holders.mjs';

const require = createRequire(import.meta.url);
const { digestBytes } = require('../../src/pdq.js');
const { HoldRegistry } = require('../../src/hold.js');
const { RELEASING_INFIX } = require('../../src/quarantine.js');

const ACTOR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'helpers',
  'hold-release-actor.cjs'
);
const BYTES = Buffer.from('bytes-two-holds-share');
const DIGEST = digestBytes(BYTES);

let tmpDir;
let quarantinePath;
let controlDir;
let bytesFile;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hold-release-test-'));
  quarantinePath = path.join(tmpDir, 'quarantine');
  controlDir = path.join(tmpDir, 'control');
  bytesFile = path.join(tmpDir, 'upload');
  await fs.mkdir(quarantinePath);
  await fs.mkdir(controlDir);
  await fs.writeFile(bytesFile, BYTES);
  await fs.writeFile(path.join(quarantinePath, DIGEST), BYTES);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function startActor(role, pauseAt) {
  // A minimal, explicit environment: nothing from this shell reaches the child.
  const child = spawn(
    process.execPath,
    [ACTOR, role, quarantinePath, bytesFile, controlDir, pauseAt],
    {
      env: {},
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code, stderr }));
  });
  return { exited };
}

async function waitFor(file, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fsSync.existsSync(path.join(controlDir, file))) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function open(role, n) {
  await fs.writeFile(path.join(controlDir, `${role}.go${n}`), '');
}

async function sidecarOwners() {
  return Object.keys((await holdersOf(quarantinePath, DIGEST)).owners).sort();
}

function registryFor(owner) {
  return new HoldRegistry({
    checks: [],
    policy: { decide: () => 'hold' },
    quarantinePath,
    owner,
    computeDigest: digestBytes,
    logger: { error: () => {} },
  });
}

// What a restart of this owner would resume: the targets it would promote,
// or none when its hold was lost.
function resumedTargets(owner) {
  const registry = registryFor(owner);
  const targets = [];
  registry.resumeFromQuarantine((targetPath) => {
    targets.push(targetPath);
    return { onAllow: () => {}, onRefuse: () => {} };
  });
  registry.stopAll();
  return targets;
}

// The release has two steps a second process can land inside: before the
// bytes are moved aside, and after. A hold's sidecar written in either gap,
// with its bytes check passing or repairing, must survive the release.
describe.each([['before'], ['after']])(
  'a hold in another process landing its sidecar %s a release moves the bytes aside',
  (pauseAt) => {
    it('keeps both the bytes and the other holder’s sidecar', async () => {
      const releaser = startActor('releaser', pauseAt);
      const holder = startActor('holder');
      await waitFor('releaser.at0');
      await waitFor('holder.at0');

      // The releaser holds the digest, is allowed, and stops with the bytes
      // aside. Only then does the second process hold the same digest.
      await open('releaser', 0);
      await waitFor('releaser.at1');
      await open('holder', 0);
      await waitFor('holder.done');

      await open('releaser', 1);
      await waitFor('releaser.done');
      for (const { code, stderr } of await Promise.all([releaser.exited, holder.exited])) {
        expect(code, stderr).toBe(0);
      }

      const names = await fs.readdir(quarantinePath);
      expect(names.filter((n) => n.includes(RELEASING_INFIX))).toEqual([]);
      await expect(fs.readFile(path.join(quarantinePath, DIGEST))).resolves.toEqual(BYTES);
      expect(await sidecarOwners()).toEqual(['holder-owner']);
    }, 30_000);

    it('removes the bytes and the sidecar when no other process holds the digest', async () => {
      const releaser = startActor('releaser', pauseAt);
      await waitFor('releaser.at0');
      await open('releaser', 0);
      await waitFor('releaser.at1');
      await open('releaser', 1);
      const { code, stderr } = await releaser.exited;
      expect(code, stderr).toBe(0);
      expect(await fs.readdir(quarantinePath)).toEqual([]);
    }, 30_000);
  }
);

// The last holder's release decides from what it finds whether other
// holders remain. A hold in another process that lands after the releaser
// looked, and before it gives up its own entry, must survive the release:
// its entry kept, and the bytes with it.
describe('a hold in another process landing while a release is deciding whether it is the last holder', () => {
  async function race() {
    const releaser = startActor('releaser', 'entry');
    const holder = startActor('holder');
    await waitFor('releaser.at0');
    await waitFor('holder.at0');

    await open('releaser', 0);
    await waitFor('releaser.at1');
    await open('holder', 0);
    await waitFor('holder.done');

    await open('releaser', 1);
    await waitFor('releaser.done');
    for (const { code, stderr } of await Promise.all([releaser.exited, holder.exited])) {
      expect(code, stderr).toBe(0);
    }
  }

  it('keeps the other process’s hold and the bytes when the releaser was the last holder', async () => {
    await race();

    await expect(fs.readFile(path.join(quarantinePath, DIGEST))).resolves.toEqual(BYTES);
    expect(resumedTargets('holder-owner')).toEqual(['holder.png']);
  }, 30_000);

  it('keeps the other process’s hold when a third holder also remains', async () => {
    const bystander = registryFor('bystander-owner');
    await bystander.hold(DIGEST, BYTES, {
      targetPath: 'bystander.png',
      onAllow: () => {},
      onRefuse: () => {},
    });
    bystander.stopAll();

    await race();

    await expect(fs.readFile(path.join(quarantinePath, DIGEST))).resolves.toEqual(BYTES);
    expect(resumedTargets('holder-owner')).toEqual(['holder.png']);
    expect(resumedTargets('bystander-owner')).toEqual(['bystander.png']);
  }, 30_000);
});
