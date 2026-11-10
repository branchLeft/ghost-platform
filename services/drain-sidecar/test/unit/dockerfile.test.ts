import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The digest the image scan was run against. The Dockerfile must pin exactly
// this digest, so the scan's findings describe the base that ships.
const SCANNED_BASE_DIGEST =
  'sha256:b2646ba6d774dc22c24d89fc37103fcf4c4467e870c78b9519aa403300b2835a';

const here = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(resolve(here, '../../Dockerfile'), 'utf8');

function fromLines(source: string): string[] {
  return source.split('\n').filter((line) => /^FROM\s/.test(line));
}

describe('Dockerfile base image', () => {
  it('pins the base by digest, not by tag alone', () => {
    const froms = fromLines(dockerfile);
    expect(froms).toHaveLength(1);
    expect(froms[0]).toMatch(/^FROM node:[0-9.]+-alpine@sha256:[0-9a-f]{64}$/);
  });

  it('pins the digest the image scan was run against', () => {
    expect(fromLines(dockerfile)[0]).toBe(
      `FROM node:26.13.0-alpine@${SCANNED_BASE_DIGEST}`,
    );
  });

  it('upgrades zlib before the package manager is used', () => {
    const zlibAt = dockerfile.indexOf('RUN apk upgrade --no-cache zlib');
    const pnpmAt = dockerfile.indexOf('RUN npm install --global pnpm@');
    expect(zlibAt).toBeGreaterThan(-1);
    expect(pnpmAt).toBeGreaterThan(zlibAt);
  });

  it('removes npm from the shipped image after pnpm is installed and used', () => {
    const removeAt = dockerfile.indexOf('/usr/local/lib/node_modules/npm');
    const pruneAt = dockerfile.indexOf('RUN pnpm prune --prod');
    expect(removeAt).toBeGreaterThan(pruneAt);
    expect(dockerfile.indexOf('USER node')).toBeGreaterThan(removeAt);
  });
});
