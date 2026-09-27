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
const BAD_BYTES = Buffer.from('known-bad-image-bytes');
const BAD_DIGEST = digestBytes(BAD_BYTES);

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scanning-storage-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// Real, short retries rather than a faked clock: onHold's own bookkeeping
// briefly touches the real filesystem (quarantine), and a fake clock only
// fast-forwards JS timers, not that I/O -- the two do not settle in the
// same tick, which made an early version of this suite assert on a retry
// that had not actually finished yet.
const RETRY_MS = 20;
const settle = (ms = RETRY_MS * 4) => new Promise((resolve) => setTimeout(resolve, ms));

function buildAdapter({
  refuse = new Map(),
  unavailable = [],
  quarantinePath,
  wrappedConfig,
  holdRetryMs = RETRY_MS,
} = {}) {
  const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
    loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
    GhostErrors,
  });
  const verdictClient = new FakeVerdictClient({ refuse, unavailable });
  const checks = [createPdqKnownMaterialCheck(verdictClient, { computeDigest: digestBytes })];
  const instance = new Adapter({
    wraps: 'FakeAdapter',
    wrappedConfig: wrappedConfig ?? { storagePath: 'wrapped' },
    quarantinePath: quarantinePath ?? path.join(tmpDir, 'quarantine'),
    checks,
    policy: new SafetyPolicy(),
    holdRetryMs,
  });
  return { instance, verdictClient };
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
    const { instance: adapter } = buildAdapter();
    expect(adapter).toBeInstanceOf(FakeStorageBase);
    expect(adapter.requiredFns).toEqual(['exists', 'save', 'serve', 'delete', 'read']);
  });

  it('implements saveRaw even though requiredFns does not name it', () => {
    // Ghost's own adapter manager only checks requiredFns, but its
    // on-demand resize middleware feature-detects saveRaw separately with a
    // plain typeof check, so this must hold regardless.
    const { instance: adapter } = buildAdapter();
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
    const { instance: adapter } = buildAdapter();
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
    const { instance: adapter } = buildAdapter();
    const file = await writeTempFile(CLEAN_BYTES, 'good.png');
    const url = await adapter.save(file);
    expect(url).toContain('good.png');
    expect(adapter.wrapped.saved).toHaveLength(1);
  });

  it('hashes and allows a clean saveRaw derivative too', async () => {
    const { instance: adapter } = buildAdapter();
    const url = await adapter.saveRaw(CLEAN_BYTES, '2026/09/derivative.png');
    expect(url).toContain('derivative.png');
    expect(adapter.wrapped.savedRaw).toHaveLength(1);
  });

  it('hashes the processed copy and the untouched original as two separate save() calls', async () => {
    const { instance: adapter } = buildAdapter();
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
    const { instance: adapter } = buildAdapter({
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
    const { instance: adapter } = buildAdapter({
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
    const { instance: adapter } = buildAdapter({
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
    const { instance: adapter } = buildAdapter({
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
    const { instance: adapter } = buildAdapter({
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
  it('fails loudly rather than guessing a behaviour for flag', async () => {
    const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
      loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
      GhostErrors,
    });
    const check = {
      kind: 'text',
      blocking: true,
      async run() {
        return { classification: 'ambiguous', source: 'test', evidence: 'x' };
      },
    };
    const adapter = new Adapter({
      wraps: 'FakeAdapter',
      quarantinePath: path.join(tmpDir, 'quarantine'),
      checks: [check],
      policy: { decide: () => 'flag' },
    });
    const file = await writeTempFile(CLEAN_BYTES, 'x.png');
    await expect(adapter.save(file)).rejects.toThrow(/flag/);
  });
});

// D34: accept on no verdict, serve nothing until a clean one, on both
// storage backends. The verdict client is made to never answer
// (FakeVerdictClient's `unavailable`) rather than hang, because checks.js's
// own timeout already proves that race -- duplicating it here would only
// make every test in this suite slower.
describe('the hold branch (D34)', () => {
  describe('local backend', () => {
    it('accepts the upload with no verdict, and withholds it from exists/read/serve', async () => {
      const { instance: adapter } = buildAdapter({
        unavailable: [BAD_DIGEST],
        wrappedConfig: { storagePath: 'wrapped', existsResult: true },
      });
      const file = await writeTempFile(BAD_BYTES, 'held.png');

      const url = await adapter.save(file);
      expect(url).toContain('held.png');
      // Local mode writes the real bytes through the real wrapped adapter
      // immediately -- that write is not the safety property, withholding
      // it is.
      expect(adapter.wrapped.saved).toHaveLength(1);

      await expect(adapter.exists(url)).resolves.toBe(false);
      await expect(adapter.read({ path: url })).rejects.toThrow();

      const next = vi.fn();
      const res = {};
      const middleware = adapter.serve();
      await middleware({ originalUrl: url }, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.served).toBeUndefined(); // masked, never reached the real middleware

      // Held bytes live in quarantine under their digest, exactly as a
      // refused object does.
      const quarantined = await fs.readFile(path.join(adapter.quarantinePath, BAD_DIGEST));
      expect(quarantined.equals(BAD_BYTES)).toBe(true);
    });

    it('promotes on a later clean verdict: exists/read/serve all resolve to the real object', async () => {
      const { instance: adapter, verdictClient } = buildAdapter({
        unavailable: [BAD_DIGEST],
        wrappedConfig: { storagePath: 'wrapped', existsResult: true, readResult: BAD_BYTES },
      });
      const file = await writeTempFile(BAD_BYTES, 'held.png');
      const url = await adapter.save(file);
      await expect(adapter.exists(url)).resolves.toBe(false);

      verdictClient.deliverVerdict(BAD_DIGEST, { classification: 'no-known-match' });
      await settle();

      await expect(adapter.exists(url)).resolves.toBe(true);
      await expect(adapter.read({ path: url })).resolves.toEqual(BAD_BYTES);
      const next = vi.fn();
      const res = {};
      await adapter.serve()({ originalUrl: url }, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.served).toBe(true); // unmasked: the real middleware ran
    });

    it('a held object that never clears is never served (the control case)', async () => {
      const { instance: adapter } = buildAdapter({
        unavailable: [BAD_DIGEST],
        wrappedConfig: { storagePath: 'wrapped', existsResult: true },
      });
      const file = await writeTempFile(BAD_BYTES, 'held.png');
      const url = await adapter.save(file);

      await settle(RETRY_MS * 8);

      await expect(adapter.exists(url)).resolves.toBe(false);
    });

    it('a later match deletes the real copy and stays withheld forever, exactly as a synchronous match would', async () => {
      const { instance: adapter, verdictClient } = buildAdapter({
        unavailable: [BAD_DIGEST],
        wrappedConfig: { storagePath: 'wrapped', existsResult: true },
      });
      const file = await writeTempFile(BAD_BYTES, 'held.png');
      const url = await adapter.save(file);

      verdictClient.deliverVerdict(BAD_DIGEST, {
        classification: 'harmful-abusive-material',
        matchType: 'exact',
      });
      await settle();

      expect(adapter.wrapped.deleted).toHaveLength(1);
      // Withheld regardless of what the wrapped adapter itself would now say.
      await expect(adapter.exists(url)).resolves.toBe(false);
    });

    it('the same bytes held via save() and again via saveRaw() (a real case with resize disabled) unmask together on one clean verdict', async () => {
      const { instance: adapter, verdictClient } = buildAdapter({
        unavailable: [BAD_DIGEST],
        wrappedConfig: { storagePath: 'wrapped', existsResult: true },
      });
      const file = await writeTempFile(BAD_BYTES, 'held.png');

      const originalUrl = await adapter.save(file);
      const derivativeUrl = await adapter.saveRaw(BAD_BYTES, '2026/09/held-w600.png');

      await expect(adapter.exists(originalUrl)).resolves.toBe(false);
      await expect(adapter.exists(derivativeUrl)).resolves.toBe(false);

      verdictClient.deliverVerdict(BAD_DIGEST, { classification: 'no-known-match' });
      await settle();

      await expect(adapter.exists(originalUrl)).resolves.toBe(true);
      await expect(adapter.exists(derivativeUrl)).resolves.toBe(true);
    });

    it('holds a saveRaw derivative the same way as save, using the caller-given target path', async () => {
      const { instance: adapter, verdictClient } = buildAdapter({
        unavailable: [BAD_DIGEST],
        wrappedConfig: { storagePath: 'wrapped', existsResult: true },
      });

      const url = await adapter.saveRaw(BAD_BYTES, '2026/09/derivative.png');
      expect(adapter.wrapped.savedRaw).toHaveLength(1); // local: written immediately, masked
      await expect(adapter.exists(url)).resolves.toBe(false);

      verdictClient.deliverVerdict(BAD_DIGEST, { classification: 'no-known-match' });
      await settle();
      await expect(adapter.exists(url)).resolves.toBe(true);
    });

    it('a deleteReal that cannot resolve a real path is a safe no-op', async () => {
      const { instance: adapter, verdictClient } = buildAdapter({
        unavailable: [BAD_DIGEST],
        wrappedConfig: { storagePath: 'wrapped', existsResult: true },
      });
      const file = await writeTempFile(BAD_BYTES, 'held.png');
      await adapter.save(file);
      // Sabotage-proof cleanup: even if the wrapped adapter's own
      // urlToPath throws, a later refuse must not crash the retry loop.
      adapter.wrapped.urlToPath = () => {
        throw new Error('urlToPath broke');
      };

      verdictClient.deliverVerdict(BAD_DIGEST, {
        classification: 'harmful-abusive-material',
        matchType: 'exact',
      });
      await settle();

      expect(adapter.wrapped.deleted).toHaveLength(0);
    });
  });

  describe('object-storage backend', () => {
    function buildS3Adapter(overrides) {
      return buildAdapter({
        wrappedConfig: {
          storagePath: 'wrapped',
          bucket: 'test-bucket',
          cdnUrl: 'https://cdn.example.test/test-bucket',
        },
        ...overrides,
      });
    }

    it('never writes to the bucket while held -- "not yet written at all", not merely unlinked', async () => {
      const { instance: adapter } = buildS3Adapter({ unavailable: [BAD_DIGEST] });
      const file = await writeTempFile(BAD_BYTES, 'held.png');

      const url = await adapter.save(file);

      expect(url).toContain(BAD_DIGEST);
      expect(adapter.wrapped.saved).toHaveLength(0);
      expect(adapter.wrapped.savedRaw).toHaveLength(0);
      await expect(adapter.exists(url)).resolves.toBe(false);

      const quarantined = await fs.readFile(path.join(adapter.quarantinePath, BAD_DIGEST));
      expect(quarantined.equals(BAD_BYTES)).toBe(true);
    });

    it('promotion is a write: the bucket receives the bytes only once a clean verdict arrives', async () => {
      const { instance: adapter, verdictClient } = buildS3Adapter({ unavailable: [BAD_DIGEST] });
      const file = await writeTempFile(BAD_BYTES, 'held.png');
      const url = await adapter.save(file);

      verdictClient.deliverVerdict(BAD_DIGEST, { classification: 'no-known-match' });
      await settle();

      expect(adapter.wrapped.savedRaw).toHaveLength(1);
      expect(adapter.wrapped.savedRaw[0].buffer.equals(BAD_BYTES)).toBe(true);
      await expect(adapter.exists(url)).resolves.toBe(false); // FakeWrappedAdapter.exists is canned, not real
    });

    it('two different held uploads sharing an original filename do not collide on promotion', async () => {
      const otherBytes = Buffer.from('a second known-bad payload, different from the first');
      const otherDigest = digestBytes(otherBytes);
      const { instance: adapter } = buildS3Adapter({ unavailable: [BAD_DIGEST, otherDigest] });

      const first = await writeTempFile(BAD_BYTES, 'same-name.png');
      const second = await writeTempFile(otherBytes, 'same-name.png');

      const firstUrl = await adapter.save(first);
      const secondUrl = await adapter.save(second);

      expect(firstUrl).not.toEqual(secondUrl);
    });

    it("uses the wrapped adapter's own getTargetDir when one is provided, as a real adapter always does", async () => {
      const { instance: adapter } = buildS3Adapter({ unavailable: [BAD_DIGEST] });
      adapter.wrapped.getTargetDir = () => '2026/09';
      const file = await writeTempFile(BAD_BYTES, 'held.png');

      const url = await adapter.save(file);

      expect(url).toBe(`https://cdn.example.test/test-bucket/2026/09/${BAD_DIGEST}.png`);
    });

    it('builds the URL from endpoint+bucket when no cdnUrl is configured', async () => {
      const { instance: adapter } = buildAdapter({
        unavailable: [BAD_DIGEST],
        wrappedConfig: {
          storagePath: 'wrapped',
          bucket: 'test-bucket',
          endpoint: 'https://s3.example.test',
        },
      });
      const file = await writeTempFile(BAD_BYTES, 'held.png');
      const url = await adapter.save(file);
      expect(url).toBe(`https://s3.example.test/test-bucket/${BAD_DIGEST}.png`);
    });

    it('fails loudly rather than guessing a URL with no cdnUrl and no endpoint', async () => {
      const { instance: adapter } = buildAdapter({
        unavailable: [BAD_DIGEST],
        wrappedConfig: { storagePath: 'wrapped', bucket: 'test-bucket' },
      });
      const file = await writeTempFile(BAD_BYTES, 'held.png');
      await expect(adapter.save(file)).rejects.toThrow(/cdnUrl/);
    });

    it('saveRaw is held the same way, using the exact target path the caller already gave', async () => {
      const { instance: adapter, verdictClient } = buildS3Adapter({ unavailable: [BAD_DIGEST] });

      await adapter.saveRaw(BAD_BYTES, '2026/09/derivative.png');
      expect(adapter.wrapped.savedRaw).toHaveLength(0); // not written while held

      verdictClient.deliverVerdict(BAD_DIGEST, { classification: 'no-known-match' });
      await settle();

      expect(adapter.wrapped.savedRaw).toHaveLength(1);
      expect(adapter.wrapped.savedRaw[0].targetPath).toBe('2026/09/derivative.png');
    });
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
