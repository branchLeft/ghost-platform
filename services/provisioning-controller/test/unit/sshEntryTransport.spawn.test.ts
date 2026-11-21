import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnCalls: { program: unknown; args: unknown; options: unknown }[] = [];

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: ((program: string, args: string[], options: object) => {
      spawnCalls.push({ program, args, options });
      return real.spawn(program, args, options);
    }) as typeof real.spawn,
  };
});

const { SshEntryTransport } = await import('../../src/sshEntryTransport.js');

let dir: string;

beforeEach(async () => {
  spawnCalls.length = 0;
  dir = await mkdtemp(join(tmpdir(), 'pc-ssh-spawn-'));
  await writeFile(join(dir, 'ssh'), '#!/bin/sh\ncat > /dev/null\nexit 0\n');
  await chmod(join(dir, 'ssh'), 0o755);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('how the client is started', () => {
  it('is one spawn with an argument array and no shell, never a command string', async () => {
    const transport = new SshEntryTransport(
      {
        keyFile: '/etc/controller/entry_key',
        knownHostsFile: '/etc/controller/known_hosts',
        sshConfigFile: '/etc/controller/ssh_config',
        jumpHops: [{ user: 'jumper', host: 'edge1.example.test' }],
        target: { user: 'tenant-entry', host: 'app1.example.test' },
      },
      { PATH: `${dir}:/usr/bin:/bin`, HOME: dir }
    );
    await transport.send('status', 'acme-blog');
    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0];
    expect(call?.program).toBe('ssh');
    expect(Array.isArray(call?.args)).toBe(true);
    expect((call?.options as { shell?: unknown }).shell).toBe(false);
  });
});
