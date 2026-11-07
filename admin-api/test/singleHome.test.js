/**
 * Rob's 19 Oct ruling: reuse means one home, never a copy. The token recipe
 * lives in admin-api/src/token.js and nowhere else. This scans the source of
 * every service and of this package, and fails on any other file that mints
 * the recipe.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_FILE = /\.(?:[cm]?js|ts)$/;
const HOME = 'admin-api/src/token.js';

/**
 * @param {string} dir
 * @returns {string[]}
 */
function sourceFiles(dir) {
  /** @type {string[]} */
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') found.push(...sourceFiles(path));
    } else if (SOURCE_FILE.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/** Source that mints the recipe: HS256 with a `kid`, or an HMAC for the `/admin/` audience. */
function mintsTheRecipe(/** @type {string} */ text) {
  return (
    (/HS256/.test(text) && /\bkid\b/.test(text)) ||
    (/createHmac/.test(text) && text.includes('/admin/'))
  );
}

/**
 * Files under `repoRoot` that mint the recipe, other than the one home. Scans
 * every `services/*\/src`, and this package's own `src` and top-level files;
 * the tests are outside it on purpose, as they hold an independent verifier.
 *
 * @param {string} repoRoot
 * @returns {string[]} repo-relative paths
 */
export function recipeCopies(repoRoot) {
  const roots = [join(repoRoot, 'admin-api', 'src')];
  let services = [];
  try {
    services = readdirSync(join(repoRoot, 'services'));
  } catch {
    // A copy of the package on its own (the sabotage test) has no services.
  }
  for (const service of services) roots.push(join(repoRoot, 'services', service, 'src'));
  const files = roots.flatMap(sourceFiles);
  for (const name of readdirSync(join(repoRoot, 'admin-api'))) {
    if (SOURCE_FILE.test(name)) files.push(join(repoRoot, 'admin-api', name));
  }
  return files
    .map((file) => relative(repoRoot, file).split('\\').join('/'))
    .filter((file) => file !== HOME)
    .filter((file) => mintsTheRecipe(readFileSync(join(repoRoot, file), 'utf8')));
}

test('only admin-api/src/token.js mints the Admin API token recipe', () => {
  assert.deepEqual(recipeCopies(dirname(packageRoot.replace(/\/$/, ''))), []);
});

test('the home itself does mint the recipe (the scanner reads the right file)', () => {
  const text = readFileSync(join(packageRoot, 'src', 'token.js'), 'utf8');
  assert.equal(mintsTheRecipe(text), true);
});

test('control: the scanner flags a planted copy of the recipe', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-api-home-'));
  try {
    mkdirSync(join(root, 'admin-api', 'src'), { recursive: true });
    mkdirSync(join(root, 'services', 'other', 'src'), { recursive: true });
    writeFileSync(join(root, HOME), readFileSync(join(packageRoot, 'src', 'token.js')));
    writeFileSync(join(root, 'services', 'other', 'src', 'fine.ts'), 'export const x = 1;\n');
    assert.deepEqual(recipeCopies(root), [], 'the clean tree is flagged');

    writeFileSync(
      join(root, 'services', 'other', 'src', 'copy.ts'),
      "const h = { alg: 'HS256', typ: 'JWT', kid: id };\n"
    );
    writeFileSync(
      join(root, 'admin-api', 'src', 'second.js'),
      "import { createHmac } from 'node:crypto';\nconst aud = '/admin/';\n"
    );
    assert.deepEqual(recipeCopies(root).sort(), [
      'admin-api/src/second.js',
      'services/other/src/copy.ts',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
