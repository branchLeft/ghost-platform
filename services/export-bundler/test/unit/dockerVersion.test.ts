import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertDockerServerSupported,
  DockerTooOldError,
  MINIMUM_DOCKER_SERVER_MAJOR_VERSION,
  readDockerServerVersion,
} from '../../src/dockerVersion.js';

describe('assertDockerServerSupported', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-docker-version-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function fakeDocker(reply: string, exit = 0): Promise<string> {
    const path = join(dir, 'fake-docker.sh');
    await writeFile(
      path,
      [
        '#!/bin/sh',
        'case "$*" in',
        `  "version --format {{.Server.Version}}") printf '%s' '${reply}'; exit ${exit} ;;`,
        'esac',
        'exit 9',
      ].join('\n') + '\n'
    );
    await chmod(path, 0o755);
    return path;
  }

  it(`is exactly ${String(MINIMUM_DOCKER_SERVER_MAJOR_VERSION)}`, () => {
    expect(MINIMUM_DOCKER_SERVER_MAJOR_VERSION).toBe(28);
  });

  it('reads the server version by asking docker directly, trimmed', async () => {
    const fake = await fakeDocker('28.1.1\n');
    expect(await readDockerServerVersion(fake)).toBe('28.1.1');
  });

  it.each([['28.0.0'], ['28.5.2'], ['29.0.0'], ['100.0.0']])(
    'passes server version %s',
    async (version) => {
      const fake = await fakeDocker(version);
      await expect(assertDockerServerSupported(fake)).resolves.toBeUndefined();
    }
  );

  it.each([['27.0.3'], ['20.10.24'], ['1.13.1'], ['0.9.0']])(
    'REFUSES server version %s, below the minimum',
    async (version) => {
      const fake = await fakeDocker(version);
      await expect(assertDockerServerSupported(fake)).rejects.toThrow(DockerTooOldError);
      await expect(assertDockerServerSupported(fake)).rejects.toThrow(
        new RegExp(`reports server version ${version.replace(/\./g, '\\.')}`)
      );
    }
  );

  it('refuses when the daemon cannot be reached, rather than treating that as a pass', async () => {
    const fake = await fakeDocker('', 1);
    await expect(assertDockerServerSupported(fake)).rejects.toThrow(DockerTooOldError);
    await expect(assertDockerServerSupported(fake)).rejects.toThrow(/could not be reached/);
  });

  it('refuses an unreadable version string, rather than treating that as a pass', async () => {
    const path = join(dir, 'fake-docker-garbage.sh');
    await writeFile(path, ['#!/bin/sh', "printf 'not-a-version'"].join('\n') + '\n');
    await chmod(path, 0o755);
    await expect(assertDockerServerSupported(path)).rejects.toThrow(/unreadable server version/);
  });

  it('never quotes the whole command in a rejected reason, even when docker itself fails', async () => {
    const fake = await fakeDocker('', 1);
    try {
      await assertDockerServerSupported(fake);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(fake);
    }
  });
});
