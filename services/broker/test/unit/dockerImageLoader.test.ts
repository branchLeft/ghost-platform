import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import dockerImageLoader from '../../src/plugins/dockerImageLoader.js';

/**
 * A real daemon is exercised by the live proof (`test/live/imagePush.live.test.ts`),
 * against `--internal`-networked containers; a unit test's job is this
 * module's own logic -- parsing `docker load`'s output and refusing what it
 * cannot recognise -- which a fake `docker` on PATH proves without needing
 * Docker at all.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FAKE_DOCKER_BIN_DIR = join(here, '..', 'helpers', 'fake-docker-bin');

describe('dockerImageLoader (docker load, never docker pull)', () => {
  const originalPath = process.env.PATH;
  const originalFail = process.env.FAKE_DOCKER_FAIL;
  const originalOutput = process.env.FAKE_DOCKER_LOAD_OUTPUT;

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalFail === undefined) delete process.env.FAKE_DOCKER_FAIL;
    else process.env.FAKE_DOCKER_FAIL = originalFail;
    if (originalOutput === undefined) delete process.env.FAKE_DOCKER_LOAD_OUTPUT;
    else process.env.FAKE_DOCKER_LOAD_OUTPUT = originalOutput;
  });

  function useFakeDocker(): void {
    process.env.PATH = `${FAKE_DOCKER_BIN_DIR}${process.platform === 'win32' ? ';' : ':'}${originalPath}`;
  }

  it('parses a bare image ID out of "docker load"s own output', async () => {
    useFakeDocker();
    const result = await dockerImageLoader.load('/tmp/does-not-need-to-exist.tar');
    expect(result.imageId).toBe(`sha256:${'0'.repeat(64)}`);
  });

  it('refuses output shaped like a repo:tag load -- "runs it by digest only" has nothing to check otherwise', async () => {
    useFakeDocker();
    process.env.FAKE_DOCKER_LOAD_OUTPUT = 'Loaded image: ghost-platform:ci-1241\n';
    await expect(dockerImageLoader.load('/tmp/does-not-matter.tar')).rejects.toThrow(
      /no bare image ID this loader recognises/
    );
  });

  it('propagates a failing "docker load" invocation as a rejected promise', async () => {
    useFakeDocker();
    process.env.FAKE_DOCKER_FAIL = '1';
    await expect(dockerImageLoader.load('/tmp/does-not-matter.tar')).rejects.toThrow(
      /docker load failed/
    );
  });
});
