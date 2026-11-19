import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CleanupRegistry } from '../../src/cleanup.js';
import { writeFakeDocker } from '../helpers/fakeDocker.js';
import {
  assertDockerEngineAtLeast28,
  DOCKER_VERSION_TIMEOUT_MS,
  DockerEngineTooOldError,
  startup,
  buildDockerRunArgs,
  buildDockerStopArgs,
  buildDockerInspectEnvArgs,
  buildRelayRunArgs,
  RELAY_SCRIPT,
  createDockerContainerRunner,
  parseInspectedEnv,
  type TenantColourTemplate,
  type TenantColourSpec,
} from '../../src/containerRunner.js';

describe('buildDockerRunArgs', () => {
  const spec: TenantColourSpec = {
    containerName: 'tenant-1-export-123',
    image: 'ghost-platform:ci',
    loopbackPort: 4400,
    envFile: '/tmp/export-bundler-env-x/tenant.env',
    user: '1001:1001',
    volumes: [{ volume: 'ghost-tenant-1-content', mountPath: '/var/lib/ghost/content' }],
    network: null,
  };

  it("joins the run's own network when given one, and no network flag otherwise", () => {
    expect(buildDockerRunArgs(spec)).not.toContain('--network');
    const args = buildDockerRunArgs({ ...spec, network: 'tenant-1-export-123-net' });
    expect(args[args.indexOf('--network') + 1]).toBe('tenant-1-export-123-net');
  });

  it('publishes only on 127.0.0.1 -- LLD-8 §08b\'s "no route pointed at it"', () => {
    const args = buildDockerRunArgs(spec);
    const idx = args.indexOf('-p');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('127.0.0.1:4400:2368');
    // Never a bare port mapping and never 0.0.0.0 -- both would publish on
    // every interface, which is exactly the "route pointed at it" this
    // colour must not have.
    expect(args).not.toContain('4400:2368');
    expect(args.join(' ')).not.toContain('0.0.0.0');
  });

  it('passes the environment only as an --env-file, never as -e values in argv', () => {
    const args = buildDockerRunArgs(spec);
    expect(args).not.toContain('-e');
    expect(args).not.toContain('--env');
    expect(args[args.indexOf('--env-file') + 1]).toBe('/tmp/export-bundler-env-x/tenant.env');
  });

  it("runs as the tenant's own user from its rendered stack", () => {
    const args = buildDockerRunArgs(spec);
    expect(args[args.indexOf('--user') + 1]).toBe('1001:1001');
    expect(buildDockerRunArgs({ ...spec, user: null })).not.toContain('--user');
  });

  it('keeps a read-only mount read-only', () => {
    const args = buildDockerRunArgs({
      ...spec,
      volumes: [
        {
          volume: 'ghost-tenant-1-adapters',
          mountPath: '/var/lib/ghost/content/adapters',
          readOnly: true,
        },
      ],
    });
    expect(args[args.indexOf('--mount') + 1]).toBe(
      'type=volume,src=ghost-tenant-1-adapters,dst=/var/lib/ghost/content/adapters,readonly'
    );
  });

  it("mounts the tenant's own data volume, never a fresh one", () => {
    const args = buildDockerRunArgs(spec);
    const idx = args.indexOf('--mount');
    expect(args[idx + 1]).toBe('type=volume,src=ghost-tenant-1-content,dst=/var/lib/ghost/content');
  });

  it('carries the container name so stop() can target exactly this run', () => {
    const args = buildDockerRunArgs(spec);
    const idx = args.indexOf('--name');
    expect(args[idx + 1]).toBe('tenant-1-export-123');
  });

  it("never runs through a shell -- every value is its own argv element, matching wrapper.ts's own sudoers-boundary reasoning", () => {
    const args = buildDockerRunArgs(spec);
    for (const arg of args) {
      expect(arg).not.toMatch(/[;&|`$]/);
    }
  });
});

describe('buildDockerStopArgs', () => {
  it('force-removes exactly the named container', () => {
    expect(buildDockerStopArgs('tenant-1-export-123')).toEqual(['rm', '-f', 'tenant-1-export-123']);
  });
});

describe('createDockerContainerRunner', () => {
  const template: TenantColourTemplate = {
    containerName: 'tenant-1-export-123',
    image: 'ghost-platform:ci',
    loopbackPort: 4400,
    user: '1001:1001',
    volumes: [{ volume: 'ghost-tenant-1-content', mountPath: '/var/lib/ghost/content' }],
    network: null,
  };
  const env = { url: 'https://tenant.example', database__connection__password: 'synthetic-secret' };
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-container-runner-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Logs argv as JSON, and copies whatever --env-file names, while it still exists. */
  async function writeEnvCapturingDocker(): Promise<{
    path: string;
    argvLog: string;
    envCopy: string;
  }> {
    const argvLog = join(dir, 'argv.log');
    const envCopy = join(dir, 'env-copy');
    const path = await writeFakeDocker(dir, { argvLogPath: argvLog });
    const script = await readFile(path, 'utf8');
    await writeFile(
      path,
      script.replace(
        'exit 0',
        [
          'prev=""',
          'for a in "$@"; do',
          `  if [ "$prev" = "--env-file" ]; then cp "$a" '${envCopy}'; fi`,
          '  prev="$a"',
          'done',
          'exit 0',
        ].join('\n')
      )
    );
    return { path, argvLog, envCopy };
  }

  it('start(env) runs exactly buildDockerRunArgs, with env handed over only as a file that is gone afterwards', async () => {
    const fake = await writeEnvCapturingDocker();
    const registry = new CleanupRegistry();
    const runner = createDockerContainerRunner(template, fake.path, registry);

    const result = await runner.start(env);

    expect(result.baseUrl).toBe('http://127.0.0.1:4400');
    const logged: string[] = JSON.parse((await readFile(fake.argvLog, 'utf8')).trim());
    const envFile = logged[logged.indexOf('--env-file') + 1]!;
    expect(logged).toEqual(buildDockerRunArgs({ ...template, envFile }));
    expect(logged.join(' ')).not.toContain('synthetic-secret');
    expect(await readFile(fake.envCopy, 'utf8')).toBe(
      'url=https://tenant.example\ndatabase__connection__password=synthetic-secret\n'
    );
    await expect(readFile(envFile)).rejects.toThrow(/ENOENT/);
    expect(registry.labels).toEqual(['export colour tenant-1-export-123']);
  });

  it("start(env, attach) puts the colour on the copy's internal network, unpublished, and reaches it through a loopback relay", async () => {
    const fake = await writeEnvCapturingDocker();
    const registry = new CleanupRegistry();
    const runner = createDockerContainerRunner(template, fake.path, registry);
    await runner.start(env, {
      network: 'tenant-1-export-123-net',
      volumes: [{ volume: 'tenant-1-export-123-data', mountPath: '/var/lib/ghost/export-scratch' }],
    });
    const calls: string[][] = (await readFile(fake.argvLog, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const colour = calls[0]!;
    expect(colour[colour.indexOf('--network') + 1]).toBe('tenant-1-export-123-net');
    expect(colour).not.toContain('-p');
    expect(colour).toContain('type=volume,src=ghost-tenant-1-content,dst=/var/lib/ghost/content');
    expect(colour).toContain(
      'type=volume,src=tenant-1-export-123-data,dst=/var/lib/ghost/export-scratch'
    );
    expect(calls.slice(1)).toEqual([
      ['network', 'create', 'tenant-1-export-123-edge'],
      [...buildRelayRunArgs({ ...template, network: 'tenant-1-export-123-net' })],
      ['network', 'connect', 'tenant-1-export-123-net', 'tenant-1-export-123-relay'],
    ]);
    expect(registry.labels).toEqual(['export colour tenant-1-export-123']);

    await runner.stop();
    const after: string[][] = (await readFile(fake.argvLog, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(after.slice(4)).toEqual([
      ['rm', '-f', 'tenant-1-export-123-relay'],
      ['network', 'rm', 'tenant-1-export-123-edge'],
      ['rm', '-f', 'tenant-1-export-123'],
    ]);
    expect(registry.labels).toEqual([]);
  });

  it('the relay publishes on loopback only, carries no env or volume, and forwards to the colour by name', () => {
    const args = buildRelayRunArgs({ ...template, network: 'n' });
    expect(args[args.indexOf('-p') + 1]).toBe('127.0.0.1:4400:2368');
    expect(args[args.indexOf('--network') + 1]).toBe('tenant-1-export-123-edge');
    expect(args).not.toContain('--env-file');
    expect(args).not.toContain('--mount');
    expect(args).toContain('--read-only');
    expect(args.slice(-3)).toEqual(['-e', RELAY_SCRIPT, 'tenant-1-export-123']);
    expect(RELAY_SCRIPT).toContain('net.connect(2368,target)');
  });

  it('the relay is started with no-new-privileges, a pids limit and a memory limit', () => {
    const args = buildRelayRunArgs({ ...template, network: 'n' });
    const imageIndex = args.indexOf(template.image);
    expect(args).toContain('--security-opt');
    expect(args[args.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
    expect(args.indexOf('--security-opt')).toBeLessThan(imageIndex);
    expect(args).toContain('--pids-limit');
    expect(args[args.indexOf('--pids-limit') + 1]).toBe('64');
    expect(args.indexOf('--pids-limit')).toBeLessThan(imageIndex);
    expect(args).toContain('--memory');
    expect(args[args.indexOf('--memory') + 1]).toBe('128m');
    expect(args.indexOf('--memory')).toBeLessThan(imageIndex);
  });

  it('removes a colour that was created but failed to start, and takes it off the registry', async () => {
    const argvLogPath = join(dir, 'argv.log');
    const fakeDocker = await writeFakeDocker(dir, { argvLogPath });
    // Log every call, then fail only `docker run`, as a port clash would.
    const script = await readFile(fakeDocker, 'utf8');
    await writeFile(
      fakeDocker,
      script.replace(
        'exit 0',
        'if [ "$1" = "run" ]; then echo "port is already allocated" >&2; exit 125; fi\nexit 0'
      )
    );
    const registry = new CleanupRegistry();
    const runner = createDockerContainerRunner(template, fakeDocker, registry);
    await expect(runner.start(env)).rejects.toThrow(/port is already allocated/);
    const calls = (await readFile(argvLogPath, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(calls[calls.length - 1]).toEqual(['rm', '-f', 'tenant-1-export-123']);
    expect(registry.labels).toEqual([]);
  });

  it('removes the colour and the relay when the relay fails to start', async () => {
    const argvLogPath = join(dir, 'argv.log');
    const fakeDocker = await writeFakeDocker(dir, { argvLogPath });
    const script = await readFile(fakeDocker, 'utf8');
    await writeFile(
      fakeDocker,
      script.replace(
        'exit 0',
        'case "$*" in *-relay*--network*|*--name\\ tenant-1-export-123-relay*) exit 125 ;; esac\nexit 0'
      )
    );
    const registry = new CleanupRegistry();
    await expect(
      createDockerContainerRunner(template, fakeDocker, registry).start(env, {
        network: 'tenant-1-export-123-net',
        volumes: [],
      })
    ).rejects.toThrow(/docker run failed/);
    const calls = (await readFile(argvLogPath, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(calls.slice(-3)).toEqual([
      ['rm', '-f', 'tenant-1-export-123'],
      ['rm', '-f', 'tenant-1-export-123-relay'],
      ['network', 'rm', 'tenant-1-export-123-edge'],
    ]);
    expect(registry.labels).toEqual([]);
  });

  it('stop() execs exactly buildDockerStopArgs and takes the colour off the cleanup registry', async () => {
    const argvLogPath = join(dir, 'argv.log');
    const fakeDocker = await writeFakeDocker(dir, { argvLogPath });
    const registry = new CleanupRegistry();
    const runner = createDockerContainerRunner(template, fakeDocker, registry);
    await runner.start(env);
    await runner.stop();
    const lines = (await readFile(argvLogPath, 'utf8')).trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1]!)).toEqual(
      buildDockerStopArgs(template.containerName)
    );
    expect(registry.labels).toEqual([]);
  });

  it("a signal's cleanup removes a started colour synchronously", async () => {
    const argvLogPath = join(dir, 'argv.log');
    const fakeDocker = await writeFakeDocker(dir, { argvLogPath });
    const registry = new CleanupRegistry();
    await createDockerContainerRunner(template, fakeDocker, registry).start(env);
    expect(registry.runAll()).toEqual([]);
    const lines = (await readFile(argvLogPath, 'utf8')).trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1]!)).toEqual(['rm', '-f', 'tenant-1-export-123']);
  });

  it('readEnv() returns the environment Docker reports for the running colour', async () => {
    const path = join(dir, 'fake-inspect.sh');
    await writeFile(
      path,
      `#!/bin/sh\necho '["database__connection__host=tenant-1-export-123-db","url=https://x.test/a=b","NOEQUALS"]'\n`
    );
    await chmod(path, 0o755);
    const runner = createDockerContainerRunner(template, path, new CleanupRegistry());
    expect(await runner.readEnv()).toEqual({
      database__connection__host: 'tenant-1-export-123-db',
      url: 'https://x.test/a=b',
    });
    expect(buildDockerInspectEnvArgs('c')).toEqual([
      'inspect',
      '--format',
      '{{json .Config.Env}}',
      'c',
    ]);
  });

  it('parseInspectedEnv refuses something that is not an env list', () => {
    expect(() => parseInspectedEnv('{"a":1}')).toThrow(/not return an env list/);
    expect(parseInspectedEnv('["a=1", 2]')).toEqual({ a: '1' });
  });

  it('start() rejects, carrying stderr and the exit code, never the argv', async () => {
    const fakeDocker = await writeFakeDocker(dir, { fail: true });
    const err = await createDockerContainerRunner(template, fakeDocker, new CleanupRegistry())
      .start(env)
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).toMatch(/forced failure/);
    expect((err as Error).message).toContain('(exit 1)');
    expect((err as Error).message).not.toContain('--env-file');
  });

  it('stop() rejects, carrying stderr, when docker fails -- never swallowed', async () => {
    const fakeDocker = await writeFakeDocker(dir, { fail: true });
    const runner = createDockerContainerRunner(template, fakeDocker, new CleanupRegistry());
    await expect(runner.stop()).rejects.toThrow(/forced failure/);
  });

  it("never lets the ambient environment reach the docker child process -- a synthetic marker set on this process does not appear in the child's", async () => {
    const envProbeLogPath = join(dir, 'env-probe.log');
    const fakeDocker = await writeFakeDocker(dir, {
      envProbeLogPath,
      envProbeVar: 'EXPORT_BUNDLER_TEST_ENV_PROBE',
    });
    process.env.EXPORT_BUNDLER_TEST_ENV_PROBE = 'must-not-leak';
    try {
      await createDockerContainerRunner(template, fakeDocker, new CleanupRegistry()).start(env);
      expect((await readFile(envProbeLogPath, 'utf8')).trim()).toBe('absent');
    } finally {
      delete process.env.EXPORT_BUNDLER_TEST_ENV_PROBE;
    }
  });

  it('falls back to an empty PATH when this process has none', async () => {
    const saved = process.env.PATH;
    delete process.env.PATH;
    try {
      await expect(
        createDockerContainerRunner(template, 'docker', new CleanupRegistry()).stop()
      ).rejects.toThrow(/docker rm failed/);
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe('assertDockerEngineAtLeast28', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-engine-gate-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the engine version with docker version --format {{.Server.Version}}, and nothing else', async () => {
    const argvLog = join(dir, 'argv.log');
    const fake = await writeFakeDocker(dir, { argvLogPath: argvLog, versionOutput: '29.9.2' });
    await expect(assertDockerEngineAtLeast28(fake, new CleanupRegistry())).resolves.toBe('29.9.2');
    expect((await readFile(argvLog, 'utf8')).trim().split('\n')).toEqual([
      '["version","--format","{{.Server.Version}}"]',
    ]);
  });

  it.each(['28.0.0', '29.9.2', '100.0.1', '28.0', '28.1.0-rc.1', '29.0.0+dfsg'])(
    'accepts engine %s',
    async (version) => {
      const fake = await writeFakeDocker(dir, { versionOutput: version });
      await expect(assertDockerEngineAtLeast28(fake, new CleanupRegistry())).resolves.toBe(version);
    }
  );

  it.each(['27.9.9', '27.5.1', '20.10.24', '1.0.0'])(
    'refuses engine %s, naming the version seen and the floor',
    async (version) => {
      const fake = await writeFakeDocker(dir, { versionOutput: version });
      const err = await assertDockerEngineAtLeast28(fake, new CleanupRegistry()).catch(
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(DockerEngineTooOldError);
      expect((err as Error).message).toContain(version);
      expect((err as Error).message).toContain('28');
    }
  );

  it.each(['', 'not a version', 'v29.0.0', '29', '29.x.1', '29.0.0\n28.0.0', '<no value>'])(
    'fails closed on output that is not a version: %j',
    async (output) => {
      const fake = await writeFakeDocker(dir, { versionOutput: output });
      await expect(assertDockerEngineAtLeast28(fake, new CleanupRegistry())).rejects.toThrow(
        DockerEngineTooOldError
      );
    }
  );

  it('fails closed when docker exits non-zero', async () => {
    const fake = await writeFakeDocker(dir, { fail: true });
    await expect(assertDockerEngineAtLeast28(fake, new CleanupRegistry())).rejects.toThrow(
      DockerEngineTooOldError
    );
  });

  it('fails closed when the docker binary is missing', async () => {
    await expect(
      assertDockerEngineAtLeast28(join(dir, 'no-such-docker'), new CleanupRegistry())
    ).rejects.toThrow(DockerEngineTooOldError);
  });

  it('gives up on a docker that never answers, instead of hanging, and says it timed out', async () => {
    const fake = join(dir, 'hung-docker.sh');
    // exec: the shell is replaced, so the kill reaches the process holding the pipes.
    await writeFile(fake, '#!/bin/sh\nexec sleep 30\n');
    await chmod(fake, 0o755);
    const started = Date.now();
    const err = await assertDockerEngineAtLeast28(fake, new CleanupRegistry(), 300).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(DockerEngineTooOldError);
    expect((err as Error).message).toContain('timed out after 300 ms');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('has a default timeout, so startup() cannot wait forever on a hung daemon', () => {
    expect(DOCKER_VERSION_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DOCKER_VERSION_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });
});

describe('startup', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-startup-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('installs the signal handlers before it checks the engine', async () => {
    // The fake reports a 29 engine only if the handlers were already installed
    // when `docker version` ran, and a 1.0.0 engine (refused) if not.
    const marker = join(dir, 'handlers-installed');
    const fake = join(dir, 'fake-docker.sh');
    await writeFile(
      fake,
      ['#!/bin/sh', `if [ -f '${marker}' ]; then echo 29.9.2; else echo 1.0.0; fi`, 'exit 0'].join(
        '\n'
      ) + '\n'
    );
    await chmod(fake, 0o755);
    const target = new EventEmitter();
    const on = target.on.bind(target);
    target.on = ((signal: string, handler: () => void) => {
      writeFileSync(marker, 'x');
      return on(signal, handler);
    }) as typeof target.on;

    const uninstall = await startup({
      dockerCommand: fake,
      registry: new CleanupRegistry(),
      signalTarget: target as never,
    });

    expect(target.listenerCount('SIGINT')).toBe(1);
    expect(target.listenerCount('SIGTERM')).toBe(1);
    uninstall();
    expect(target.listenerCount('SIGINT')).toBe(0);
  });

  it('leaves no signal handler behind when the engine is refused', async () => {
    const fake = await writeFakeDocker(dir, { versionOutput: '27.5.1' });
    const target = new EventEmitter();
    await expect(
      startup({
        dockerCommand: fake,
        registry: new CleanupRegistry(),
        signalTarget: target as never,
      })
    ).rejects.toThrow(DockerEngineTooOldError);
    expect(target.listenerCount('SIGINT')).toBe(0);
    expect(target.listenerCount('SIGTERM')).toBe(0);
  });
});
