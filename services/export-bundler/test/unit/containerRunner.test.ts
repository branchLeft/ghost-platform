import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDockerRunArgs,
  buildDockerStopArgs,
  createDockerContainerRunner,
  type TenantColourSpec,
} from '../../src/containerRunner.js';

/**
 * A stand-in for the real `docker` binary, written fresh per test with its
 * output paths baked into the script text rather than read from the
 * environment -- run()'s own `{ env: { PATH } }` deliberately replaces the
 * ambient environment for this child (see containerRunner.ts's comment),
 * so a fixture that needed an env var to know where to log would break
 * for the same reason it is safe. Mirrors
 * services/broker/test/helpers/fakeWrapper.mjs's role, adapted for a
 * child that gets no env at all.
 */
async function writeFakeDocker(
  dir: string,
  opts: { fail?: boolean; argvLogPath?: string; envProbeLogPath?: string; envProbeVar?: string }
): Promise<string> {
  const scriptPath = join(dir, 'fake-docker.sh');
  const lines = ['#!/bin/sh'];
  if (opts.fail) {
    lines.push('echo "fake docker: forced failure" >&2', 'exit 1');
  } else {
    if (opts.argvLogPath) {
      lines.push(
        `printf '[' >> '${opts.argvLogPath}'`,
        'first=1',
        'for arg in "$@"; do',
        `  if [ "$first" = 1 ]; then first=0; else printf ',' >> '${opts.argvLogPath}'; fi`,
        `  printf '"%s"' "$arg" >> '${opts.argvLogPath}'`,
        'done',
        `printf ']\\n' >> '${opts.argvLogPath}'`
      );
    }
    if (opts.envProbeLogPath && opts.envProbeVar) {
      lines.push(
        `if [ -n "$${opts.envProbeVar}" ]; then echo present > '${opts.envProbeLogPath}'; else echo absent > '${opts.envProbeLogPath}'; fi`
      );
    }
    lines.push('exit 0');
  }
  await writeFile(scriptPath, lines.join('\n') + '\n');
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

describe('buildDockerRunArgs', () => {
  const spec: TenantColourSpec = {
    containerName: 'tenant-1-export-123',
    image: 'ghost-platform:ci',
    loopbackPort: 4400,
    env: { database__client: 'sqlite3' },
    volumes: [{ volume: 'ghost-tenant-1-content', mountPath: '/var/lib/ghost/content' }],
  };

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
  const spec: TenantColourSpec = {
    containerName: 'tenant-1-export-123',
    image: 'ghost-platform:ci',
    loopbackPort: 4400,
    env: { database__client: 'sqlite3' },
    volumes: [{ volume: 'ghost-tenant-1-content', mountPath: '/var/lib/ghost/content' }],
  };
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-container-runner-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("start() execs the fake docker with exactly buildDockerRunArgs' own argv, and resolves the published baseUrl", async () => {
    const argvLogPath = join(dir, 'argv.log');
    const fakeDocker = await writeFakeDocker(dir, { argvLogPath });
    const runner = createDockerContainerRunner(spec, fakeDocker);

    const result = await runner.start();

    expect(result.baseUrl).toBe('http://127.0.0.1:4400');
    const logged = JSON.parse((await readFile(argvLogPath, 'utf8')).trim());
    expect(logged).toEqual(buildDockerRunArgs(spec));
  });

  it("stop() execs the fake docker with exactly buildDockerStopArgs' own argv", async () => {
    const argvLogPath = join(dir, 'argv.log');
    const fakeDocker = await writeFakeDocker(dir, { argvLogPath });
    const runner = createDockerContainerRunner(spec, fakeDocker);

    await runner.stop();

    const logged = JSON.parse((await readFile(argvLogPath, 'utf8')).trim());
    expect(logged).toEqual(buildDockerStopArgs(spec.containerName));
  });

  it('start() rejects, carrying stderr, when docker fails -- never swallowed', async () => {
    const fakeDocker = await writeFakeDocker(dir, { fail: true });
    const runner = createDockerContainerRunner(spec, fakeDocker);
    await expect(runner.start()).rejects.toThrow(/forced failure/);
  });

  it('stop() rejects, carrying stderr, when docker fails -- never swallowed', async () => {
    const fakeDocker = await writeFakeDocker(dir, { fail: true });
    const runner = createDockerContainerRunner(spec, fakeDocker);
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
      const runner = createDockerContainerRunner(spec, fakeDocker);
      await runner.start();
      expect((await readFile(envProbeLogPath, 'utf8')).trim()).toBe('absent');
    } finally {
      delete process.env.EXPORT_BUNDLER_TEST_ENV_PROBE;
    }
  });
});
