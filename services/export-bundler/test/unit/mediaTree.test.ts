import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TreeEntry } from '../../src/mediaSource.js';
import {
  MediaTreeRefusedError,
  MediaTreeTooLargeError,
  readMediaTree,
  referencedMedia,
} from '../../src/mediaTree.js';
import { entriesOf, fakeSource, SERVED_FILES } from '../helpers/mediaTree.js';

const CEILING = 1024;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('readMediaTree', () => {
  const read = (
    entries: readonly TreeEntry[] = entriesOf(SERVED_FILES),
    contentJson = '{}',
    extra: { maxCarriedBytes?: number } = {}
  ) =>
    readMediaTree({
      source: fakeSource(entries),
      uploadCeilingBytes: CEILING,
      contentJson,
      ...extra,
    });

  it('lists every file the source read with its path, size and checksum, and carries the bytes', async () => {
    const { listing, files } = await read();
    const served = Object.entries(SERVED_FILES);
    expect(listing.treeFileCount).toBe(served.length);
    expect(listing.files.map((f) => [f.path, f.size, f.sha256, f.status])).toEqual(
      served
        .map(([rel, data]) => [`content/${rel}`, data.length, sha(data), 'carried'])
        .sort((a, b) => (a[0]! < b[0]! ? -1 : 1))
    );
    expect(files.map((f) => f.name)).toEqual(listing.files.map((f) => f.path));
    for (const file of files) {
      expect(Buffer.from(file.data).toString('utf8')).toBe(
        SERVED_FILES[file.name.slice('content/'.length)]
      );
    }
  });

  it('an empty slot lists nothing', async () => {
    const { listing, files } = await read([]);
    expect(listing.treeFileCount).toBe(0);
    expect(files).toEqual([]);
  });

  it('lists a file over the upload ceiling as oversized, with its size and checksum, and does not carry it', async () => {
    const big: TreeEntry = {
      rel: 'media/2026/11/big.mp4',
      size: CEILING + 1,
      data: null,
      sha256: sha('B'.repeat(CEILING + 1)),
    };
    const { listing, files } = await read([...entriesOf(SERVED_FILES), big]);
    expect(listing.files.find((f) => f.path === 'content/media/2026/11/big.mp4')).toEqual({
      path: 'content/media/2026/11/big.mp4',
      size: CEILING + 1,
      sha256: sha('B'.repeat(CEILING + 1)),
      status: 'oversized',
    });
    expect(listing.treeFileCount).toBe(Object.keys(SERVED_FILES).length + 1);
    expect(listing.files).toHaveLength(listing.treeFileCount);
    expect(files.map((f) => f.name)).not.toContain('content/media/2026/11/big.mp4');
  });

  it('treats bytes the host holds above the ceiling as oversized, whatever the source said', async () => {
    const { listing, files } = await read(entriesOf({ 'files/x.bin': 'x'.repeat(CEILING + 1) }));
    expect(listing.files[0]?.status).toBe('oversized');
    expect(files).toEqual([]);
  });

  it('a file exactly at the ceiling is carried', async () => {
    const { listing } = await read(entriesOf({ 'files/exact.bin': 'x'.repeat(CEILING) }));
    expect(listing.files[0]?.status).toBe('carried');
  });

  it('names a file whose name the bundle cannot carry, counting it in the tree', async () => {
    const { listing, files } = await read(
      entriesOf({ ...SERVED_FILES, 'images/has space.png': 'x' })
    );
    expect(listing.unrepresentable).toEqual(['content/images/has space.png']);
    expect(listing.treeFileCount).toBe(listing.files.length + 1);
    expect(files.map((f) => f.name)).not.toContain('content/images/has space.png');
  });

  it('refuses, by name, more media than the bundle holds in memory', async () => {
    await expect(read(undefined, '{}', { maxCarriedBytes: 20 })).rejects.toBeInstanceOf(
      MediaTreeTooLargeError
    );
  });

  it('a refusal by the source ends the read; nothing is turned into a listing', async () => {
    const refusing = fakeSource(async () => {
      throw new MediaTreeRefusedError('content/images/planted.png', 'a symbolic link');
    });
    await expect(
      readMediaTree({ source: refusing, uploadCeilingBytes: CEILING, contentJson: '{}' })
    ).rejects.toThrow(/content\/images\/planted.png.*symbolic link/);
  });

  describe('references to files the tree does not hold', () => {
    const content = (...refs: string[]): string =>
      JSON.stringify({ posts: refs.map((r) => ({ feature_image: `__GHOST_URL__/content/${r}` })) });

    it('lists a held, refused or deleted file by reference, and says nothing of one that is there', async () => {
      const { listing } = await read(
        undefined,
        content('images/2026/11/hero-AAAAAAAAAAAAAAAAAAAAAA.png', 'images/2026/11/deleted.png')
      );
      expect(listing.danglingReferences).toEqual(['content/images/2026/11/deleted.png']);
    });

    it('reads a resized address as the original, and decodes the path', async () => {
      const { listing } = await read(
        undefined,
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
