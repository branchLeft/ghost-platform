import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CleanupRegistry, dockerRemoveSync, installSignalCleanup } from '../../src/cleanup.js';

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
