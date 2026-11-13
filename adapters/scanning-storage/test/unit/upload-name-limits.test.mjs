import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeStorageBase } from '../helpers/fake-storage-base.mjs';
import {
  FakeWrappedAdapter,
  makeLoadWrappedAdapterClass,
} from '../helpers/fake-wrapped-adapter.mjs';

const require = createRequire(import.meta.url);
const { defineScanningStorageAdapter } = require('../../src/scanning-storage.js');
const { FakeVerdictClient } = require('../../src/verdict-client.js');
const { SafetyPolicy } = require('../../src/policy.js');
const { createPdqKnownMaterialCheck } = require('../../src/checks.js');
const { digestBytes } = require('../../src/pdq.js');
const GhostErrors = require('@tryghost/errors');

const CLEAN_BYTES = Buffer.from('clean-image-bytes');
const DIR = 'content/images/2019/01';
const COMPONENT = /-([a-z2-7]{22})(?=[._-])/;

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-name-limits-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function buildAdapter({ reservationMaxEntries } = {}) {
  const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
    loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
    GhostErrors,
  });
  const verdictClient = new FakeVerdictClient({ refuse: new Map(), unavailable: [] });
  return new Adapter({
    wraps: 'FakeAdapter',
    wrappedConfig: { storagePath: 'wrapped' },
    quarantinePath: path.join(tmpDir, 'quarantine'),
    checks: [createPdqKnownMaterialCheck(verdictClient, { computeDigest: digestBytes })],
    policy: new SafetyPolicy(),
    computeDigest: digestBytes,
    holdLogger: { error: () => {} },
    reservationMaxEntries,
  });
}

async function tempFile(name) {
  const filePath = path.join(tmpDir, `src-${crypto.randomBytes(4).toString('hex')}`);
  await fs.writeFile(filePath, CLEAN_BYTES);
  return { name, path: filePath, type: 'image/png' };
}

// Ghost's media inliner and oEmbed thumbnail code: a name and a directory, no
// temp file, then the bytes written to the path that came back.
async function inline(adapter, name) {
  const target = await adapter.getUniqueFileName({ name }, DIR);
  await adapter.saveRaw(CLEAN_BYTES, target);
  return target;
}

describe('inlined media of one name', () => {
  it('gets an unrelated random component each time, and no -1 suffix to follow', async () => {
    const adapter = buildAdapter();
    const first = await inline(adapter, 'hero.jpg');
    const second = await inline(adapter, 'hero.jpg');
    expect(second).not.toBe(first);
    // A URL that is the first with a counter added would let anyone who sees
    // the second derive the first.
    expect(second).not.toMatch(/-1\.jpg$/);
    expect(first.match(COMPONENT)[1]).not.toBe(second.match(COMPONENT)[1]);
    expect(adapter.wrapped.files.size).toBe(2);
  });

  it('reserves nothing, because no save() will ever spend it', async () => {
    const adapter = buildAdapter();
    await inline(adapter, 'hero.jpg');
    await inline(adapter, 'hero.jpg');
    expect(adapter.reservedNames.size).toBe(0);
  });

  it('cannot fill the reservation table', async () => {
    const adapter = buildAdapter({ reservationMaxEntries: 2 });
    for (let n = 0; n < 5; n += 1) {
      await inline(adapter, `n${n}.jpg`);
    }
    expect(adapter.reservedNames.size).toBe(0);
  });

  it('still keeps the promise for a file that has a temp path (an import)', async () => {
    const adapter = buildAdapter();
    const file = await tempFile('hero.jpg');
    const promised = await adapter.getUniqueFileName(file, DIR);
    expect(adapter.reservedNames.size).toBe(1);
    await adapter.save(file, DIR);
    expect(adapter.wrapped.files.has(promised)).toBe(true);
  });
});

describe('concurrent getUniqueFileName() for one file', () => {
  it('returns one path to every caller, and save() stores at it', async () => {
    const adapter = buildAdapter();
    const file = await tempFile('once.png');
    const [a, b, c] = await Promise.all([
      adapter.getUniqueFileName(file, DIR),
      adapter.getUniqueFileName(file, DIR),
      adapter.getUniqueFileName(file, DIR),
    ]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(adapter.reservedNames.size).toBe(1);
    await adapter.save(file, DIR);
    expect(adapter.wrapped.files.has(a)).toBe(true);
    expect(adapter.wrapped.files.size).toBe(1);
  });

  it('keeps two different files apart', async () => {
    const adapter = buildAdapter();
    const one = await tempFile('same.png');
    const two = await tempFile('same.png');
    const [a, b] = await Promise.all([
      adapter.getUniqueFileName(one, DIR),
      adapter.getUniqueFileName(two, DIR),
    ]);
    expect(a).not.toBe(b);
    expect(adapter.reservedNames.size).toBe(2);
  });

  it('shares a refusal, then lets the next ask try again', async () => {
    const adapter = buildAdapter({ reservationMaxEntries: 1 });
    await adapter.getUniqueFileName(await tempFile('full.png'), DIR);
    const file = await tempFile('blocked.png');
    const results = await Promise.allSettled([
      adapter.getUniqueFileName(file, DIR),
      adapter.getUniqueFileName(file, DIR),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(adapter.namesInFlight.size).toBe(0);
    // A later ask is not stuck behind the failed one: it is refused afresh.
    await expect(adapter.getUniqueFileName(file, DIR)).rejects.toThrow(/too many upload names/);
  });
});

describe("an imported processed image and its '_o' original", () => {
  const stored = (p) => path.basename(p);

  it('are promised one component, so Ghost finds the original by its usual name', async () => {
    const adapter = buildAdapter();
    const processed = await tempFile('photo.png');
    const original = await tempFile('photo_o.png');
    const processedPath = await adapter.getUniqueFileName(processed, DIR);
    const originalPath = await adapter.getUniqueFileName(original, DIR);
    // Ghost looks for <stored basename>_o<ext> of the processed image.
    expect(stored(originalPath)).toBe(stored(processedPath).replace(/\.png$/, '_o.png'));
    await adapter.save(processed, DIR);
    await adapter.save(original, DIR);
    expect(adapter.wrapped.files.has(processedPath)).toBe(true);
    expect(adapter.wrapped.files.has(originalPath)).toBe(true);
  });

  it('pairs only inside one directory', async () => {
    const adapter = buildAdapter();
    const processedPath = await adapter.getUniqueFileName(await tempFile('photo.png'), DIR);
    const originalPath = await adapter.getUniqueFileName(
      await tempFile('photo_o.png'),
      'content/images/2019/02'
    );
    expect(stored(originalPath)).not.toBe(stored(processedPath).replace(/\.png$/, '_o.png'));
  });

  it('pairs an original once: a second one of the same name gets its own component', async () => {
    const adapter = buildAdapter();
    const processedPath = await adapter.getUniqueFileName(await tempFile('photo.png'), DIR);
    const first = await adapter.getUniqueFileName(await tempFile('photo_o.png'), DIR);
    const second = await adapter.getUniqueFileName(await tempFile('photo_o.png'), DIR);
    const paired = stored(processedPath).replace(/\.png$/, '_o.png');
    expect(stored(first)).toBe(paired);
    expect(stored(second)).not.toBe(paired);
    expect(stored(second)).toMatch(/^photo_o-[a-z2-7]{22}\.png$/);
  });

  it('pairs two concurrent originals with one processed image only once', async () => {
    const adapter = buildAdapter();
    const processedPath = await adapter.getUniqueFileName(await tempFile('photo.png'), DIR);
    const [a, b] = await Promise.all([
      adapter.getUniqueFileName(await tempFile('photo_o.png'), DIR),
      adapter.getUniqueFileName(await tempFile('photo_o.png'), DIR),
    ]);
    const paired = stored(processedPath).replace(/\.png$/, '_o.png');
    expect([stored(a), stored(b)].filter((name) => name === paired)).toHaveLength(1);
  });

  it('does not pair with a promise that has lapsed', async () => {
    const adapter = buildAdapter();
    const start = Date.now();
    const processedPath = await adapter.getUniqueFileName(await tempFile('photo.png'), DIR);
    vi.spyOn(Date, 'now').mockReturnValue(start + 2 * 60 * 60 * 1000);
    const originalPath = await adapter.getUniqueFileName(await tempFile('photo_o.png'), DIR);
    expect(stored(originalPath)).not.toBe(stored(processedPath).replace(/\.png$/, '_o.png'));
  });

  it('states its limit: an original promised first is not paired with a processed image after it', async () => {
    const adapter = buildAdapter();
    const originalPath = await adapter.getUniqueFileName(await tempFile('photo_o.png'), DIR);
    const processedPath = await adapter.getUniqueFileName(await tempFile('photo.png'), DIR);
    expect(stored(originalPath)).not.toBe(stored(processedPath).replace(/\.png$/, '_o.png'));
  });

  it('never pairs a name that is only an extension', async () => {
    const adapter = buildAdapter();
    await adapter.getUniqueFileName(await tempFile('.png'), DIR);
    const other = await adapter.getUniqueFileName(await tempFile('_o.png'), DIR);
    expect(stored(other)).toMatch(/^_o-[a-z2-7]{22}\.png$/);
  });
});

describe('the upload-name table errors', () => {
  it('a full table is a typed 503, not a bare Error', async () => {
    const adapter = buildAdapter({ reservationMaxEntries: 1 });
    await adapter.getUniqueFileName(await tempFile('a.png'), DIR);
    const refusal = await adapter.getUniqueFileName(await tempFile('b.png'), DIR).catch((e) => e);
    expect(refusal).toBeInstanceOf(GhostErrors.MaintenanceError);
    expect(refusal.statusCode).toBe(503);
    expect(refusal.message).toMatch(/too many upload names/);
  });

  it('a save of a lapsed name is a typed 503, not a bare Error', async () => {
    const adapter = buildAdapter();
    const start = Date.now();
    const file = await tempFile('late.png');
    await adapter.getUniqueFileName(file, DIR);
    vi.spyOn(Date, 'now').mockReturnValue(start + 2 * 60 * 60 * 1000);
    const refusal = await adapter.save(file, DIR).catch((e) => e);
    expect(refusal).toBeInstanceOf(GhostErrors.MaintenanceError);
    expect(refusal.statusCode).toBe(503);
    expect(refusal.message).toMatch(/lapsed/);
    expect(adapter.wrapped.files.size).toBe(0);
  });
});
