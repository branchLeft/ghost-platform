import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  CLEANUP_FAILED_EXIT_CODE,
  CleanupRegistry,
  dockerRemoveSync,
  dockerRemoveUntilGoneSync,
  installSignalCleanup,
  type TrackedChild,
} from '../../src/cleanup.js';
import { streamDumpIntoScratch } from '../../src/scratchDatabase.js';

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

describe('CleanupRegistry: docker clients still in flight', () => {
  function fakeChild(
    state: { exitCode?: number | null; signalCode?: 'SIGTERM' | 'SIGKILL' | null } = {},
    events: string[] = [],
    name = 'child'
  ): TrackedChild {
    return {
      exitCode: state.exitCode ?? null,
      signalCode: state.signalCode ?? null,
      kill: (signal) => {
        events.push(`kill ${name} ${String(signal)}`);
        return true;
      },
    };
  }

  it('SIGKILLs every tracked client before any remover runs, and counts them', () => {
    const registry = new CleanupRegistry();
    const events: string[] = [];
    registry.register('colour', () => events.push('remover colour'));
    registry.trackChild(fakeChild({}, events, 'run'));
    registry.register('scratch', () => events.push('remover scratch'));
    registry.trackChild(fakeChild({}, events, 'dump'));
    registry.runAll();
    expect(events).toEqual([
      'kill run SIGKILL',
      'kill dump SIGKILL',
      'remover scratch',
      'remover colour',
    ]);
    expect(registry.killedInFlight).toBe(2);
  });

  it('does not signal a client that has exited, or one taken back off', () => {
    const registry = new CleanupRegistry();
    const events: string[] = [];
    registry.trackChild(fakeChild({ exitCode: 0 }, events, 'exited'));
    registry.trackChild(fakeChild({ signalCode: 'SIGTERM' }, events, 'signalled'));
    registry.trackChild(fakeChild({}, events, 'running'))();
    registry.runAll();
    expect(events).toEqual([]);
    expect(registry.killedInFlight).toBe(0);
  });

  it('still runs every remover when a kill throws', () => {
    const registry = new CleanupRegistry();
    const ran: string[] = [];
    registry.register('colour', () => ran.push('colour'));
    registry.trackChild({
      exitCode: null,
      signalCode: null,
      kill: () => {
        throw new Error('ESRCH');
      },
    });
    expect(registry.runAll()).toEqual([]);
    expect(ran).toEqual(['colour']);
    expect(registry.killedInFlight).toBe(0);
  });

  describe('with real child processes', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'export-bundler-inflight-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    /** A docker that would create its container one second after it is started. */
    async function lateCreatingDocker(): Promise<{ path: string; marker: string }> {
      const marker = join(dir, 'late-create');
      const path = join(dir, 'slow-docker.sh');
      await writeFile(
        path,
        ['#!/bin/sh', 'sleep 1', `echo created > '${marker}'`, 'exit 0'].join('\n') + '\n'
      );
      await chmod(path, 0o755);
      return { path, marker };
    }

    it('a client killed by runAll() never goes on to make its late create', async () => {
      const { path, marker } = await lateCreatingDocker();
      const registry = new CleanupRegistry();
      const pending = streamDumpIntoScratch(path, ['dump'], ['import'], () => undefined, registry);
      registry.runAll();
      expect(registry.killedInFlight).toBe(2);
      const result = await pending;
      expect(result.dumpCode).toBeNull();
      expect(result.importCode).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(existsSync(marker)).toBe(false);
    });

    it('control: left alone, the same clients do make the create, and are no longer tracked', async () => {
      const { path, marker } = await lateCreatingDocker();
      const registry = new CleanupRegistry();
      const result = await streamDumpIntoScratch(
        path,
        ['dump'],
        ['import'],
        () => undefined,
        registry
      );
      expect(result.dumpCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
      registry.runAll();
      expect(registry.killedInFlight).toBe(0);
    });
  });
});

describe('dockerRemoveUntilGoneSync', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-until-gone-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** `docker inspect` finds the container for its first `presentReads` reads, then not. */
  async function fakeDocker(presentReads: number): Promise<{ path: string; log: string }> {
    const log = join(dir, 'argv.log');
    const count = join(dir, 'inspect-count');
    const path = join(dir, 'fake-docker.sh');
    await writeFile(
      path,
      [
        '#!/bin/sh',
        `echo "$@" >> '${log}'`,
        'if [ "$1" = inspect ]; then',
        `  n=$(cat '${count}' 2>/dev/null || echo 0); n=$((n + 1)); echo $n > '${count}'`,
        `  if [ $n -le ${String(presentReads)} ]; then exit 0; fi`,
        '  exit 1',
        'fi',
        'exit 0',
      ].join('\n') + '\n'
    );
    await chmod(path, 0o755);
    return { path, log };
  }

  async function lines(log: string): Promise<string[]> {
    return (await readFile(log, 'utf8')).trim().split('\n');
  }

  function registryThatKilled(count: number): CleanupRegistry {
    const registry = new CleanupRegistry();
    for (let i = 0; i < count; i += 1) {
      registry.trackChild({ exitCode: null, signalCode: null, kill: () => true });
    }
    registry.runAll();
    return registry;
  }

  it('with nothing killed it is exactly one rm and no inspect', async () => {
    const fake = await fakeDocker(0);
    dockerRemoveUntilGoneSync('tenant-export-1', fake.path, new CleanupRegistry());
    expect(await lines(fake.log)).toEqual(['rm -f tenant-export-1']);
  });

  it('with a client killed, repeats rm -f while the container keeps appearing and stops once it stays gone', async () => {
    const fake = await fakeDocker(2);
    dockerRemoveUntilGoneSync('tenant-export-1', fake.path, registryThatKilled(1));
    const inspect = 'inspect --type container tenant-export-1';
    expect(await lines(fake.log)).toEqual([
      'rm -f tenant-export-1',
      inspect,
      'rm -f tenant-export-1',
      inspect,
      'rm -f tenant-export-1',
      inspect,
      inspect,
    ]);
  });

  it('stops at two absent reads in a row when the container never appeared', async () => {
    const fake = await fakeDocker(0);
    dockerRemoveUntilGoneSync('tenant-export-1', fake.path, registryThatKilled(1));
    expect(await lines(fake.log)).toEqual([
      'rm -f tenant-export-1',
      'inspect --type container tenant-export-1',
      'inspect --type container tenant-export-1',
    ]);
  });

  it('is bounded: a container that never goes is read ten times, then given up on, without throwing', async () => {
    const fake = await fakeDocker(1000);
    const started = Date.now();
    expect(() =>
      dockerRemoveUntilGoneSync('tenant-export-1', fake.path, registryThatKilled(1))
    ).not.toThrow();
    const all = await lines(fake.log);
    expect(all.filter((l) => l.startsWith('inspect'))).toHaveLength(10);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('passes the flag it is given to rm (-fv for the scratch database volume)', async () => {
    const fake = await fakeDocker(0);
    dockerRemoveUntilGoneSync('db', fake.path, new CleanupRegistry(), '-fv');
    expect(await lines(fake.log)).toEqual(['rm -fv db']);
  });

  it('never throws when docker itself is missing', () => {
    expect(() =>
      dockerRemoveUntilGoneSync('x', join(dir, 'no-such-docker'), registryThatKilled(1))
    ).not.toThrow();
  });
});
