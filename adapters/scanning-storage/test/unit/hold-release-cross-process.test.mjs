import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { digestBytes } = require('../../src/pdq.js');
const { HOLDS_SUFFIX } = require('../../src/hold.js');
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
  const raw = await fs.readFile(path.join(quarantinePath, `${DIGEST}${HOLDS_SUFFIX}`), 'utf8');
  return Object.keys(JSON.parse(raw).owners).sort();
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
