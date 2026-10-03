import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  engines: { node: string };
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

  it('declares a Node floor where require() of an ES module works', () => {
    expect(pkg.engines.node).toBe('>=20.19');
  });

  it('keeps the package version a plain release version the tag check can compare', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('compiled output', () => {
  let pkgDir: string;
  let outDir: string;

  beforeAll(() => {
    pkgDir = mkdtempSync(join(tmpdir(), 'render-core-build-'));
    outDir = join(pkgDir, 'dist');
    copyFileSync(join(root, 'package.json'), join(pkgDir, 'package.json'));
    const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--outDir', outDir], {
      cwd: root,
      stdio: 'pipe',
    });
  }, 120_000);

  afterAll(() => {
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it('emits the entry point and declaration file the export map names', () => {
    expect(existsSync(join(outDir, 'index.js'))).toBe(true);
    expect(existsSync(join(outDir, 'index.d.ts'))).toBe(true);
  });

  it('emits nothing from test/', () => {
    expect(existsSync(join(outDir, 'test'))).toBe(false);
    expect(existsSync(join(outDir, 'packaging.test.js'))).toBe(false);
  });

  it('loads from a CommonJS context, as infra/tenant must', () => {
    const out = execFileSync(
      process.execPath,
      ['-e', 'const m = require(process.argv[1]); process.stdout.write(typeof m.render)', pkgDir],
      { encoding: 'utf-8' }
    );
    expect(out).toBe('function');
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
