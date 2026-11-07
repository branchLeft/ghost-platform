import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as api from '../index.js';

const declarations = readFileSync(new URL('../index.d.ts', import.meta.url), 'utf8');

/** The names a declaration file exports, split into values and types. */
function declared() {
  const values = new Set();
  const types = new Set();
  for (const match of declarations.matchAll(
    /^export (?:declare )?(const|function|class|interface|type) (\w+)/gm
  )) {
    const [, kind, name] = /** @type {[string, string, string]} */ (match);
    (kind === 'interface' || kind === 'type' ? types : values).add(name);
  }
  return { values: [...values].sort(), types: [...types] };
}

test('index.d.ts declares exactly the values index.js exports', () => {
  assert.deepEqual(declared().values, Object.keys(api).sort());
});

test('the drift guard sees a name that is declared but not exported, and the reverse', () => {
  const exported = Object.keys(api).sort();
  assert.notDeepEqual([...exported, 'phantom'].sort(), declared().values);
  assert.notDeepEqual(exported.slice(1), declared().values);
});

test('index.d.ts declares the option and client types too', () => {
  assert.deepEqual(declared().types.sort(), [
    'AdminApiClient',
    'AdminApiClientOptions',
    'AdminApiOutcome',
  ]);
});
