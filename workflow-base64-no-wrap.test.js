import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// GNU base64 wraps at 76 columns, so an encoded credential long enough to wrap
// carries a newline into an HTTP header and git refuses to send the request.
const WORKFLOWS = path.join(import.meta.dirname, '.github', 'workflows');
const ENCODE = /\|\s*base64\b(?![^\n|)]*(?:\s-d\b|\s--decode\b))([^\n|)]*)/g;
const NO_WRAP = /\s(?:-w\s?0|--wrap=0)\b/;

function unwrappedEncodes(text) {
  const found = [];
  for (const match of text.matchAll(ENCODE)) {
    if (!NO_WRAP.test(match[1])) {
      found.push(text.slice(0, match.index).split('\n').length);
    }
  }
  return found;
}

test('every workflow that base64-encodes disables line wrapping', () => {
  const offenders = [];
  for (const name of fs.readdirSync(WORKFLOWS)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const lines = unwrappedEncodes(fs.readFileSync(path.join(WORKFLOWS, name), 'utf8'));
    for (const line of lines) offenders.push(`${name}:${line}`);
  }
  assert.deepEqual(offenders, []);
});

test('the matcher still finds a wrapping encode, and ignores decodes', () => {
  assert.deepEqual(unwrappedEncodes('A="$(printf x | base64)"'), [1]);
  assert.deepEqual(unwrappedEncodes('A=$(printf x | base64 -w0)'), []);
  assert.deepEqual(unwrappedEncodes('A=$(printf x | base64 --wrap=0)'), []);
  assert.deepEqual(unwrappedEncodes('base64 -d < in > out\ncat f | base64 -d'), []);
});
