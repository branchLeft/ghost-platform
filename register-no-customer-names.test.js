// A customer tenant name is never written to the public repo register or to the
// sources of the published packages. The "customer name" here is a lower-cased
// ALL_CAPS placeholder; no real or tenant-identifying name appears anywhere.
//
// Red then green: each placement below makes the guard exit non-zero. The same
// placements run against a copy of the guard with its allowlist checks removed,
// and the guard goes blind (exit 0), which shows the test sees the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = import.meta.dirname;
const GUARD = path.join(ROOT, 'scripts', 'assert-register-holds-no-customer-names.js');
const NAME = 'CUSTOMER_NAME_PLACEHOLDER'.toLowerCase().replaceAll('_', '-');
const PLACEHOLDER_ENTRY = `  { name: '${NAME}', kind: 'tenant', repo: 'branchLeft/ghost-tenant-${NAME}' },\n`;
const INFRA_PLACEHOLDER_ENTRY = `  { name: '${NAME}', kind: 'infrastructure' },\n`;
const INFRA_LINE = "  { name: 'website', kind: 'infrastructure' },\n";
const ZERO_LINE = "  { name: 'blog', kind: 'tenant', repo: 'branchLeft/ghost-tenant-blog' },\n";

const REGISTER = path.join('registers', 'tenant-names.json');
const RENDER_CORE_COPY = path.join('render-core', 'src', 'naming.ts');
const INFRA_TENANT_COPY = path.join('infra', 'tenant', 'naming.ts');
const PUBLISHED_SCRIPT = path.join('infra', 'tenant', 'scripts', 'assert-no-tenant-deletes.py');

function guard(script, root) {
  const result = spawnSync(process.execPath, [script, root], { encoding: 'utf-8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const scratch = [];
function tempTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'register-leak-'));
  scratch.push(root);
  for (const relative of [REGISTER, RENDER_CORE_COPY, INFRA_TENANT_COPY, PUBLISHED_SCRIPT]) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), path.join(root, relative));
  }
  return root;
}
test.after(() => {
  for (const root of scratch) fs.rmSync(root, { recursive: true, force: true });
});

function edit(root, relative, transform) {
  const file = path.join(root, relative);
  const before = fs.readFileSync(file, 'utf-8');
  const after = transform(before);
  assert.notEqual(after, before, `the edit to ${relative} applied`);
  fs.writeFileSync(file, after);
}

function addToGeneratedBlock(text) {
  assert.ok(text.includes(ZERO_LINE), 'the generated block holds the tenant zero line');
  return text.replace(ZERO_LINE, ZERO_LINE + PLACEHOLDER_ENTRY);
}

// Each placement of the placeholder, as a function that edits a fresh temp tree.
const PLACEMENTS = [
  [
    'the repo register',
    (root) =>
      edit(root, REGISTER, (text) => {
        const register = JSON.parse(text);
        register.names.push({
          name: NAME,
          kind: 'tenant',
          repo: `branchLeft/ghost-tenant-${NAME}`,
        });
        return JSON.stringify(register, null, 2);
      }),
  ],
  [
    'the repo register, labelled infrastructure',
    (root) =>
      edit(root, REGISTER, (text) => {
        const register = JSON.parse(text);
        register.names.push({ name: NAME, kind: 'infrastructure' });
        return JSON.stringify(register, null, 2);
      }),
  ],
  [
    'the repo register, labelled infrastructure with a repo field',
    (root) =>
      edit(root, REGISTER, (text) => {
        const register = JSON.parse(text);
        register.names.push({
          name: NAME,
          kind: 'infrastructure',
          repo: `branchLeft/ghost-tenant-${NAME}`,
        });
        return JSON.stringify(register, null, 2);
      }),
  ],
  [
    'the generated block in the render-core copy, labelled infrastructure',
    (root) =>
      edit(root, RENDER_CORE_COPY, (text) =>
        text.replace(INFRA_LINE, INFRA_LINE + INFRA_PLACEHOLDER_ENTRY)
      ),
  ],
  [
    'a register-shaped infrastructure entry in another source file',
    (root) => {
      fs.writeFileSync(
        path.join(root, 'infra', 'tenant', 'extra.ts'),
        `export const X = [{ name: '${NAME}', kind: 'infrastructure' }];\n`
      );
    },
  ],
  [
    'the generated block in the render-core copy',
    (root) => edit(root, RENDER_CORE_COPY, addToGeneratedBlock),
  ],
  [
    'the generated block in the infra/tenant copy',
    (root) => edit(root, INFRA_TENANT_COPY, addToGeneratedBlock),
  ],
  [
    'another non-test source file in a package dir',
    (root) => {
      fs.writeFileSync(
        path.join(root, 'infra', 'tenant', 'extra.ts'),
        `// customer: ghost-tenant-${NAME}\n`
      );
    },
  ],
  [
    'a register-shaped entry with no repo in another source file',
    (root) => {
      fs.writeFileSync(
        path.join(root, 'render-core', 'src', 'extra.ts'),
        `export const X = [{ name: '${NAME}', kind: 'tenant' }];\n`
      );
    },
  ],
  [
    'a published script under infra/tenant/scripts',
    (root) => {
      fs.writeFileSync(
        path.join(root, 'infra', 'tenant', 'scripts', 'extra.py'),
        `REPO = "ghost-tenant-${NAME}"\n`
      );
    },
  ],
];

test('green: the real tree holds tenant zero and infrastructure names only', () => {
  const result = guard(GUARD, ROOT);
  assert.equal(result.code, 0, result.stderr);
});

test('green: a temp tree with only tenant zero and infrastructure names', () => {
  const result = guard(GUARD, tempTree());
  assert.equal(result.code, 0, result.stderr);
});

for (const [label, place] of PLACEMENTS) {
  test(`red: the placeholder in ${label} is refused, and the finding does not quote it`, () => {
    const root = tempTree();
    place(root);
    const result = guard(GUARD, root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /::error::/);
    assert.ok(!result.stderr.includes(NAME), 'a finding never repeats the name');
  });
}

test('red: a missing or unreadable register refuses rather than passes', () => {
  const root = tempTree();
  fs.rmSync(path.join(root, REGISTER));
  assert.equal(guard(GUARD, root).code, 1);
  const broken = tempTree();
  fs.writeFileSync(path.join(broken, REGISTER), '{ not json');
  assert.equal(guard(GUARD, broken).code, 1);
});

test('red: an entry of an unknown kind in the register is refused', () => {
  const root = tempTree();
  edit(root, REGISTER, (text) => {
    const register = JSON.parse(text);
    register.names.push({ name: NAME, kind: 'customer' });
    return JSON.stringify(register);
  });
  assert.equal(guard(GUARD, root).code, 1);
});

test('red: a permitted register entry carrying an extra field is refused', () => {
  const root = tempTree();
  edit(root, REGISTER, (text) => {
    const register = JSON.parse(text);
    register.names[0].note = NAME;
    return JSON.stringify(register);
  });
  const result = guard(GUARD, root);
  assert.equal(result.code, 1);
  assert.ok(!result.stderr.includes(NAME), 'a finding never repeats the name');
});

test('red then green: the register entry kind is no exemption', () => {
  const root = tempTree();
  edit(root, REGISTER, (text) => {
    const register = JSON.parse(text);
    register.names.push({ name: NAME, kind: 'infrastructure' });
    return JSON.stringify(register);
  });
  assert.equal(guard(GUARD, root).code, 1, 'red: a new infrastructure name is refused');
  edit(root, REGISTER, (text) => {
    const register = JSON.parse(text);
    register.names = register.names.filter((entry) => entry.name !== NAME);
    return JSON.stringify(register);
  });
  assert.equal(guard(GUARD, root).code, 0, 'green: removing it passes');
});

test('the boundary: unpublished tests and a <name> placeholder in docs are not findings', () => {
  const root = tempTree();
  fs.mkdirSync(path.join(root, 'infra', 'tenant', 'test'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'infra', 'tenant', 'test', 'fixture.ts'),
    `const R = 'ghost-tenant-${NAME}';\n`
  );
  fs.writeFileSync(
    path.join(root, 'infra', 'tenant', 'claim.test.ts'),
    `const R = 'ghost-tenant-${NAME}';\n`
  );
  fs.writeFileSync(
    path.join(root, 'infra', 'tenant', 'doc.md'),
    'Named ghost-tenant-<name> and ghost-tenant-${slug}.\n'
  );
  assert.equal(guard(GUARD, root).code, 0);
});

test('a usage error is exit 2', () => {
  const result = spawnSync(process.execPath, [GUARD, 'a', 'b'], { encoding: 'utf-8' });
  assert.equal(result.status, 2);
});

test('sabotage: with the allowlist checks removed the guard is blind to every placement (red recorded, then green)', () => {
  const source = fs.readFileSync(GUARD, 'utf-8');
  const blind = source
    .replace(/return PERMITTED_ENTRIES\.some\([\s\S]*?\n {2}\);/, 'return true;')
    .replace('return TENANT_ZERO_REFS.has(ref);', 'return true;');
  assert.notEqual(blind, source, 'the mutation applied');
  assert.equal(blind.split('return true;').length - 1, 2, 'both allowlist checks were removed');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'register-leak-guard-'));
  scratch.push(directory);
  const sabotaged = path.join(directory, 'guard.mjs');
  fs.writeFileSync(sabotaged, blind);
  for (const [label, place] of PLACEMENTS) {
    const root = tempTree();
    place(root);
    assert.equal(guard(sabotaged, root).code, 0, `sabotaged guard misses: ${label}`);
    assert.equal(guard(GUARD, root).code, 1, `restored guard catches: ${label}`);
  }
});
