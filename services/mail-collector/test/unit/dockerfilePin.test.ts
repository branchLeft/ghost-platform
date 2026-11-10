import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The base image the collector was last scanned on, by digest. The pin in the
// Dockerfile must equal it, so the image that was scanned is the image built.
const SCANNED_BASE =
  'node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216';

const dockerfile = readFileSync(
  fileURLToPath(new URL('../../Dockerfile', import.meta.url)),
  'utf8'
);

const fromLines = dockerfile.split('\n').filter((line) => /^FROM\s/.test(line));

describe('mail-collector Dockerfile base image', () => {
  it('has exactly one FROM line', () => {
    expect(fromLines).toHaveLength(1);
  });

  it('pins the base image by sha256 digest', () => {
    expect(fromLines[0]).toMatch(/^FROM node:[0-9.]+-alpine@sha256:[0-9a-f]{64}$/);
  });

  it('pins the same digest that was scanned', () => {
    expect(fromLines[0]).toBe(`FROM ${SCANNED_BASE}`);
  });
});
