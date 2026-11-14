import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The test identity provider and the browser harness are test code. These
// checks keep them out of everything that ships: no module under `src/`
// (which holds both entry points) imports from `test/` or from the browser
// library, the build leaves `test/` out of `dist`, the image's build context
// leaves it out, and the browser library is a development dependency only.

const APPS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER_LIBRARIES = ['playwright', 'playwright-core', '@playwright/test'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : []
  );
}

function specifiers(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    found.push(m[1] ?? '');
  }
  return found;
}

/** Every import under `src` of test code or of a browser library, as `file -> specifier`. */
export function testCodeImports(appsRoot: string): string[] {
  const src = join(appsRoot, 'src');
  const found: string[] = [];
  for (const file of sourceFiles(src)) {
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      const relativeSpec = spec.startsWith('.');
      const target = relativeSpec ? relative(appsRoot, resolve(dirname(file), spec)) : spec;
      const intoTest = relativeSpec && (target === 'test' || target.startsWith('test/'));
      const library = BROWSER_LIBRARIES.some(
        (name) => spec === name || spec.startsWith(`${name}/`)
      );
      if (intoTest || library) found.push(`${relative(appsRoot, file)} -> ${spec}`);
    }
  }
  return found;
}

const configProblems = (buildConfig: string, ignoreFile: string, manifest: string): string[] => {
  const problems: string[] = [];
  const build = JSON.parse(buildConfig.replace(/^\s*\/\/.*$/gm, '')) as {
    include?: string[];
    exclude?: string[];
  };
  if (JSON.stringify(build.include) !== JSON.stringify(['src/**/*.ts'])) {
    problems.push('the build must include src alone');
  }
  if (!(build.exclude ?? []).includes('test/**/*.ts')) {
    problems.push('the build must exclude test/**/*.ts');
  }
  if (!ignoreFile.split('\n').some((line) => line.trim() === '**/test')) {
    problems.push("the image's ignore file must list **/test");
  }
  const pkg = JSON.parse(manifest) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  for (const name of BROWSER_LIBRARIES) {
    if (pkg.dependencies?.[name] !== undefined) problems.push(`${name} must not be a dependency`);
  }
  if (pkg.devDependencies?.['playwright'] === undefined) {
    problems.push('playwright must be a development dependency');
  }
  return problems;
};

const read = (...parts: string[]): string => readFileSync(join(APPS, ...parts), 'utf8');

describe('test code stays out of what ships', () => {
  it('no module under src imports test code or a browser library', () => {
    expect(testCodeImports(APPS)).toEqual([]);
  });

  it('the build, the image context and the manifest keep it out', () => {
    expect(
      configProblems(
        read('tsconfig.build.json'),
        readFileSync(join(APPS, '..', 'Dockerfile.dockerignore'), 'utf8'),
        read('package.json')
      )
    ).toEqual([]);
  });

  describe('control cases: each rule fails when broken', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'portal-guard-'));
    const entry = join(scratch, 'src', 'tenant');
    mkdirSync(entry, { recursive: true });
    mkdirSync(join(scratch, 'test'), { recursive: true });

    it('an entry point importing the test provider is named', () => {
      writeFileSync(
        join(entry, 'main.ts'),
        "import { startTestIdp } from '../../test/idpServer.js';\n"
      );
      expect(testCodeImports(scratch)).toEqual(['src/tenant/main.ts -> ../../test/idpServer.js']);
      rmSync(join(entry, 'main.ts'));
    });

    it('a dynamic import of test code or of the browser library is named', () => {
      writeFileSync(
        join(entry, 'app.ts'),
        "const a = await import('../../test/idp.js');\nconst b = await import('playwright');\n"
      );
      expect(testCodeImports(scratch)).toHaveLength(2);
      rmSync(join(entry, 'app.ts'));
    });

    it('an ordinary relative import inside src is not named', () => {
      writeFileSync(join(entry, 'ok.ts'), "import { x } from '../shell/app.js';\n");
      expect(testCodeImports(scratch)).toEqual([]);
      rmSync(scratch, { recursive: true });
    });

    it('config that lets test code or the browser library in is named', () => {
      const build = '{ "include": ["src/**/*.ts", "test/**/*.ts"], "exclude": [] }';
      const manifest = '{ "dependencies": { "playwright": "1.0.0" } }';
      expect(configProblems(build, '**/node_modules\n', manifest)).toEqual([
        'the build must include src alone',
        'the build must exclude test/**/*.ts',
        "the image's ignore file must list **/test",
        'playwright must not be a dependency',
        'playwright must be a development dependency',
      ]);
    });
  });
});
