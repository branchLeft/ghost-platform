/**
 * Red, then green, for the safety controls of this package. Each mutation
 * breaks one control in a COPY of the package (never the real files) by an
 * exact string replacement; the copy's own test suite must then fail. The
 * pristine copy must pass, or a failure above could just be a broken suite.
 * A replacement that matches nothing, or more than once, fails this test, so
 * a refactor cannot leave a mutation quietly doing nothing.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// The child suites run this file too; they must not run it again.
const IS_CHILD = process.env.ADMIN_API_SABOTAGE_CHILD === '1';

/**
 * @typedef {{ file: string, from: string, to: string }} Edit
 * @type {Array<{ name: string, edits: Edit[] }>}
 */
const MUTATIONS = [
  {
    name: 'the secret is no longer hex-decoded',
    edits: [
      { file: 'src/token.js', from: "Buffer.from(secret, 'hex')", to: 'Buffer.from(secret)' },
    ],
  },
  {
    name: 'a 3xx counts as success',
    edits: [
      {
        file: 'src/client.js',
        from: "if (status >= 300) return 'redirect';",
        to: "if (status >= 300) return 'ok';",
      },
    ],
  },
  {
    name: 'the error path interpolates the key',
    edits: [
      { file: 'src/client.js', from: 'label: url.pathname,', to: 'label: url.pathname + key,' },
    ],
  },
  {
    name: 'any http URL is accepted',
    edits: [{ file: 'src/client.js', from: '!LOOPBACK_HOSTS.has(url.hostname)', to: 'false' }],
  },
  {
    name: 'the total deadline is an idle timer',
    edits: [
      {
        file: 'src/client.js',
        from: "const timer = setTimeout(() => fail('timeout'), timeoutMs);",
        to: 'const timer = undefined;',
      },
      {
        file: 'src/client.js',
        from: 'req.end();',
        to: "req.setTimeout(timeoutMs, () => fail('timeout'));\n    req.end();",
      },
    ],
  },
];

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Copies the package to `<tmp>/admin-api` (the name its own tests expect) and
 * applies the edits there.
 *
 * @param {Edit[]} edits
 * @returns {string} the copy's directory
 */
function copyWith(edits) {
  const root = mkdtempSync(join(tmpdir(), 'admin-api-sabotage-'));
  const copy = join(root, 'admin-api');
  cpSync(packageRoot, copy, {
    recursive: true,
    filter: (source) => !source.includes('node_modules'),
  });
  for (const edit of edits) {
    const path = join(copy, edit.file);
    const text = readFileSync(path, 'utf8');
    const matches = text.split(edit.from).length - 1;
    assert.equal(matches, 1, `"${edit.from}" matched ${matches} times in ${edit.file}, not once`);
    writeFileSync(
      path,
      text.replace(edit.from, () => edit.to)
    );
  }
  return copy;
}

/**
 * @param {string} copy
 * @returns {Promise<number | null>} the exit code of the copy's suite
 */
function runSuite(copy) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', 'test/*.test.js'], {
      cwd: copy,
      env: { PATH: process.env.PATH ?? '', ADMIN_API_SABOTAGE_CHILD: '1' },
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('close', resolve);
  });
}

test(
  'the pristine copy passes (green), and each broken control fails the suite (red)',
  { skip: IS_CHILD && 'the child suites do not recurse', timeout: 180_000 },
  async () => {
    const copies = [copyWith([]), ...MUTATIONS.map((mutation) => copyWith(mutation.edits))];
    try {
      const [green, ...reds] = await Promise.all(copies.map(runSuite));
      assert.equal(green, 0, 'the pristine copy of the package does not pass its own suite');
      reds.forEach((code, index) => {
        assert.notEqual(
          code,
          0,
          `the suite still passes with the control broken: ${MUTATIONS[index]?.name}`
        );
      });
    } finally {
      for (const copy of copies) rmSync(join(copy, '..'), { recursive: true, force: true });
    }
  }
);
