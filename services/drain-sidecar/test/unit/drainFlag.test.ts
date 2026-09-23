import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
});
