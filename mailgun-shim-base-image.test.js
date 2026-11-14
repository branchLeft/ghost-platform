// Guards services/mailgun-shim/Dockerfile's base image. The base must be pinned
// by digest, and the digest must be the one the image was last scanned against,
// so the scan's findings describe the image that ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DOCKERFILE = path.join(import.meta.dirname, 'services', 'mailgun-shim', 'Dockerfile');

// The digest the base was scanned at with Grype (see the PR body's findings table).
const SCANNED_BASE =
  'node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216';

function fromLines(text) {
  return text
    .split('\n')
    .filter((line) => /^FROM\s/.test(line))
    .map((line) => line.replace(/^FROM\s+/, '').trim());
}

test('mailgun-shim base image is pinned by digest', () => {
  const froms = fromLines(fs.readFileSync(DOCKERFILE, 'utf8'));
  assert.equal(froms.length, 1, 'expected exactly one FROM line');
  assert.match(froms[0], /^node:[0-9.]+-alpine@sha256:[0-9a-f]{64}$/);
});

test('mailgun-shim base image digest equals the scanned digest', () => {
  const froms = fromLines(fs.readFileSync(DOCKERFILE, 'utf8'));
  assert.equal(froms[0], SCANNED_BASE);
});
