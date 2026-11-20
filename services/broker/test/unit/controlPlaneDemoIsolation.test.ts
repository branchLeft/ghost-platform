import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The demo estate never initiates (LLD-2 section 06) and the demo host holds
// no signing key. The provisioning step dials out with one, so it must not be
// reachable from anything the host's bundle is built from.

const src = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const BUNDLED_ENTRIES = [
  'server.ts',
  'plugins/renderCorePlugin.ts',
  'plugins/dockerImageLoader.ts',
  'plugins/ghostAdminApi.ts',
  'plugins/refusingDrainSource.ts',
];

function relativeImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)) {
    const spec = (match[1] as string).replace(/\.js$/, '.ts');
    found.push(resolve(dirname(file), spec));
  }
  return found;
}

function reachableFrom(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = entries.map((entry) => join(src, entry));
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.endsWith('.ts')) queue.push(...relativeImports(file));
  }
  return seen;
}

describe('the control-plane demo provisioning modules', () => {
  it("are not reachable from anything the demo host's bundle is built from", () => {
    const reached = [...reachableFrom(BUNDLED_ENTRIES)];
    expect(reached.length).toBeGreaterThan(10);
    expect(reached.filter((file) => file.includes('controlPlaneDemo'))).toEqual([]);
  });

  it('the walk does see an import that is there: it finds the signing module from the server', () => {
    expect([...reachableFrom(BUNDLED_ENTRIES)]).toContain(join(src, 'signing.ts'));
  });
});
