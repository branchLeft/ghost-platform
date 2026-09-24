import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DescriptorStore } from '../../src/descriptorStore.js';

const BASE_DOMAIN = 'sites.publicpress.co.uk';

let dir: string;
let skipped: Array<{ file: string; reason: string }>;

function write(name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

function makeStore(descriptorDir = dir): DescriptorStore {
  return new DescriptorStore({
    descriptorDir,
    baseDomain: BASE_DOMAIN,
    onSkippedFile: (file, reason) => skipped.push({ file, reason }),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'odask-descriptors-'));
  skipped = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('DescriptorStore', () => {
  it('starts empty and answers has() as false for everything before the first refresh', () => {
    const store = makeStore();
    expect(store.size).toBe(0);
    expect(store.has('tenant-one.sites.publicpress.co.uk')).toBe(false);
  });

  it('serves an "ours" descriptor composed with the base domain', async () => {
    write(
      't1.json',
      JSON.stringify({ hostname: { kind: 'ours', sub: 'tenant-one', gated: false } })
    );
    const store = makeStore();
    await store.refresh();
    expect(store.has('tenant-one.sites.publicpress.co.uk')).toBe(true);
    expect(store.size).toBe(1);
  });

  it('serves a "theirs" descriptor on its own fqdn, case- and dot-normalized', async () => {
    write(
      't2.json',
      JSON.stringify({
        hostname: {
          kind: 'theirs',
          fqdn: 'Blog.Trypublicpress.co.uk.',
          verifiedAt: '2026-01-01T00:00:00Z',
        },
      })
    );
    const store = makeStore();
    await store.refresh();
    expect(store.has('blog.trypublicpress.co.uk')).toBe(true);
  });

  it('ignores non-.json files in the directory', async () => {
    write(
      't1.json',
      JSON.stringify({ hostname: { kind: 'ours', sub: 'tenant-one', gated: false } })
    );
    write('README.md', 'not a descriptor');
    write('.DS_Store', '');
    const store = makeStore();
    await store.refresh();
    expect(store.size).toBe(1);
  });

  it('excludes one file with invalid JSON without affecting the others', async () => {
    write(
      'good.json',
      JSON.stringify({ hostname: { kind: 'ours', sub: 'tenant-one', gated: false } })
    );
    write('bad.json', '{ not json');
    const store = makeStore();
    await store.refresh();
    expect(store.has('tenant-one.sites.publicpress.co.uk')).toBe(true);
    expect(store.size).toBe(1);
    expect(skipped).toEqual([
      expect.objectContaining({
        file: 'bad.json',
        reason: expect.stringContaining('not valid JSON'),
      }),
    ]);
  });

  it.each([
    ['{}', 'a file with no hostname field at all'],
    ['{"hostname": null}', 'a null hostname'],
    ['{"hostname": "tenant-one.example"}', 'a hostname that is a bare string, not an object'],
    ['{"hostname": {"kind": "unknown"}}', 'an unrecognized kind'],
    ['{"hostname": {"kind": "ours"}}', 'an "ours" hostname missing sub'],
    ['{"hostname": {"kind": "ours", "sub": ""}}', 'an "ours" hostname with an empty sub'],
    ['{"hostname": {"kind": "ours", "sub": 5}}', 'an "ours" hostname with a non-string sub'],
    ['{"hostname": {"kind": "theirs"}}', 'a "theirs" hostname missing fqdn'],
    ['{"hostname": {"kind": "theirs", "fqdn": ""}}', 'a "theirs" hostname with an empty fqdn'],
  ])('excludes a file with a malformed hostname shape: %s (%s)', async (content) => {
    write('bad.json', content);
    const store = makeStore();
    await store.refresh();
    expect(store.size).toBe(0);
    expect(skipped[0]?.reason).toContain('malformed hostname');
  });

  it('excludes a file whose derived hostname is not well-formed', async () => {
    // A sub containing a character the label pattern refuses -- corrupt
    // input still must not enter the served set (defence in depth beside
    // whatever admitted it to the descriptor directory in the first place).
    write(
      'bad.json',
      JSON.stringify({ hostname: { kind: 'ours', sub: 'bad sub name', gated: false } })
    );
    const store = makeStore();
    await store.refresh();
    expect(store.size).toBe(0);
    expect(skipped[0]?.reason).toContain('not a well-formed hostname');
  });

  it('a directory-read failure keeps the previous set rather than clearing it', async () => {
    write(
      't1.json',
      JSON.stringify({ hostname: { kind: 'ours', sub: 'tenant-one', gated: false } })
    );
    const store = makeStore();
    await store.refresh();
    expect(store.has('tenant-one.sites.publicpress.co.uk')).toBe(true);

    // The directory becomes unreadable between refreshes (a mount hiccup,
    // a permissions change) -- a transient read error must not turn every
    // hostname unserved.
    rmSync(dir, { recursive: true, force: true });
    await store.refresh();
    expect(store.has('tenant-one.sites.publicpress.co.uk')).toBe(true);
    expect(store.size).toBe(1);
    expect(skipped.at(-1)?.reason).toContain('directory unreadable');
  });

  it('a later refresh drops a hostname whose descriptor file was removed', async () => {
    write(
      't1.json',
      JSON.stringify({ hostname: { kind: 'ours', sub: 'tenant-one', gated: false } })
    );
    const store = makeStore();
    await store.refresh();
    expect(store.has('tenant-one.sites.publicpress.co.uk')).toBe(true);

    rmSync(join(dir, 't1.json'));
    await store.refresh();
    expect(store.has('tenant-one.sites.publicpress.co.uk')).toBe(false);
    expect(store.size).toBe(0);
  });

  it('the default onSkippedFile logs to console.warn rather than throwing', async () => {
    write('bad.json', '{ not json');
    const store = new DescriptorStore({ descriptorDir: dir, baseDomain: BASE_DOMAIN });
    await expect(store.refresh()).resolves.toBeUndefined();
  });
});
