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
const { RELEASING_INFIX, sweepOrphans, ORPHAN_LOG_PREFIX } = require('../../src/quarantine.js');

const CRASH_ACTOR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'helpers',
  'hold-crash-actor.cjs'
);
const ACTOR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'helpers',
  'quarantine-actor.cjs'
);
const BYTES = Buffer.from('bytes-two-processes-share');
const DIGEST = digestBytes(BYTES);

let tmpDir;
let quarantinePath;
let controlDir;
let bytesFile;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cross-process-test-'));
  quarantinePath = path.join(tmpDir, 'quarantine');
  controlDir = path.join(tmpDir, 'control');
  bytesFile = path.join(tmpDir, 'upload');
  await fs.mkdir(quarantinePath);
  await fs.mkdir(controlDir);
  await fs.writeFile(bytesFile, BYTES);
  // The bytes a hold left in quarantine, about to be released by one
  // process while another seals a refusal of the same digest.
  await fs.writeFile(path.join(quarantinePath, DIGEST), BYTES);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function startActor(role) {
  // A minimal, explicit environment: nothing from this shell reaches the child.
  const child = spawn(
    process.execPath,
    [ACTOR, role, quarantinePath, DIGEST, bytesFile, controlDir],
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
  return { exited, child };
}

async function waitForAny(files, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = files.find((f) => fsSync.existsSync(path.join(controlDir, f)));
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${files.join(' or ')}`);
}

// Each actor has two steps, split by the pause its seam provides: the
// releaser moves the bytes aside | checks the record and unlinks or restores;
// the sealer writes the record | makes sure the bytes are there. These are
// all six ways to interleave them.
const ORDERS = [
  ['release', 'release', 'seal', 'seal'],
  ['release', 'seal', 'release', 'seal'],
  ['release', 'seal', 'seal', 'release'],
  ['seal', 'release', 'release', 'seal'],
  ['seal', 'release', 'seal', 'release'],
  ['seal', 'seal', 'release', 'release'],
];

async function runInterleaving(releaserRole, order) {
  const actors = { [releaserRole]: startActor(releaserRole), seal: startActor('seal') };
  await waitForAny([`${releaserRole}.at0`]);
  await waitForAny(['seal.at0']);

  const step = { [releaserRole]: 0, seal: 0 };
  for (const role of order.map((name) => (name === 'release' ? releaserRole : name))) {
    if (fsSync.existsSync(path.join(controlDir, `${role}.done`))) continue;
    await fs.writeFile(path.join(controlDir, `${role}.go${step[role]}`), '');
    step[role] += 1;
    await waitForAny(step[role] === 1 ? [`${role}.at1`, `${role}.done`] : [`${role}.done`]);
  }

  const results = await Promise.all([actors[releaserRole].exited, actors.seal.exited]);
  for (const { code, stderr } of results) expect(code, stderr).toBe(0);

  const names = await fs.readdir(quarantinePath);
  expect(names).toContain(`${DIGEST}.refused.json`);
  expect(names.filter((n) => n.includes(RELEASING_INFIX))).toEqual([]);
  await expect(fs.readFile(path.join(quarantinePath, DIGEST))).resolves.toEqual(BYTES);
}

describe('a refusal sealed in one process while another releases the same bytes', () => {
  it.each(ORDERS.map((order) => [order.join(' > '), order]))(
    'keeps the sealed bytes behind the record: %s',
    (_name, order) => runInterleaving('release', order),
    30_000
  );
});

describe('a refusal sealed in one process while another sweeps the same orphaned bytes', () => {
  beforeEach(async () => {
    const then = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(path.join(quarantinePath, DIGEST), then, then);
  });

  it.each(ORDERS.map((order) => [order.join(' > '), order]))(
    'keeps the sealed bytes behind the record: %s',
    (_name, order) => runInterleaving('sweep', order),
    30_000
  );
});

// A releaser dies with the bytes moved aside, a hold in a third process lands
// its sidecar, and a start-up sweep in a fourth finds the aside copy. The
// sidecar is written by the test, standing in for that hold.
async function leaveAsideThenSweep({ sidecarLands }) {
  const releaser = startActor('release');
  await waitForAny(['release.at0']);
  await fs.writeFile(path.join(controlDir, 'release.go0'), '');
  await waitForAny(['release.at1']);
  releaser.child.kill('SIGKILL');
  await releaser.exited;
  expect(await fs.readdir(quarantinePath)).toEqual([expect.stringContaining(RELEASING_INFIX)]);

  if (sidecarLands) {
    await fs.writeFile(
      path.join(quarantinePath, `${DIGEST}.holds.json`),
      JSON.stringify({ owners: { 'owner-a': ['a.png'] } })
    );
  }

  const sweeper = startActor('sweep-aside');
  await waitForAny(['sweep-aside.at0']);
  await fs.writeFile(path.join(controlDir, 'sweep-aside.go0'), '');
  const { code, stderr } = await sweeper.exited;
  expect(code, stderr).toBe(0);
  return fs.readdir(quarantinePath);
}

describe('a hold landing its sidecar while a start-up sweep finds a dead releaser’s aside copy', () => {
  it('restores the bytes beside the sidecar', async () => {
    const names = await leaveAsideThenSweep({ sidecarLands: true });
    expect(names.sort()).toEqual([DIGEST, `${DIGEST}.holds.json`].sort());
    await expect(fs.readFile(path.join(quarantinePath, DIGEST))).resolves.toEqual(BYTES);
  });

  it('still deletes the aside copy when no hold and no record names the digest', async () => {
    expect(await leaveAsideThenSweep({ sidecarLands: false })).toEqual([]);
  });
});

describe('a process killed between a hold writing its bytes and its sidecar', () => {
  it('leaves orphaned bytes that the next start-up sweep accounts for', async () => {
    await fs.rm(path.join(quarantinePath, DIGEST));
    const child = spawn(process.execPath, [CRASH_ACTOR, quarantinePath, bytesFile], {
      env: {},
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const { code, signal } = await new Promise((resolve) => {
      child.on('exit', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
    });
    expect(signal, `exit code ${code}: ${stderr}`).toBe('SIGKILL');

    expect(await fs.readdir(quarantinePath)).toEqual([DIGEST]);
    const then = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(path.join(quarantinePath, DIGEST), then, then);

    const lines = [];
    const removed = sweepOrphans(quarantinePath, {
      minAgeMs: 1000,
      logger: { error: (message) => lines.push(message) },
    });

    expect(removed).toBe(1);
    expect(await fs.readdir(quarantinePath)).toEqual([]);
    expect(lines).toEqual([expect.stringContaining(ORPHAN_LOG_PREFIX)]);
    expect(lines[0]).toContain(DIGEST);
  });
});
