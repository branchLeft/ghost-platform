import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The digest the image scan was run against. The Dockerfile must pin exactly
// this digest, so the scan's findings describe the base that ships.
const SCANNED_BASE_DIGEST =
  'sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68';

const here = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(resolve(here, '../../Dockerfile'), 'utf8');

function fromLines(source: string): string[] {
  return source.split('\n').filter((line) => /^FROM\s/.test(line));
}

describe('Dockerfile base image', () => {
  it('pins the base by digest, not by tag alone', () => {
    const froms = fromLines(dockerfile);
    expect(froms).toHaveLength(1);
    expect(froms[0]).toMatch(/^FROM node:[0-9.]+-bookworm-slim@sha256:[0-9a-f]{64}$/);
  });

  it('pins the digest the image scan was run against', () => {
    expect(fromLines(dockerfile)[0]).toBe(
      `FROM node:26.13.0-bookworm-slim@${SCANNED_BASE_DIGEST}`,
    );
  });

  it('upgrades the bundled npm before pnpm is installed', () => {
    const npmAt = dockerfile.indexOf('RUN npm install --global npm@12.2.2');
    const pnpmAt = dockerfile.indexOf('RUN npm install --global pnpm@');
    expect(npmAt).toBeGreaterThan(-1);
    expect(pnpmAt).toBeGreaterThan(npmAt);
  });
});
