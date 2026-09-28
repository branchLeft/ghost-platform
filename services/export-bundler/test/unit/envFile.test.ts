import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { EnvFileError, renderEnvFile, withEnvFile } from '../../src/envFile.js';
import { CleanupRegistry, installSignalCleanup } from '../../src/cleanup.js';

describe('renderEnvFile', () => {
  it('writes one KEY=VALUE per line, verbatim', () => {
    expect(
      renderEnvFile({ url: 'https://x.test', logging__transports: '["stdout"]', empty: '' })
    ).toBe('url=https://x.test\nlogging__transports=["stdout"]\nempty=\n');
  });

  it.each([['a\nb'], ['a\rb'], ['a\0b']])(
    'refuses a value holding %j, without repeating it',
    (value) => {
      let caught: unknown;
      try {
        renderEnvFile({ database__connection__password: value });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EnvFileError);
      expect((caught as Error).message).not.toContain(value);
    }
  );

  it.each([['1abc'], ['a b'], ['a=b'], ['']])('refuses the key %j', (key) => {
    expect(() => renderEnvFile({ [key]: 'v' })).toThrow(EnvFileError);
  });
});

describe('withEnvFile', () => {
  it('hands fn a 0600 file in a 0700 directory holding the env, then removes both', async () => {
    let seenPath = '';
    const result = await withEnvFile({ secret: 'synthetic-value' }, async (path) => {
      seenPath = path;
      expect(await readFile(path, 'utf8')).toBe('secret=synthetic-value\n');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      return 'done';
    });
    expect(result).toBe('done');
    expect(existsSync(dirname(seenPath))).toBe(false);
  });

  it('removes the file when fn throws, and rethrows', async () => {
    let seenPath = '';
    await expect(
      withEnvFile({ secret: 'x' }, async (path) => {
        seenPath = path;
        throw new Error('refused inside');
      })
    ).rejects.toThrow('refused inside');
    expect(seenPath).not.toBe('');
    expect(existsSync(dirname(seenPath))).toBe(false);
  });

  it('writes nothing at all when the env cannot be rendered', async () => {
    let called = false;
    await expect(
      withEnvFile({ bad: 'a\nb' }, async () => {
        called = true;
      })
    ).rejects.toThrow(EnvFileError);
    expect(called).toBe(false);
  });

  it('is registered for cleanup while it exists, and deregistered once removed', async () => {
    const registry = new CleanupRegistry();
    await withEnvFile(
      { a: 'b' },
      async () => {
        expect(registry.labels).toHaveLength(1);
        expect(registry.labels[0]).toMatch(/^env file /);
      },
      registry
    );
    expect(registry.labels).toEqual([]);
  });
});

describe('withEnvFile on a signal', () => {
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('the registry removes the file on %s before exiting %i', async (signal, code) => {
    const registry = new CleanupRegistry();
    const exit = vi.fn();
    const uninstall = installSignalCleanup(registry, exit);
    try {
      let seenPath = '';
      await withEnvFile(
        { secret: 'x' },
        async (path) => {
          seenPath = path;
          process.emit(signal, signal);
          expect(existsSync(dirname(seenPath))).toBe(false);
        },
        registry
      );
      expect(exit).toHaveBeenCalledWith(code);
    } finally {
      uninstall();
    }
  });
});
