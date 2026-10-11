import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');
const REPO_ROOT = path.resolve(HERE, '../../../..');
const NOTICE = fs.readFileSync(
  path.join(SRC, 'THIRD-PARTY-LICENSE-ThreatExchange-PDQ.txt'),
  'utf8'
);
const SOURCE = fs.readFileSync(path.join(SRC, 'pdq-hash.js'), 'utf8');

// The upstream repository's root LICENSE at the commit the port was made
// from. Pinned by hash, so an edited or truncated notice fails here.
const UPSTREAM_LICENSE_SHA256 = '68ecc6aafbd2a205a1077f86127030898f03091b7dae9d9017325a8702d8668f';

describe('the BSD notice for the ported PDQ code', () => {
  const separator = '----------------------------------------------------------------\n\n';

  it('carries the upstream licence text byte for byte', () => {
    const body = NOTICE.slice(NOTICE.indexOf(separator) + separator.length);
    expect(crypto.createHash('sha256').update(body).digest('hex')).toBe(UPSTREAM_LICENSE_SHA256);
  });

  it('keeps the copyright line, the three conditions and the disclaimer', () => {
    expect(NOTICE).toContain('Copyright (c) Meta Platforms, Inc. and affiliates.');
    expect(NOTICE).toContain(
      'Redistributions of source code must retain the above copyright notice'
    );
    expect(NOTICE).toContain(
      'Redistributions in binary form must reproduce the above copyright notice'
    );
    expect(NOTICE).toContain('Neither the name Facebook nor the names of its contributors');
    expect(NOTICE).toContain(
      'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"'
    );
  });

  it('names the commit the port was made from', () => {
    expect(NOTICE).toContain('bd0108ff1745135a421856586d19d820dd62c6de');
  });

  it('is named by the ported source file, which keeps the copyright line', () => {
    expect(SOURCE).toContain('Copyright (c) Meta Platforms, Inc. and affiliates');
    expect(SOURCE).toContain('THIRD-PARTY-LICENSE-ThreatExchange-PDQ.txt');
  });

  it('ships with the code: the image build copies the whole src directory, and nothing ignores the notice', () => {
    const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^COPY .*adapters\/scanning-storage\/src\/ /m);
    const ignored = fs.readFileSync(path.join(REPO_ROOT, '.dockerignore'), 'utf8').split('\n');
    const covers = ignored.filter(
      (line) => line && !line.startsWith('#') && /\.txt$|^THIRD-PARTY|^adapters|^\*$/.test(line)
    );
    expect(covers).toEqual([]);
  });
});
