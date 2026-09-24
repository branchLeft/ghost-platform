import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DescriptorStore } from '../../src/descriptorStore.js';

const PLATFORM_ZONE = 'sites.publicpress.co.uk';
const OWNED_DOMAINS = ['publicpress.co.uk', 'trypublicpress.co.uk'];
const MAX_STALENESS_MS = 60_000;

let dir: string;
let skipped: Array<{ file: string; reason: string }>;
let nowMs: number;

function write(name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

function makeStore(
  overrides: Partial<{
    descriptorDir: string;
    platformZone: string;
    ownedDomains: readonly string[];
    maxStalenessMs: number;
  }> = {}
): DescriptorStore {
  return new DescriptorStore({
    descriptorDir: dir,
    platformZone: PLATFORM_ZONE,
    ownedDomains: OWNED_DOMAINS,
    maxStalenessMs: MAX_STALENESS_MS,
    now: () => nowMs,
    onSkippedFile: (file, reason) => skipped.push({ file, reason }),
    ...overrides,
  });
}

function tenantDescriptorJson(hostname: unknown): string {
  return JSON.stringify({ kind: 'tenant', hostname });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'odask-descriptors-'));
  skipped = [];
  nowMs = 1_000_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('DescriptorStore', () => {
  it('starts empty and answers has() as false for everything before the first refresh', () => {
    const store = makeStore();
    expect(store.size).toBe(0);
    expect(store.has('tenant-one.sites.publicpress.co.uk')).toBe(false);
    expect(store.isStale).toBe(true);
  });

  it('serves a tenant\'s "ours" descriptor composed with the platform zone', async () => {
    write('t1.json', tenantDescriptorJson({ kind: 'ours', sub: 'tenant-one', gated: false }));
    const store = makeStore();
    await store.refresh();
    expect(store.has('tenant-one.sites.publicpress.co.uk')).toBe(true);
    expect(store.size).toBe(1);
    expect(store.isStale).toBe(false);
  });

  it('serves a tenant\'s "theirs" descriptor on its own fqdn', async () => {
    write(
      't2.json',
      tenantDescriptorJson({
        kind: 'theirs',
        fqdn: 'blog.acme.example',
        verifiedAt: '2026-01-01T00:00:00Z',
      })
    );
    const store = makeStore();
    await store.refresh();
    expect(store.has('blog.acme.example')).toBe(true);
  });

  it('excludes a "theirs" fqdn with an uppercase label or a trailing dot -- render-core\'s shape rules, not a tolerant normalizer', async () => {
    write(
      'uppercase.json',
      tenantDescriptorJson({
        kind: 'theirs',
        fqdn: 'Blog.Acme.Example',
        verifiedAt: '2026-01-01T00:00:00Z',
      })
    );
    write(
      'dot.json',
      tenantDescriptorJson({
        kind: 'theirs',
        fqdn: 'blog.acme.example.',
        verifiedAt: '2026-01-01T00:00:00Z',
      })
    );
    const store = makeStore();
    await store.refresh();
    expect(store.size).toBe(0);
  });

  it('never serves a demo descriptor\'s "ours" hostname -- demo slots sit under the platform wildcard, not a per-hostname cert', async () => {
    write(
      'demo.json',
      JSON.stringify({
        kind: 'demo',
        hostname: { kind: 'ours', sub: 'slot-7', gated: true },
      })
    );
    const store = makeStore();
    await store.refresh();
    expect(store.has('slot-7.sites.publicpress.co.uk')).toBe(false);
    expect(store.size).toBe(0);
    expect(skipped[0]?.reason).toContain('not eligible');
  });

  it('never serves a multi-label "ours" sub -- a single DNS label only', async () => {
    write('t1.json', tenantDescriptorJson({ kind: 'ours', sub: 'a.b', gated: false }));
    const store = makeStore();
    await store.refresh();
    expect(store.has('a.b.sites.publicpress.co.uk')).toBe(false);
    expect(store.size).toBe(0);
  });

  it('never serves a "theirs" fqdn that is one of the platform\'s owned domains', async () => {
    write(
      't1.json',
      tenantDescriptorJson({
        kind: 'theirs',
        fqdn: 'trypublicpress.co.uk',
        verifiedAt: '2026-01-01T00:00:00Z',
      })
    );
    const store = makeStore();
    await store.refresh();
    expect(store.has('trypublicpress.co.uk')).toBe(false);
    expect(store.size).toBe(0);
  });

  it('ignores non-.json files in the directory', async () => {
    write('t1.json', tenantDescriptorJson({ kind: 'ours', sub: 'tenant-one', gated: false }));
    write('README.md', 'not a descriptor');
    write('.DS_Store', '');
    const store = makeStore();
    await store.refresh();
    expect(store.size).toBe(1);
  });

  it('excludes one file with invalid JSON without affecting the others', async () => {
    write('good.json', tenantDescriptorJson({ kind: 'ours', sub: 'tenant-one', gated: false }));
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
    ['{}', 'no kind or hostname field at all'],
    ['{"kind": "tenant"}', 'missing hostname entirely'],
    [
      '{"kind": "Tenant", "hostname": {"kind": "ours", "sub": "t", "gated": false}}',
      'an unrecognized kind (case)',
    ],
    ['{"kind": "tenant", "hostname": null}', 'a null hostname'],
    [
      '{"kind": "tenant", "hostname": "tenant-one.example"}',
      'a hostname that is a bare string, not an object',
    ],
    ['{"kind": "tenant", "hostname": {"kind": "unknown"}}', 'an unrecognized hostname kind'],
    ['{"kind": "tenant", "hostname": {"kind": "ours"}}', 'an "ours" hostname missing sub'],
    [
      '{"kind": "tenant", "hostname": {"kind": "ours", "sub": ""}}',
      'an "ours" hostname with an empty sub',
    ],
    [
      '{"kind": "tenant", "hostname": {"kind": "ours", "sub": 5}}',
      'an "ours" hostname with a non-string sub',
    ],
    ['{"kind": "tenant", "hostname": {"kind": "theirs"}}', 'a "theirs" hostname missing fqdn'],
    [
      '{"kind": "tenant", "hostname": {"kind": "theirs", "fqdn": ""}}',
      'a "theirs" hostname with an empty fqdn',
    ],
  ])('excludes a file with a malformed kind/hostname shape: %s (%s)', async (content) => {
    write('bad.json', content);
    const store = makeStore();
    await store.refresh();
    expect(store.size).toBe(0);
    expect(skipped[0]?.reason).toContain('malformed kind/hostname');
  });

  it('excludes a file whose derived hostname is not well-formed', async () => {
    // A malformed "theirs" fqdn -- corrupt input still must not enter the
    // served set (defence in depth beside whatever admitted it to the
    // descriptor directory in the first place).
    write(
      'bad.json',
      tenantDescriptorJson({
        kind: 'theirs',
        fqdn: '203.0.113.5',
        verifiedAt: '2026-01-01T00:00:00Z',
      })
    );
    const store = makeStore();
    await store.refresh();
    expect(store.size).toBe(0);
    expect(skipped[0]?.reason).toContain('not eligible');
  });

  it('excludes an "ours" composition that exceeds 253 characters -- render-core\'s "ours" branch never checks the composed length, only the sub label', async () => {
    // render-core's servedHostnameOf validates hostname.sub as a single
    // label (<=63 chars) but composes it with platformZone unchecked --
    // that composition is this service's own deployment property, not
    // something render-core's descriptor-shaped rules have an opinion on.
    // A long-enough platformZone plus a max-length sub still produces an
    // over-length hostname, which is exactly what this second, odask-side
    // check exists to catch.
    const longZone = `${'a'.repeat(60)}.${'a'.repeat(60)}.${'a'.repeat(60)}.${'a'.repeat(16)}`;
    write('t1.json', tenantDescriptorJson({ kind: 'ours', sub: 'a'.repeat(63), gated: false }));
    const store = makeStore({ platformZone: longZone });
    await store.refresh();
    expect(store.size).toBe(0);
    expect(skipped[0]?.reason).toContain('not a well-formed hostname');
  });

  it.each([
    ['null', 'null'],
    ['a bare string', '"just a string"'],
    ['a number', '42'],
    ['an array', '[]'],
  ])('excludes a file whose top-level JSON is %s, not an object', async (_label, json) => {
    write('bad.json', json);
    const store = makeStore();
    await store.refresh();
    expect(store.size).toBe(0);
    expect(skipped[0]?.reason).toContain('malformed kind/hostname');
  });

  it('a directory-read failure keeps the previous set intact until it goes stale', async () => {
    write('t1.json', tenantDescriptorJson({ kind: 'ours', sub: 'tenant-one', gated: false }));
    const store = makeStore();
    await store.refresh();
    expect(store.has('tenant-one.sites.publicpress.co.uk')).toBe(true);

    // The directory becomes unreadable between refreshes (a mount hiccup,
    // a permissions change) -- a transient read error must not turn every
    // hostname unserved immediately.
    rmSync(dir, { recursive: true, force: true });
    await store.refresh();
    expect(store.has('tenant-one.sites.publicpress.co.uk')).toBe(true);
    expect(store.size).toBe(1);
    expect(skipped.at(-1)?.reason).toContain('directory unreadable');
  });

  it('fails closed once the last good refresh is further in the past than maxStalenessMs', async () => {
    write('t1.json', tenantDescriptorJson({ kind: 'ours', sub: 'tenant-one', gated: false }));
    const store = makeStore({ maxStalenessMs: 1000 });
    await store.refresh();
    expect(store.has('tenant-one.sites.publicpress.co.uk')).toBe(true);
    expect(store.isStale).toBe(false);

    rmSync(dir, { recursive: true, force: true });
    nowMs += 500;
    await store.refresh();
    // Still within the staleness bound -- a transient outage this short
    // must not flip a real, previously-served hostname to refused.
    expect(store.has('tenant-one.sites.publicpress.co.uk')).toBe(true);

    nowMs += 600; // 1100ms since the last good refresh, past the 1000ms bound
    await store.refresh();
    expect(store.isStale).toBe(true);
    expect(store.has('tenant-one.sites.publicpress.co.uk')).toBe(false);
  });

  it('says "never refreshed" rather than "stale" when the very first read fails', async () => {
    const store = makeStore({ descriptorDir: join(dir, 'does-not-exist') });
    await store.refresh();
    expect(skipped[0]?.reason).toContain('never refreshed');
    expect(skipped[0]?.reason).not.toContain('stale');
  });

  it('fails closed at boot -- no refresh has ever succeeded, regardless of maxStalenessMs', () => {
    const store = makeStore({ maxStalenessMs: 10_000_000 });
    expect(store.isStale).toBe(true);
    expect(store.has('anything.sites.publicpress.co.uk')).toBe(false);
  });

  it('a later refresh drops a hostname whose descriptor file was removed', async () => {
    write('t1.json', tenantDescriptorJson({ kind: 'ours', sub: 'tenant-one', gated: false }));
    const store = makeStore();
    await store.refresh();
    expect(store.has('tenant-one.sites.publicpress.co.uk')).toBe(true);

    rmSync(join(dir, 't1.json'));
    await store.refresh();
    expect(store.has('tenant-one.sites.publicpress.co.uk')).toBe(false);
    expect(store.size).toBe(0);
  });

  it('an overlapping refresh joins the one already in flight rather than racing it', async () => {
    write('t1.json', tenantDescriptorJson({ kind: 'ours', sub: 'tenant-one', gated: false }));
    const store = makeStore();

    // Two refreshes fired back to back, neither awaited before the other
    // starts -- exactly what a slow read plus a fixed-interval timer
    // produces in server.ts. Both must observe the same, single completed
    // read rather than one clobbering the other's result.
    const first = store.refresh();
    const second = store.refresh();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(store.has('tenant-one.sites.publicpress.co.uk')).toBe(true);
    expect(store.size).toBe(1);
  });

  it('a slow refresh does not let a fast later one install a stale set on top of it', async () => {
    write('t1.json', tenantDescriptorJson({ kind: 'ours', sub: 'tenant-one', gated: false }));
    const store = makeStore();

    const first = store.refresh();
    // Remove the file and refresh again only after the first has settled
    // -- the in-flight guard means this is a genuinely separate refresh,
    // not a race with the first, so its result must be the one that wins.
    await first;
    rmSync(join(dir, 't1.json'));
    await store.refresh();
    expect(store.has('tenant-one.sites.publicpress.co.uk')).toBe(false);
  });

  it('the default onSkippedFile logs to console.warn rather than throwing', async () => {
    write('bad.json', '{ not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new DescriptorStore({
      descriptorDir: dir,
      platformZone: PLATFORM_ZONE,
      ownedDomains: OWNED_DOMAINS,
      maxStalenessMs: MAX_STALENESS_MS,
    });
    await expect(store.refresh()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('defaults `now` to Date.now', async () => {
    write('t1.json', tenantDescriptorJson({ kind: 'ours', sub: 'tenant-one', gated: false }));
    const store = new DescriptorStore({
      descriptorDir: dir,
      platformZone: PLATFORM_ZONE,
      ownedDomains: OWNED_DOMAINS,
      maxStalenessMs: MAX_STALENESS_MS,
      onSkippedFile: () => {},
    });
    await store.refresh();
    expect(store.has('tenant-one.sites.publicpress.co.uk')).toBe(true);
  });
});
