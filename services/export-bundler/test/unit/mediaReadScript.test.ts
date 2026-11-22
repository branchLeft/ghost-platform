import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MEDIA_READ_SCRIPT, MediaFrameParser } from '../../src/mediaSource.js';
import { MediaTreeRefusedError } from '../../src/mediaTree.js';
import {
  localMediaSource,
  NOT_SERVED_FILES,
  plantSymlink,
  SERVED_FILES,
  seedContentDir,
} from '../helpers/mediaTree.js';

/**
 * The reader script itself, run on real directories by this machine's node.
 * It reaches every path through /proc/self/fd, so it runs on Linux only: in
 * production that is the container it runs in, and in CI it is the runner.
 */
describe.skipIf(process.platform !== 'linux')('the media reader script on a real tree', () => {
  let dir: string;
  let outside: string;
  const LIMITS = { uploadCeilingBytes: 1024, maxCarriedBytes: 64 * 1024 * 1024 };

  beforeEach(async () => {
    dir = await seedContentDir();
    outside = await mkdtemp(join(tmpdir(), 'export-bundler-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'OUTSIDE-the-tree');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const read = () => localMediaSource(dir).read(LIMITS);

  it('reads exactly the served tree: no resized variant, no quarantine, nothing outside the three trees', async () => {
    const entries = await read();
    expect(entries.map((e) => e.rel).sort()).toEqual(Object.keys(SERVED_FILES).sort());
    for (const entry of entries) {
      expect(entry.data?.toString('utf8')).toBe(SERVED_FILES[entry.rel]);
    }
    const everything = JSON.stringify(entries.map((e) => e.rel));
    for (const rel of Object.keys(NOT_SERVED_FILES)) expect(everything).not.toContain(rel);
  });

  it('a slot with no media trees reads as empty', async () => {
    const empty = await seedContentDir({ 'themes/x.json': '{}' });
    try {
      expect(await localMediaSource(empty).read(LIMITS)).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('hashes a file over the upload ceiling and does not send its bytes', async () => {
    await writeFile(join(dir, 'media/2026/11/big.mp4'), 'B'.repeat(2000));
    const big = (await read()).find((e) => e.rel === 'media/2026/11/big.mp4');
    expect(big).toMatchObject({ size: 2000, data: null });
    expect(big?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  describe('CONTROL: what is not a regular file refuses the read, by name', () => {
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
      await expect(read()).rejects.toThrow(/media.*symbolic link/);
    });

    it('a symlink that points inside the tree', async () => {
      await plantSymlink(dir, 'images/alias.svg', join(dir, 'images/logo.svg'));
      await expect(read()).rejects.toBeInstanceOf(MediaTreeRefusedError);
    });

    it('a named pipe', async () => {
      execFileSync('mkfifo', [join(dir, 'files/pipe')]);
      await expect(read()).rejects.toThrow(/content\/files\/pipe.*named pipe/);
    });

    it('a link inside the resized-variant directory is not part of the served tree and does not refuse', async () => {
      await plantSymlink(dir, 'images/size/w600/link.png', join(outside, 'secret.txt'));
      await expect(read()).resolves.toBeDefined();
    });
  });

  describe('CONTROL: the live demo writes while the tree is read', () => {
    /**
     * The script is held inside a large file by a stdout nobody is reading, so
     * the test can change the tree at that exact moment, and then lets it go on.
     */
    async function readWhile(
      change: () => Promise<void>
    ): Promise<ReturnType<MediaFrameParser['finish']>> {
      const child = spawn(
        process.execPath,
        ['-e', MEDIA_READ_SCRIPT, dir, String(LIMITS.uploadCeilingBytes * 8 * 1024)],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const parser = new MediaFrameParser({
        uploadCeilingBytes: LIMITS.uploadCeilingBytes * 8 * 1024,
        maxCarriedBytes: LIMITS.maxCarriedBytes,
      });
      await new Promise<void>((resolve) => child.stdout.once('readable', () => resolve()));
      await change();
      child.stdout.removeAllListeners('readable');
      let failure: unknown;
      child.stdout.on('data', (chunk: Buffer) => {
        try {
          parser.push(chunk);
        } catch (err) {
          failure = err;
          child.kill('SIGKILL');
        }
      });
      await new Promise<void>((resolve) => child.on('close', () => resolve()));
      if (failure !== undefined) throw failure;
      return parser.finish();
    }

    beforeEach(async () => {
      // images/x/0big is read first and is larger than the pipe; images/x/y comes after it.
      await mkdir(join(dir, 'images/x/y'), { recursive: true });
      await writeFile(join(dir, 'images/x/0big'), Buffer.alloc(4 * 1024 * 1024, 66));
      await writeFile(join(dir, 'images/x/y/secret.txt'), 'INSIDE-the-tree');
      await mkdir(join(outside, 'y'));
      await writeFile(join(outside, 'y/secret.txt'), 'OUTSIDE-the-tree');
    });

    it('a directory above the one being read, swapped for a link out of the tree, is not followed', async () => {
      const entries = await readWhile(async () => {
        await rename(join(dir, 'images/x'), join(dir, 'images/x-moved'));
        await symlink(outside, join(dir, 'images/x'));
      });
      const secret = entries.find((e) => e.rel === 'images/x/y/secret.txt');
      expect(secret?.data?.toString('utf8')).toBe('INSIDE-the-tree');
      expect(entries.some((e) => e.data?.toString('utf8').includes('OUTSIDE'))).toBe(false);
    });

    it('a directory not yet opened, swapped for a link out of the tree, refuses by name', async () => {
      await mkdir(join(dir, 'images/z'));
      await writeFile(join(dir, 'images/z/a.txt'), 'INSIDE-the-tree');
      await writeFile(join(outside, 'a.txt'), 'OUTSIDE-the-tree');
      const err = await readWhile(async () => {
        await rm(join(dir, 'images/z'), { recursive: true });
        await symlink(outside, join(dir, 'images/z'));
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MediaTreeRefusedError);
      expect((err as Error).message).toContain('content/images/z');
    });

    it.each(Array.from({ length: 300 }, (_, i) => i))(
      'a file not yet opened, swapped for a link out of the tree, refuses by name (run %i)',
      async () => {
        await writeFile(join(dir, 'images/x/zz.txt'), 'INSIDE-the-tree');
        const err = await readWhile(async () => {
          await unlink(join(dir, 'images/x/zz.txt'));
          await symlink(join(outside, 'secret.txt'), join(dir, 'images/x/zz.txt'));
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(MediaTreeRefusedError);
        expect((err as Error).message).toContain('content/images/x/zz.txt');
      }
    );

    it('a file deleted after it was listed is left out, not an error', async () => {
      const entries = await readWhile(async () => {
        await unlink(join(dir, 'images/x/y/secret.txt'));
      });
      expect(entries.map((e) => e.rel)).not.toContain('images/x/y/secret.txt');
      expect(entries.map((e) => e.rel)).toContain('images/x/0big');
    });
  });
});
