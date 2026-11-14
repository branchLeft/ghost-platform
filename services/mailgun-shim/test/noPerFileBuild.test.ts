import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Proves no test file builds dist/ itself: test/globalSetup.ts builds it once
 * before the suite, and vitest runs files in parallel, so a second builder
 * races the tests that spawn dist/server.js.
 * See noPerFileBuild.test.md#why-a-test-may-not-build.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const testRoot = __dirname;
const allowedBuilder = join(testRoot, 'globalSetup.ts');
const thisFile = fileURLToPath(import.meta.url);

// A child-process call, then the next 300 characters: enough to hold the
// argument list of any call this suite makes, including a nested join(...).
const SPAWN_CALL = /\b(?:execFileSync|execFile|execSync|exec|spawnSync|spawn|fork)\s*\(/g;
const BUILD_ARGUMENT = /\btsc\b|\btsconfig\.build\b|['"`]build['"`]|\brun build\b/;
const WINDOW = 300;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (/\.(?:ts|mjs)$/.test(entry.name)) found.push(path);
  }
  return found;
}

/** Child-process calls in `source` whose arguments run a build. */
function buildingCalls(source: string): string[] {
  const hits: string[] = [];
  for (const match of source.matchAll(SPAWN_CALL)) {
    const window = source.slice(match.index, match.index + match[0].length + WINDOW);
    if (BUILD_ARGUMENT.test(window)) hits.push(window.split('\n')[0] ?? window);
  }
  return hits;
}

describe('no test builds dist/ itself', () => {
  it('flags a child-process call that runs the build (the detector can fail)', () => {
    expect(buildingCalls(`execFileSync('pnpm', ['run', 'build'], { cwd: root });`)).toHaveLength(1);
    expect(buildingCalls(`execFileSync('npm', ['run', 'build'], { cwd: root });`)).toHaveLength(1);
    expect(
      buildingCalls(
        `execFileSync(process.execPath, [join(root, 'bin', 'tsc'), '-p', 'tsconfig.build.json']);`
      )
    ).toHaveLength(1);
    expect(buildingCalls(`spawn(process.execPath, [serverJsPath], { cwd: projectRoot });`)).toEqual(
      []
    );
  });

  it('finds no test file other than globalSetup.ts running a build', () => {
    const offenders = sourceFiles(testRoot)
      .filter((file) => file !== allowedBuilder && file !== thisFile)
      .flatMap((file) =>
        buildingCalls(readFileSync(file, 'utf8')).map(
          (call) => `${relative(testRoot, file)}: ${call}`
        )
      );
    expect(offenders).toEqual([]);
  });

  it('still has globalSetup.ts building, so the others have a dist/ to spawn', () => {
    expect(buildingCalls(readFileSync(allowedBuilder, 'utf8'))).toHaveLength(1);
  });
});
