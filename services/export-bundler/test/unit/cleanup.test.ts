import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  CLEANUP_FAILED_EXIT_CODE,
  CleanupRegistry,
  dockerRemoveSync,
  installSignalCleanup,
} from '../../src/cleanup.js';

describe('CleanupRegistry', () => {
  it('runs every registered step, newest first, and empties itself', () => {
    const registry = new CleanupRegistry();
    const order: string[] = [];
    registry.register('scratch', () => order.push('scratch'));
    registry.register('colour', () => order.push('colour'));
    expect(registry.labels).toEqual(['scratch', 'colour']);
    expect(registry.runAll()).toEqual([]);
    expect(order).toEqual(['colour', 'scratch']);
    expect(registry.labels).toEqual([]);
    expect(registry.runAll()).toEqual([]);
  });

  it('a step taken back off the registry does not run', () => {
    const registry = new CleanupRegistry();
    const ran: string[] = [];
    const unregister = registry.register('done already', () => ran.push('x'));
    unregister();
    registry.runAll();
    expect(ran).toEqual([]);
  });

  it('attempts every step even when one throws, and names the ones that did', () => {
    const registry = new CleanupRegistry();
    const ran: string[] = [];
    registry.register('first', () => ran.push('first'));
    registry.register('broken', () => {
      throw new Error('boom');
    });
    registry.register('last', () => ran.push('last'));
    expect(registry.runAll()).toEqual(['broken']);
    expect(ran).toEqual(['last', 'first']);
  });
});

describe('installSignalCleanup', () => {
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('on %s runs every step before exiting %i', (signal, code) => {
    const registry = new CleanupRegistry();
    const target = new EventEmitter();
    const events: string[] = [];
    registry.register('colour', () => events.push('removed colour'));
    const exit = vi.fn(() => events.push('exit'));
    installSignalCleanup(registry, exit, target as never);
    target.emit(signal);
    expect(events).toEqual(['removed colour', 'exit']);
    expect(exit).toHaveBeenCalledWith(code);
  });

  it('can be uninstalled', () => {
    const target = new EventEmitter();
    const uninstall = installSignalCleanup(new CleanupRegistry(), vi.fn(), target as never);
    expect(target.listenerCount('SIGINT')).toBe(1);
    uninstall();
    expect(target.listenerCount('SIGINT')).toBe(0);
    expect(target.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('installSignalCleanup failure reporting', () => {
  interface ReportingHarness {
    target: EventEmitter;
    written: string[];
    writeStderr: Mock<(line: string) => void>;
    exit: Mock<(code: number) => void>;
  }

  function installReporting(
    registry: CleanupRegistry,
    writeLine?: (line: string) => void
  ): ReportingHarness {
    const target = new EventEmitter();
    const written: string[] = [];
    const writeStderr = vi.fn((line: string) => {
      if (writeLine) {
        writeLine(line);
        return;
      }
      written.push(line);
    });
    const exit = vi.fn((_code: number) => undefined);
    installSignalCleanup(registry, exit, target as never, writeStderr);
    return { target, written, writeStderr, exit };
  }

  it.each([['SIGINT'], ['SIGTERM']] as const)(
    'on %s names a failed step on stderr, exits with the cleanup-failed code and still attempts every step',
    (signal) => {
      const registry = new CleanupRegistry();
      const ran: string[] = [];
      registry.register('healthy step before', () => ran.push('healthy step before'));
      registry.register('broken scratch step', () => {
        throw new Error('boom');
      });
      registry.register('healthy step after', () => ran.push('healthy step after'));
      const { target, written, writeStderr, exit } = installReporting(registry);
      target.emit(signal);
      expect(writeStderr).toHaveBeenCalledTimes(1);
      expect(writeStderr).toHaveBeenCalledWith(
        `export-bundler: cleanup step failed on ${signal}: broken scratch step`
      );
      expect(written).toEqual([
        `export-bundler: cleanup step failed on ${signal}: broken scratch step`,
      ]);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(CLEANUP_FAILED_EXIT_CODE);
      expect(exit).not.toHaveBeenCalledWith(130);
      expect(exit).not.toHaveBeenCalledWith(143);
      expect(ran).toEqual(['healthy step after', 'healthy step before']);
    }
  );

  it('writes one line per failed step, in the order runAll() returns them', () => {
    const registry = new CleanupRegistry();
    registry.register('broken first step', () => {
      throw new Error('boom');
    });
    registry.register('healthy step between', () => undefined);
    registry.register('broken second step', () => {
      throw new Error('boom');
    });
    const { target, written, writeStderr, exit } = installReporting(registry);
    target.emit('SIGINT');
    expect(writeStderr).toHaveBeenCalledTimes(2);
    expect(written).toEqual([
      'export-bundler: cleanup step failed on SIGINT: broken second step',
      'export-bundler: cleanup step failed on SIGINT: broken first step',
    ]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(CLEANUP_FAILED_EXIT_CODE);
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('on %s writes nothing and exits %i when every step succeeds', (signal, code) => {
    const registry = new CleanupRegistry();
    registry.register('healthy step', () => undefined);
    const { target, written, writeStderr, exit } = installReporting(registry);
    target.emit(signal);
    expect(writeStderr).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(code);
  });

  it('still exits with the cleanup-failed code when stderr itself throws', () => {
    const registry = new CleanupRegistry();
    registry.register('broken scratch step', () => {
      throw new Error('boom');
    });
    const { target, exit } = installReporting(registry, () => {
      throw new Error('stderr closed');
    });
    expect(() => target.emit('SIGINT')).not.toThrow();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(CLEANUP_FAILED_EXIT_CODE);
  });

  it('a throwing stderr write does not stop the remaining lines, and exit still runs last', () => {
    const registry = new CleanupRegistry();
    registry.register('broken first step', () => {
      throw new Error('boom');
    });
    registry.register('broken second step', () => {
      throw new Error('boom');
    });
    const recorded: string[] = [];
    let calls = 0;
    const { target, writeStderr, exit } = installReporting(registry, (line) => {
      calls += 1;
      if (calls === 1) {
        throw new Error('stderr closed');
      }
      recorded.push(line);
    });
    target.emit('SIGTERM');
    expect(writeStderr).toHaveBeenCalledTimes(2);
    expect(recorded).toEqual(['export-bundler: cleanup step failed on SIGTERM: broken first step']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(CLEANUP_FAILED_EXIT_CODE);
  });

  it('never writes the thrown error message, which can carry paths', () => {
    const registry = new CleanupRegistry();
    registry.register('broken scratch step', () => {
      throw new Error('SECRET-IN-MESSAGE /private/path');
    });
    const { target, written, exit } = installReporting(registry);
    target.emit('SIGINT');
    expect(written).toEqual(['export-bundler: cleanup step failed on SIGINT: broken scratch step']);
    expect(written.join('\n')).not.toContain('SECRET-IN-MESSAGE');
    expect(exit).toHaveBeenCalledWith(CLEANUP_FAILED_EXIT_CODE);
  });
});

describe('dockerRemoveSync', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-cleanup-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function fakeDocker(lines: readonly string[]): Promise<string> {
    const path = join(dir, 'fake-docker.sh');
    await writeFile(path, ['#!/bin/sh', ...lines].join('\n') + '\n');
    await chmod(path, 0o755);
    return path;
  }

  it('runs docker synchronously with exactly the argv given', async () => {
    const log = join(dir, 'argv.log');
    const fake = await fakeDocker([`for a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done`]);
    dockerRemoveSync(['rm', '-fv', 'tenant-export-1-db'], fake);
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual([
      'rm',
      '-fv',
      'tenant-export-1-db',
    ]);
  });

  it('throws when docker fails, so the registry can report it', async () => {
    const fake = await fakeDocker(['exit 1']);
    expect(() => dockerRemoveSync(['rm', '-f', 'x'], fake)).toThrow();
  });

  it('falls back to an empty PATH when this process has none', () => {
    const saved = process.env.PATH;
    delete process.env.PATH;
    try {
      expect(() => dockerRemoveSync(['rm', '-f', 'x'], 'docker')).toThrow();
    } finally {
      process.env.PATH = saved;
    }
  });
});
