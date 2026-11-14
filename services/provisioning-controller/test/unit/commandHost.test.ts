import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ENTRY_POINTS,
  PermanentStepError,
  commandHostPorts,
  type CommandSpec,
  type Env,
  type StepRequest,
} from '../../src/index.js';
import { FAKE_HOST, Workdir } from '../support/workdir.js';

const REQUEST: StepRequest = {
  key: 'TENANT_ID_PLACEHOLDER/create-database',
  id: 'create-database',
  idempotencyKey: 'TENANT_ID_PLACEHOLDER/create-database@DIGEST_PLACEHOLDER',
  inputs: { slot: 'SLOT_PLACEHOLDER', hostnames: ['host-one.example.invalid'] },
};

let work: Workdir;
beforeEach(async () => {
  work = await Workdir.create();
});
afterEach(async () => {
  await work.remove();
});

const spec = (timeoutMs = 10_000): CommandSpec => ({
  argv: [process.execPath, FAKE_HOST, work.dir],
  timeoutMs,
});
const hostWith = (s: CommandSpec, env: Env = {}) =>
  commandHostPorts({ 'db-host': s }, env)['db-host'];

describe('commandHostPorts', () => {
  it('has one port per entry point', () => {
    const ports = commandHostPorts({}, {});
    expect(Object.keys(ports).sort()).toEqual([...ENTRY_POINTS].sort());
  });

  it('hands the step to the program on standard input and nothing else', async () => {
    await hostWith(spec()).run(REQUEST);
    const line = (await readFile(work.path('calls.jsonl'), 'utf8')).trim();
    expect(JSON.parse(line)).toEqual(REQUEST);
  });

  it('treats exit 0 as success', async () => {
    await expect(hostWith(spec()).run(REQUEST)).resolves.toBeUndefined();
  });

  it('treats an ordinary failure as retryable', async () => {
    await work.modes({ 'create-database': 'fail' });
    const failure = await hostWith(spec())
      .run(REQUEST)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PermanentStepError);
    expect((failure as Error).message).toContain('exit 1');
  });

  it('treats the permanent exit status as a permanent failure', async () => {
    await work.modes({ 'create-database': 'permanent' });
    await expect(hostWith(spec()).run(REQUEST)).rejects.toBeInstanceOf(PermanentStepError);
  });

  it('treats a program that cannot be started as permanent', async () => {
    const missing: CommandSpec = { argv: [work.path('no-such-program')], timeoutMs: 5000 };
    const failure = await hostWith(missing)
      .run(REQUEST)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PermanentStepError);
    expect((failure as Error).message).toContain('ENOENT');
  });

  it('kills a program that outlasts its limit and fails the attempt as retryable', async () => {
    await work.modes({ 'create-database': 'hang' });
    const failure = await hostWith(spec(300))
      .run(REQUEST)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PermanentStepError);
    expect((failure as Error).message).toContain('timed out after 300 ms');
  });

  it('never lets anything the program prints reach the error', async () => {
    await work.modes({ 'create-database': 'noisy' });
    const failure = (await hostWith(spec())
      .run(REQUEST)
      .catch((e: unknown) => e)) as Error;
    expect(failure.message).not.toContain('SECRETVALUE');
    expect(failure.message).not.toContain('token=');
  });

  it('starts the program with only PATH, HOME and LANG, so no token of the controller reaches it', async () => {
    await work.modes({ 'create-database': 'env' });
    const env = {
      PATH: process.env['PATH'],
      HOME: '/HOME_PLACEHOLDER',
      GH_TOKEN: 'TOKEN_PLACEHOLDER',
      STORAGE_GATEWAY_ADMIN_KEY_PROVISIONING_CONTROLLER: 'KEY_PLACEHOLDER',
      SSH_AUTH_SOCK: '/SOCKET_PLACEHOLDER',
    };
    const { childEnvironment } = await import('../../src/commandHost.js');
    await hostWith(spec(), childEnvironment(env)).run(REQUEST);
    const names = JSON.parse(await readFile(work.path('env.json'), 'utf8')) as string[];
    expect(names).toContain('HOME');
    for (const leaked of [
      'GH_TOKEN',
      'STORAGE_GATEWAY_ADMIN_KEY_PROVISIONING_CONTROLLER',
      'SSH_AUTH_SOCK',
    ]) {
      expect(names).not.toContain(leaked);
    }
  });

  it('fails an unconfigured entry point at once, permanently, and starts nothing', async () => {
    const failure = await commandHostPorts({}, {})
      ['db-host'].run(REQUEST)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PermanentStepError);
    expect((failure as Error).message).toContain('no host entry point is configured for db-host');
    expect(await work.calledIds()).toEqual([]);
  });
});
