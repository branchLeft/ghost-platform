import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MediaTreeRefusedError,
  MediaTreeTooLargeError,
  readMediaTree,
  referencedMedia,
} from '../../src/mediaTree.js';
import {
  NOT_SERVED_FILES,
  plantSymlink,
  SERVED_FILES,
  seedContentDir,
} from '../helpers/mediaTree.js';

const CEILING = 1024;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('readMediaTree', () => {
  let dir: string;
  let outside: string;

  beforeEach(async () => {
    dir = await seedContentDir();
    outside = await mkdtemp(join(tmpdir(), 'export-bundler-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'OUTSIDE-the-tree');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const read = (contentJson = '{}', extra: { maxCarriedBytes?: number } = {}) =>
    readMediaTree({ contentDir: dir, uploadCeilingBytes: CEILING, contentJson, ...extra });

  it('lists every file of the served tree with its path, size and checksum, and carries the bytes', async () => {
    const { listing, files } = await read();
    const served = Object.entries(SERVED_FILES);
    expect(listing.treeFileCount).toBe(served.length);
    expect(listing.files).toHaveLength(served.length);
    expect(listing.files.map((f) => [f.path, f.size, f.sha256, f.status])).toEqual(
      served
        .map(([rel, data]) => [`content/${rel}`, data.length, sha(data), 'carried'])
        .sort((a, b) => (a[0]! < b[0]! ? -1 : 1))
    );
    expect(files.map((f) => f.name)).toEqual(listing.files.map((f) => f.path));
    for (const file of files) {
      const rel = file.name.slice('content/'.length);
      expect(Buffer.from(file.data).toString('utf8')).toBe(SERVED_FILES[rel]);
    }
  });

  it('never carries a resized variant, the quarantine directory, or anything outside the three trees', async () => {
    const { listing, files } = await read();
    const everything = JSON.stringify([listing, files.map((f) => f.name)]);
    for (const rel of Object.keys(NOT_SERVED_FILES)) expect(everything).not.toContain(rel);
    expect(everything).not.toContain('RESIZED');
    expect(everything).not.toContain('quarantine');
    expect(files.some((f) => Buffer.from(f.data).toString().includes('QUARANTINED'))).toBe(false);
  });

  it('an empty slot, or one with no media trees at all, lists nothing', async () => {
    const empty = await seedContentDir({ 'themes/x.json': '{}' });
    try {
      const { listing, files } = await readMediaTree({
        contentDir: empty,
        uploadCeilingBytes: CEILING,
        contentJson: '{}',
      });
      expect(listing.treeFileCount).toBe(0);
      expect(files).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  describe('CONTROL: what is not a regular file refuses the export, by name', () => {
    it('a symlink out of the tree', async () => {
      await plantSymlink(dir, 'images/2026/11/planted.png', join(outside, 'secret.txt'));
      const err = await read().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MediaTreeRefusedError);
      expect((err as Error).message).toContain('content/images/2026/11/planted.png');
      expect((err as Error).message).toContain('symbolic link');
    });

    it('a symlink to a directory outside the tree', async () => {
      await plantSymlink(dir, 'files/leak', outside);
      await expect(read()).rejects.toThrow(/content\/files\/leak.*symbolic link/);
    });

    it('a media root that is itself a link out of the tree', async () => {
      await rm(join(dir, 'media'), { recursive: true });
      await symlink(outside, join(dir, 'media'));
      await expect(read()).rejects.toThrow(/content\/media.*symbolic link/);
    });

    it('a symlink that points inside the tree is still refused', async () => {
      await plantSymlink(dir, 'images/alias.svg', join(dir, 'images/logo.svg'));
      await expect(read()).rejects.toBeInstanceOf(MediaTreeRefusedError);
    });

    it('a named pipe', async () => {
      execFileSync('mkfifo', [join(dir, 'files/pipe')]);
      await expect(read()).rejects.toThrow(/content\/files\/pipe.*named pipe/);
    });

    it('a symlink swapped in for a file after the walk is refused when it is read, not followed', async () => {
      const target = join(dir, 'images/logo.svg');
      const err = await readMediaTree({
        contentDir: dir,
        uploadCeilingBytes: CEILING,
        contentJson: '{}',
        afterListing: async () => {
          await unlink(target);
          await symlink(join(outside, 'secret.txt'), target);
        },
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MediaTreeRefusedError);
      expect((err as Error).message).toContain('content/images/logo.svg');
    });

    it('the same swap for a file over the ceiling, which is hashed rather than carried', async () => {
      const target = join(dir, 'files/big.bin');
      await writeFile(target, 'x'.repeat(CEILING + 1));
      await expect(
        readMediaTree({
          contentDir: dir,
          uploadCeilingBytes: CEILING,
          contentJson: '{}',
          afterListing: async () => {
            await unlink(target);
            await symlink(join(outside, 'secret.txt'), target);
          },
        })
      ).rejects.toBeInstanceOf(MediaTreeRefusedError);
    });

    it('a link inside the resized-variant directory is not part of the served tree and does not refuse', async () => {
      await plantSymlink(dir, 'images/size/w600/link.png', join(outside, 'secret.txt'));
      await expect(read()).resolves.toBeDefined();
    });
  });

  it('lists a file over the upload ceiling as oversized, with its size and checksum, and does not carry it', async () => {
    const big = 'B'.repeat(CEILING + 1);
    await writeFile(join(dir, 'media/2026/11/big-DDDDDDDDDDDDDDDDDDDDDD.mp4'), big);
    const { listing, files } = await read();
    const entry = listing.files.find((f) => f.path.endsWith('big-DDDDDDDDDDDDDDDDDDDDDD.mp4'));
    expect(entry).toEqual({
      path: 'content/media/2026/11/big-DDDDDDDDDDDDDDDDDDDDDD.mp4',
      size: CEILING + 1,
      sha256: sha(big),
      status: 'oversized',
    });
    expect(listing.treeFileCount).toBe(Object.keys(SERVED_FILES).length + 1);
    expect(listing.files).toHaveLength(listing.treeFileCount);
    expect(files.map((f) => f.name)).not.toContain(entry?.path);
  });

  it('a file exactly at the ceiling is carried', async () => {
    await writeFile(join(dir, 'files/exact.bin'), 'x'.repeat(CEILING));
    const { listing } = await read();
    expect(listing.files.find((f) => f.path === 'content/files/exact.bin')?.status).toBe('carried');
  });

  it('names a file whose name the bundle cannot carry, counting it in the tree', async () => {
    await writeFile(join(dir, 'images/has space.png'), 'x');
    const { listing, files } = await read();
    expect(listing.unrepresentable).toEqual(['content/images/has space.png']);
    expect(listing.treeFileCount).toBe(listing.files.length + 1);
    expect(files.map((f) => f.name)).not.toContain('content/images/has space.png');
  });

  it('refuses, by name, more media than the bundle holds in memory', async () => {
    await expect(read('{}', { maxCarriedBytes: 20 })).rejects.toBeInstanceOf(
      MediaTreeTooLargeError
    );
  });

  describe('references to files the tree does not hold', () => {
    const content = (...refs: string[]): string =>
      JSON.stringify({ posts: refs.map((r) => ({ feature_image: `__GHOST_URL__/content/${r}` })) });

    it('lists a held, refused or deleted file by reference, and says nothing of one that is there', async () => {
      const { listing } = await read(
        content('images/2026/11/hero-AAAAAAAAAAAAAAAAAAAAAA.png', 'images/2026/11/deleted.png')
      );
      expect(listing.danglingReferences).toEqual(['content/images/2026/11/deleted.png']);
    });

    it('reads a resized address as the original, and decodes the path', async () => {
      const { listing } = await read(
        content(
          'images/size/w600/2026/11/hero-AAAAAAAAAAAAAAAAAAAAAA.png',
          'images/size/w1000/format/webp/logo.svg',
          'images/size/w1000/format/webp/gone.png',
          'files/two%20words.pdf',
          'images/%E0%A4%A.png'
        )
      );
      expect(listing.danglingReferences).toEqual([
        'content/files/two words.pdf',
        'content/images/%E0%A4%A.png',
        'content/images/gone.png',
      ]);
    });
  });
});

describe('referencedMedia', () => {
  it('finds each distinct site-relative reference, ignores other forms, and strips query and punctuation', () => {
    const html =
      '<img src="__GHOST_URL__/content/images/a.png?v=2"> see __GHOST_URL__/content/media/b.mp4. ' +
      '__GHOST_URL__/content/images/a.png https://elsewhere.test/content/images/c.png __GHOST_URL__/other/d.png';
    expect(referencedMedia(html)).toEqual(['images/a.png', 'media/b.mp4']);
  });
});
