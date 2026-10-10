// Proves the pin in kalotyp.sha256 is the one the vendored files match, and
// that the check rejects a tampered copy. The Dockerfile runs the same check
// with sha256sum at build time; this test is the CI-side proof of the same
// property, with its sabotage case alongside so a check that always passes
// cannot go unnoticed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PIN_FILE = path.join(HERE, 'kalotyp.sha256');

// Format written by `sha256sum`: "<64 hex>  <name>" per line.
function readPins(file) {
  const pins = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line === '') continue;
    const m = /^([0-9a-f]{64})  (\S+)$/.exec(line);
    assert.ok(m, `malformed pin line: ${JSON.stringify(line)}`);
    pins.set(m[2], m[1]);
  }
  return pins;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// The same comparison `sha256sum -c` makes: returns the names that do not match.
function mismatches(dir, pins) {
  const bad = [];
  for (const [name, want] of pins) {
    if (sha256(path.join(dir, name)) !== want) bad.push(name);
  }
  return bad;
}

describe('vendored Kalotyp pins', () => {
  const pins = readPins(PIN_FILE);

  it('pins exactly the two shipped assets, by name', () => {
    assert.deepEqual([...pins.keys()].sort(), ['kalotyp.css', 'kalotyp.js']);
  });

  it('vendored bytes match their pins (green)', () => {
    assert.deepEqual(mismatches(HERE, pins), []);
  });

  it('a tampered copy fails the pin check (red)', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'kalotyp-sabotage-'));
    try {
      copyFileSync(path.join(HERE, 'kalotyp.js'), path.join(scratch, 'kalotyp.js'));
      copyFileSync(path.join(HERE, 'kalotyp.css'), path.join(scratch, 'kalotyp.css'));
      // One appended byte is enough to change the digest.
      const tampered = path.join(scratch, 'kalotyp.js');
      appendFileSync(tampered, '\n');
      assert.deepEqual(mismatches(scratch, pins), ['kalotyp.js']);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('the Dockerfile copies the vendored files into the admin assets path under the same guard', () => {
    const dockerfile = readFileSync(path.join(HERE, '..', '..', 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /sha256sum -c kalotyp\.sha256/);
    assert.match(dockerfile, /vendor\/kalotyp\/kalotyp\.sha256/);
    assert.match(dockerfile, /core\/built\/admin\/assets\/kalotyp\//);
  });
});
