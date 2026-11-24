/**
 * Starts the compiled host entry as a process, the way the bundle's launcher
 * does, through a symlinked directory (the role's `current` link) and through a
 * symlinked file. With no configuration each start must refuse with exit 78
 * and name the missing input; a silent exit 0 would be a tick that did nothing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_CONFIG, HOST_STATE_DIR } from '../../src/hostEntry.js';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Under test/ so the nearest package.json (type: module) governs the compiled files.
const work = join(packageDir, 'test', '.sabotage-tmp', `entry-${process.pid}-${Date.now()}`);
const outDir = join(work, 'dist');
const realEntry = join(outDir, 'hostEntry.js');

beforeAll(() => {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  mkdirSync(outDir, { recursive: true });
  execFileSync(
    process.execPath,
    [tsc, '-p', join(packageDir, 'tsconfig.build.json'), '--outDir', outDir],
    { cwd: packageDir, stdio: 'pipe' }
  );
}, 120_000);

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Starts the entry at `script` with no configuration at all. */
function startWithoutConfig(script: string) {
  return spawnSync(process.execPath, [script], { env: {}, encoding: 'utf8' });
}

describe('the compiled host entry, started as a process', () => {
  it('refuses with exit 78 and names the missing input when started by its real path', () => {
    const run = startWithoutConfig(realEntry);
    expect(run.status).toBe(EXIT_CONFIG);
    expect(run.stderr).toContain(HOST_STATE_DIR);
  });

  it('refuses with exit 78 when started through a symlinked directory', () => {
    const link = join(work, 'current');
    symlinkSync(outDir, link, 'dir');
    const run = startWithoutConfig(join(link, 'hostEntry.js'));
    expect(run.status).toBe(EXIT_CONFIG);
    expect(run.stderr).toContain(HOST_STATE_DIR);
  });

  it('refuses with exit 78 when started through a symlinked file', () => {
    const link = join(work, 'ring-controller-link.js');
    symlinkSync(realEntry, link, 'file');
    const run = startWithoutConfig(link);
    expect(run.status).toBe(EXIT_CONFIG);
    expect(run.stderr).toContain(HOST_STATE_DIR);
  });
});
