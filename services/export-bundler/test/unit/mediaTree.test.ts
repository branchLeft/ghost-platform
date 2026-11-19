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
const content = (...refs: string[]): string =>
  JSON.stringify({ posts: refs.map((r) => ({ feature_image: `__GHOST_URL__/content/${r}` })) });
/** Content that references every file of the served tree. */
const REFERENCES_ALL = content(...Object.keys(SERVED_FILES));

describe('readMediaTree', () => {
  const read = (
    entries: readonly TreeEntry[] = entriesOf(SERVED_FILES),
    contentJson = REFERENCES_ALL,
    extra: { maxCarriedBytes?: number } = {}
  ) =>
    readMediaTree({
      source: fakeSource(entries),
      uploadCeilingBytes: CEILING,
      contentJson,
      ...extra,
    });

  it('lists a referenced original with its path, size and checksum, and carries the bytes', async () => {
    const { listing, files } = await read(entriesOf(SERVED_FILES), REFERENCES_ALL);
    const carried = Object.entries(SERVED_FILES).filter(([rel]) => !rel.startsWith('media/'));
    expect(listing.treeFileCount).toBe(Object.keys(SERVED_FILES).length);
    expect(
      listing.files.filter((f) => f.status === 'carried').map((f) => [f.path, f.size, f.sha256])
    ).toEqual(
      carried
        .map(([rel, data]) => [`content/${rel}`, data.length, sha(data)])
        .sort((a, b) => (a[0]! < b[0]! ? -1 : 1))
    );
    expect(files.map((f) => f.name)).toEqual(
      listing.files.filter((f) => f.status === 'carried').map((f) => f.path)
    );
    for (const file of files) {
      expect(Buffer.from(file.data).toString('utf8')).toBe(
        SERVED_FILES[file.name.slice('content/'.length)]
      );
    }
  });

  describe('what the content references decides what is carried', () => {
    const tree = {
      'images/2026/11/used.png': 'USED',
      'images/2026/11/used_o.png': 'ORIGINAL-NOT-NAMED',
      'images/2026/11/unused.png': 'UNUSED-IMAGE',
      'images/stray.svg': '<svg/>',
      'files/2026/11/used.pdf': 'USED-PDF',
      'files/2026/11/unused.pdf': 'UNUSED-PDF',
      'media/2026/11/referenced.mp4': 'VIDEO-1',
      'media/2026/11/unreferenced.mp3': 'AUDIO-22',
    };
    const readTree = (refs: string[]) => read(entriesOf(tree), content(...refs));

    it('carries a referenced original, counts an unreferenced one and does not carry it', async () => {
      const { listing, files } = await readTree([
        'images/2026/11/used.png',
        'files/2026/11/used.pdf',
      ]);
      expect(files.map((f) => f.name)).toEqual([
        'content/files/2026/11/used.pdf',
        'content/images/2026/11/used.png',
      ]);
      expect(listing.unreferenced).toEqual(
        [
          'content/images/2026/11/unused.png',
          'content/images/2026/11/used_o.png',
          'content/images/stray.svg',
          'content/files/2026/11/unused.pdf',
        ].sort()
      );
      expect(listing.treeFileCount).toBe(Object.keys(tree).length);
      expect(listing.treeFileCount).toBe(
        listing.files.length + listing.unreferenced.length + listing.unrepresentable.length
      );
    });

    it('a resized address names the original it was made from', async () => {
      const { files, listing } = await readTree(['images/size/w600/format/webp/2026/11/used.png']);
      expect(files.map((f) => f.name)).toEqual(['content/images/2026/11/used.png']);
      expect(listing.unreferenced).toContain('content/images/2026/11/used_o.png');
    });

    it('carries nothing when nothing is referenced, and everything else is counted', async () => {
      const { files, listing } = await readTree([]);
      expect(files).toEqual([]);
      expect(listing.unreferenced).toHaveLength(6);
      expect(listing.files.every((f) => f.status === 'not-sent')).toBe(true);
    });

    it('lists every file under media with its size and checksum, referenced or not, and never carries one', async () => {
      const { files, listing } = await readTree([
        'media/2026/11/referenced.mp4',
        'images/2026/11/used.png',
      ]);
      expect(listing.files.filter((f) => f.status === 'not-sent')).toEqual([
        {
          path: 'content/media/2026/11/referenced.mp4',
          size: 7,
          sha256: sha('VIDEO-1'),
          status: 'not-sent',
        },
        {
          path: 'content/media/2026/11/unreferenced.mp3',
          size: 8,
          sha256: sha('AUDIO-22'),
          status: 'not-sent',
        },
      ]);
      expect(files.map((f) => f.name)).toEqual(['content/images/2026/11/used.png']);
      expect(listing.unreferenced.some((n) => n.startsWith('content/media/'))).toBe(false);
    });

    it('lists a media file the reader did not send bytes for by the size and checksum it gave', async () => {
      const { listing, files } = await read(
        [
          {
            rel: 'media/big.mp4',
            size: CEILING + 5,
            data: null,
            sha256: sha('V'.repeat(CEILING + 5)),
          },
        ],
        content('media/big.mp4')
      );
      expect(listing.files).toEqual([
        {
          path: 'content/media/big.mp4',
          size: CEILING + 5,
          sha256: sha('V'.repeat(CEILING + 5)),
          status: 'not-sent',
        },
      ]);
      expect(files).toEqual([]);
    });

    it('an unreferenced file over the ceiling is counted as unreferenced, not as oversized', async () => {
      const { listing } = await read(
        [{ rel: 'files/old.bin', size: CEILING + 1, data: null, sha256: 'd'.repeat(64) }],
        '{}'
      );
      expect(listing.unreferenced).toEqual(['content/files/old.bin']);
      expect(listing.files).toEqual([]);
    });
  });

  it('an empty slot lists nothing', async () => {
    const { listing, files } = await read([]);
    expect(listing.treeFileCount).toBe(0);
    expect(files).toEqual([]);
  });

  it('lists a referenced file over the upload ceiling as oversized, with its size and checksum, and does not carry it', async () => {
    const big: TreeEntry = {
      rel: 'files/2026/11/big.zip',
      size: CEILING + 1,
      data: null,
      sha256: sha('B'.repeat(CEILING + 1)),
    };
    const { listing, files } = await read(
      [...entriesOf(SERVED_FILES), big],
      content(...Object.keys(SERVED_FILES), 'files/2026/11/big.zip')
    );
    expect(listing.files.find((f) => f.path === 'content/files/2026/11/big.zip')).toEqual({
      path: 'content/files/2026/11/big.zip',
      size: CEILING + 1,
      sha256: sha('B'.repeat(CEILING + 1)),
      status: 'oversized',
    });
    expect(listing.treeFileCount).toBe(Object.keys(SERVED_FILES).length + 1);
    expect(listing.files).toHaveLength(listing.treeFileCount);
    expect(files.map((f) => f.name)).not.toContain('content/files/2026/11/big.zip');
  });

  it('treats bytes the host holds above the ceiling as oversized, whatever the source said', async () => {
    const { listing, files } = await read(
      entriesOf({ 'files/x.bin': 'x'.repeat(CEILING + 1) }),
      content('files/x.bin')
    );
    expect(listing.files[0]?.status).toBe('oversized');
    expect(files).toEqual([]);
  });

  it('a file exactly at the ceiling is carried', async () => {
    const { listing } = await read(
      entriesOf({ 'files/exact.bin': 'x'.repeat(CEILING) }),
      content('files/exact.bin')
    );
    expect(listing.files[0]?.status).toBe('carried');
  });

  it('names a file whose name the bundle cannot carry, counting it in the tree', async () => {
    const { listing, files } = await read(
      entriesOf({ ...SERVED_FILES, 'images/has space.png': 'x' }),
      content(...Object.keys(SERVED_FILES), 'images/has space.png')
    );
    expect(listing.unrepresentable).toEqual(['content/images/has space.png']);
    expect(listing.treeFileCount).toBe(listing.files.length + listing.unreferenced.length + 1);
    expect(files.map((f) => f.name)).not.toContain('content/images/has space.png');
  });

  it('refuses, by name, more media than the bundle holds in memory', async () => {
    await expect(read(undefined, REFERENCES_ALL, { maxCarriedBytes: 20 })).rejects.toBeInstanceOf(
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
