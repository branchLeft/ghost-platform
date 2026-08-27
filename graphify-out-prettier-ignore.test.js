// graphify-out/ is written only by CI (graphify.yml). Prettier's own JSON
// formatting disagrees with graphify's, so the moment a file in that tree
// stops being ignored, `npm run format` silently rewrites it -- exactly the
// local-tool-versus-CI-artifact drift the workspace graphify convention
// forbids. This asserts the ignore configuration directly rather than
// relying on today's committed bytes happening to already match what
// Prettier would produce.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import prettier from 'prettier';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const IGNORE_PATHS = [
  path.join(ROOT, '.gitignore'),
  path.join(ROOT, '.prettierignore'),
  path.join(ROOT, 'node_modules/@branchleft/prettier-config/prettierignore'),
];

// One file per extension Prettier actually has a printer for in this tree,
// plus the extensionless cache file -- an extension-based ignore pattern
// would silently miss that one.
const SAMPLE_PATHS = [
  'graphify-out/graph.json',
  'graphify-out/graph.html',
  'graphify-out/cache/last_query_stamp',
];

for (const relPath of SAMPLE_PATHS) {
  test(`${relPath} is ignored by Prettier`, async () => {
    const info = await prettier.getFileInfo(path.join(ROOT, relPath), {
      ignorePath: IGNORE_PATHS,
    });
    assert.equal(info.ignored, true);
  });
}

// `.prettierignore` only reaches Prettier. `trailing-whitespace` and
// `end-of-file-fixer` rewrite file content directly and never consult it --
// this repo keeps them off graphify-out/ via .pre-commit-config.yaml's
// top-level `exclude`, which every hook inherits. That is safe here only
// because no hook in this file needs to see inside graphify-out/ (unlike the
// prettier hook, which is scoped separately, in .prettierignore, precisely
// because pass_filenames: false makes pre-commit's own file filtering
// irrelevant to what it runs).
test('.pre-commit-config.yaml excludes graphify-out/ at the top level', () => {
  const config = readFileSync(path.join(ROOT, '.pre-commit-config.yaml'), 'utf8');
  const match = config.match(/^exclude:\s*(\S+)\s*$/m);
  assert.ok(match, '.pre-commit-config.yaml declares a top-level `exclude`');
  const pattern = new RegExp(match[1]);
  for (const relPath of SAMPLE_PATHS) {
    assert.ok(pattern.test(relPath), `${relPath} matches the top-level exclude`);
  }
});
