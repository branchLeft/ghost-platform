// The demo gate imports the built output of render-core and of the request
// guard, and CI builds both before it runs `pnpm run typecheck`. The package
// script has to build them itself, or a local run from a clean checkout fails
// before it type-checks anything. These guards read the script, so a change
// that drops either build fails here rather than in a local run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

const gate = readJson(path.join('services', 'demo-gate', 'package.json'));
const steps = gate.scripts.typecheck.split('&&').map((step) => step.trim());

function indexOfStep(step) {
  return steps.indexOf(step);
}

const TSC = indexOfStep('tsc --noEmit');

test('the demo-gate typecheck script type-checks with tsc', () => {
  assert.notEqual(TSC, -1, `typecheck must end with tsc --noEmit: ${gate.scripts.typecheck}`);
});

test('the demo-gate typecheck builds request-guard before it type-checks', () => {
  const build = indexOfStep('pnpm --dir ../request-guard run build');
  assert.notEqual(build, -1, `typecheck must build request-guard: ${gate.scripts.typecheck}`);
  assert.ok(build < TSC, 'the request-guard build must run before tsc');
});

test('the demo-gate typecheck builds render-core before it type-checks', () => {
  const build = indexOfStep('pnpm --dir ../../render-core run build');
  assert.notEqual(build, -1, `typecheck must build render-core: ${gate.scripts.typecheck}`);
  assert.ok(build < TSC, 'the render-core build must run before tsc');
});

test('the request-guard package still has the build script the typecheck calls', () => {
  const guard = readJson(path.join('services', 'request-guard', 'package.json'));
  assert.equal(typeof guard.scripts.build, 'string');
});
