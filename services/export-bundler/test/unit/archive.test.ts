import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeTarArchive } from '../../src/archive.js';

function tarList(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'tar',
      ['-tf', path],
      { env: { PATH: process.env.PATH ?? '' } },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${err.message}: ${stderr}`));
        resolve(stdout);
      }
    );
  });
}

function tarExtract(path: string, member: string, destDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'tar',
      ['-xf', path, '-C', destDir, member],
      { env: { PATH: process.env.PATH ?? '' } },
      (err, _stdout, stderr) => {
        if (err) return reject(new Error(`${err.message}: ${stderr}`));
        resolve(join(destDir, member));
      }
    );
  });
}

describe('writeTarArchive', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-archive-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('bundles every named file into one archive, byte-for-byte', async () => {
    const dest = join(dir, 'out.tar');
    await writeTarArchive(dest, [
      { name: 'ghost.json', data: '{"db":[]}' },
      { name: 'ghost.analytics.csv', data: 'post_id,visits\n1,2\n' },
      { name: 'manifest.json', data: '{"tenantId":"t1"}' },
    ]);

    const listing = await tarList(dest);
    expect(listing).toContain('ghost.json');
    expect(listing).toContain('ghost.analytics.csv');
    expect(listing).toContain('manifest.json');

    const extractDir = join(dir, 'extracted');
    await mkdir(extractDir);
    const extracted = await tarExtract(dest, 'ghost.json', extractDir);
    const content = await readFile(extracted, 'utf8');
    expect(content).toBe('{"db":[]}');
  });

  it('writes the archive 0600 and its directory 0700 -- never world-readable', async () => {
    const dest = join(dir, 'sub', 'out.tar');
    await writeTarArchive(dest, [{ name: 'a.txt', data: 'x' }]);

    const fileInfo = await stat(dest);
    expect(fileInfo.mode & 0o777).toBe(0o600);
    const dirInfo = await stat(join(dir, 'sub'));
    expect(dirInfo.mode & 0o777).toBe(0o700);
  });

  it("rejects, carrying tar's own stderr, when the archive step fails -- never swallowed", async () => {
    // A destination that is itself a directory is a `tar -cf` failure
    // (cannot write an archive over a directory) without needing any
    // Docker or filesystem trickery to provoke.
    const destAsDirectory = join(dir, 'not-actually-a-file');
    await mkdir(destAsDirectory);
    await expect(writeTarArchive(destAsDirectory, [{ name: 'a.txt', data: 'x' }])).rejects.toThrow(
      /tar failed/
    );
  });

  it("falls back to an empty PATH, rather than throwing on read, when this process's own PATH is unset", async () => {
    const savedPath = process.env.PATH;
    delete process.env.PATH;
    try {
      // No PATH means `tar` cannot be found -- this exercises the `?? ''`
      // fallback itself (a real string, not `undefined`, reaches
      // execFile's env), and the resulting ENOENT surfaces as the same
      // "tar failed" rejection every other tar failure does.
      await expect(
        writeTarArchive(join(dir, 'out.tar'), [{ name: 'a.txt', data: 'x' }])
      ).rejects.toThrow(/tar failed/);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('tightens a destination directory that already existed with looser permissions -- mkdir alone does not fix an existing dir', async () => {
    const { mkdir: rawMkdir, chmod } = await import('node:fs/promises');
    const preexisting = join(dir, 'preexisting');
    await rawMkdir(preexisting, { mode: 0o755 });
    await chmod(preexisting, 0o755); // some filesystems apply umask despite the mode above

    await writeTarArchive(join(preexisting, 'out.tar'), [{ name: 'a.txt', data: 'x' }]);

    const dirInfo = await stat(preexisting);
    expect(dirInfo.mode & 0o777).toBe(0o700);
  });
});
