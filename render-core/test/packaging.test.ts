import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

interface ExportTarget {
  types?: string;
  default?: string;
}

interface PackageJson {
  name: string;
  version: string;
  type: string;
  main: string;
  types: string;
  files: string[];
  exports: Record<string, ExportTarget | string>;
  publishConfig: { registry: string; access: string };
  dependencies?: Record<string, string>;
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as PackageJson;

describe('published package metadata', () => {
  it('is scoped to the registry the publish workflow targets, publicly', () => {
    expect(pkg.name).toBe('@branchleft/ghost-platform-render-core');
    expect(pkg.publishConfig).toEqual({ registry: 'https://npm.pkg.github.com', access: 'public' });
  });

  it('is an ES module whose entry points and export map agree', () => {
    expect(pkg.type).toBe('module');
    expect(pkg.exports['.']).toEqual({ types: `./${pkg.types}`, default: `./${pkg.main}` });
  });

  it('ships the compiled output only, never sources or tests', () => {
    expect(pkg.files).toEqual(['dist']);
  });

  it('declares no runtime dependency, so a consumer resolves nothing beyond this package', () => {
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it('keeps the package version a plain release version the tag check can compare', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('compiled output', () => {
  let outDir: string;

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), 'render-core-build-'));
    const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--outDir', outDir], {
      cwd: root,
      stdio: 'pipe',
    });
  }, 120_000);

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('emits the entry point and declaration file the export map names', () => {
    expect(existsSync(join(outDir, 'index.js'))).toBe(true);
    expect(existsSync(join(outDir, 'index.d.ts'))).toBe(true);
  });

  it('emits nothing from test/', () => {
    expect(existsSync(join(outDir, 'test'))).toBe(false);
    expect(existsSync(join(outDir, 'packaging.test.js'))).toBe(false);
  });

  it('loads as an ES module in plain Node and exposes the public surface', async () => {
    const entry = (await import(pathToFileURL(join(outDir, 'index.js')).href)) as Record<
      string,
      unknown
    >;
    expect(typeof entry['render']).toBe('function');
    expect(typeof entry['validateSlug']).toBe('function');
  });
});
