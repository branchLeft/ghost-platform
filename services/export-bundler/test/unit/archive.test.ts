import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArchiveEntryError,
  buildTar,
  writeEncryptedArchive,
  writeManifestSidecar,
} from '../../src/archive.js';
import {
  decryptAge,
  generateAgeIdentity,
  tarListing,
  tarMember,
  type AgeIdentity,
} from '../helpers/age.js';

describe('buildTar', () => {
  it('round-trips every entry byte-for-byte through the system tar, across block boundaries', () => {
    const binary = Buffer.alloc(1537);
    for (let i = 0; i < binary.length; i++) binary[i] = i % 256;
    const tar = buildTar(
      [
        { name: 'content_and_settings.json', data: '{"db":[]}' },
        { name: 'post_analytics.csv', data: 'post_id,visits\n1,2\n' },
        { name: 'exact-block.bin', data: Buffer.alloc(512, 7) },
        { name: 'binary.bin', data: binary },
        { name: 'empty.txt', data: '' },
      ],
      1_700_000_000
    );
    expect(tar.length % 512).toBe(0);
    expect(tarListing(tar)).toEqual([
      'content_and_settings.json',
      'post_analytics.csv',
      'exact-block.bin',
      'binary.bin',
      'empty.txt',
    ]);
    expect(tarMember(tar, 'content_and_settings.json').toString('utf8')).toBe('{"db":[]}');
    expect(tarMember(tar, 'exact-block.bin').equals(Buffer.alloc(512, 7))).toBe(true);
    expect(tarMember(tar, 'binary.bin').equals(binary)).toBe(true);
    expect(tarMember(tar, 'empty.txt').length).toBe(0);
  });

  it.each([['../escape'], ['a/b'], [''], ['.'], ['..'], ['x'.repeat(101)], ['spa ce']])(
    'refuses the unsafe entry name %j',
    (name) => {
      expect(() => buildTar([{ name, data: 'x' }], 0)).toThrow(ArchiveEntryError);
    }
  );

  it('refuses a duplicate entry name rather than shadowing one file with another', () => {
    expect(() =>
      buildTar(
        [
          { name: 'a.txt', data: 'one' },
          { name: 'a.txt', data: 'two' },
        ],
        0
      )
    ).toThrow(ArchiveEntryError);
  });

  it('refuses an entry larger than the ustar size field can state', () => {
    const huge = { length: 8 ** 11 } as unknown as Buffer;
    expect(() => buildTar([{ name: 'huge.bin', data: huge }], 0)).toThrow(/size limit/);
  });
});

describe('writeEncryptedArchive', () => {
  let dir: string;
  let identity: AgeIdentity;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-archive-test-'));
    identity = generateAgeIdentity(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes an age ciphertext that decrypts, with the tenant's identity, to the tar of every file", async () => {
    const dest = join(dir, 'out', 'export.tar.age');
    await writeEncryptedArchive(
      dest,
      [
        { name: 'content_and_settings.json', data: '{"db":[]}' },
        { name: 'manifest.json', data: '{"tenantId":"t1"}' },
      ],
      0,
      identity.recipient
    );
    const onDisk = await readFile(dest);
    expect(onDisk.subarray(0, 21).toString('ascii')).toBe('age-encryption.org/v1');
    const tar = decryptAge(dest, identity.identityPath);
    expect(tarListing(tar)).toEqual(['content_and_settings.json', 'manifest.json']);
    expect(tarMember(tar, 'content_and_settings.json').toString('utf8')).toBe('{"db":[]}');
  });

  it('writes the archive 0600 and its directory 0700, tightening a directory that already existed looser', async () => {
    const preexisting = join(dir, 'preexisting');
    await mkdir(preexisting, { mode: 0o755 });
    await chmod(preexisting, 0o755);
    const dest = join(preexisting, 'export.tar.age');
    await writeEncryptedArchive(dest, [{ name: 'a.txt', data: 'x' }], 0, identity.recipient);
    expect((await stat(dest)).mode & 0o777).toBe(0o600);
    expect((await stat(preexisting)).mode & 0o777).toBe(0o700);
  });

  it('never overwrites an existing file at the destination', async () => {
    const dest = join(dir, 'export.tar.age');
    await writeFile(dest, 'already here');
    await expect(
      writeEncryptedArchive(dest, [{ name: 'a.txt', data: 'x' }], 0, identity.recipient)
    ).rejects.toThrow(/EEXIST/);
    expect(await readFile(dest, 'utf8')).toBe('already here');
  });
});

describe('writeManifestSidecar', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-sidecar-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the manifest 0600, in a 0700 directory, and never over an existing file', async () => {
    const dest = join(dir, 'sub', 'export.manifest.json');
    await writeManifestSidecar(dest, '{"a":1}');
    expect(await readFile(dest, 'utf8')).toBe('{"a":1}');
    expect((await stat(dest)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'sub'))).mode & 0o777).toBe(0o700);
    await expect(writeManifestSidecar(dest, '{"b":2}')).rejects.toThrow(/EEXIST/);
  });
});
