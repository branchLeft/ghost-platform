import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(here, '..', 'package.json');
const lockfilePath = join(here, '..', 'package-lock.json');

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
});
