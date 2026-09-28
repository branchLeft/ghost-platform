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
const { RELEASING_INFIX } = require('../../src/quarantine.js');

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
  return { exited };
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

describe('a refusal sealed in one process while another releases the same bytes', () => {
  it.each(ORDERS.map((order) => [order.join(' > '), order]))(
    'keeps the sealed bytes behind the record: %s',
    async (_name, order) => {
      const actors = { release: startActor('release'), seal: startActor('seal') };
      await waitForAny(['release.at0']);
      await waitForAny(['seal.at0']);

      const step = { release: 0, seal: 0 };
      for (const role of order) {
        if (fsSync.existsSync(path.join(controlDir, `${role}.done`))) continue;
        await fs.writeFile(path.join(controlDir, `${role}.go${step[role]}`), '');
        step[role] += 1;
        await waitForAny(step[role] === 1 ? [`${role}.at1`, `${role}.done`] : [`${role}.done`]);
      }

      const results = await Promise.all([actors.release.exited, actors.seal.exited]);
      for (const { code, stderr } of results) expect(code, stderr).toBe(0);

      const names = await fs.readdir(quarantinePath);
      expect(names).toContain(`${DIGEST}.refused.json`);
      expect(names.filter((n) => n.includes(RELEASING_INFIX))).toEqual([]);
      await expect(fs.readFile(path.join(quarantinePath, DIGEST))).resolves.toEqual(BYTES);
    },
    30_000
  );
});
