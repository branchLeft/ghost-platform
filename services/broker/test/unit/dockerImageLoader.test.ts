import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import dockerImageLoader from '../../src/plugins/dockerImageLoader.js';
import { makeTempDir } from '../../src/atomicFile.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(here, '..', '..', 'src');
const FAKE_WRAPPER = fileURLToPath(new URL('../helpers/fakeWrapper.mjs', import.meta.url));
const FAKE_DOCKER_BIN_DIR = join(here, '..', 'helpers', 'fake-docker-bin');

async function readLoggedInvocations(logPath: string): Promise<string[][]> {
  const text = await readFile(logPath, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

/**
 * `dockerImageLoader.ts` reads its own env directly (the same convention
 * `renderCorePlugin.ts` uses for `zonesFromEnv`) rather than receiving a
 * `BrokerConfig`, so these tests configure it the same way a real deploy
 * would: environment variables, not constructor arguments. A real `docker`
 * on `PATH` (`fake-docker-bin`, ahead of it) proves the negative every
 * test here depends on -- if the loader ever shelled out to `docker`
 * directly, this is what would answer, and `FAKE_DOCKER_CALL_LOG` records
 * it.
 */
describe('dockerImageLoader (goes through the sudoers wrapper, never docker directly)', () => {
  const originalPath = process.env.PATH;
  let root: string;
  let fixedDir: string;
  let wrapperLogPath: string;
  let dockerCallLogPath: string;

  beforeEach(async () => {
    root = await makeTempDir('docker-image-loader-');
    fixedDir = join(root, 'image-tmp');
    await mkdir(fixedDir);
    wrapperLogPath = join(root, 'wrapper.log');
    dockerCallLogPath = join(root, 'docker-calls.log');

    process.env.PATH = `${FAKE_DOCKER_BIN_DIR}${process.platform === 'win32' ? ';' : ':'}${originalPath}`;
    process.env.FAKE_DOCKER_CALL_LOG = dockerCallLogPath;
    process.env.BROKER_IMAGE_TMP_DIR = fixedDir;
    process.env.BROKER_WRAPPER_COMMAND = FAKE_WRAPPER;
    process.env.BROKER_WRAPPER_PREFIX = process.execPath;
    process.env.FAKE_WRAPPER_LOG = wrapperLogPath;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_DOCKER_CALL_LOG;
    delete process.env.FAKE_DOCKER_FAIL;
    delete process.env.BROKER_IMAGE_TMP_DIR;
    delete process.env.BROKER_WRAPPER_COMMAND;
    delete process.env.BROKER_WRAPPER_PREFIX;
    delete process.env.FAKE_WRAPPER_LOG;
    delete process.env.FAKE_WRAPPER_FAIL;
    delete process.env.FAKE_WRAPPER_LOAD_OUTPUT;
    await rm(root, { recursive: true, force: true });
  });

  async function stageTar(dir: string, name = 'image.tar'): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, 'not a real tar -- the fake wrapper never reads it');
    return path;
  }

  it('parses a bare image ID out of the wrapper’s own stdout', async () => {
    const tarPath = await stageTar(fixedDir);
    const result = await dockerImageLoader.load(tarPath);
    expect(result.imageId).toBe(`sha256:${'0'.repeat(64)}`);
  });

  it('GREEN: invokes only the sudoers wrapper -- docker is never on the call path', async () => {
    const tarPath = await stageTar(fixedDir);
    await dockerImageLoader.load(tarPath);

    expect(await readLoggedInvocations(wrapperLogPath)).toEqual([['load', tarPath]]);
    // The control this story exists for: a fake `docker` sits ahead of the
    // wrapper on PATH and would have logged here if anything had invoked it.
    await expect(readFile(dockerCallLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses output shaped like a repo:tag load -- "runs it by digest only" has nothing to check otherwise', async () => {
    const tarPath = await stageTar(fixedDir);
    process.env.FAKE_WRAPPER_LOAD_OUTPUT = 'Loaded image: ghost-platform:ci-1241\n';
    await expect(dockerImageLoader.load(tarPath)).rejects.toThrow(
      /no bare image ID this loader recognises/
    );
  });

  it('propagates a failing wrapper invocation as a rejected promise', async () => {
    const tarPath = await stageTar(fixedDir);
    process.env.FAKE_WRAPPER_FAIL = '1';
    await expect(dockerImageLoader.load(tarPath)).rejects.toThrow(/slot wrapper failed/);
  });

  it('RED (the control this story exists for): refuses a path outside the fixed directory, without ever invoking the wrapper', async () => {
    const outsideDir = await makeTempDir('outside-the-fixed-dir-');
    try {
      const outsideTarPath = await stageTar(outsideDir);
      await expect(dockerImageLoader.load(outsideTarPath)).rejects.toThrow(
        /outside the fixed image-staging directory/
      );
      await expect(readFile(wrapperLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('refuses a symlink inside the fixed directory that resolves outside it, without ever invoking the wrapper', async () => {
    const outsideDir = await makeTempDir('outside-the-fixed-dir-');
    try {
      const realTarget = await stageTar(outsideDir, 'real.tar');
      const linkPath = join(fixedDir, 'image.tar');
      await symlink(realTarget, linkPath);

      await expect(dockerImageLoader.load(linkPath)).rejects.toThrow(
        /outside the fixed image-staging directory/
      );
      await expect(readFile(wrapperLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('refuses a path that does not exist, without ever invoking the wrapper', async () => {
    const missingPath = join(fixedDir, 'never-written.tar');
    await expect(dockerImageLoader.load(missingPath)).rejects.toBeTruthy();
    await expect(readFile(wrapperLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to start with BROKER_IMAGE_TMP_DIR unset', async () => {
    const tarPath = await stageTar(fixedDir);
    delete process.env.BROKER_IMAGE_TMP_DIR;
    await expect(dockerImageLoader.load(tarPath)).rejects.toThrow(
      /BROKER_IMAGE_TMP_DIR is not set/
    );
  });

  it('never quotes "docker" as a command this module would invoke directly', () => {
    const source = readFileSync(join(SRC_DIR, 'plugins', 'dockerImageLoader.ts'), 'utf8');
    expect(source).not.toMatch(/execFile\(\s*['"]docker['"]/);
    expect(source).not.toMatch(/spawn\(\s*['"]docker['"]/);
  });
});
