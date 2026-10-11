import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeStorageBase } from '../helpers/fake-storage-base.mjs';
import { FakeWrappedAdapter } from '../helpers/fake-wrapped-adapter.mjs';

const require = createRequire(import.meta.url);
const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const { pdqHashOfImage } = require('../../src/pdq.js');

// The entry file is the one Ghost loads by name. It requires
// `ghost-storage-base`, which only Ghost's own image carries, and it resolves
// the wrapped adapter by name from its own directory when an instance is
// built. Both are answered here by the doubles the rest of the suite uses,
// for the life of this file. Everything else is the real entry file, which
// is the point: the wiring decision lives in it.
const NodeModule = require('node:module');
const originalLoad = NodeModule._load;
const WRAPPED_PATH = path.join(SRC_DIR, 'FakeAdapter');
NodeModule._load = function patchedLoad(request, ...rest) {
  if (request === 'ghost-storage-base') {
    return { StorageBase: FakeStorageBase };
  }
  if (request === WRAPPED_PATH) {
    return FakeWrappedAdapter;
  }
  return originalLoad.call(this, request, ...rest);
};
afterAll(() => {
  NodeModule._load = originalLoad;
});

const EntryAdapter = require('../../src/ScanningStorageAdapter.js');

// Real pictures: what the verdict client is asked about is their perceptual
// hash, so stand-in bytes would have no hash and be held.
const CLEAN_BYTES = fsSync.readFileSync(path.join(SRC_DIR, '../test/fixtures/clean.png'));
const BAD_BYTES = fsSync.readFileSync(path.join(SRC_DIR, '../test/fixtures/bad.png'));
const BAD_KEY = (await pdqHashOfImage(BAD_BYTES)).hash;

let tmpDir;
let logged;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scanning-entry-test-'));
  logged = [];
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function build(extra = {}) {
  return new EntryAdapter({
    wraps: 'FakeAdapter',
    wrappedConfig: { storagePath: 'wrapped' },
    quarantinePath: path.join(tmpDir, 'quarantine'),
    holdRetryMs: 20,
    holdLogger: { error: (...args) => logged.push(args.join(' ')) },
    ...extra,
  });
}

describe('the entry file picks its verdict source', () => {
  it('refuses an upload when no verdict source is configured (production default)', async () => {
    const adapter = build();
    await expect(adapter.saveRaw(CLEAN_BYTES, '2026/10/clean.png')).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(adapter.wrapped.savedRaw).toEqual([]);
  });

  it('still refuses when only the fake seed config is present, without the explicit flag', async () => {
    const adapter = build({ refuse: { [BAD_KEY]: { classification: 'csam' } } });
    await expect(adapter.saveRaw(CLEAN_BYTES, '2026/10/clean.png')).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(adapter.wrapped.savedRaw).toEqual([]);
  });

  it.each(['', 'true', 'IN-PROCESS-FAKE', 'fake', 'in-process-fake '])(
    'treats the unrecognised value %j as unconfigured, so a typo cannot open the gate',
    async (verdictSource) => {
      const adapter = build({ verdictSource });
      await expect(adapter.saveRaw(CLEAN_BYTES, '2026/10/clean.png')).rejects.toMatchObject({
        statusCode: 503,
      });
    }
  );

  it('control: the explicit in-process-fake flag still allows a clean upload', async () => {
    const adapter = build({ verdictSource: 'in-process-fake' });
    await expect(adapter.saveRaw(CLEAN_BYTES, '2026/10/clean.png')).resolves.toMatch(/clean\.png$/);
    expect(adapter.wrapped.savedRaw).toHaveLength(1);
  });

  it('control: with the flag the seeded refusal is honoured (configured behaviour is unchanged)', async () => {
    const adapter = build({
      verdictSource: 'in-process-fake',
      refuse: JSON.stringify({ [BAD_KEY]: { classification: 'csam', matchType: 'exact' } }),
    });
    await expect(adapter.saveRaw(BAD_BYTES, '2026/10/bad.png')).rejects.toMatchObject({
      statusCode: 415,
    });
    expect(adapter.wrapped.savedRaw).toEqual([]);
  });

  it('says so loudly once at boot and on every refused upload, with a stable token to alert on', async () => {
    const adapter = build();
    expect(logged.join('\n')).toContain('SCANNER_UNCONFIGURED');
    const bootLines = logged.length;
    await expect(adapter.saveRaw(CLEAN_BYTES, '2026/10/clean.png')).rejects.toBeDefined();
    await expect(adapter.saveRaw(CLEAN_BYTES, '2026/10/clean.png')).rejects.toBeDefined();
    expect(logged.length).toBe(bootLines + 2);
    expect(logged.at(-1)).toContain('UPLOAD_REFUSED_SCANNER_UNCONFIGURED');
  });

  it('a refusal for an unconfigured scanner seals nothing: the same bytes upload once a source exists', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    const unconfigured = build({ quarantinePath });
    await expect(unconfigured.saveRaw(CLEAN_BYTES, '2026/10/clean.png')).rejects.toBeDefined();
    const sealed = await fs.readdir(quarantinePath).catch(() => []);
    expect(sealed).toEqual([]);

    const configured = build({ quarantinePath, verdictSource: 'in-process-fake' });
    await expect(configured.saveRaw(CLEAN_BYTES, '2026/10/clean.png')).resolves.toBeDefined();
  });

  it('keeps serving what is already stored while uploads are refused', async () => {
    const adapter = build();
    adapter.wrapped.files.set('2026/10/old.png', Buffer.from('old'));
    await expect(adapter.exists('old.png', '2026/10')).resolves.toBe(true);
    await expect(adapter.read({ path: '2026/10/old.png' })).resolves.toEqual(Buffer.from('old'));
  });

  it('never promotes a hold left by an earlier process: no source means no verdict, so it stays held', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    const digest = (await pdqHashOfImage(CLEAN_BYTES)).hash;
    const earlier = build({
      quarantinePath,
      verdictSource: 'in-process-fake',
      unavailable: [digest],
    });
    const url = await earlier.saveRaw(CLEAN_BYTES, '2026/10/held.png');
    expect(url).toMatch(/held\.png$/);
    expect(earlier.wrapped.savedRaw).toEqual([]);

    const restarted = build({ quarantinePath });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(restarted.wrapped.savedRaw).toEqual([]);
    expect(earlier.wrapped.savedRaw).toEqual([]);
  });
});

// The compose files render-core pins as goldens are what a demo and a tenant
// are started from. The images feature's storage__images__* keys are read
// out of them and handed to the real entry file exactly as Ghost's config
// loader would, so what is proved is "as rendered, this refuses", not "a
// config shaped like it does". The test's own explicit flag, set on a copy
// of the config and never in a rendered file, is the only way an upload is
// let through here.
const GOLDEN_DIR = path.resolve(SRC_DIR, '../../../render-core/test/golden');

async function renderedImagesConfig(goldenName) {
  const text = await fs.readFile(path.join(GOLDEN_DIR, goldenName), 'utf8');
  const config = {};
  for (const line of text.split('\n')) {
    const match = /^\s+storage__images__([A-Za-z]+): '?([^'\n]*)'?\s*$/.exec(line);
    if (match && !(match[1] in config)) {
      config[match[1]] = match[2];
    }
  }
  return config;
}

describe.each([
  ['a demo', 'demo.compose.yml', 'LocalImagesStorage'],
  ['an entry tenant', 'entry-tenant.compose.yml', 'S3Storage'],
  ['a professional tenant', 'professional-tenant.compose.yml', 'S3Storage'],
])('%s, as render-core renders it', (_label, golden, renderedWraps) => {
  async function adapterFromRendered(extra = {}) {
    const rendered = await renderedImagesConfig(golden);
    expect(rendered.adapter).toBe('ScanningStorageAdapter');
    expect(rendered.wraps).toBe(renderedWraps);
    expect(rendered).not.toHaveProperty('verdictSource');
    return new EntryAdapter({
      ...rendered,
      // The wrapped class is the suite's double; its real name is checked above.
      wraps: 'FakeAdapter',
      wrappedConfig: { storagePath: 'wrapped' },
      quarantinePath: path.join(tmpDir, 'quarantine'),
      holdRetryMs: 20,
      holdLogger: { error: (...args) => logged.push(args.join(' ')) },
      ...extra,
    });
  }

  it('renders no verdict source and refuses an upload, loudly', async () => {
    const adapter = await adapterFromRendered();
    await expect(adapter.saveRaw(CLEAN_BYTES, '2026/10/clean.png')).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(adapter.wrapped.savedRaw).toEqual([]);
    expect(logged.join('\n')).toContain('SCANNER_UNCONFIGURED');
    expect(logged.join('\n')).toContain('UPLOAD_REFUSED_SCANNER_UNCONFIGURED');
  });

  it('control: the same config with the test harness own explicit flag lets a clean upload through', async () => {
    const adapter = await adapterFromRendered({ verdictSource: 'in-process-fake' });
    await expect(adapter.saveRaw(CLEAN_BYTES, '2026/10/clean.png')).resolves.toMatch(/clean\.png$/);
  });
});
