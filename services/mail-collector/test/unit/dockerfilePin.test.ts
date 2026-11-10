import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The base image the collector was last scanned on, by digest. The pin in the
// Dockerfile must equal it, so the image that was scanned is the image built.
const SCANNED_BASE =
  'node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68';

const dockerfile = readFileSync(
  fileURLToPath(new URL('../../Dockerfile', import.meta.url)),
  'utf8',
);

const fromLines = dockerfile
  .split('\n')
  .filter((line) => /^FROM\s/.test(line));

describe('mail-collector Dockerfile base image', () => {
  it('has exactly one FROM line', () => {
    expect(fromLines).toHaveLength(1);
  });

  it('pins the base image by sha256 digest', () => {
    expect(fromLines[0]).toMatch(/^FROM node:[0-9.]+-bookworm-slim@sha256:[0-9a-f]{64}$/);
  });

  it('pins the same digest that was scanned', () => {
    expect(fromLines[0]).toBe(`FROM ${SCANNED_BASE}`);
  });
});
