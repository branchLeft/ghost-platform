import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDirectoryDsnMailbox } from '../../src/dsnMailbox.js';

describe('directory DSN mailbox', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsn-mailbox-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists only .eml files, oldest name first, and retires them into processed/ without deleting', async () => {
    await writeFile(join(dir, 'b.eml'), 'B');
    await writeFile(join(dir, 'a.eml'), 'A');
    await writeFile(join(dir, 'notes.txt'), 'ignore me');
    const mailbox = createDirectoryDsnMailbox(dir);

    expect((await mailbox.list()).map((m) => [m.ref, m.raw])).toEqual([
      ['a.eml', 'A'],
      ['b.eml', 'B'],
    ]);
    await mailbox.markProcessed('a.eml');
    expect((await mailbox.list()).map((m) => m.ref)).toEqual(['b.eml']);
    expect(await readdir(join(dir, 'processed'))).toEqual(['a.eml']);
  });

  it('reads an oversized file as empty text, so it is retired unread rather than parsed', async () => {
    await writeFile(join(dir, 'big.eml'), Buffer.alloc(1024 * 1024 + 1, 'x'));
    expect((await createDirectoryDsnMailbox(dir).list())[0]!.raw).toBe('');
  });

  it.each(['../escape.eml', 'a/b.eml', '.hidden.eml'])('refuses an unsafe ref: %s', async (ref) => {
    await expect(createDirectoryDsnMailbox(dir).markProcessed(ref)).rejects.toThrow(/unsafe/);
  });
});
