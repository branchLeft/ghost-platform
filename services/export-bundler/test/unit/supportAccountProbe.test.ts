import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildStatusProbeArgs,
  createDockerStatusProbe,
  parseStatusProbeOutput,
  STATUS_PROBE_SCRIPT,
  SupportAccountStatusUnreadableError,
  type StatusProbeSpec,
} from '../../src/supportAccountProbe.js';

const spec: StatusProbeSpec = {
  image: 'ghost-platform:ci',
  envFile: '/tmp/export-bundler-env-x/tenant.env',
  user: '1001:1001',
  volumes: [{ volume: 'ghost-tenant-1-content', mountPath: '/var/lib/ghost/content' }],
};

async function writeFakeDocker(dir: string, lines: readonly string[]): Promise<string> {
  const path = join(dir, 'fake-docker.sh');
  await writeFile(path, ['#!/bin/sh', ...lines].join('\n') + '\n');
  await chmod(path, 0o755);
  return path;
}

const ACTIVE_ADMIN = `echo 'BL_SUPPORT_STATUS {"status":"active","roles":["Administrator"]}'`;

describe('buildStatusProbeArgs', () => {
  const args = buildStatusProbeArgs(spec, 'support@tenant.test');

  it('is a one-shot container: removed on exit, no published port, no name to collide with a colour', () => {
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    expect(args).not.toContain('-p');
    expect(args).not.toContain('-d');
    expect(args).not.toContain('--name');
  });

  it("runs node, never Ghost itself, as the tenant's own user", () => {
    expect(args.slice(2, 4)).toEqual(['--entrypoint', 'node']);
    expect(args[args.indexOf('--user') + 1]).toBe('1001:1001');
  });

  it("carries the tenant's env as a file, never -e values, then the image, the script and the identity last", () => {
    // The only -e is node's own, carrying the script.
    expect(args.indexOf('-e')).toBe(args.length - 3);
    expect(args.lastIndexOf('-e')).toBe(args.length - 3);
    expect(args[args.indexOf('--env-file') + 1]).toBe('/tmp/export-bundler-env-x/tenant.env');
    expect(args).toContain('type=volume,src=ghost-tenant-1-content,dst=/var/lib/ghost/content');
    expect(args.slice(-4)).toEqual([
      'ghost-platform:ci',
      '-e',
      STATUS_PROBE_SCRIPT,
      'support@tenant.test',
    ]);
  });
});

describe('STATUS_PROBE_SCRIPT', () => {
  it('reads only: it selects status and role names and has no call that writes a row', () => {
    expect(STATUS_PROBE_SCRIPT).toContain(
      ".select('users.status as status', 'roles.name as role')"
    );
    expect(STATUS_PROBE_SCRIPT).not.toMatch(
      /\.(update|insert|del|delete|truncate|increment|decrement|raw|upsert)\(/
    );
    expect(STATUS_PROBE_SCRIPT).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
  });
});

describe('parseStatusProbeOutput', () => {
  it('reads the account from the marker line, ignoring anything Ghost logged around it', () => {
    expect(
      parseStatusProbeOutput('noise\nBL_SUPPORT_STATUS {"status":"inactive","roles":["Owner"]}\n')
    ).toEqual({ status: 'inactive', roles: ['Owner'] });
  });

  it('reads null as an account that does not exist', () => {
    expect(parseStatusProbeOutput('BL_SUPPORT_STATUS null\n')).toBeNull();
  });

  it.each([
    ['nothing at all', ''],
    ['a malformed line', 'BL_SUPPORT_STATUS {oops\n'],
    ['a bare status string', 'BL_SUPPORT_STATUS "active"\n'],
    ['a non-string status', 'BL_SUPPORT_STATUS {"status":1,"roles":[]}\n'],
    ['roles that are not a list', 'BL_SUPPORT_STATUS {"status":"active","roles":"Owner"}\n'],
    ['a non-string role', 'BL_SUPPORT_STATUS {"status":"active","roles":[1]}\n'],
  ])('refuses %s as unreadable', (_label, stdout) => {
    expect(() => parseStatusProbeOutput(stdout)).toThrow(SupportAccountStatusUnreadableError);
  });
});

describe('createDockerStatusProbe', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-status-probe-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('execs docker with exactly buildStatusProbeArgs and returns the account it printed', async () => {
    const argvLog = join(dir, 'argv.log');
    const fake = await writeFakeDocker(dir, [
      `for a in "$@"; do printf '%s\\n' "$a" >> '${argvLog}'; done`,
      ACTIVE_ADMIN,
    ]);
    const account = await createDockerStatusProbe(spec, fake).readAccount('support@tenant.test');
    expect(account).toEqual({ status: 'active', roles: ['Administrator'] });
    const logged = (await readFile(argvLog, 'utf8')).trimEnd();
    expect(logged).toBe(buildStatusProbeArgs(spec, 'support@tenant.test').join('\n'));
  });

  it('refuses as unreadable when docker fails, carrying the exit code and stderr, not the argv', async () => {
    const fake = await writeFakeDocker(dir, ['echo "fake docker: forced failure" >&2', 'exit 3']);
    const err = await createDockerStatusProbe(spec, fake)
      .readAccount('support@tenant.test')
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(SupportAccountStatusUnreadableError);
    expect((err as Error).message).toContain('docker exited 3: fake docker: forced failure');
    expect((err as Error).message).not.toContain('--env-file');
  });

  it('refuses as unreadable when the probe prints no status', async () => {
    const fake = await writeFakeDocker(dir, ['echo hello']);
    await expect(
      createDockerStatusProbe(spec, fake).readAccount('support@tenant.test')
    ).rejects.toThrow(SupportAccountStatusUnreadableError);
  });

  it("never lets the ambient environment reach docker -- a synthetic marker set here does not appear in the child's", async () => {
    const probe = join(dir, 'env-probe.log');
    const fake = await writeFakeDocker(dir, [
      `if [ -n "$EXPORT_BUNDLER_TEST_ENV_PROBE" ]; then echo present > '${probe}'; else echo absent > '${probe}'; fi`,
      ACTIVE_ADMIN,
    ]);
    process.env.EXPORT_BUNDLER_TEST_ENV_PROBE = 'must-not-leak';
    try {
      await createDockerStatusProbe(spec, fake).readAccount('support@tenant.test');
    } finally {
      delete process.env.EXPORT_BUNDLER_TEST_ENV_PROBE;
    }
    expect((await readFile(probe, 'utf8')).trim()).toBe('absent');
  });

  it('falls back to an empty PATH when this process has none', async () => {
    const saved = process.env.PATH;
    delete process.env.PATH;
    try {
      await expect(createDockerStatusProbe(spec).readAccount('x')).rejects.toThrow(
        SupportAccountStatusUnreadableError
      );
    } finally {
      process.env.PATH = saved;
    }
  });
});
