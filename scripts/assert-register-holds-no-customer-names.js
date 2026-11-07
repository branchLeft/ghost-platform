#!/usr/bin/env node
// Refuse a customer tenant name in the public name register or in the sources
// of the two published packages. See assert-register-holds-no-customer-names.md.
//
// Usage: assert-register-holds-no-customer-names.js [ROOT]
// Exit 0: clean. Exit 1: a finding. Exit 2: usage error.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Tenant zero is the only `tenant` entry the repo may hold. Both values are
// already public in the register.
export const TENANT_ZERO = Object.freeze({ name: 'blog', repo: 'branchLeft/ghost-tenant-blog' });

const REGISTER = path.join('registers', 'tenant-names.json');
// The published packages: `render-core` and `infra/tenant`. Their sources are
// what the publish workflows build and pack.
const PACKAGE_DIRS = [path.join('render-core'), path.join('infra', 'tenant')];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'test', '.git']);
const SKIPPED_FILE = /\.test\.[a-z]+$/;
const SCANNED_FILE = /\.(ts|js|mjs|cjs|json|py|sh|md|ya?ml)$/;

// Tenant zero's repository name, and the same name as it appears in a Pulumi
// stack-resource name (`<project>-<stack>`), as `infra/tenant/scripts` carries it.
const TENANT_ZERO_REFS = new Set(['ghost-tenant-blog', 'ghost-tenant-blog-blog']);

// The two allowlist checks are the whole rule. Mutating either to `return true`
// is the sabotage the test makes.
export function isTenantZero(entry) {
  return entry.name === TENANT_ZERO.name && entry.repo === TENANT_ZERO.repo;
}

export function isTenantZeroRef(ref) {
  return TENANT_ZERO_REFS.has(ref);
}

function checkRegister(root) {
  const file = path.join(root, REGISTER);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [`${REGISTER}: missing or not valid JSON (refusing rather than assuming it is clean)`];
  }
  if (!Array.isArray(parsed?.names)) return [`${REGISTER}: has no names array`];
  const findings = [];
  for (const entry of parsed.names) {
    if (entry?.kind === 'infrastructure') continue;
    if (entry?.kind === 'tenant' && isTenantZero(entry)) continue;
    findings.push(
      `${REGISTER}: a ${JSON.stringify(entry?.kind)} entry other than infrastructure and tenant zero: a customer name belongs in the control plane, not here`
    );
  }
  return findings;
}

function* sourceFiles(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* sourceFiles(full);
    } else if (SCANNED_FILE.test(entry.name) && !SKIPPED_FILE.test(entry.name)) {
      yield full;
    }
  }
}

// A register-shaped entry: one object literal holding a string `name` and
// `kind: 'tenant'`. Other `kind: 'tenant'` objects (a mail identity, a claimant)
// carry no `name`.
const OBJECT_LITERAL = /\{[^{}]*\}/g;
const KIND_TENANT = /\bkind['"]?\s*[:=]\s*['"]tenant['"]/;
const NAME_FIELD = /\bname['"]?\s*[:=]\s*['"]([^'"]+)['"]/;
const REPO_FIELD = /\brepo['"]?\s*[:=]\s*['"]([^'"]+)['"]/;
// A tenant repository reference. `<name>` and `${...}` placeholders do not match.
const TENANT_REPO_REF = /ghost-tenant-([a-z0-9][a-z0-9-]*)/g;

function checkSource(root, file) {
  const text = fs.readFileSync(file, 'utf-8');
  const relative = path.relative(root, file);
  const findings = [];
  for (const [literal] of text.matchAll(OBJECT_LITERAL)) {
    if (!KIND_TENANT.test(literal)) continue;
    const name = NAME_FIELD.exec(literal)?.[1];
    if (name === undefined) continue;
    const repo = REPO_FIELD.exec(literal)?.[1];
    if (!isTenantZero({ name, repo })) {
      findings.push(`${relative}: a register-shaped tenant entry other than tenant zero`);
    }
  }
  for (const [, slug] of text.matchAll(TENANT_REPO_REF)) {
    if (!isTenantZeroRef(`ghost-tenant-${slug}`)) {
      findings.push(`${relative}: a tenant repository reference other than tenant zero`);
    }
  }
  return findings;
}

/** Every finding under `root`; empty means clean. Findings never quote the name. */
export function findCustomerNames(root) {
  const findings = checkRegister(root);
  for (const packageDir of PACKAGE_DIRS) {
    for (const file of sourceFiles(path.join(root, packageDir))) {
      findings.push(...checkSource(root, file));
    }
  }
  return findings;
}

export function main(argv, stderr = process.stderr, stdout = process.stdout) {
  if (argv.length > 1) {
    stderr.write('usage: assert-register-holds-no-customer-names.js [ROOT]\n');
    return 2;
  }
  const root = path.resolve(argv[0] ?? path.join(import.meta.dirname, '..'));
  const findings = findCustomerNames(root);
  for (const finding of findings) stderr.write(`::error::${finding}\n`);
  if (findings.length > 0) return 1;
  stdout.write('no customer tenant name in the register or the published package sources\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
