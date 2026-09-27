import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
const BAD_BYTES = Buffer.from('known-bad-image-bytes');
const BAD_DIGEST = digestBytes(BAD_BYTES);

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scanning-storage-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function buildAdapter({
  refuse = new Map(),
  classification = 'harmful-abusive-material',
  matchType = 'exact',
  quarantinePath,
} = {}) {
  const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
    loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
    GhostErrors,
  });
  const verdictClient = new FakeVerdictClient({ refuse });
  const checks = [createPdqKnownMaterialCheck(verdictClient, { computeDigest: digestBytes })];
  const instance = new Adapter({
    wraps: 'FakeAdapter',
    wrappedConfig: { storagePath: 'wrapped' },
    quarantinePath: quarantinePath ?? path.join(tmpDir, 'quarantine'),
    checks,
    policy: new SafetyPolicy(),
  });
  return instance;
}

async function writeTempFile(buffer, name = 'upload.png') {
  const filePath = path.join(tmpDir, `src-${crypto.randomBytes(4).toString('hex')}`);
  await fs.writeFile(filePath, buffer);
  return { name, path: filePath, type: 'image/png' };
}

describe('defineScanningStorageAdapter dependency guards', () => {
  it('requires a loadWrappedAdapterClass function', () => {
    expect(() => defineScanningStorageAdapter(FakeStorageBase, { GhostErrors })).toThrow(
      /loadWrappedAdapterClass/
    );
  });

  it('requires a GhostErrors module with UnsupportedMediaTypeError', () => {
    expect(() =>
      defineScanningStorageAdapter(FakeStorageBase, {
        loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
      })
    ).toThrow(/GhostErrors/);
  });
});

describe('ScanningStorageAdapter construction', () => {
  it('extends the injected base class', () => {
    const adapter = buildAdapter();
    expect(adapter).toBeInstanceOf(FakeStorageBase);
    expect(adapter.requiredFns).toEqual(['exists', 'save', 'serve', 'delete', 'read']);
  });

  it('implements saveRaw even though requiredFns does not name it', () => {
    // Ghost's own adapter manager only checks requiredFns, but its
    // on-demand resize middleware feature-detects saveRaw separately with a
    // plain typeof check, so this must hold regardless.
    const adapter = buildAdapter();
    expect(typeof adapter.saveRaw).toBe('function');
  });

  it('rejects config missing wraps', () => {
    const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
      loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
      GhostErrors,
    });
    expect(() => new Adapter({ quarantinePath: '/tmp/q', policy: new SafetyPolicy() })).toThrow(
      /wraps/
    );
  });

  it('rejects config missing quarantinePath', () => {
    const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
      loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
      GhostErrors,
    });
    expect(() => new Adapter({ wraps: 'FakeAdapter', policy: new SafetyPolicy() })).toThrow(
      /quarantinePath/
    );
  });

  it('rejects config missing a policy', () => {
    const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
      loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
      GhostErrors,
    });
    expect(() => new Adapter({ wraps: 'FakeAdapter', quarantinePath: '/tmp/q' })).toThrow(/policy/);
  });

  it('static validate runs the same checks without constructing an instance', () => {
    const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
      loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
      GhostErrors,
    });
    expect(() => Adapter.validate({})).toThrow(/wraps/);
    expect(() =>
      Adapter.validate({
        wraps: 'FakeAdapter',
        quarantinePath: '/tmp/q',
        policy: new SafetyPolicy(),
      })
    ).not.toThrow();
  });
});

describe('delegation of everything not intercepted', () => {
  it('delegates exists, read, delete, urlToPath and serve to the wrapped adapter untouched', async () => {
    const adapter = buildAdapter();
    await adapter.exists('a.png', 'dir');
    await adapter.read({ path: 'a.png' });
    await adapter.delete('a.png', 'dir');
    adapter.urlToPath('https://example.test/content/images/a.png');
    const middleware = adapter.serve();

    expect(adapter.wrapped.deleted).toEqual([{ fileName: 'a.png', targetDir: 'dir' }]);
    expect(typeof middleware).toBe('function');
  });
});

describe('a clean upload', () => {
  it('writes through to the wrapped adapter and returns its URL', async () => {
    const adapter = buildAdapter();
    const file = await writeTempFile(CLEAN_BYTES, 'good.png');
    const url = await adapter.save(file);
    expect(url).toContain('good.png');
    expect(adapter.wrapped.saved).toHaveLength(1);
  });

  it('hashes and allows a clean saveRaw derivative too', async () => {
    const adapter = buildAdapter();
    const url = await adapter.saveRaw(CLEAN_BYTES, '2026/09/derivative.png');
    expect(url).toContain('derivative.png');
    expect(adapter.wrapped.savedRaw).toHaveLength(1);
  });

  it('hashes the processed copy and the untouched original as two separate save() calls', async () => {
    const adapter = buildAdapter();
    const processed = await writeTempFile(CLEAN_BYTES, 'good.png');
    const original = await writeTempFile(CLEAN_BYTES, 'good_o.png');
    await adapter.save(processed);
    await adapter.save(original);
    expect(adapter.wrapped.saved.map((entry) => entry.file.name)).toEqual([
      'good.png',
      'good_o.png',
    ]);
  });
});

describe('a refused upload', () => {
  it('never reaches the wrapped adapter, is quarantined by digest, and throws the typed error', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    const adapter = buildAdapter({
      refuse: new Map([
        [BAD_DIGEST, { classification: 'harmful-abusive-material', matchType: 'exact' }],
      ]),
      quarantinePath,
    });
    const file = await writeTempFile(BAD_BYTES, 'bad.png');

    await expect(adapter.save(file)).rejects.toBeInstanceOf(GhostErrors.UnsupportedMediaTypeError);
    expect(adapter.wrapped.saved).toHaveLength(0);

    const quarantined = await fs.readFile(path.join(quarantinePath, BAD_DIGEST));
    expect(quarantined.equals(BAD_BYTES)).toBe(true);
  });

  it('refuses saveRaw the same way as save', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    const adapter = buildAdapter({
      refuse: new Map([
        [BAD_DIGEST, { classification: 'harmful-abusive-material', matchType: 'exact' }],
      ]),
      quarantinePath,
    });

    await expect(adapter.saveRaw(BAD_BYTES, '2026/09/bad.png')).rejects.toBeInstanceOf(
      GhostErrors.UnsupportedMediaTypeError
    );
    expect(adapter.wrapped.savedRaw).toHaveLength(0);
  });

  it('throws a 415 UnsupportedMediaTypeError, never a plain Error', async () => {
    const adapter = buildAdapter({
      refuse: new Map([
        [BAD_DIGEST, { classification: 'harmful-abusive-material', matchType: 'exact' }],
      ]),
    });
    const file = await writeTempFile(BAD_BYTES, 'bad.png');

    let caught;
    try {
      await adapter.save(file);
    } catch (err) {
      caught = err;
    }
    expect(caught.statusCode).toBe(415);
    expect(caught.errorType).toBe('UnsupportedMediaTypeError');
  });

  it('names no classification in the response for csam', async () => {
    const adapter = buildAdapter({
      refuse: new Map([[BAD_DIGEST, { classification: 'csam', matchType: 'exact' }]]),
    });
    const file = await writeTempFile(BAD_BYTES, 'bad.png');
    let caught;
    try {
      await adapter.save(file);
    } catch (err) {
      caught = err;
    }
    expect(caught.context).not.toMatch(/csam/);
  });

  it('names the classification in the response for a non-csam match', async () => {
    const adapter = buildAdapter({
      refuse: new Map([
        [BAD_DIGEST, { classification: 'harmful-abusive-material', matchType: 'exact' }],
      ]),
    });
    const file = await writeTempFile(BAD_BYTES, 'bad.png');
    let caught;
    try {
      await adapter.save(file);
    } catch (err) {
      caught = err;
    }
    expect(caught.context).toMatch(/harmful-abusive-material/);
  });
});

describe('checks the adapter is told not to implement', () => {
  it('fails loudly rather than guessing a behaviour for hold', async () => {
    const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
      loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
      GhostErrors,
    });
    const check = {
      kind: 'media',
      blocking: true,
      async run() {
        return { classification: 'unavailable', source: 'test', evidence: 'x' };
      },
    };
    const adapter = new Adapter({
      wraps: 'FakeAdapter',
      quarantinePath: path.join(tmpDir, 'quarantine'),
      checks: [check],
      policy: new SafetyPolicy(),
    });
    const file = await writeTempFile(CLEAN_BYTES, 'x.png');
    await expect(adapter.save(file)).rejects.toThrow(/hold/);
  });
});

describe('non-blocking checks', () => {
  it('never runs an advisory check at all', async () => {
    let ran = false;
    const advisory = {
      kind: 'text',
      blocking: false,
      async run() {
        ran = true;
        return { classification: 'no-known-match', source: 'test', evidence: 'x' };
      },
    };
    const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
      loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
      GhostErrors,
    });
    const adapter = new Adapter({
      wraps: 'FakeAdapter',
      quarantinePath: path.join(tmpDir, 'quarantine'),
      checks: [advisory],
      policy: new SafetyPolicy(),
    });
    const file = await writeTempFile(CLEAN_BYTES, 'x.png');
    await adapter.save(file);
    expect(ran).toBe(false);
  });
});
