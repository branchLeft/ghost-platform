import { chmod, readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ControllerHost,
  DEPLOY_ACCOUNT,
  PermanentStepError,
  SlotDeployHost,
  SshEntryTransport,
  TENANT_IMAGE,
  type HostEntryPoint,
  type SlotKeys,
  type StepId,
  type StepRequest,
} from '../../src/index.js';
import { Workdir } from '../support/workdir.js';

let work: Workdir;
beforeEach(async () => {
  work = await Workdir.create();
});
afterEach(async () => {
  await work.remove();
});

const DIGEST = `sha256:${'cd'.repeat(32)}`;
const KEY_FILE = '/var/lib/controller/slot-keys/slot-one.key';

const request = (
  id: StepId,
  inputs: StepRequest['inputs'] = { slot: 'slot-one' }
): StepRequest => ({
  key: `t/${id}`,
  id,
  idempotencyKey: `t/${id}@d`,
  inputs,
});

function recorder(): { host: HostEntryPoint; seen: StepRequest[] } {
  const seen: StepRequest[] = [];
  return { seen, host: { run: async (r) => void seen.push(r) } };
}

describe('SlotDeployHost', () => {
  function build(code: number | Error): {
    host: SlotDeployHost;
    deploys: string[][];
    fallback: StepRequest[];
  } {
    const deploys: string[][] = [];
    const fb = recorder();
    const keys: Pick<SlotKeys, 'privateKeyPath'> = { privateKeyPath: async () => KEY_FILE };
    const host = new SlotDeployHost({
      keys,
      fallback: fb.host,
      transport: {
        deploy: async (keyFile, user, image) => {
          deploys.push([keyFile, user, image]);
          if (code instanceof Error) throw code;
          return code;
        },
      },
    });
    return { host, deploys, fallback: fb.seen };
  }

  it('deploys the register digest on the tenant image over the slot key and the deploy account', async () => {
    const { host, deploys, fallback } = build(0);
    await host.run(request('first-deploy', { slot: 'slot-one', imageDigest: DIGEST }));
    expect(deploys).toEqual([[KEY_FILE, DEPLOY_ACCOUNT, `${TENANT_IMAGE}@${DIGEST}`]]);
    expect(fallback).toEqual([]);
  });

  it('refuses a first deploy with no register digest, and a digest that is not one', async () => {
    const { host, deploys } = build(0);
    await expect(host.run(request('first-deploy'))).rejects.toBeInstanceOf(PermanentStepError);
    for (const imageDigest of ['latest', 'sha256:abc', `${DIGEST}\nother`, 7]) {
      await expect(
        host.run(request('first-deploy', { slot: 'slot-one', imageDigest }))
      ).rejects.toBeInstanceOf(PermanentStepError);
    }
    expect(deploys).toEqual([]);
  });

  it('stops for good when the wrapper refuses, tries again for any other failure', async () => {
    const inputs = { slot: 'slot-one', imageDigest: DIGEST };
    for (const code of [1, 2]) {
      await expect(build(code).host.run(request('first-deploy', inputs))).rejects.toBeInstanceOf(
        PermanentStepError
      );
    }
    const other = await build(5)
      .host.run(request('first-deploy', inputs))
      .catch((e: unknown) => e);
    expect(other).toBeInstanceOf(Error);
    expect(other).not.toBeInstanceOf(PermanentStepError);
  });

  it('passes every other step to its fallback and deploys nothing', async () => {
    const { host, deploys, fallback } = build(0);
    await host.run(request('create-owner-account'));
    expect(fallback.map((r) => r.id)).toEqual(['create-owner-account']);
    expect(deploys).toEqual([]);
  });
});

describe('ControllerHost', () => {
  it('makes the slot key for register-host-keys and nothing else', async () => {
    const made: string[] = [];
    const fb = recorder();
    const host = new ControllerHost({ ensure: async (s) => void made.push(s) }, fb.host);
    await host.run(request('register-host-keys'));
    await host.run(request('confirm-register-assignment'));
    expect(made).toEqual(['slot-one']);
    expect(fb.seen.map((r) => r.id)).toEqual(['confirm-register-assignment']);
    await expect(host.run(request('register-host-keys', {}))).rejects.toBeInstanceOf(
      PermanentStepError
    );
  });
});

describe('SshEntryTransport.deploy', () => {
  async function transport(): Promise<SshEntryTransport> {
    const program = work.path('ssh');
    await writeFile(
      program,
      [
        '#!/bin/sh',
        `echo "$*" > ${work.path('args.log')}`,
        `cat > ${work.path('stdin.txt')}`,
        'exit 0',
        '',
      ].join('\n')
    );
    await chmod(program, 0o755);
    return new SshEntryTransport({
      keyFile: '/etc/controller/entry_key',
      knownHostsFile: '/etc/controller/known_hosts',
      sshConfigFile: '/etc/controller/ssh_config',
      jumpHops: [
        { user: 'jumper', host: 'edge1.example.test' },
        { user: 'jumper', host: 'edge-t.example.test' },
      ],
      target: { user: 'tenant-entry', host: 'app1.example.test' },
      sshProgram: program,
    });
  }

  it('runs the slot key against the deploy account through the same hops, image on stdin, no command', async () => {
    const image = `${TENANT_IMAGE}@${DIGEST}`;
    expect(await (await transport()).deploy(KEY_FILE, 'deploy', image)).toBe(0);
    const args = (await readFile(work.path('args.log'), 'utf8')).trim();
    expect(args).toContain(`-i ${KEY_FILE}`);
    expect(args).toContain('-o IdentitiesOnly=yes');
    expect(args).toContain('-J jumper@edge1.example.test,jumper@edge-t.example.test');
    expect(args.endsWith(' deploy@app1.example.test')).toBe(true);
    expect(args).not.toContain('/etc/controller/entry_key');
    expect(await readFile(work.path('stdin.txt'), 'utf8')).toBe(`${image}\n`);
  });

  it('refuses an image that is not one digest-pinned reference, before any process starts', async () => {
    const t = await transport();
    for (const bad of [
      'img:latest',
      `x@sha256:${'a'.repeat(63)}`,
      `${TENANT_IMAGE}@${DIGEST}\nx`,
    ]) {
      await expect(t.deploy(KEY_FILE, 'deploy', bad)).rejects.toBeInstanceOf(PermanentStepError);
    }
    await expect(
      t.deploy('relative.key', 'deploy', `${TENANT_IMAGE}@${DIGEST}`)
    ).rejects.toBeInstanceOf(PermanentStepError);
    await expect(readFile(work.path('args.log'), 'utf8')).rejects.toThrow();
  });
});
