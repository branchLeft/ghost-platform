import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { digestBytes } = require('../../src/pdq.js');
const {
  quarantineBytes,
  sealRefusal,
  sweepOrphans,
  writeFileAtomic,
  TEMP_LOG_PREFIX,
  TEMP_MIN_AGE_FLOOR_MS,
} = require('../../src/quarantine.js');

const BYTES = Buffer.from('bytes-a-refusal-keeps');
const DIGEST = digestBytes(BYTES);
const MIN_AGE_MS = 120_000;
const OLD_SECONDS = 60 * 60;

let tmpDir;
let quarantinePath;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crash-residue-test-'));
  quarantinePath = path.join(tmpDir, 'quarantine');
  await fs.mkdir(quarantinePath, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function recordingLogger() {
  return {
    lines: [],
    error(...args) {
      this.lines.push(args.map(String).join(' '));
    },
  };
}

const sweep = (overrides = {}) =>
  sweepOrphans(quarantinePath, {
    minAgeMs: MIN_AGE_MS,
    logger: recordingLogger(),
    ...overrides,
  });

const listing = async () => (await fs.readdir(quarantinePath)).sort();

async function ageFile(name, seconds = OLD_SECONDS) {
  const then = new Date(Date.now() - seconds * 1000);
  await fs.utimes(path.join(quarantinePath, name), then, then);
}

// The temp file a real writer leaves when it dies between its write and its
// rename: take the name writeFileAtomic gave it, and make the rename and the
// clean-up that follows a failed rename do nothing.
async function leaveRealResidue(target) {
  const renames = [];
  vi.spyOn(fs, 'rename').mockImplementation(async (from) => {
    renames.push(path.basename(from));
    throw new Error('simulated crash');
  });
  vi.spyOn(fs, 'rm').mockResolvedValue(undefined);
  await expect(writeFileAtomic(path.join(quarantinePath, target), 'half')).rejects.toThrow(
    'simulated crash'
  );
  vi.restoreAllMocks();
  return renames[0];
}

describe('crash-residue temp files in the quarantine directory', () => {
  it('removes the temp file a real writer left, once it is older than the minimum age, and logs it', async () => {
    const name = await leaveRealResidue(`${DIGEST}.holds.json`);
    expect(name).toMatch(/^\./);
    await ageFile(name);
    const logger = recordingLogger();

    expect(sweep({ logger })).toBe(1);

    expect(await listing()).toEqual([]);
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toContain(TEMP_LOG_PREFIX);
    expect(logger.lines[0]).toContain(name);
  });

  it('leaves a temp file younger than the minimum age alone and logs nothing', async () => {
    const name = await leaveRealResidue(DIGEST);
    await ageFile(name, 30);
    const logger = recordingLogger();

    expect(sweep({ logger })).toBe(0);

    expect(await listing()).toEqual([name]);
    expect(logger.lines).toEqual([]);
  });

  it('keeps a temp file exactly at the minimum age, and removes it one millisecond later', async () => {
    const name = await leaveRealResidue(DIGEST);
    const writtenAtMs = fsSync.statSync(path.join(quarantinePath, name)).mtimeMs;

    expect(sweep({ now: () => writtenAtMs + MIN_AGE_MS })).toBe(0);
    expect(await listing()).toEqual([name]);

    expect(sweep({ now: () => writtenAtMs + MIN_AGE_MS + 1 })).toBe(1);
    expect(await listing()).toEqual([]);
  });

  it('never removes a temp file younger than the floor, however small the age it was given', async () => {
    const name = await leaveRealResidue(DIGEST);
    const writtenAtMs = fsSync.statSync(path.join(quarantinePath, name)).mtimeMs;

    expect(sweep({ minAgeMs: 1, now: () => writtenAtMs + TEMP_MIN_AGE_FLOOR_MS })).toBe(0);
    expect(await listing()).toEqual([name]);

    expect(sweep({ minAgeMs: 1, now: () => writtenAtMs + TEMP_MIN_AGE_FLOOR_MS + 1 })).toBe(1);
    expect(await listing()).toEqual([]);
  });

  it('leaves bytes, sidecars, refusal records and aside copies alone, however old', async () => {
    await sealRefusal(quarantinePath, DIGEST, BYTES, { classification: 'csam' }, digestBytes);
    const held = digestBytes(Buffer.from('held'));
    await quarantineBytes(quarantinePath, held, Buffer.from('held'));
    await fs.writeFile(path.join(quarantinePath, `${held}.holds.json`), '{}');
    await fs.writeFile(path.join(quarantinePath, `${held}.releasing.1.abc`), 'aside');
    for (const name of await listing()) await ageFile(name);
    const before = await listing();
    const logger = recordingLogger();

    expect(sweep({ logger })).toBe(0);

    expect(await listing()).toEqual(before);
    await expect(fs.readFile(path.join(quarantinePath, DIGEST))).resolves.toEqual(BYTES);
    expect(logger.lines).toEqual([]);
  });

  it('removes only the temp file when it sits beside a refusal, and the refusal keeps its bytes', async () => {
    await sealRefusal(quarantinePath, DIGEST, BYTES, { classification: 'csam' }, digestBytes);
    const name = await leaveRealResidue(`${DIGEST}.refused.json`);
    await ageFile(name);
    await ageFile(DIGEST);
    await ageFile(`${DIGEST}.refused.json`);

    expect(sweep()).toBe(1);

    expect(await listing()).toEqual([DIGEST, `${DIGEST}.refused.json`].sort());
  });

  it('leaves every dotfile whose name is not exactly a writer temp name, however old', async () => {
    const names = [
      '.other.1.abc.tmp',
      '.no-pid.abcdef012345.tmp',
      `.${DIGEST}.123.abcdef01234.tmp`,
      `.${DIGEST}.123.ABCDEF012345.tmp`,
      `.${DIGEST}.123.abcdef012345`,
      `.${DIGEST}.123.abcdef0123456.tmp.bak`,
      '..123.abcdef012345.tmp',
      '.hidden',
      `${DIGEST}.123.abcdef012345.tmp`,
    ];
    for (const name of names) {
      await fs.writeFile(path.join(quarantinePath, name), 'not ours');
      await ageFile(name);
    }
    const logger = recordingLogger();

    // The last name has no leading dot, so it is plain bytes to the orphan
    // rule: it is the only one removed, and not as a temp file.
    expect(sweep({ logger })).toBe(1);

    expect(await listing()).toEqual(names.slice(0, -1).sort());
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).not.toContain(TEMP_LOG_PREFIX);
  });

  it('never touches anything but a regular file with the temp name', async () => {
    const outside = path.join(tmpDir, 'outside');
    await fs.writeFile(outside, 'not quarantine bytes');
    const dir = '.a-dir.1.abcdef012345.tmp';
    const link = '.a-link.1.abcdef012345.tmp';
    const dangling = '.a-dangling.1.abcdef012345.tmp';
    await fs.mkdir(path.join(quarantinePath, dir));
    await fs.symlink(outside, path.join(quarantinePath, link));
    await fs.symlink(path.join(tmpDir, 'missing'), path.join(quarantinePath, dangling));
    const then = new Date(Date.now() - OLD_SECONDS * 1000);
    for (const name of [dir, link, dangling]) {
      await fs.lutimes(path.join(quarantinePath, name), then, then);
    }
    const logger = recordingLogger();

    expect(sweep({ logger })).toBe(0);

    expect(await listing()).toEqual([dir, dangling, link].sort());
    await expect(fs.readFile(outside, 'utf8')).resolves.toBe('not quarantine bytes');
    expect(logger.lines).toEqual([]);
  });

  it('logs and carries on when one temp file cannot be removed', async () => {
    const stuck = await leaveRealResidue(`${DIGEST}.holds.json`);
    const other = await leaveRealResidue(DIGEST);
    await ageFile(stuck);
    await ageFile(other);
    const realRm = fsSync.rmSync;
    vi.spyOn(fsSync, 'rmSync').mockImplementation((file, options) => {
      if (path.basename(String(file)) === stuck) throw new Error('EPERM: simulated');
      return realRm(file, options);
    });
    const logger = recordingLogger();

    expect(sweep({ logger })).toBe(1);

    expect(await listing()).toEqual([stuck]);
    expect(logger.lines.some((line) => line.includes('left in place'))).toBe(true);
    expect(logger.lines.some((line) => line.includes(TEMP_LOG_PREFIX))).toBe(true);
  });

  it('two sweeps over one directory remove a temp file once and neither fails', async () => {
    const name = await leaveRealResidue(DIGEST);
    await ageFile(name);

    const first = sweep();
    const second = sweep();

    expect(first + second).toBe(1);
    expect(await listing()).toEqual([]);
  });
});
