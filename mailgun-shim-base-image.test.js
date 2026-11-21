// Guards the shape of services/mailgun-shim/Dockerfile's base image: the FROM
// line is the node alpine base, pinned by a sha256 digest. It does not pin
// which digest. The image scan gate scans the image that ships, so a digest
// bump (for example from Dependabot) changes the pin without failing this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DOCKERFILE = path.join(import.meta.dirname, 'services', 'mailgun-shim', 'Dockerfile');

function fromLines(text) {
  return text
    .split('\n')
    .filter((line) => /^FROM\s/.test(line))
    .map((line) => line.replace(/^FROM\s+/, '').trim());
}

test('mailgun-shim base image is the node alpine base pinned by a sha256 digest', () => {
  const froms = fromLines(fs.readFileSync(DOCKERFILE, 'utf8'));
  assert.equal(froms.length, 1, 'expected exactly one FROM line');
  assert.match(froms[0], /^node:[0-9.]+-alpine@sha256:[0-9a-f]{64}$/);
});

// The image scan fails on any high finding with a fix in the base's index. The
// alpine base ships libcrypto3 and libssl3 below their fixed release, so the
// Dockerfile must upgrade them alongside zlib before the scan runs.
test('mailgun-shim Dockerfile upgrades the OpenSSL packages the image scan flags', () => {
  const text = fs.readFileSync(DOCKERFILE, 'utf8');
  assert.match(text, /^RUN apk upgrade --no-cache zlib libcrypto3 libssl3$/m);
});
