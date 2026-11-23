import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXIT,
  SshEntryStartupError,
  composeHostPorts,
  parseRunConfig,
  runCli,
  type HostComposition,
  type RunConfig,
  type TenantEntryInputs,
} from '../../src/index.js';
import { DbEntryHost } from '../../src/dbEntryHost.js';
import { TenantEntryHost } from '../../src/tenantEntryHost.js';
import { APPROVAL } from '../support/doubles.js';
import { Workdir } from '../support/workdir.js';

let dir: string;
let work: Workdir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pc-compose-'));
  work = await Workdir.create();
  await mkdir(join(dir, 'hand-over'), { mode: 0o700 });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await work.remove();
});

const KEY = '/etc/controller/entry_key';
const KNOWN = '/etc/controller/known_hosts';

/** What `ssh -G` prints for a hop that is configured as the target is. */
const PINNED = [
  'stricthostkeychecking true',
  'batchmode yes',
  'identitiesonly yes',
  `userknownhostsfile ${KNOWN}`,
  'globalknownhostsfile /dev/null',
  `identityfile ${KEY}`,
];

/** A stand-in for the ssh client: `-G` prints the given lines, and every call's arguments are logged. */
async function fakeSsh(gOutput: readonly string[]): Promise<string> {
  await writeFile(join(dir, 'g.out'), `${gOutput.join('\n')}\n`);
  const program = join(dir, 'ssh');
  await writeFile(
    program,
    `#!/bin/sh\necho "$*" >> ${dir}/calls.log\nif [ "$1" = "-G" ]; then cat ${dir}/g.out; fi\nexit 0\n`
  );
  await chmod(program, 0o755);
  return program;
}

const sshEntry = (program: string): Record<string, unknown> => ({
  keyFile: KEY,
  knownHostsFile: KNOWN,
  sshConfigFile: '/etc/controller/ssh_config',
  jumpHops: [{ user: 'jumper', host: 'edge1.example.test' }],
  target: { user: 'tenant-entry', host: 'app1.example.test' },
  inputs: {
    secretsFile: '/etc/controller/secrets.json',
    stackFile: '/etc/controller/stack.json',
    deployKeyFile: '/etc/controller/deploy_key.json',
  },
  sshProgram: program,
});

const dbEntry = (): Record<string, unknown> => ({
  target: { user: 'tenantdb', host: 'db1.example.test' },
  handOverDir: join(dir, 'hand-over'),
});

const configBase = {
  stateFile: '/var/lib/controller/state.jsonl',
  approvalsFile: '/var/lib/controller/approvals.json',
  registerFile: '/var/lib/controller/register.json',
  hosts: {},
};

const configWith = (entry?: Record<string, unknown>, db: unknown = dbEntry()): RunConfig =>
  parseRunConfig({
    ...configBase,
    ...(entry !== undefined && { sshEntry: entry }),
    ...(entry !== undefined && db !== undefined && { dbEntry: db }),
  });

const INPUTS: TenantEntryInputs = {
  secrets: () => Promise.reject(new Error('not reached')),
  stack: () => Promise.reject(new Error('not reached')),
  deployKey: () => Promise.reject(new Error('not reached')),
  owner: () => Promise.reject(new Error('not reached')),
};
const WITH_INPUTS: HostComposition = { tenantEntryInputs: INPUTS };
const ENV = { PATH: '/usr/bin:/bin' };

async function sshCalls(): Promise<string[]> {
  try {
    return (await readFile(join(dir, 'calls.log'), 'utf8')).split('\n').filter((l) => l !== '');
  } catch {
    return [];
  }
}

describe('composeHostPorts: ssh stays off unless configured', () => {
  it('uses the configured programs alone when there is no sshEntry section, and starts no ssh', async () => {
    const config = configWith();
    expect(config.sshEntry).toBeUndefined();
    const hosts = await composeHostPorts(config, ENV, WITH_INPUTS);
    expect(hosts['app-host']).not.toBeInstanceOf(TenantEntryHost);
    await expect(hosts['app-host'].run(STEP)).rejects.toThrow(/no host entry point/);
    expect(await sshCalls()).toEqual([]);
  });

  it('has no default: the section is refused for a missing key file, host or hop list', () => {
    const base = sshEntry('/usr/bin/ssh');
    for (const key of ['keyFile', 'knownHostsFile', 'target', 'jumpHops', 'inputs']) {
      const { [key]: _left, ...rest } = base;
      expect(() => configWith(rest)).toThrow(new RegExp(`sshEntry\\.${key} is required`));
    }
  });

  it('refuses a key it does not know, a relative path and a malformed hop', () => {
    const base = sshEntry('/usr/bin/ssh');
    expect(() => configWith({ ...base, agent: true })).toThrow(/unknown keys: agent/);
    expect(() => configWith({ ...base, keyFile: 'entry_key' })).toThrow(/keyFile is not usable/);
    expect(() => configWith({ ...base, jumpHops: [{ user: 'a b', host: 'x.test' }] })).toThrow(
      /jumpHops\[0\]\.user is not usable/
    );
  });
});

describe('composeHostPorts: the hop check runs at startup', () => {
  it('selects the tenant entry adapter for the app host once every hop is pinned, having asked ssh -G', async () => {
    const program = await fakeSsh(PINNED);
    const hosts = await composeHostPorts(configWith(sshEntry(program)), ENV, WITH_INPUTS);
    expect(hosts['app-host']).toBeInstanceOf(TenantEntryHost);
    expect(hosts['db-host']).toBeInstanceOf(DbEntryHost);
    const calls = await sshCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(
      /^-G -F \/etc\/controller\/ssh_config -l jumper edge1\.example\.test$/
    );
  });

  it('refuses to start when a hop would not use strict host keys, and names the problem', async () => {
    const program = await fakeSsh(PINNED.filter((l) => !l.startsWith('stricthostkeychecking')));
    const started = composeHostPorts(configWith(sshEntry(program)), ENV, WITH_INPUTS);
    await expect(started).rejects.toBeInstanceOf(SshEntryStartupError);
    await expect(started).rejects.toThrow(/jumpHops\[0\]: StrictHostKeyChecking is not yes/);
  });

  it('refuses to start when ssh cannot read the configuration at all', async () => {
    const started = composeHostPorts(
      configWith(sshEntry(join(dir, 'missing-ssh'))),
      ENV,
      WITH_INPUTS
    );
    await expect(started).rejects.toThrow(/ssh could not read the configuration/);
  });

  it('refuses to start when no source of the tenant entry inputs is available', async () => {
    const program = await fakeSsh(PINNED);
    await expect(composeHostPorts(configWith(sshEntry(program)), ENV)).rejects.toThrow(
      /no source of the tenant entry inputs/
    );
  });
});

describe('composeHostPorts: the database entry', () => {
  it('is required with sshEntry, needs it, and is closed to other keys', () => {
    const ssh = sshEntry('/usr/bin/ssh');
    expect(() => parseRunConfig({ ...configBase, sshEntry: ssh })).toThrow(
      /dbEntry is required with sshEntry/
    );
    expect(() => parseRunConfig({ ...configBase, dbEntry: dbEntry() })).toThrow(
      /dbEntry needs sshEntry/
    );
    expect(() => configWith(ssh, { ...dbEntry(), agent: true })).toThrow(
      /dbEntry has unknown keys: agent/
    );
    expect(() => configWith(ssh, 'x')).toThrow(/dbEntry is not an object/);
    expect(() => configWith(ssh, { handOverDir: '/a' })).toThrow(/dbEntry\.target is required/);
    expect(() => configWith(ssh, { ...dbEntry(), handOverDir: 'relative' })).toThrow(
      /dbEntry\.handOverDir is not an absolute path/
    );
    expect(() =>
      configWith(ssh, { ...dbEntry(), target: { user: 'a b', host: 'db1.example.test' } })
    ).toThrow(/dbEntry\.target\.user is not usable/);
  });

  it('refuses to start over a hand-over directory others can reach, or one that is missing', async () => {
    const program = await fakeSsh(PINNED);
    await chmod(join(dir, 'hand-over'), 0o755);
    const open = composeHostPorts(configWith(sshEntry(program)), ENV, WITH_INPUTS);
    await expect(open).rejects.toBeInstanceOf(SshEntryStartupError);
    await expect(open).rejects.toThrow(/hand-over directory .* its mode lets other users/);
    await rm(join(dir, 'hand-over'), { recursive: true });
    await expect(composeHostPorts(configWith(sshEntry(program)), ENV, WITH_INPUTS)).rejects.toThrow(
      /hand-over directory .* it cannot be read/
    );
  });
});

describe('runCli: a configured ssh entry point that is not usable stops the run before any step', () => {
  const run = async (
    config: string,
    withInputs = false
  ): Promise<{ code: number; stdout: string[]; stderr: string[] }> => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(['--config', config, '--approval-id', APPROVAL.approvalId], {
      stdout: (l) => stdout.push(l),
      stderr: (l) => stderr.push(l),
      env: { PATH: process.env['PATH'] },
      ...(withInputs && { tenantEntryInputs: () => INPUTS }),
    });
    return { code, stdout, stderr };
  };

  it('exits with the usage status, runs no step and writes no state, over an unpinned hop', async () => {
    const program = await fakeSsh(PINNED.filter((l) => l !== 'batchmode yes'));
    const config = await work.deployment({ sshEntry: sshEntry(program), dbEntry: dbEntry() });
    const outcome = await run(config, true);
    expect(outcome.code).toBe(EXIT.usage);
    expect(outcome.stdout).toEqual([]);
    expect(outcome.stderr.join('\n')).toContain('BatchMode is not yes');
    expect(await work.calledIds()).toEqual([]);
    await expect(readFile(work.path('state.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('exits with the usage status over a configuration that names no key file', async () => {
    const { keyFile: _left, ...rest } = sshEntry('/usr/bin/ssh');
    const outcome = await run(await work.deployment({ sshEntry: rest, dbEntry: dbEntry() }));
    expect(outcome.code).toBe(EXIT.usage);
    expect(outcome.stderr.join('\n')).toContain('sshEntry.keyFile is required');
    expect(await work.calledIds()).toEqual([]);
  });
});

const STEP = {
  key: 'k',
  id: 'create-app-host-slot',
  idempotencyKey: 'k@d',
  inputs: { slot: 'acme-blog' },
} as const;
