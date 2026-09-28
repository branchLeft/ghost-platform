import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  quarantineBytes,
  quarantinedBytesMatch,
  writeFileAtomicSync,
  isRefused,
  readRefusal,
  sealRefusal,
} = require('../../src/quarantine.js');
const { digestBytes } = require('../../src/pdq.js');

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

describe('atomic writes', () => {
  // A hard link keeps pointing at whichever inode it was made against. An
  // in-place rewrite changes that inode, so the link sees the new bytes (or
  // a prefix of them, mid-write); a temp-file-and-rename swaps the directory
  // entry and leaves the old inode whole. This is the observable difference
  // between the two, deterministic rather than timing-dependent.
  it('replaces a quarantined file by rename, never by rewriting it in place', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    await quarantineBytes(quarantinePath, 'abc123', Buffer.from('old-bytes'));
    const reader = path.join(tmpDir, 'reader-view');
    await fs.link(path.join(quarantinePath, 'abc123'), reader);

    await quarantineBytes(quarantinePath, 'abc123', Buffer.from('new-bytes-longer'));

    expect((await fs.readFile(reader)).toString()).toBe('old-bytes');
    expect((await fs.readFile(path.join(quarantinePath, 'abc123'))).toString()).toBe(
      'new-bytes-longer'
    );
  });

  it('leaves no temp file behind', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    await quarantineBytes(quarantinePath, 'abc123', Buffer.from('bytes'));
    expect(await fs.readdir(quarantinePath)).toEqual(['abc123']);
  });

  it('removes its temp file when the rename fails', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    // A directory where the file should go makes the rename fail.
    await fs.mkdir(path.join(quarantinePath, 'abc123'), { recursive: true });
    await expect(quarantineBytes(quarantinePath, 'abc123', Buffer.from('x'))).rejects.toThrow();
    expect(await fs.readdir(quarantinePath)).toEqual(['abc123']);
  });

  it('the synchronous form also replaces by rename and cleans up on failure', async () => {
    const dir = path.join(tmpDir, 'sync');
    await fs.mkdir(dir);
    const target = path.join(dir, 'file.json');
    writeFileAtomicSync(target, 'old');
    await fs.link(target, path.join(tmpDir, 'sync-reader'));
    writeFileAtomicSync(target, 'new');
    expect((await fs.readFile(path.join(tmpDir, 'sync-reader'))).toString()).toBe('old');
    expect((await fs.readFile(target)).toString()).toBe('new');

    await fs.mkdir(path.join(dir, 'blocked'));
    expect(() => writeFileAtomicSync(path.join(dir, 'blocked'), 'x')).toThrow();
    expect((await fs.readdir(dir)).sort()).toEqual(['blocked', 'file.json']);
  });
});

describe('quarantinedBytesMatch', () => {
  it('is true only for bytes that hash to the name they are filed under', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    const bytes = Buffer.from('whole-upload');
    const digest = digestBytes(bytes);
    expect(await quarantinedBytesMatch(quarantinePath, digest, digestBytes)).toBe(false);

    await quarantineBytes(quarantinePath, digest, bytes);
    expect(await quarantinedBytesMatch(quarantinePath, digest, digestBytes)).toBe(true);

    await fs.truncate(path.join(quarantinePath, digest), 4);
    expect(await quarantinedBytesMatch(quarantinePath, digest, digestBytes)).toBe(false);
  });

  it('rethrows a read failure that is not a missing file', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    await fs.mkdir(path.join(quarantinePath, 'a-directory'), { recursive: true });
    await expect(
      quarantinedBytesMatch(quarantinePath, 'a-directory', digestBytes)
    ).rejects.toThrow();
  });
});

describe('sealRefusal', () => {
  const bytes = Buffer.from('refused-bytes');
  const digest = digestBytes(bytes);
  const verdict = { classification: 'csam', matchType: 'exact', source: 'test' };

  it('writes the bytes, then a record naming the refusal', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    expect(isRefused(quarantinePath, digest)).toBe(false);
    expect(readRefusal(quarantinePath, digest)).toBeNull();

    await sealRefusal(quarantinePath, digest, bytes, verdict, digestBytes);

    expect(await fs.readFile(path.join(quarantinePath, digest))).toEqual(bytes);
    expect(isRefused(quarantinePath, digest)).toBe(true);
    expect(readRefusal(quarantinePath, digest)).toEqual({
      classification: 'csam',
      matchType: 'exact',
      source: 'test',
      evidence: digest,
    });
  });

  it('repairs quarantined bytes that do not match their digest', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    await quarantineBytes(quarantinePath, digest, bytes.subarray(0, 3));
    await sealRefusal(quarantinePath, digest, bytes, verdict, digestBytes);
    expect(await fs.readFile(path.join(quarantinePath, digest))).toEqual(bytes);
  });

  it('never rewrites matching bytes or an existing record', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    await sealRefusal(quarantinePath, digest, bytes, verdict, digestBytes);
    const reader = path.join(tmpDir, 'reader');
    await fs.link(path.join(quarantinePath, digest), reader);

    await sealRefusal(
      quarantinePath,
      digest,
      bytes,
      { classification: 'harmful-abusive-material' },
      digestBytes
    );

    expect(readRefusal(quarantinePath, digest).classification).toBe('csam');
    // Same inode: the bytes were left alone, not rewritten.
    const [a, b] = await Promise.all([fs.stat(reader), fs.stat(path.join(quarantinePath, digest))]);
    expect(a.ino).toBe(b.ino);
  });

  it('reads an unparseable record as a refusal worded generically', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    await fs.mkdir(quarantinePath, { recursive: true });
    await fs.writeFile(path.join(quarantinePath, `${digest}.refused.json`), '{not json');
    expect(readRefusal(quarantinePath, digest)).toEqual({
      classification: 'csam',
      evidence: digest,
    });
  });

  it('rethrows a record read failure that is not a missing file', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    await fs.mkdir(path.join(quarantinePath, `${digest}.refused.json`), { recursive: true });
    expect(() => readRefusal(quarantinePath, digest)).toThrow();
  });
});
