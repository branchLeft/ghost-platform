import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli.js';
import { DockerEngineTooOldError } from '../../src/containerRunner.js';
import { TenantConfigError } from '../../src/tenantConfig.js';
import { writeFakeDocker } from '../helpers/fakeDocker.js';

/**
 * The call site of the Docker engine gate. The gate itself is unit-tested in
 * containerRunner.test.ts; this file proves main() makes the call, and makes
 * it before anything that creates a resource -- which no other test can,
 * since cli.ts is not covered. Delete the `startup` call from main() and the
 * 27.x case below fails: main() goes on to the descriptor instead of refusing.
 */
describe('main: the Docker engine gate runs first', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-cli-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A complete, valid flag set; the descriptor does not exist, so a run that passes the gate stops there. */
  function argv(): string[] {
    return [
      '--grant-lane',
      'consented',
      '--grant-reference',
      'test-reference',
      '--descriptor',
      join(dir, 'no-such-descriptor.json'),
      '--age-recipient',
      'age1testrecipient',
      '--requested-by',
      'tester',
      '--delivered-to',
      'tester',
      '--dest-dir',
      join(dir, 'dest'),
      '--flag-dir',
      join(dir, 'flags'),
      '--audit-log',
      join(dir, 'audit.log'),
      '--loopback-port',
      '4400',
      '--erasure-date',
      '2030-01-01',
    ];
  }

  async function calls(argvLog: string): Promise<string[][]> {
    const text = await readFile(argvLog, 'utf8').catch(() => '');
    return text
      .trim()
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as string[]);
  }

  it('refuses a 27.x engine before any docker run, create, network, volume or compose call', async () => {
    const argvLog = join(dir, 'argv.log');
    const fake = await writeFakeDocker(dir, { argvLogPath: argvLog, versionOutput: '27.5.1' });

    await expect(
      main(argv(), { dockerCommand: fake, signalTarget: new EventEmitter() as never })
    ).rejects.toThrow(DockerEngineTooOldError);

    const verbs = (await calls(argvLog)).map((c) => c[0]);
    expect(verbs).toEqual(['version']);
    for (const forbidden of ['run', 'create', 'network', 'volume', 'compose']) {
      expect(verbs).not.toContain(forbidden);
    }
  });

  it('lets a 28.0.0 engine through to the descriptor, after exactly one version call', async () => {
    const argvLog = join(dir, 'argv.log');
    const fake = await writeFakeDocker(dir, { argvLogPath: argvLog, versionOutput: '28.0.0' });

    await expect(
      main(argv(), { dockerCommand: fake, signalTarget: new EventEmitter() as never })
    ).rejects.toThrow(TenantConfigError);

    expect((await calls(argvLog)).map((c) => c[0])).toEqual(['version']);
  });

  it('refuses before the flags are read: a missing grant on a 27.x engine is still an engine refusal', async () => {
    const fake = await writeFakeDocker(dir, { versionOutput: '27.5.1' });
    await expect(
      main([], { dockerCommand: fake, signalTarget: new EventEmitter() as never })
    ).rejects.toThrow(DockerEngineTooOldError);
  });

  it('installs the signal handlers on the target it is given, and not on process', async () => {
    const fake = await writeFakeDocker(dir, { versionOutput: '28.0.0' });
    const target = new EventEmitter();
    const before = process.listenerCount('SIGINT');
    await main(argv(), { dockerCommand: fake, signalTarget: target as never }).catch(
      () => undefined
    );
    expect(target.listenerCount('SIGINT')).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
