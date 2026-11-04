// The image harness reads `docker logs` through execFileSync. A container log
// past Node's default 1 MiB maxBuffer must not make that throw ENOBUFS. A fake
// docker on PATH prints a log larger than that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dockerSync } from './test-support/image-harness.mjs';

test('a container log larger than 1 MiB is read whole', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-docker-'));
  const fake = path.join(dir, 'docker');
  fs.writeFileSync(fake, '#!/bin/sh\nhead -c 3145728 /dev/zero | tr "\\000" x\n', { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${saved}`;
  try {
    const out = dockerSync('docker logs', 'logs', 'a-container');
    assert.equal(out.length, 3145728);
  } finally {
    process.env.PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
