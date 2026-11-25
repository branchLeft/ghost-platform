import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENT_BINARIES,
  MODEL_ENV_PREFIXES,
  MODEL_ENV_SUFFIXES,
  ModelKeyPresentError,
  assertModelFreeEnvironment,
} from '../../src/modelFreeEnvironment.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, '..', '..');
const srcDir = join(packageDir, 'src');
const fixture = join(here, 'fixtures', 'runReleaseScrubbedEnv.mjs');

/** Static `import ... from`, `export ... from`, a bare `import 'x'`, and a dynamic `import('x')`. */
function importSpecifiers(text: string): string[] {
  const pattern =
    /^\s*(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]/gm;
  return [...text.matchAll(pattern)].map((match) => (match[1] ?? match[2] ?? match[3]) as string);
}

let scratch: string;
let emptyBin: string;
let agentBin: string;
let compiledDir: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'ring-controller-modelfree-'));

  emptyBin = join(scratch, 'empty-bin');
  mkdirSync(emptyBin);

  agentBin = join(scratch, 'agent-bin');
  mkdirSync(agentBin);
  writeFileSync(join(agentBin, 'claude'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(agentBin, 'claude'), 0o755);

  // Real compiled source for the child process: the production TypeScript,
  // transpiled file by file, never a re-implementation.
  compiledDir = join(scratch, 'compiled');
  mkdirSync(compiledDir);
  writeFileSync(join(compiledDir, 'package.json'), '{"type":"module"}');
  for (const file of readdirSync(srcDir).filter((name) => name.endsWith('.ts'))) {
    const { outputText } = ts.transpileModule(readFileSync(join(srcDir, file), 'utf-8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
    });
    writeFileSync(join(compiledDir, file.replace(/\.ts$/, '.js')), outputText);
  }
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('assertModelFreeEnvironment', () => {
  it('passes an environment with no model key and no agent binary', () => {
    expect(() => assertModelFreeEnvironment({})).not.toThrow();
    expect(() =>
      assertModelFreeEnvironment({ PATH: emptyBin, HOME: '/nowhere', LANG: 'C' })
    ).not.toThrow();
  });

  it.each([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_ORG_ID',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'SOME_VENDOR_API_KEY',
    'anthropic_auth_token',
    'gemini_api_key',
  ])('refuses %s, naming the variable and never its value', (name) => {
    const secret = 'value-that-must-never-be-echoed';
    let thrown: unknown;
    try {
      assertModelFreeEnvironment({ [name]: secret });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ModelKeyPresentError);
    const error = thrown as ModelKeyPresentError;
    expect(error.source).toBe('environment');
    expect(error.name).toBe('ModelKeyPresentError');
    expect(error.message).toContain(name);
    expect(error.message).not.toContain(secret);
  });

  it('ignores a variable that is listed but undefined', () => {
    expect(() => assertModelFreeEnvironment({ ANTHROPIC_API_KEY: undefined })).not.toThrow();
  });

  it('does not mistake ordinary variables for model ones', () => {
    expect(() =>
      assertModelFreeEnvironment({
        HOME: '/h',
        API_KEY_ROTATION_DAYS: '30',
        NODE_ENV: 'production',
      })
    ).not.toThrow();
  });

  it('refuses an agent binary resolvable on PATH', () => {
    const path = [emptyBin, agentBin].join(delimiter);

    expect(() => assertModelFreeEnvironment({ PATH: path })).toThrow(ModelKeyPresentError);
    expect(() => assertModelFreeEnvironment({ PATH: path })).toThrow(
      /claude is resolvable on PATH/
    );
  });

  it('is not fooled by a claude that is not an executable file', () => {
    const notExecutable = join(scratch, 'plain-file');
    mkdirSync(notExecutable);
    writeFileSync(join(notExecutable, 'claude'), 'text');
    const aDirectory = join(scratch, 'dir-named-claude');
    mkdirSync(join(aDirectory, 'claude'), { recursive: true });

    expect(() =>
      assertModelFreeEnvironment({
        PATH: [notExecutable, aDirectory, '/nonexistent'].join(delimiter),
      })
    ).not.toThrow();
  });

  it('documents its deny-lists as constants', () => {
    expect(MODEL_ENV_SUFFIXES).toContain('_API_KEY');
    expect(MODEL_ENV_PREFIXES).toEqual(['ANTHROPIC_', 'OPENAI_', 'CLAUDE_CODE_']);
    expect(AGENT_BINARIES).toContain('claude');
  });
});

describe('D37 in a real child process', () => {
  const child = (scenario: string, env: Record<string, string>) => {
    const result = spawnSync(process.execPath, [fixture, compiledDir, scenario], {
      env,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  };

  it('promotes on green with no API key and no agent binary on PATH', () => {
    const seen = child('green', { PATH: emptyBin });

    expect(seen).toMatchObject({ refused: false, outcome: 'completed', gateRuns: 1, holds: [] });
    expect(seen['bumps']).toBe(3);
  });

  it('refuses on red with no API key and no agent binary on PATH, bumping nothing', () => {
    const seen = child('red', { PATH: emptyBin });

    expect(seen).toMatchObject({
      refused: false,
      outcome: 'held',
      reason: 'gate-red',
      gateRuns: 1,
      bumps: 0,
    });
    expect(seen['holds']).toEqual(['gate-red']);
  });

  it('refuses before any gate runs when the environment holds a model key', () => {
    const seen = child('green', { PATH: emptyBin, ANTHROPIC_API_KEY: 'sk-test-not-real' });

    expect(seen).toMatchObject({
      refused: true,
      error: 'ModelKeyPresentError',
      gateRuns: 0,
      bumps: 0,
    });
    expect(JSON.stringify(seen)).toContain('ANTHROPIC_API_KEY');
    expect(JSON.stringify(seen)).not.toContain('sk-test-not-real');
  });

  it('refuses before any gate runs when an agent binary is on PATH', () => {
    const seen = child('green', { PATH: [emptyBin, agentBin].join(delimiter) });

    expect(seen).toMatchObject({
      refused: true,
      error: 'ModelKeyPresentError',
      gateRuns: 0,
      bumps: 0,
    });
  });
});

describe('static: nothing a model, a network or a package could reach', () => {
  const sources = readdirSync(srcDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, text: readFileSync(join(srcDir, name), 'utf-8') }));

  it('declares no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
    };

    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });

  it('imports only node: modules and relative paths', () => {
    const bad = sources.flatMap(({ name, text }) =>
      importSpecifiers(text)
        .filter((target) => !target.startsWith('node:') && !target.startsWith('./'))
        .map((target) => `${name}: ${target}`)
    );

    expect(sources.length).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it('would notice a package import (control case for the scan above)', () => {
    const sample = [
      "import { a } from 'left-pad';",
      'import {',
      '  b,',
      "} from 'some-sdk';",
      "export * from 're-exported';",
      "import 'side-effect';",
      "const c = await import('dynamic-pkg');",
      "import { ok } from './fine.js';",
      "import { fs } from 'node:fs';",
      "const text = 'a message that says from recovery itself';",
    ].join('\n');

    expect(importSpecifiers(sample)).toEqual([
      'left-pad',
      'some-sdk',
      're-exported',
      'side-effect',
      'dynamic-pkg',
      './fine.js',
      'node:fs',
    ]);
  });

  it('reaches the process environment through no route but the one entry', () => {
    const scans = sources.map(({ name, text }) => ({ name, ...scanSource(name, text) }));

    expect(scans.flatMap(({ findings }) => findings)).toEqual([]);
    const readers = scans.filter(({ envReads }) => envReads > 0);
    expect(readers.map(({ name }) => name)).toEqual(['processEntry.ts']);
    expect(readers[0]?.envReads).toBe(1);
  });

  it('passes the entry its environment as it stands', () => {
    const entry = sources.find(({ name }) => name === 'processEntry.ts')?.text ?? '';
    expect(entry).toContain('const env: ModelFreeEnvironment = process.env;');
    expect(entry).toContain('return runRelease(release, deps, config, env);');
  });
});

const PROCESS_MODULES = new Set(['process', 'node:process']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'self', 'window']);

/** The literal text of a string or no-substitution template, or undefined when the key is computed. */
function literalText(node: ts.Node): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

interface SourceScan {
  /** Accesses to `process.env` (or `process['env']`) in this file. */
  envReads: number;
  /** Every other route to the environment, or to `process` itself, that fails closed. */
  findings: string[];
}

/**
 * Walks the TypeScript AST of one file. A bare `process` (alias, destructuring, argument, cast,
 * `globalThis.process` property) is a finding; `process.<name>` is a read only for `env`; a computed key
 * on `process` or on a global object is a finding; a module specifier naming `process` is a finding; and
 * `eval` or `Function(...)` is a finding, since either can rebuild the same access from a string.
 */
function scanSource(file: string, text: string): SourceScan {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const scan: SourceScan = { envReads: 0, findings: [] };
  const flag = (node: ts.Node, form: string) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    scan.findings.push(`${file}:${line} ${form}`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'process') {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        if (parent.name.text === 'env') scan.envReads += 1;
      } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        const key = literalText(parent.argumentExpression);
        if (key === 'env') scan.envReads += 1;
        else if (key === undefined) flag(node, 'computed key on process');
      } else {
        flag(node, 'bare process');
      }
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      PROCESS_MODULES.has(node.text)
    ) {
      flag(node, `module specifier ${node.text}`);
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_OBJECTS.has(node.expression.text) &&
      literalText(node.argumentExpression) === undefined
    ) {
      flag(node, 'computed key on a global object');
    }
    if (ts.isIdentifier(node) && node.text === 'eval') flag(node, 'eval');
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Function'
    ) {
      flag(node, 'Function constructor');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return scan;
}

/**
 * Whether a source file reaches the process environment other than through processEntry.ts: any
 * finding, or any `process.env` read outside the one entry.
 */
function flagsEnvironmentRead(file: string, text: string): boolean {
  const scan = scanSource(file, text);
  return scan.findings.length > 0 || (scan.envReads > 0 && file !== 'processEntry.ts');
}

describe('sabotage: each route to the environment off process is caught', () => {
  it.each([
    ['process.env', 'const e = process.env;'],
    ["process['env']", "const e = process['env'];"],
    ['process["env"]', 'const e = process["env"];'],
    ['process[`env`]', 'const e = process[`env`];'],
    ['optional chain', 'const e = process?.env;'],
    ['destructured env', 'const { env } = process;'],
    ['renamed destructured env', 'const { env: e } = process;'],
    [
      'named import of env from node:process',
      "import { env } from 'node:process';\nconst e = env;",
    ],
    ['named import of env from process', "import { env } from 'process';\nconst e = env;"],
    ['namespace import then .env', "import * as p from 'node:process';\nconst e = p.env;"],
    ['dynamic import of node:process', "const p = await import('node:process');\nconst e = p.env;"],
    ["globalThis['process'].env", "const e = globalThis['process'].env;"],
    ['computed key on globalThis', "const e = globalThis[['pro', 'cess'].join('')].env;"],
    ['Reflect.get', "const e = Reflect.get(process, 'env');"],
    ['alias of process', 'const p = process;\nconst e = p.env;'],
    ['type cast', 'const e = (process as any).env;'],
    ['computed key on process', "const k = 'env';\nconst e = process[k];"],
    ['eval through a global', "const e = eval('this').process?.['env'];"],
    ['Function constructor', "const e = Function('return this')().process?.['env'];"],
  ])('flags %s outside processEntry.ts', (_form, source) => {
    expect(flagsEnvironmentRead('someOtherFile.ts', source)).toBe(true);
  });

  it('does not flag ordinary process use (control)', () => {
    expect(
      flagsEnvironmentRead('someOtherFile.ts', 'process.exitCode = 1;\nprocess.on("exit", f);')
    ).toBe(false);
  });
});
