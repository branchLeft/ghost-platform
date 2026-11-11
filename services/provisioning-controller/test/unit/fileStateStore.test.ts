import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileStateStore,
  StateCorruptError,
  StateFileUnsafeError,
  StateStoreUnreadableError,
  executeOnboarding,
  type StateRecord,
} from '../../src/index.js';
import { APPROVAL, World } from '../support/doubles.js';

const rec = (n: number): StateRecord => ({
  at: '2026-01-01T00:00:00Z',
  approvalId: 'APPROVAL_ID_PLACEHOLDER',
  event: 'complete',
  key: `KEY_${n}`,
  inputDigest: 'DIGEST_PLACEHOLDER',
  attempt: 1,
});

let dir = '';
let file = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pc-state-'));
  file = join(dir, 'nested', 'state.jsonl');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FileStateStore', () => {
  it('reads a missing file as an empty history', async () => {
    expect(await new FileStateStore(file).readAll()).toEqual([]);
  });

  it('appends one line per record and reads them back in order, across instances', async () => {
    await new FileStateStore(file).append(rec(1));
    await new FileStateStore(file).append(rec(2));
    const text = await readFile(file, 'utf8');
    expect(text.split('\n')).toHaveLength(3);
    expect(await new FileStateStore(file).readAll()).toEqual([rec(1), rec(2)]);
  });

  it('writes a private file', async () => {
    await new FileStateStore(file).append(rec(1));
    expect((await stat(file)).mode & 0o077).toBe(0);
  });

  describe('refuses a state file it cannot trust', () => {
    const seed = async (): Promise<void> => {
      await new FileStateStore(file).append(rec(1));
    };

    it('refuses a symbolic link, to read or to append, and leaves the target alone', async () => {
      await seed();
      const link = join(dir, 'link.jsonl');
      await symlink(file, link);
      const before = await readFile(file, 'utf8');
      await expect(new FileStateStore(link).readAll()).rejects.toBeInstanceOf(StateFileUnsafeError);
      await expect(new FileStateStore(link).append(rec(2))).rejects.toBeInstanceOf(
        StateFileUnsafeError
      );
      expect(await readFile(file, 'utf8')).toBe(before);
    });

    it('refuses a link that points nowhere, so an append cannot create the target through it', async () => {
      await mkdir(dirname(file), { recursive: true });
      const target = join(dir, 'created-through-link.jsonl');
      await symlink(target, file);
      await expect(new FileStateStore(file).append(rec(1))).rejects.toBeInstanceOf(
        StateFileUnsafeError
      );
      await expect(stat(target)).rejects.toThrow();
    });

    it('refuses something that is not a regular file', async () => {
      await mkdir(file, { recursive: true, mode: 0o700 });
      await expect(new FileStateStore(file).readAll()).rejects.toBeInstanceOf(StateFileUnsafeError);
    });

    it.each([
      ['0640', 0o640],
      ['0604', 0o604],
      ['0660', 0o660],
      ['0666', 0o666],
    ])(
      'refuses a file that others can reach (mode %s), to read or to append, and does not change it',
      async (_label, mode) => {
        await seed();
        await chmod(file, mode);
        const before = await readFile(file, 'utf8');
        await expect(new FileStateStore(file).readAll()).rejects.toBeInstanceOf(
          StateFileUnsafeError
        );
        await expect(new FileStateStore(file).append(rec(2))).rejects.toBeInstanceOf(
          StateFileUnsafeError
        );
        expect(await readFile(file, 'utf8')).toBe(before);
        expect((await stat(file)).mode & 0o777).toBe(mode);
      }
    );

    it('makes the executor run nothing when the file is unsafe', async () => {
      await seed();
      await chmod(file, 0o644);
      const world = new World();
      await expect(
        executeOnboarding(APPROVAL.approvalId, world.ports(new FileStateStore(file)))
      ).rejects.toBeInstanceOf(StateStoreUnreadableError);
      expect(world.calls).toEqual([]);
    });

    it('accepts a file only its owner can reach', async () => {
      await seed();
      await chmod(file, 0o400);
      expect(await new FileStateStore(file).readAll()).toEqual([rec(1)]);
    });
  });

  it('ignores a write that never finished, and cuts it off before the next append', async () => {
    const store = new FileStateStore(file);
    await store.append(rec(1));
    await appendFile(file, '{"at":"2026-01-01T00:00:00Z","appr');
    expect(await store.readAll()).toEqual([rec(1)]);
    await store.append(rec(2));
    expect(await store.readAll()).toEqual([rec(1), rec(2)]);
  });

  it('cuts a file that holds only a torn write back to empty', async () => {
    await new FileStateStore(file).append(rec(1));
    await writeFile(file, '{"torn');
    const store = new FileStateStore(file);
    expect(await store.readAll()).toEqual([]);
    await store.append(rec(3));
    expect(await store.readAll()).toEqual([rec(3)]);
  });

  it.each([
    ['not JSON', 'nonsense\n'],
    ['a blank line', '\n'],
    ['an array', '[]\n'],
    ['a null', 'null\n'],
    ['a record missing its event', '{"at":"A","approvalId":"B"}\n'],
    ['an unknown event', '{"at":"A","approvalId":"B","event":"made-up"}\n'],
    ['a step event with no key', '{"at":"A","approvalId":"B","event":"complete"}\n'],
    ['a key that is not text', '{"at":"A","approvalId":"B","event":"run-halted","key":3}\n'],
    [
      'an attempt that is not a count',
      '{"at":"A","approvalId":"B","event":"run-halted","attempt":1.5}\n',
    ],
  ])('refuses a file with %s', async (_name, content) => {
    await new FileStateStore(file).append(rec(1));
    await writeFile(file, content);
    await expect(new FileStateStore(file).readAll()).rejects.toBeInstanceOf(StateCorruptError);
  });

  it('names the bad line', async () => {
    const store = new FileStateStore(file);
    await store.append(rec(1));
    await appendFile(file, 'nonsense\n');
    const err = await store.readAll().catch((e: unknown) => e);
    expect((err as StateCorruptError).line).toBe(2);
  });

  it('propagates a read failure that is not a missing file', async () => {
    await expect(new FileStateStore(dir).readAll()).rejects.toThrow();
  });

  it('makes the executor run nothing when the file is corrupt', async () => {
    await new FileStateStore(file).append(rec(1));
    await appendFile(file, 'nonsense\n');
    const world = new World();
    await expect(
      executeOnboarding(APPROVAL.approvalId, world.ports(new FileStateStore(file)))
    ).rejects.toBeInstanceOf(StateStoreUnreadableError);
    expect(world.calls).toEqual([]);
  });

  it('resumes a run from the file after the process is gone', async () => {
    const first = new World();
    first.state.failAppendsFrom = 9;
    const killedPorts = first.ports(new FileStateStore(file));
    const original = killedPorts.state;
    let appended = 0;
    await expect(
      executeOnboarding(APPROVAL.approvalId, {
        ...killedPorts,
        state: {
          readAll: () => original.readAll(),
          append: async (r) => {
            if (appended++ === 9) throw new Error('KILLED_PLACEHOLDER');
            await original.append(r);
          },
        },
      })
    ).rejects.toThrow();
    const ranBefore = first.calls.map((c) => c.request.key);

    const second = new World();
    const result = await executeOnboarding(
      APPROVAL.approvalId,
      second.ports(new FileStateStore(file))
    );
    expect(result.status).toBe('complete');
    const completedBefore = (await new FileStateStore(file).readAll())
      .filter((r) => r.event === 'complete')
      .map((r) => r.key);
    for (const key of ranBefore.slice(0, result.skipped.length)) {
      expect(second.calls.map((c) => c.request.key)).not.toContain(key);
    }
    expect(new Set(completedBefore).size).toBe(13);
  });
});
