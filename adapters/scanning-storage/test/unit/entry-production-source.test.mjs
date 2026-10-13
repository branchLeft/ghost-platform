import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeStorageBase } from '../helpers/fake-storage-base.mjs';
import { FakeWrappedAdapter } from '../helpers/fake-wrapped-adapter.mjs';

const require = createRequire(import.meta.url);
const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

// The entry file Ghost loads by name, with Ghost's own storage base and the
// wrapped adapter answered by the suite's doubles (the same arrangement as
// entry-verdict-source.test.mjs). Everything else is the real entry file.
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

const CLEAN_BYTES = Buffer.from('clean-image-bytes');

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'entry-production-test-'));
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
    holdLogger: { error: () => {} },
    ...extra,
  });
}

// The entry file builds no transport yet, so naming the production value in
// config cannot select a client there. It must read as no source at all.
describe('the entry file and the production value', () => {
  it('control: verdictSource=production with no transport still refuses every upload', async () => {
    const adapter = build({ verdictSource: 'production' });
    await expect(adapter.saveRaw(CLEAN_BYTES, '2026/10/clean.png')).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(adapter.wrapped.savedRaw).toEqual([]);
  });

  it('control: the same with budgets set, and with fake seed keys alongside', async () => {
    const adapter = build({
      verdictSource: 'production',
      verdictConnectTimeoutMs: '100',
      verdictTotalTimeoutMs: '500',
      refuse: {},
      unavailable: [],
    });
    await expect(adapter.saveRaw(CLEAN_BYTES, '2026/10/clean.png')).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(adapter.wrapped.savedRaw).toEqual([]);
  });
});
