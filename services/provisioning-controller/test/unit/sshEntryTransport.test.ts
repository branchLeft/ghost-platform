import { spawnSync } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PermanentStepError } from '../../src/errors.js';
import {
  hopConfigProblems,
  SSH_ENTRY_VERBS,
  SshEntryTransport,
  SshTransportError,
  SshTransportRefusedError,
  type SshEndpoint,
  type SshEntryConfig,
  type SshEntryReply,
} from '../../src/sshEntryTransport.js';

/**
 * The port as the host adapter declares it (`EntryTransport` in the tenant entry host adapter),
 * copied here so this transport is proved assignable to it; the adapter's own file is not on this
 * branch. Replace the copy with an import once the adapter has landed.
 */
interface AdapterEntryTransport {
  send(
    verb: 'status' | 'claim' | 'secrets' | 'stack' | 'enable' | 'key' | 'owner',
    slug: string,
    payload?: Readonly<Record<string, unknown>>
  ): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
}

const HOPS = [
  { user: 'jumper', host: 'edge1.example.test' },
  { user: 'jumper2', host: 'edge-t.example.test', port: 2222 },
];

let dir: string;

/** A fake `ssh` that records what it was given, then runs `body`. It is found on PATH, as the real one is. */
async function fakeSsh(body: string): Promise<void> {
  const script = [
    '#!/bin/sh',
    `D=${dir}`,
    'echo $$ > "$D/pid"',
    'printf "%s\\n" "$@" > "$D/argv"',
    'env > "$D/env"',
    'cat > "$D/stdin"',
    body,
    '',
  ].join('\n');
  const file = join(dir, 'ssh');
  await writeFile(file, script);
  await chmod(file, 0o755);
}

const baseConfig = (): SshEntryConfig => ({
  keyFile: '/etc/controller/entry_key',
  knownHostsFile: '/etc/controller/known_hosts',
  jumpHops: HOPS,
  sshConfigFile: '/etc/controller/ssh_config',
  target: { user: 'tenant-entry', host: 'app1.example.test' },
  timeoutMs: 5000,
});

const transport = (over: Partial<SshEntryConfig> = {}, env?: Record<string, string>) =>
  new SshEntryTransport(
    { ...baseConfig(), ...over },
    env ?? { PATH: `${dir}:${process.env['PATH'] ?? ''}`, HOME: dir }
  );

const argvSeen = async (): Promise<string[]> =>
  (await readFile(join(dir, 'argv'), 'utf8')).split('\n').slice(0, -1);

const spawned = async (): Promise<boolean> =>
  access(join(dir, 'argv')).then(
    () => true,
    () => false
  );

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function pidSeen(): Promise<number> {
  return Number((await readFile(join(dir, 'pid'), 'utf8')).trim());
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pc-ssh-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the argument vector', () => {
  it('is exactly the designed one, through two hops, with no shell', async () => {
    await fakeSsh('exit 0');
    await transport().send('status', 'acme-blog');
    expect(await argvSeen()).toEqual([
      '-F',
      '/etc/controller/ssh_config',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'UserKnownHostsFile=/etc/controller/known_hosts',
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      'LogLevel=ERROR',
      '-o',
      'ConnectTimeout=10',
      '-T',
      '-i',
      '/etc/controller/entry_key',
      '-J',
      'jumper@edge1.example.test,jumper2@edge-t.example.test:2222',
      'tenant-entry@app1.example.test',
      'status',
      'acme-blog',
    ]);
  });

  it('names a port, an ssh config file and a connect timeout only from configuration', async () => {
    await fakeSsh('exit 0');
    await transport({
      jumpHops: [],
      target: { user: 'tenant-entry', host: 'app1.example.test', port: 2200 },
      sshConfigFile: '/etc/controller/ssh_config',
      connectTimeoutSeconds: 4,
    }).send('claim', 'acme-blog');
    const argv = await argvSeen();
    expect(argv.slice(0, 2)).toEqual(['-F', '/etc/controller/ssh_config']);
    expect(argv).toContain('ConnectTimeout=4');
    expect(argv.slice(-5)).toEqual([
      '-p',
      '2200',
      'tenant-entry@app1.example.test',
      'claim',
      'acme-blog',
    ]);
    expect(argv).not.toContain('-J');
  });

  it('always carries BatchMode and StrictHostKeyChecking, for every verb', async () => {
    await fakeSsh('exit 0');
    for (const verb of SSH_ENTRY_VERBS) {
      await transport().send(verb, 'acme-blog');
      const argv = await argvSeen();
      expect(argv).toContain('BatchMode=yes');
      expect(argv).toContain('StrictHostKeyChecking=yes');
      expect(argv.filter((a) => /StrictHostKeyChecking|BatchMode/.test(a))).toHaveLength(2);
      expect(argv.slice(-2)).toEqual([verb, 'acme-blog']);
    }
  });

  it('puts nothing of the payload on the command line', async () => {
    await fakeSsh('exit 0');
    await transport().send('key', 'acme-blog', { public_key: 'ssh-ed25519 AAAA keyFile=/x' });
    expect((await argvSeen()).join('\n')).not.toContain('AAAA');
  });

  it('is accepted by the real ssh client: -G reads every option back', async () => {
    const ssh = spawnSync('ssh', ['-V']);
    if (ssh.error !== undefined) return; // no ssh client on this machine
    const config = join(dir, 'ssh_config');
    await writeFile(config, '');
    const t = transport({ sshConfigFile: config }, { PATH: process.env['PATH'] ?? '' });
    const shown = spawnSync('ssh', ['-G', ...t.argvFor('status', 'acme-blog')], {
      encoding: 'utf8',
    });
    expect(shown.status).toBe(0);
    const lines = new Set(shown.stdout.split('\n'));
    expect(lines).toContain('stricthostkeychecking true');
    expect(lines).toContain('batchmode yes');
    expect(lines).toContain('userknownhostsfile /etc/controller/known_hosts');
    expect(lines).toContain('hostname app1.example.test');
    expect(lines).toContain('user tenant-entry');
    expect(lines).toContain('proxyjump jumper@edge1.example.test,jumper2@edge-t.example.test:2222');
  });
});

describe('what is refused before a process is started', () => {
  const badSlugs = [
    '',
    'a;rm -rf /',
    '$(id)',
    '`id`',
    'a b',
    'a|b',
    'a&b',
    'a>b',
    "a'b",
    'a"b',
    'a\nb',
    'a\\b',
    '-oProxyCommand=x',
    '--help',
    '.hidden',
    'x'.repeat(129),
  ];

  it.each(badSlugs)('refuses the slug %j', async (slug) => {
    await fakeSsh('exit 0');
    const error: unknown = await transport()
      .send('status', slug)
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(error).toBeInstanceOf(SshTransportRefusedError);
    expect(error).toBeInstanceOf(PermanentStepError);
    expect((error as SshTransportRefusedError).failure).toBe('invalid-request');
    expect(await spawned()).toBe(false);
  });

  it.each(['', 'STATUS', 'status; id', 'shell', 'status acme', '-oProxyCommand=x', '__proto__'])(
    'refuses the verb %j',
    async (verb) => {
      await fakeSsh('exit 0');
      await expect(transport().send(verb, 'acme-blog')).rejects.toBeInstanceOf(
        SshTransportRefusedError
      );
      expect(await spawned()).toBe(false);
    }
  );

  it('refuses a payload that is not one JSON object, or is too large', async () => {
    await fakeSsh('exit 0');
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const payloads = [
      [] as unknown as Record<string, unknown>,
      null as unknown as Record<string, unknown>,
      'text' as unknown as Record<string, unknown>,
      circular,
      { big: 'x'.repeat(200) },
    ];
    for (const payload of payloads) {
      await expect(
        transport({ maxPayloadBytes: 100 }).send('stack', 'acme-blog', payload)
      ).rejects.toMatchObject({ failure: 'invalid-request' });
    }
    expect(await spawned()).toBe(false);
  });

  it.each<[string, Partial<SshEntryConfig>]>([
    ['a relative key path', { keyFile: 'entry_key' }],
    ['a key path with a space', { keyFile: '/etc/my key' }],
    ['a key path with an ssh token', { keyFile: '/etc/%d/key' }],
    ['a known-hosts path that climbs', { knownHostsFile: '/etc/../tmp/kh' }],
    ['a known-hosts path with an equals sign', { knownHostsFile: '/etc/a=b' }],
    [
      'a target host that is an option',
      { target: { user: 'tenant-entry', host: '-oProxyCommand=x' } },
    ],
    [
      'a target user with a shell character',
      { target: { user: 'root;id', host: 'app1.example.test' } },
    ],
    [
      'a target port out of range',
      { target: { user: 'tenant-entry', host: 'a.example.test', port: 70000 } },
    ],
    ['hops and no ssh config file', { sshConfigFile: undefined }],
    ['no jumpHops list', { jumpHops: undefined as unknown as SshEntryConfig['jumpHops'] }],
    ['no target', { target: undefined as unknown as SshEntryConfig['target'] }],
    ['a hop that is not an object', { jumpHops: [null as unknown as SshEndpoint] }],
    ['a hop that is an option', { jumpHops: [{ user: 'j', host: '-J' }] }],
    ['a hop host with a comma', { jumpHops: [{ user: 'j', host: 'a,b' }] }],
    ['a program that is a relative path', { sshProgram: './ssh' }],
    ['a timeout of zero', { timeoutMs: 0 }],
    ['an output bound of zero', { maxOutputBytes: 0 }],
  ])('refuses a configuration with %s', (_name, over) => {
    expect(() => transport(over)).toThrow(SshTransportRefusedError);
    expect(() => transport(over)).toThrow(/unusable/);
  });
});

describe('the standard input and the child', () => {
  it('sends the payload as one JSON object, and nothing when there is none', async () => {
    await fakeSsh('exit 0');
    await transport().send('secrets', 'acme-blog', { template: 't', values: { A: 'b' } });
    expect(JSON.parse(await readFile(join(dir, 'stdin'), 'utf8'))).toEqual({
      template: 't',
      values: { A: 'b' },
    });
    await transport().send('status', 'acme-blog');
    expect(await readFile(join(dir, 'stdin'), 'utf8')).toBe('');
  });

  it('hands the client only PATH, HOME and LANG: no token, no agent socket', async () => {
    await fakeSsh('exit 0');
    const t = transport(
      {},
      {
        PATH: `${dir}:${process.env['PATH'] ?? ''}`,
        HOME: dir,
        GITHUB_TOKEN: 'ghs_secret',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
      }
    );
    await t.send('status', 'acme-blog');
    const seen = await readFile(join(dir, 'env'), 'utf8');
    expect(seen).not.toContain('ghs_secret');
    expect(seen).not.toContain('SSH_AUTH_SOCK');
  });

  it('survives a client that exits without reading its input', async () => {
    const script = ['#!/bin/sh', 'exit 0', ''].join('\n');
    await writeFile(join(dir, 'ssh'), script);
    await chmod(join(dir, 'ssh'), 0o755);
    const reply = await transport().send('stack', 'acme-blog', { blob: 'x'.repeat(500_000) });
    expect(reply.code).toBe(0);
  });
});

describe('the timeout and the output bound', () => {
  it('kills the child when the call takes too long, with a retryable error', async () => {
    await fakeSsh('exec sleep 30');
    const started = Date.now();
    const error: unknown = await transport({ timeoutMs: 300 })
      .send('status', 'acme-blog')
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(error).toBeInstanceOf(SshTransportError);
    expect(error).not.toBeInstanceOf(PermanentStepError);
    expect((error as SshTransportError).failure).toBe('timeout');
    const pid = await pidSeen();
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(pid)).toBe(false);
  });

  it('refuses output over the bound and kills the child, even one that never stops', async () => {
    await fakeSsh('exec yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const error: unknown = await transport({ maxOutputBytes: 1000 })
      .send('status', 'acme-blog')
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(error).toBeInstanceOf(SshTransportRefusedError);
    expect((error as SshTransportRefusedError).failure).toBe('output-too-large');
    const pid = await pidSeen();
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(pid)).toBe(false);
  });

  it('bounds standard error as well', async () => {
    await fakeSsh(
      'yes bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb | head -c 50000 >&2; exit 1'
    );
    await expect(
      transport({ maxOutputBytes: 1000 }).send('status', 'acme-blog')
    ).rejects.toMatchObject({ failure: 'output-too-large' });
  });

  it('returns output that is exactly at the bound', async () => {
    await fakeSsh('printf "%01000d" 0');
    const reply = await transport({ maxOutputBytes: 1000 }).send('status', 'acme-blog');
    expect(reply.stdout).toHaveLength(1000);
  });
});

describe('the exit code', () => {
  it.each([0, 1, 2, 3, 4, 7, 127])(
    'hands the host program its own exit code %i, with both streams, for the adapter to map',
    async (code) => {
      await fakeSsh(`echo "out $?"; echo "refused: no-room" >&2; exit ${String(code)}`);
      const reply: SshEntryReply = await transport().send('claim', 'acme-blog');
      expect(reply.code).toBe(code);
      expect(reply.stdout).toBe('out 0\n');
      expect(reply.stderr).toBe('refused: no-room\n');
    }
  );

  it('maps ssh exit 255 with a host-key failure to a permanent error that quotes nothing', async () => {
    await fakeSsh('echo "Host key verification failed." >&2; exit 255');
    const error: unknown = await transport()
      .send('status', 'acme-blog')
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(error).toBeInstanceOf(SshTransportRefusedError);
    expect(error).toBeInstanceOf(PermanentStepError);
    expect((error as SshTransportRefusedError).failure).toBe('host-key');
    expect((error as Error).message).not.toContain('verification failed');
  });

  it('maps a changed host key to the same permanent error', async () => {
    await fakeSsh('echo "@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @" >&2; exit 255');
    await expect(transport().send('status', 'acme-blog')).rejects.toMatchObject({
      failure: 'host-key',
    });
  });

  it('maps ssh exit 255 otherwise to a retryable connection error that quotes nothing', async () => {
    await fakeSsh(
      'echo "ssh: connect to host app1 port 22: Connection refused SECRETWORD" >&2; exit 255'
    );
    const error: unknown = await transport()
      .send('status', 'acme-blog')
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(error).toBeInstanceOf(SshTransportError);
    expect(error).not.toBeInstanceOf(PermanentStepError);
    expect((error as SshTransportError).failure).toBe('connection');
    expect((error as Error).message).not.toContain('SECRETWORD');
  });

  it('maps a client ended by a signal to a retryable error', async () => {
    await fakeSsh('kill -9 $$');
    await expect(transport().send('status', 'acme-blog')).rejects.toMatchObject({
      failure: 'signal',
    });
  });

  it('maps a client that cannot be started to a permanent error, and never reaches for a shell', async () => {
    await expect(
      transport({}, { PATH: join(dir, 'nowhere'), HOME: dir }).send('status', 'acme-blog')
    ).rejects.toMatchObject({ failure: 'not-startable', name: 'SshTransportRefusedError' });
    await expect(
      transport({ sshProgram: join(dir, 'absent') }).send('status', 'acme-blog')
    ).rejects.toBeInstanceOf(PermanentStepError);
  });
});

describe('the hops through the real ssh client', () => {
  const hasSsh = spawnSync('ssh', ['-V']).error === undefined;
  const GOOD = [
    'Host edge1.example.test edge-t.example.test',
    '  StrictHostKeyChecking yes',
    '  BatchMode yes',
    '  UserKnownHostsFile /etc/controller/known_hosts',
    '  GlobalKnownHostsFile /dev/null',
    '  IdentitiesOnly yes',
    '  IdentityFile /etc/controller/entry_key',
    '',
  ];

  async function problemsWith(lines: string[]): Promise<string[]> {
    const file = join(dir, 'hop_config');
    await writeFile(file, lines.join('\n'));
    await chmod(file, 0o600);
    const env = { PATH: process.env['PATH'] ?? '', HOME: dir };
    return hopConfigProblems({ ...baseConfig(), sshConfigFile: file }, env);
  }

  it.skipIf(!hasSsh)('finds a stanza that pins every setting complete, for each hop', async () => {
    expect(await problemsWith(GOOD)).toEqual([]);
  });

  it.skipIf(!hasSsh)('names a hop the stanza does not cover at all', async () => {
    const problems = await problemsWith(
      GOOD.map((l) => l.replace('edge-t.example.test', 'other.example.test'))
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.startsWith('jumpHops[1]'))).toBe(true);
  });

  it.skipIf(!hasSsh).each([
    ['StrictHostKeyChecking yes', 'StrictHostKeyChecking is not yes'],
    ['BatchMode yes', 'BatchMode is not yes'],
    ['UserKnownHostsFile /etc/controller/known_hosts', 'UserKnownHostsFile is not the pinned'],
    ['GlobalKnownHostsFile /dev/null', 'GlobalKnownHostsFile is not switched off'],
    ['IdentitiesOnly yes', 'IdentitiesOnly is not yes'],
    ['IdentityFile /etc/controller/entry_key', 'IdentityFile is not the key'],
  ])('reports a stanza with %s missing', async (setting, expected) => {
    const problems = await problemsWith(GOOD.filter((l) => l.trim() !== setting));
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('jumpHops[0]');
    expect(problems[1]).toContain('jumpHops[1]');
    expect(problems.every((p) => p.includes(expected))).toBe(true);
  });

  it.skipIf(!hasSsh)('reports a stanza that points at another known-hosts file', async () => {
    const problems = await problemsWith(
      GOOD.map((l) => l.replace('/etc/controller/known_hosts', '/etc/other/known_hosts'))
    );
    expect(problems.some((p) => p.includes('UserKnownHostsFile'))).toBe(true);
  });

  it('reports a configuration ssh cannot read, and an unusable one', async () => {
    const env = { PATH: `${dir}:/usr/bin:/bin`, HOME: dir };
    await writeFile(join(dir, 'ssh'), '#!/bin/sh\nexit 255\n');
    await chmod(join(dir, 'ssh'), 0o755);
    expect(await hopConfigProblems(baseConfig(), env)).toEqual([
      'jumpHops[0]: ssh could not read the configuration',
      'jumpHops[1]: ssh could not read the configuration',
    ]);
    expect(await hopConfigProblems({ ...baseConfig(), sshConfigFile: undefined }, env)).toEqual([
      'invalid setting sshConfigFile (required with jumpHops)',
    ]);
  });
});

describe('the port', () => {
  it('is assignable to the host adapter transport', async () => {
    await fakeSsh('echo done');
    const port: AdapterEntryTransport = transport();
    const reply = await port.send('status', 'acme-blog');
    expect(reply).toEqual({ code: 0, stdout: 'done\n', stderr: '' });
  });
});
