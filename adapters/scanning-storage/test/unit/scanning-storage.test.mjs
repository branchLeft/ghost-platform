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

const SILENT_LOGGER = { error: () => {} };
const WAIT = { timeout: 5000, interval: 10 };

function buildAdapter({
  refuse = new Map(),
  unavailable = [],
  quarantinePath,
  wrappedConfig,
  holdRetryMs = RETRY_MS,
  holdMaxRetryMs,
  holdMaxFailures,
  holdLogger = SILENT_LOGGER,
} = {}) {
  const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
    loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
    GhostErrors,
  });
  const verdictClient = new FakeVerdictClient({ refuse, unavailable });
  const checks = [createPdqKnownMaterialCheck(verdictClient, { computeDigest: digestBytes })];
  const resolvedQuarantinePath = quarantinePath ?? path.join(tmpDir, 'quarantine');
  const instance = new Adapter({
    wraps: 'FakeAdapter',
    wrappedConfig: wrappedConfig ?? { storagePath: 'wrapped' },
    quarantinePath: resolvedQuarantinePath,
    checks,
    policy: new SafetyPolicy(),
    computeDigest: digestBytes,
    holdRetryMs,
    holdMaxRetryMs,
    holdMaxFailures,
    holdLogger,
  });
  return { instance, verdictClient, quarantinePath: resolvedQuarantinePath };
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

  it('rejects config missing computeDigest', () => {
    const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
      loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
      GhostErrors,
    });
    expect(
      () =>
        new Adapter({ wraps: 'FakeAdapter', quarantinePath: '/tmp/q', policy: new SafetyPolicy() })
    ).toThrow(/computeDigest/);
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
    // Nothing here is masked or specially handled -- a held digest is
    // simply never written to the wrapped adapter until promotion, so
    // there is no separate "intercepted" case to test for these five;
    // existsResult/readResult force a deterministic answer for this
    // pure-delegation check, independent of what has or hasn't been
    // written to the fake's own virtual filesystem.
    const { instance: adapter } = buildAdapter({
      wrappedConfig: { storagePath: 'wrapped', existsResult: true, readResult: Buffer.from('x') },
    });
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
      computeDigest: digestBytes,
    });
    const file = await writeTempFile(CLEAN_BYTES, 'x.png');
    await expect(adapter.save(file)).rejects.toThrow(/flag/);
  });
});

// The hold branch: accept on no verdict, serve nothing until a clean one,
// on both storage backends. The verdict client is made to never answer
// (FakeVerdictClient's `unavailable`) rather than hang, because checks.js's
// own timeout already proves that race -- duplicating it here would only
// make every test in this suite slower.
//
// Review cycle 1: both backends now defer the real write until promotion --
// the design's own words for the local backend, "held outside the served
// tree," are no longer local-only advice this decorator diverged from. The
// two backends differ only in URL shape (a bucket config builds a CDN URL;
// anything else builds a site-relative one), so the behavioural cases below
// are shared, parametrised over which `wrappedConfig` builds which adapter.
describe('the hold branch', () => {
  function localAdapter(overrides) {
    return buildAdapter({ wrappedConfig: { storagePath: 'wrapped' }, ...overrides });
  }

  function s3Adapter(overrides) {
    return buildAdapter({
      wrappedConfig: {
        storagePath: 'wrapped',
        bucket: 'test-bucket',
        cdnUrl: 'https://cdn.example.test/test-bucket',
      },
      ...overrides,
    });
  }

  describe.each([
    ['local', localAdapter],
    ['object storage', s3Adapter],
  ])('%s backend', (_name, buildBackendAdapter) => {
    it('accepts the upload with no verdict, and never writes to the wrapped adapter until promoted', async () => {
      const { instance: adapter, quarantinePath } = buildBackendAdapter({
        unavailable: [BAD_DIGEST],
      });
      const file = await writeTempFile(BAD_BYTES, 'held.png');

      const url = await adapter.save(file);

      expect(url).toContain(BAD_DIGEST); // digest-named: never the caller's own filename
      expect(adapter.wrapped.saved).toHaveLength(0);
      expect(adapter.wrapped.savedRaw).toHaveLength(0);
      await expect(adapter.exists(url)).resolves.toBe(false);
      // Nothing has been written to the wrapped adapter's own virtual
      // filesystem at all, so any read on it is a miss -- not because
      // this decorator masked a real file, but because there is no real
      // file yet (the design's own words: "held outside the served tree").
      await expect(adapter.read({ path: 'anything' })).rejects.toThrow();

      // Held bytes live in quarantine under their digest, exactly as a
      // refused object does, with a sidecar recording it is still pending.
      const quarantined = await fs.readFile(path.join(quarantinePath, BAD_DIGEST));
      expect(quarantined.equals(BAD_BYTES)).toBe(true);
      await expect(
        fs.readFile(path.join(quarantinePath, `${BAD_DIGEST}.holds.json`))
      ).resolves.toBeTruthy();
    });

    it('promotes on a later clean verdict: the wrapped adapter receives exactly the held bytes', async () => {
      const { instance: adapter, verdictClient } = buildBackendAdapter({
        unavailable: [BAD_DIGEST],
      });
      const file = await writeTempFile(BAD_BYTES, 'held.png');
      await adapter.save(file);

      verdictClient.deliverVerdict(BAD_DIGEST, { classification: 'no-known-match' });
      await settle();

      expect(adapter.wrapped.savedRaw).toHaveLength(1);
      expect(adapter.wrapped.savedRaw[0].buffer.equals(BAD_BYTES)).toBe(true);
    });

    it('a held object that never clears is never promoted (the control case)', async () => {
      const { instance: adapter } = buildBackendAdapter({ unavailable: [BAD_DIGEST] });
      const file = await writeTempFile(BAD_BYTES, 'held.png');
      await adapter.save(file);

      await settle(RETRY_MS * 8);

      expect(adapter.wrapped.saved).toHaveLength(0);
      expect(adapter.wrapped.savedRaw).toHaveLength(0);
    });

    it('a later match is never promoted, and the quarantine bytes remain as the permanent record', async () => {
      const {
        instance: adapter,
        verdictClient,
        quarantinePath,
      } = buildBackendAdapter({
        unavailable: [BAD_DIGEST],
      });
      const file = await writeTempFile(BAD_BYTES, 'held.png');
      await adapter.save(file);

      verdictClient.deliverVerdict(BAD_DIGEST, {
        classification: 'harmful-abusive-material',
        matchType: 'exact',
      });
      await settle();

      expect(adapter.wrapped.saved).toHaveLength(0);
      expect(adapter.wrapped.savedRaw).toHaveLength(0);
      const quarantined = await fs.readFile(path.join(quarantinePath, BAD_DIGEST));
      expect(quarantined.equals(BAD_BYTES)).toBe(true);
      // The sidecar is gone -- indistinguishable from a synchronous refusal now.
      await expect(
        fs.readFile(path.join(quarantinePath, `${BAD_DIGEST}.holds.json`))
      ).rejects.toThrow();
    });

    it('the same bytes held via save() and again via saveRaw() (a real case with resize disabled) both promote on one clean verdict', async () => {
      const { instance: adapter, verdictClient } = buildBackendAdapter({
        unavailable: [BAD_DIGEST],
      });
      const file = await writeTempFile(BAD_BYTES, 'held.png');

      await adapter.save(file);
      await adapter.saveRaw(BAD_BYTES, '2026/09/held-w600.png');
      expect(adapter.wrapped.saved).toHaveLength(0);
      expect(adapter.wrapped.savedRaw).toHaveLength(0);

      verdictClient.deliverVerdict(BAD_DIGEST, { classification: 'no-known-match' });
      await settle();

      // One promotion per place the bytes were ever promised, from one shared retry loop.
      expect(adapter.wrapped.savedRaw).toHaveLength(2);
      expect(adapter.wrapped.savedRaw.map((s) => s.targetPath)).toContain('2026/09/held-w600.png');
    });

    it('two different held uploads sharing an original filename do not collide on promotion', async () => {
      const otherBytes = Buffer.from('a second known-bad payload, different from the first');
      const otherDigest = digestBytes(otherBytes);
      const { instance: adapter } = buildBackendAdapter({ unavailable: [BAD_DIGEST, otherDigest] });

      const first = await writeTempFile(BAD_BYTES, 'same-name.png');
      const second = await writeTempFile(otherBytes, 'same-name.png');

      const firstUrl = await adapter.save(first);
      const secondUrl = await adapter.save(second);

      expect(firstUrl).not.toEqual(secondUrl);
    });
  });

  describe('restart-safety (review cycle 1)', () => {
    it('a fresh adapter instance resumes a pending hold from quarantine alone, synchronously, before it can serve a request', async () => {
      const { instance: firstAdapter, quarantinePath } = buildAdapter({
        unavailable: [BAD_DIGEST],
        wrappedConfig: { storagePath: 'wrapped' },
      });
      const file = await writeTempFile(BAD_BYTES, 'held.png');
      await firstAdapter.save(file);
      expect(firstAdapter.wrapped.savedRaw).toHaveLength(0);

      // Simulate a process restart: a brand new adapter instance, its own
      // fresh in-memory HoldRegistry, constructed with nothing but the
      // same quarantinePath -- no reference to firstAdapter or its
      // in-memory state at all, matching what actually survives a real
      // restart. Pending immediately after `new`, with no await and no
      // separate setup call: resumeFromQuarantine runs inside the
      // constructor itself. The end-to-end proof against a real,
      // restarted Ghost container is in test/image/scanning-storage.image.test.mjs.
      const { instance: secondAdapter, verdictClient: secondVerdictClient } = buildAdapter({
        quarantinePath,
        unavailable: [BAD_DIGEST],
        wrappedConfig: { storagePath: 'wrapped' },
      });
      expect(secondAdapter.hold.isPending(BAD_DIGEST)).toBe(true);

      // And it is not just present but genuinely live: a clean verdict
      // delivered to the SECOND instance's own verdict client promotes it.
      secondVerdictClient.deliverVerdict(BAD_DIGEST, { classification: 'no-known-match' });
      await settle();

      expect(secondAdapter.wrapped.savedRaw).toHaveLength(1);
      expect(secondAdapter.wrapped.savedRaw[0].buffer.equals(BAD_BYTES)).toBe(true);
    });

    it('a resumed hold that never clears is still never promoted', async () => {
      const { instance: firstAdapter, quarantinePath } = buildAdapter({
        unavailable: [BAD_DIGEST],
        wrappedConfig: { storagePath: 'wrapped' },
      });
      const file = await writeTempFile(BAD_BYTES, 'held.png');
      await firstAdapter.save(file);

      const { instance: secondAdapter } = buildAdapter({
        quarantinePath,
        unavailable: [BAD_DIGEST],
        wrappedConfig: { storagePath: 'wrapped' },
      });

      await settle(RETRY_MS * 8);

      expect(secondAdapter.wrapped.savedRaw).toHaveLength(0);
      expect(secondAdapter.hold.isPending(BAD_DIGEST)).toBe(true);
    });

    // Ghost builds one decorator per storage feature, and a deployment
    // gives all three the same quarantinePath. After a restart, only the
    // feature that accepted the upload may resume and promote its hold;
    // the others' verdict clients answering "clean" first must neither
    // promote it into their own served tree nor delete the bytes the
    // owning feature is still waiting on.
    describe.each([
      ['local', (feature) => ({ storagePath: `/var/lib/ghost/content/${feature}` })],
      [
        'object storage',
        (feature) => ({
          storagePath: `content/${feature}`,
          bucket: 'test-bucket',
          cdnUrl: 'https://cdn.example.test/test-bucket',
        }),
      ],
    ])('three features sharing one quarantinePath (%s backend)', (_name, featureConfig) => {
      function bootAllFeatures(quarantinePath, imagesUnavailable) {
        const boot = (feature, unavailable) =>
          buildAdapter({
            quarantinePath,
            unavailable,
            holdMaxRetryMs: RETRY_MS,
            wrappedConfig: featureConfig(feature),
          });
        return {
          images: boot('images', imagesUnavailable),
          media: boot('media', []),
          files: boot('files', []),
        };
      }

      it('a restarted process promotes a held image only through the images feature, never another', async () => {
        const quarantinePath = path.join(tmpDir, 'quarantine');
        const before = bootAllFeatures(quarantinePath, [BAD_DIGEST]);
        await before.images.instance.save(await writeTempFile(BAD_BYTES, 'held.png'));
        for (const { instance } of Object.values(before)) instance.hold.stopAll();

        const after = bootAllFeatures(quarantinePath, [BAD_DIGEST]);
        expect(after.images.instance.hold.isPending(BAD_DIGEST)).toBe(true);
        expect(after.media.instance.hold.isPending(BAD_DIGEST)).toBe(false);
        expect(after.files.instance.hold.isPending(BAD_DIGEST)).toBe(false);

        await settle(RETRY_MS * 6);
        expect(after.media.instance.wrapped.savedRaw).toHaveLength(0);
        expect(after.files.instance.wrapped.savedRaw).toHaveLength(0);
        expect(after.images.instance.wrapped.savedRaw).toHaveLength(0);

        after.images.verdictClient.deliverVerdict(BAD_DIGEST, { classification: 'no-known-match' });
        await vi.waitFor(
          () => expect(after.images.instance.hold.isPending(BAD_DIGEST)).toBe(false),
          WAIT
        );

        expect(after.images.instance.wrapped.savedRaw).toHaveLength(1);
        expect(after.images.instance.wrapped.savedRaw[0].buffer.equals(BAD_BYTES)).toBe(true);
        expect(after.media.instance.wrapped.savedRaw).toHaveLength(0);
        expect(after.files.instance.wrapped.savedRaw).toHaveLength(0);
      });

      it('the same bytes held by two features both promote, each into its own tree, and the bytes outlive the first promotion', async () => {
        const quarantinePath = path.join(tmpDir, 'quarantine');
        const boot = (feature) =>
          buildAdapter({
            quarantinePath,
            unavailable: [BAD_DIGEST],
            holdMaxRetryMs: RETRY_MS,
            wrappedConfig: featureConfig(feature),
          });
        const images = boot('images');
        const media = boot('media');
        await images.instance.save(await writeTempFile(BAD_BYTES, 'held.png'));
        await media.instance.save(await writeTempFile(BAD_BYTES, 'held.mp4'));

        images.verdictClient.deliverVerdict(BAD_DIGEST, { classification: 'no-known-match' });
        await vi.waitFor(
          () => expect(images.instance.hold.isPending(BAD_DIGEST)).toBe(false),
          WAIT
        );
        expect(images.instance.wrapped.savedRaw).toHaveLength(1);
        expect(await fs.readFile(path.join(quarantinePath, BAD_DIGEST))).toEqual(BAD_BYTES);

        media.verdictClient.deliverVerdict(BAD_DIGEST, { classification: 'no-known-match' });
        await vi.waitFor(() => expect(media.instance.hold.isPending(BAD_DIGEST)).toBe(false), WAIT);
        expect(media.instance.wrapped.savedRaw).toHaveLength(1);
        expect(media.instance.wrapped.savedRaw[0].buffer.equals(BAD_BYTES)).toBe(true);
        await expect(fs.readFile(path.join(quarantinePath, BAD_DIGEST))).rejects.toThrow();
      });
    });
  });

  describe('URL building', () => {
    it("uses the wrapped adapter's own getTargetDir when one is provided, as a real adapter always does", async () => {
      const { instance: adapter } = s3Adapter({ unavailable: [BAD_DIGEST] });
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

    it('fails loudly rather than guessing a URL with a bucket set but no cdnUrl and no endpoint', async () => {
      const { instance: adapter } = buildAdapter({
        unavailable: [BAD_DIGEST],
        wrappedConfig: { storagePath: 'wrapped', bucket: 'test-bucket' },
      });
      const file = await writeTempFile(BAD_BYTES, 'held.png');
      await expect(adapter.save(file)).rejects.toThrow(/cdnUrl/);
    });

    it('local URLs are site-relative, prefixed by the feature the wrapped adapter serves', async () => {
      const { instance: adapter } = localAdapter({ unavailable: [BAD_DIGEST] });
      const file = await writeTempFile(BAD_BYTES, 'held.png');
      const url = await adapter.save(file);
      expect(url).toBe(`/content/wrapped/${BAD_DIGEST}.png`);
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
      computeDigest: digestBytes,
    });
    const file = await writeTempFile(CLEAN_BYTES, 'x.png');
    await adapter.save(file);
    expect(ran).toBe(false);
  });
});

// Three features share one quarantine directory. A digest one of them
// refuses must be refused by all of them, and its bytes kept, whatever the
// order the verdicts land in.
describe('a refusal by any feature', () => {
  const refusedAsCsam = () =>
    new Map([[BAD_DIGEST, { classification: 'csam', matchType: 'exact' }]]);
  const feature = (name) => ({ storagePath: `/var/lib/ghost/content/${name}` });

  it('stops a held copy in another feature from ever promoting, and keeps the sealed bytes', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    const images = buildAdapter({
      quarantinePath,
      unavailable: [BAD_DIGEST],
      holdMaxRetryMs: RETRY_MS,
      wrappedConfig: feature('images'),
    });
    const media = buildAdapter({
      quarantinePath,
      refuse: refusedAsCsam(),
      wrappedConfig: feature('media'),
    });

    await images.instance.save(await writeTempFile(BAD_BYTES, 'held.png'));
    await expect(
      media.instance.save(await writeTempFile(BAD_BYTES, 'x.mp4'))
    ).rejects.toBeInstanceOf(GhostErrors.UnsupportedMediaTypeError);

    images.verdictClient.deliverVerdict(BAD_DIGEST, { classification: 'no-known-match' });
    await vi.waitFor(() => expect(images.instance.hold.isPending(BAD_DIGEST)).toBe(false), WAIT);

    expect(images.instance.wrapped.savedRaw).toHaveLength(0);
    expect(await fs.readFile(path.join(quarantinePath, BAD_DIGEST))).toEqual(BAD_BYTES);
    expect(await fs.readdir(quarantinePath)).toEqual(
      expect.arrayContaining([BAD_DIGEST, `${BAD_DIGEST}.refused.json`])
    );
  });

  it('refuses a later upload of the same bytes in another feature whose own verdict is clean, worded by the sealed classification', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    const images = buildAdapter({
      quarantinePath,
      refuse: refusedAsCsam(),
      wrappedConfig: feature('images'),
    });
    const files = buildAdapter({ quarantinePath, wrappedConfig: feature('files') });

    await expect(images.instance.saveRaw(BAD_BYTES, 'a.png')).rejects.toBeInstanceOf(
      GhostErrors.UnsupportedMediaTypeError
    );
    let caught;
    try {
      await files.instance.save(await writeTempFile(BAD_BYTES, 'a.png'));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GhostErrors.UnsupportedMediaTypeError);
    expect(caught.context).not.toMatch(/csam/);
    expect(files.instance.wrapped.saved).toHaveLength(0);
    expect(files.instance.wrapped.savedRaw).toHaveLength(0);
  });

  it('keeps the bytes when one feature promotes a clean verdict and another then refuses', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    const boot = (name) =>
      buildAdapter({
        quarantinePath,
        unavailable: [BAD_DIGEST],
        holdMaxRetryMs: RETRY_MS,
        wrappedConfig: feature(name),
      });
    const images = boot('images');
    const media = boot('media');
    await images.instance.save(await writeTempFile(BAD_BYTES, 'held.png'));
    await media.instance.save(await writeTempFile(BAD_BYTES, 'held.mp4'));

    images.verdictClient.deliverVerdict(BAD_DIGEST, { classification: 'no-known-match' });
    await vi.waitFor(() => expect(images.instance.hold.isPending(BAD_DIGEST)).toBe(false), WAIT);
    media.verdictClient.deliverVerdict(BAD_DIGEST, { classification: 'csam', matchType: 'exact' });
    await vi.waitFor(() => expect(media.instance.hold.isPending(BAD_DIGEST)).toBe(false), WAIT);

    expect(media.instance.wrapped.savedRaw).toHaveLength(0);
    expect(await fs.readFile(path.join(quarantinePath, BAD_DIGEST))).toEqual(BAD_BYTES);
  });
});

describe('verified, bounded hold retries through the adapter', () => {
  it('never promotes a held upload whose quarantined bytes were truncated', async () => {
    const { instance, verdictClient, quarantinePath } = buildAdapter({
      unavailable: [BAD_DIGEST],
      holdMaxRetryMs: RETRY_MS,
    });
    await instance.save(await writeTempFile(BAD_BYTES, 'held.png'));
    await fs.truncate(path.join(quarantinePath, BAD_DIGEST), 3);

    verdictClient.deliverVerdict(BAD_DIGEST, { classification: 'no-known-match' });
    await vi.waitFor(() => expect(instance.hold.isStuck(BAD_DIGEST)).toBe(true), WAIT);
    expect(instance.wrapped.savedRaw).toHaveLength(0);
  });

  it('sticks after holdMaxFailures consecutive failed promotions and stops trying', async () => {
    const { instance, verdictClient } = buildAdapter({
      unavailable: [BAD_DIGEST],
      holdMaxRetryMs: RETRY_MS,
      holdMaxFailures: 3,
    });
    let attempts = 0;
    instance.wrapped.saveRaw = async () => {
      attempts += 1;
      throw new Error('bucket unavailable');
    };
    await instance.save(await writeTempFile(BAD_BYTES, 'held.png'));

    verdictClient.deliverVerdict(BAD_DIGEST, { classification: 'no-known-match' });
    await vi.waitFor(() => expect(instance.hold.isStuck(BAD_DIGEST)).toBe(true), WAIT);
    await settle();
    expect(attempts).toBe(3);
  });
});
