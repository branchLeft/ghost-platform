import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds dist/ once, before any test file runs, for the tests that start the
 * real compiled dist/server.js as their own process. Node's request-timeout
 * sweep does not run inside the vitest worker, so the read-timeout tests need
 * a real process.
 */
export default function setup(): void {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  execFileSync(
    process.execPath,
    [join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'],
    { cwd: projectRoot, stdio: 'pipe' }
  );
}
