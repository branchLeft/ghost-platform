import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeFileIfPresent, writeFileAtomic } from '../../src/atomicFile.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('ring-controller-atomicfile-');
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('writeFileAtomic', () => {
  it('writes content readable back exactly', async () => {
    const dir = await tempDir();
    const path = join(dir, 'record.json');

    await writeFileAtomic(path, '{"a":1}');

    expect(await readFile(path, 'utf8')).toBe('{"a":1}');
  });

  it('leaves no temp file behind once the write completes', async () => {
    const dir = await tempDir();
    const path = join(dir, 'record.json');

    await writeFileAtomic(path, 'hello');

    const names = await readdir(dir);
    expect(names).toEqual(['record.json']);
  });

  it('a second write replaces the first, never leaving a byte-mix', async () => {
    const dir = await tempDir();
    const path = join(dir, 'record.json');

    await writeFileAtomic(path, 'first');
    await writeFileAtomic(path, 'second-and-longer');

    expect(await readFile(path, 'utf8')).toBe('second-and-longer');
    expect(await readdir(dir)).toEqual(['record.json']);
  });
});

describe('removeFileIfPresent', () => {
  it('removes an existing file', async () => {
    const dir = await tempDir();
    const path = join(dir, 'record.json');
    await writeFileAtomic(path, 'x');

    await removeFileIfPresent(path);

    expect(await readdir(dir)).toEqual([]);
  });

  it('is a no-op when the file never existed', async () => {
    const dir = await tempDir();
    const path = join(dir, 'never-written.json');

    await expect(removeFileIfPresent(path)).resolves.toBeUndefined();
  });
});
