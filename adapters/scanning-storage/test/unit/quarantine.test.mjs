import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { quarantineBytes } = require('../../src/quarantine.js');

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quarantine-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('quarantineBytes', () => {
  it('creates the quarantine directory if it does not exist yet', async () => {
    const quarantinePath = path.join(tmpDir, 'nested', 'quarantine');
    await quarantineBytes(quarantinePath, 'digest-1', Buffer.from('bytes'));
    const written = await fs.readFile(path.join(quarantinePath, 'digest-1'));
    expect(written.toString()).toBe('bytes');
  });

  it('names the file by digest, not by any uploader-chosen name', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    const target = await quarantineBytes(quarantinePath, 'abc123', Buffer.from('x'));
    expect(path.basename(target)).toBe('abc123');
  });

  it('writing the same digest twice is a no-op in effect', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    await quarantineBytes(quarantinePath, 'abc123', Buffer.from('same-bytes'));
    await quarantineBytes(quarantinePath, 'abc123', Buffer.from('same-bytes'));
    const written = await fs.readFile(path.join(quarantinePath, 'abc123'));
    expect(written.toString()).toBe('same-bytes');
  });
});
