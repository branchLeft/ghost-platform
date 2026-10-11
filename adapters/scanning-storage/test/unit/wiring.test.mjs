import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { FakeStorageBase } from '../helpers/fake-storage-base.mjs';
import {
  FakeWrappedAdapter,
  makeLoadWrappedAdapterClass,
} from '../helpers/fake-wrapped-adapter.mjs';

const require = createRequire(import.meta.url);
const { defineScanningStorageAdapter } = require('../../src/scanning-storage.js');
const { buildScanner, startupProblems } = require('../../src/wiring.js');
const { digestBytes, pdqHashOfImage } = require('../../src/pdq.js');
const GhostErrors = require('@tryghost/errors');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '../fixtures');
const ORIGINAL = fsSync.readFileSync(
  path.join(FIXTURES, 'pdq-generated/scene-a-large-1280x960.jpg')
);
const UNRELATED = fsSync.readFileSync(path.join(FIXTURES, 'pdq-generated/scene-b-256x192.png'));
// The hash source's own rule, as the reference states it.
const MATCH_DISTANCE = 31;

function distance(a, b) {
  let bits = 0;
  for (let i = 0; i < a.length; i += 1) {
    let x = a[i] ^ b[i];
    while (x) {
      bits += x & 1;
      x >>= 1;
    }
  }
  return bits;
}

// What the real hash source does and the in-process fake does not: it
// answers for a hash NEAR a listed one, and it takes nothing but a PDQ hash.
class NearMatchVerdictClient {
  constructor(listed) {
    this.listed = listed.map((hash) => Buffer.from(hash, 'base64'));
    this.asked = [];
  }

  async getVerdict(key) {
    this.asked.push(key);
    const bytes = Buffer.from(String(key), 'base64');
    if (bytes.length !== 32 || bytes.toString('base64') !== key) {
      return { classification: 'unavailable', source: 'near-match-test-double' };
    }
    const near = this.listed.some((hash) => distance(hash, bytes) <= MATCH_DISTANCE);
    return near
      ? { classification: 'csam', matchType: 'near', source: 'near-match-test-double' }
      : { classification: 'no-known-match', source: 'near-match-test-double' };
  }
}

let tmpDir;
let logged;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scanning-wiring-test-'));
  logged = [];
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function build(verdictClient) {
  const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
    loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
    GhostErrors,
  });
  const scanner = buildScanner({ verdictSource: 'in-process-fake' }, { verdictClient });
  return new Adapter({
    wraps: 'FakeAdapter',
    wrappedConfig: { storagePath: 'wrapped' },
    quarantinePath: path.join(tmpDir, 'quarantine'),
    holdRetryMs: 20,
    holdLogger: { error: (...args) => logged.push(args.join(' ')) },
    ...scanner,
  });
}

async function listedClientFor(buffer) {
  const { hash } = await pdqHashOfImage(buffer);
  return new NearMatchVerdictClient([hash]);
}

describe('the verdict key is the perceptual hash of the image', () => {
  it('refuses a resized, recompressed copy of a listed image (a different file, the same picture)', async () => {
    const client = await listedClientFor(ORIGINAL);
    const adapter = build(client);
    const copy = await sharp(ORIGINAL).resize(420).jpeg({ quality: 50 }).toBuffer();
    expect(digestBytes(copy)).not.toBe(digestBytes(ORIGINAL));

    await expect(adapter.saveRaw(copy, '2026/10/copy.jpg')).rejects.toMatchObject({
      statusCode: 415,
    });
    expect(adapter.wrapped.savedRaw).toEqual([]);
    // Sealed under what names these exact bytes, not under the key asked.
    const sealed = await fs.readdir(path.join(tmpDir, 'quarantine'));
    expect(sealed).toContain(digestBytes(copy));
    expect(sealed).toContain(`${digestBytes(copy)}.refused.json`);
  });

  it('refuses the listed image itself', async () => {
    const adapter = build(await listedClientFor(ORIGINAL));
    await expect(adapter.saveRaw(ORIGINAL, '2026/10/original.jpg')).rejects.toMatchObject({
      statusCode: 415,
    });
  });

  it('control: an unrelated image is allowed and written', async () => {
    const adapter = build(await listedClientFor(ORIGINAL));
    await expect(adapter.saveRaw(UNRELATED, '2026/10/other.jpg')).resolves.toMatch(/other\.jpg$/);
    expect(adapter.wrapped.savedRaw).toHaveLength(1);
  });

  it('only ever asks the hash source a canonical PDQ hash', async () => {
    const client = await listedClientFor(ORIGINAL);
    const adapter = build(client);
    await adapter.saveRaw(UNRELATED, '2026/10/other.jpg');
    expect(client.asked).toHaveLength(1);
    expect(client.asked[0]).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(client.asked[0]).not.toBe(digestBytes(UNRELATED));
  });
});

describe('bytes that are not a hashable image are never allowed on that basis', () => {
  it('holds them, never asks the hash source, and never writes them to storage', async () => {
    const client = await listedClientFor(ORIGINAL);
    const adapter = build(client);
    const text = Buffer.from('a document, not a picture');

    const url = await adapter.saveRaw(text, '2026/10/notes.txt');
    expect(url).toMatch(/notes\.txt$/);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(adapter.wrapped.savedRaw).toEqual([]);
    expect(client.asked).toEqual([]);
    expect(adapter.hold.isPending(digestBytes(text))).toBe(true);
    adapter.hold.stopAll();
  });
});

describe('buildScanner', () => {
  it('keys files by content digest and asks the verdict client about the hash', () => {
    const scanner = buildScanner({ verdictSource: 'in-process-fake' });
    expect(scanner.computeDigest(Buffer.from('x'))).toBe(digestBytes(Buffer.from('x')));
    expect(scanner.refuseUploadsReason).toBeNull();
    expect(scanner.checks).toHaveLength(1);
    expect(scanner.checks[0].blocking).toBe(true);
  });

  it('is closed when no verdict source is configured', () => {
    expect(buildScanner({}).refuseUploadsReason).toBe('SCANNER_UNCONFIGURED');
  });

  it('reports no start-up problem while the decoder loads', () => {
    expect(startupProblems()).toEqual([]);
  });
});
