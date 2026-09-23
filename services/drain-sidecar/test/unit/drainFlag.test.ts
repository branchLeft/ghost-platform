import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileDrainFlag } from '../../src/drainFlag.js';

describe('createFileDrainFlag', () => {
  let dir: string;
  let flagPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'drain-flag-'));
    flagPath = join(dir, 'drain');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is unset when the file does not exist', () => {
    expect(createFileDrainFlag(flagPath).isSet()).toBe(false);
  });

  it('is set once the file exists, regardless of its contents', () => {
    writeFileSync(flagPath, '');
    expect(createFileDrainFlag(flagPath).isSet()).toBe(true);
  });

  it('tracks the file live -- no caching across calls', () => {
    const flag = createFileDrainFlag(flagPath);
    expect(flag.isSet()).toBe(false);

    writeFileSync(flagPath, '');
    expect(flag.isSet()).toBe(true);

    unlinkSync(flagPath);
    expect(flag.isSet()).toBe(false);
  });

  it('is set (fails closed) when the containing directory cannot be traversed', () => {
    const restrictedDir = mkdtempSync(join(tmpdir(), 'drain-flag-'));
    const restrictedFlagPath = join(restrictedDir, 'drain');
    chmodSync(restrictedDir, 0o000);
    try {
      expect(createFileDrainFlag(restrictedFlagPath).isSet()).toBe(true);
    } finally {
      // Restore access before cleanup -- afterEach only removes `dir`, but
      // this test manages `restrictedDir` itself, and rmSync can't recurse
      // into a directory it can't read.
      chmodSync(restrictedDir, 0o700);
      rmSync(restrictedDir, { recursive: true, force: true });
    }
  });

  it('is set (fails closed) when the containing directory does not exist', () => {
    const missingPath = join(dir, 'no-such-directory', 'drain');
    expect(createFileDrainFlag(missingPath).isSet()).toBe(true);
  });
});
