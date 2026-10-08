import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds dist/ once, before any test file runs. The server-startup tests all
 * run the compiled entrypoint, and vitest runs test files in parallel: when
 * each built into the same dist/ itself, one test could start the server
 * while another was mid-write and see a half-emitted module. Each of those
 * tests still starts the real compiled dist/server.js as its own process.
 */
export default function setup(): void {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  execFileSync(
    process.execPath,
    [join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'],
    { cwd: projectRoot, stdio: 'pipe' }
  );
}
