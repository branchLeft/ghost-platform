import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(here, '..', 'package.json');
const lockfilePath = join(here, '..', 'package-lock.json');
const srcDir = join(here, '..', 'src');

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface PackageLock {
  packages?: Record<string, { resolved?: string }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

/**
 * This is the sabotage-proof half of the "no Pulumi in the dependency
 * closure" requirement: a control case proves the matcher can still find
 * something, so a matcher that quietly stopped matching does not pass
 * silently forever.
 */
const CONTROL_NAMES = ['@pulumi/pulumi', 'pulumi-fake-control-case'];

function namesContainingPulumi(names: Iterable<string>): string[] {
  return [...names].filter((name) => name.toLowerCase().includes('pulumi'));
}

/**
 * Every source file under `src/`, recursively. `readdirSync(..., {
 * recursive: true })` returns paths relative to `dir`, mixed with
 * directories — filtered here to `.ts` files only.
 */
function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

// Matches `from '...'` / `from "..."` (static and re-export forms), plus
// `import('...')` and `require('...')` — everything that names a module
// specifier in source text, without needing a real module resolver.
const IMPORT_SPECIFIER_PATTERN = /(?:from\s+|import\(|require\()\s*['"]([^'"]+)['"]/g;

function importSpecifiersFrom(text: string): string[] {
  return [...text.matchAll(IMPORT_SPECIFIER_PATTERN)].map((match) => match[1]);
}

function importSpecifiersIn(filePath: string): string[] {
  return importSpecifiersFrom(readFileSync(filePath, 'utf-8'));
}

/** A specifier that does not resolve inside this package's own `src/` tree. */
function leavesThePackage(specifier: string): boolean {
  return !specifier.startsWith('./') && !specifier.startsWith('../');
}

describe('dependency closure — no Pulumi module anywhere in it', () => {
  it('control case: the matcher itself finds a Pulumi-shaped name', () => {
    expect(namesContainingPulumi(CONTROL_NAMES)).toEqual(CONTROL_NAMES);
  });

  it('package.json declares no Pulumi dependency, direct or dev', () => {
    const pkg = readJson<PackageJson>(packageJsonPath);
    const declared = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ];
    expect(namesContainingPulumi(declared)).toEqual([]);
  });

  it('the resolved lockfile tree contains no Pulumi package at any depth', () => {
    const lock = readJson<PackageLock>(lockfilePath);
    const resolvedPaths = Object.keys(lock.packages ?? {});
    // Lockfile keys are paths like "node_modules/foo/node_modules/bar" —
    // this catches a transitive dependency a direct one pulled in, not only
    // a direct one this package declared itself.
    expect(namesContainingPulumi(resolvedPaths)).toEqual([]);
  });

  it('control case: the specifier classifier flags a bare import and clears a relative one', () => {
    expect(leavesThePackage('@pulumi/pulumi')).toBe(true);
    expect(leavesThePackage('vitest')).toBe(true);
    expect(leavesThePackage('./brand.js')).toBe(false);
    expect(leavesThePackage('../src/index.js')).toBe(false);
  });

  it('control case: the specifier extractor finds a specifier in a literal import line', () => {
    expect(importSpecifiersFrom("import { x } from '@pulumi/pulumi';")).toEqual(['@pulumi/pulumi']);
  });

  it('no source file under src/ imports anything outside this package', () => {
    // Reads the *text* of every source file rather than importing it — a
    // bad specifier here (e.g. `@pulumi/pulumi`, never installed) would
    // otherwise fail module resolution before this test ever got to make
    // its own assertion, which is a crash, not a finding.
    const files = listSourceFiles(srcDir);
    expect(files.length).toBeGreaterThan(0); // control: the walk itself finds files

    const offenders: Array<{ file: string; specifier: string }> = [];
    for (const file of files) {
      for (const specifier of importSpecifiersIn(file)) {
        if (leavesThePackage(specifier)) {
          offenders.push({ file, specifier });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no source file under src/ imports anything naming the Pulumi scope', () => {
    const files = listSourceFiles(srcDir);
    const offenders: Array<{ file: string; specifier: string }> = [];
    for (const file of files) {
      for (const specifier of importSpecifiersIn(file)) {
        if (specifier.toLowerCase().includes('pulumi')) {
          offenders.push({ file, specifier });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
