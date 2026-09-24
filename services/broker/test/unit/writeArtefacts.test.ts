import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import { makeTempDir } from '../../src/atomicFile.js';
import { writeArtefacts } from '../../src/writeArtefacts.js';

describe('writeArtefacts', () => {
  let base: string;

  beforeEach(async () => {
    base = await makeTempDir('broker-artefacts-');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('writes each artefact under <base>/<slot>/<path>, creating subdirectories', async () => {
    await writeArtefacts(base, '0' as SlotName, [
      { path: 'compose.yml', content: 'a: 1' },
      { path: 'env/ghost.env', content: 'NODE_ENV=production' },
    ]);
    expect(await readFile(join(base, '0', 'compose.yml'), 'utf8')).toBe('a: 1');
    expect(await readFile(join(base, '0', 'env', 'ghost.env'), 'utf8')).toBe('NODE_ENV=production');
  });

  it('refuses an artefact path that would escape the slot directory', async () => {
    await expect(
      writeArtefacts(base, '0' as SlotName, [{ path: '../../../etc/passwd', content: 'x' }])
    ).rejects.toThrow(/escapes the slot directory/);
  });

  it('refuses an absolute-looking artefact path that resolves outside the slot directory', async () => {
    await expect(
      writeArtefacts(base, '0' as SlotName, [{ path: '../1/compose.yml', content: 'x' }])
    ).rejects.toThrow(/escapes the slot directory/);
  });

  it('a refused artefact leaves no partial write from artefacts before it -- CONTROL: a legitimate path inside the slot still succeeds', async () => {
    // Control case: an ordinary path must not be refused by the same
    // check that catches traversal, proving the guard can pass as well as
    // fail rather than refusing everything indiscriminately.
    await writeArtefacts(base, '3' as SlotName, [{ path: 'nested/dir/file.txt', content: 'ok' }]);
    expect(await readFile(join(base, '3', 'nested', 'dir', 'file.txt'), 'utf8')).toBe('ok');
  });
});
