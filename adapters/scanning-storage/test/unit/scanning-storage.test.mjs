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
const { sealRefusal } = require('../../src/quarantine.js');
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
// Inside the test's own timeout, so a wait that never succeeds fails its assertion.
const SHORT_WAIT = { timeout: 2000, interval: 10 };

function buildAdapter({
  refuse = new Map(),
  unavailable = [],
  quarantinePath,
  wrappedConfig,
  holdRetryMs = RETRY_MS,
  holdMaxRetryMs,
  holdMaxFailures,
  holdLogger = SILENT_LOGGER,
  overwriteWindowMs,
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
    overwriteWindowMs,
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
  it('delegates exists, read, urlToPath and serve to the wrapped adapter untouched', async () => {
    // Nothing here is masked or specially handled -- a held digest is
    // simply never written to the wrapped adapter until promotion, so
    // there is no separate "intercepted" case to test for these four;
    // existsResult/readResult force a deterministic answer for this
    // pure-delegation check, independent of what has or hasn't been
    // written to the fake's own virtual filesystem.
    const { instance: adapter } = buildAdapter({
      wrappedConfig: { storagePath: 'wrapped', existsResult: true, readResult: Buffer.from('x') },
    });
    await adapter.exists('a.png', 'dir');
    await adapter.read({ path: 'a.png' });
    adapter.urlToPath('https://example.test/content/images/a.png');
    const middleware = adapter.serve();

    expect(typeof middleware).toBe('function');
  });
});

describe('replacing a same-name thumbnail (Ghost deletes, then saves)', () => {
  const NEW_BYTES = Buffer.from('replacement-thumbnail-bytes');
  const NEW_DIGEST = digestBytes(NEW_BYTES);

  // The two shapes the wrapper fronts: a local-disk adapter (no bucket) and
  // an object-storage adapter (a bucket). Each also refuses delete and picks
  // a new name for a taken one, as the gateway and Ghost's save() do.
  const BACKENDS = {
    'local disk': { storagePath: 'wrapped', refuseDelete: true, uniqueNames: true },
    'object storage': {
      storagePath: 'wrapped',
      refuseDelete: true,
      uniqueNames: true,
      bucket: 'media',
      cdnUrl: 'https://media.example.test',
    },
  };

  // What Ghost's uploadThumbnail does, in order.
  async function replaceThumbnail(adapter, file, targetDir) {
    if (await adapter.exists(file.name, targetDir)) {
      await adapter.delete(file.name, targetDir);
    }
    return adapter.save(file, targetDir);
  }

  describe.each(Object.entries(BACKENDS))('on %s', (_name, wrappedConfig) => {
    async function seeded() {
      const built = buildAdapter({ wrappedConfig });
      await built.instance.wrapped.saveRaw(CLEAN_BYTES, 'dir/thumb.png');
      return built;
    }

    it('leaves one object at the same name holding the new bytes and sends no delete', async () => {
      const { instance: adapter } = await seeded();
      const file = await writeTempFile(NEW_BYTES, 'thumb.png');

      await replaceThumbnail(adapter, file, 'dir');

      expect(adapter.wrapped.deleted).toEqual([]);
      expect([...adapter.wrapped.files.keys()]).toEqual(['dir/thumb.png']);
      expect(adapter.wrapped.files.get('dir/thumb.png')).toEqual(NEW_BYTES);
      expect(adapter.wrapped.saved).toEqual([]);
    });

    it('returns the URL of the same name', async () => {
      const { instance: adapter } = await seeded();
      const file = await writeTempFile(NEW_BYTES, 'thumb.png');

      const url = await replaceThumbnail(adapter, file, 'dir');

      expect(url.endsWith('/dir/thumb.png')).toBe(true);
    });

    it('scans the replacement like any upload: a refused digest is refused and the old thumbnail stays', async () => {
      const refuse = new Map([[NEW_DIGEST, { classification: 'csam', matchType: 'exact' }]]);
      const { instance: adapter } = buildAdapter({ wrappedConfig, refuse });
      await adapter.wrapped.saveRaw(CLEAN_BYTES, 'dir/thumb.png');
      const file = await writeTempFile(NEW_BYTES, 'thumb.png');

      await expect(replaceThumbnail(adapter, file, 'dir')).rejects.toThrow();

      expect(adapter.wrapped.files.get('dir/thumb.png')).toEqual(CLEAN_BYTES);
      expect(adapter.wrapped.deleted).toEqual([]);
    });

    it('holds a replacement whose verdict is unavailable and promotes it to the same name', async () => {
      const { instance: adapter } = buildAdapter({ wrappedConfig, unavailable: [NEW_DIGEST] });
      await adapter.wrapped.saveRaw(CLEAN_BYTES, 'dir/thumb.png');
      const file = await writeTempFile(NEW_BYTES, 'thumb.png');

      const url = await replaceThumbnail(adapter, file, 'dir');

      expect(url.endsWith('/dir/thumb.png')).toBe(true);
      expect(adapter.wrapped.files.get('dir/thumb.png')).toEqual(CLEAN_BYTES);
    });
  });

  it('does not turn an unrelated later save of the same name into an overwrite after one use', async () => {
    const { instance: adapter } = buildAdapter({ wrappedConfig: BACKENDS['local disk'] });
    await adapter.wrapped.saveRaw(CLEAN_BYTES, 'dir/thumb.png');
    await replaceThumbnail(adapter, await writeTempFile(NEW_BYTES, 'thumb.png'), 'dir');

    await adapter.save(await writeTempFile(Buffer.from('another'), 'thumb.png'), 'dir');

    const keys = [...adapter.wrapped.files.keys()].sort();
    expect(keys).toHaveLength(2);
    expect(keys).toContain('dir/thumb.png');
    expect(keys.find((k) => k !== 'dir/thumb.png')).toMatch(/^dir\/thumb-[a-z2-7]{22}\.png$/);
  });

  it('only overwrites the name that was deleted', async () => {
    const { instance: adapter } = buildAdapter({ wrappedConfig: BACKENDS['local disk'] });
    await adapter.delete('a.png', 'dir');

    await adapter.save(await writeTempFile(NEW_BYTES, 'b.png'), 'dir');

    expect(adapter.wrapped.saved).toHaveLength(1);
    expect(adapter.wrapped.savedRaw).toEqual([]);
  });

  it('forgets a delete that no save followed once the window has passed', async () => {
    const { instance: adapter } = buildAdapter({
      wrappedConfig: BACKENDS['local disk'],
      overwriteWindowMs: 1,
    });
    await adapter.delete('thumb.png', 'dir');
    await settle(10);

    await adapter.save(await writeTempFile(NEW_BYTES, 'thumb.png'), 'dir');

    expect(adapter.wrapped.saved).toHaveLength(1);
    expect(adapter.pendingOverwrites.size).toBe(0);
  });

  it('prunes stale delete records on the next delete', async () => {
    const { instance: adapter } = buildAdapter({
      wrappedConfig: BACKENDS['local disk'],
      overwriteWindowMs: 1,
    });
    await adapter.delete('old.png', 'dir');
    await settle(10);
    await adapter.delete('new.png', 'dir');

    expect([...adapter.pendingOverwrites.keys()]).toEqual(['dir/new.png']);
  });

  it('honours a configured window and falls back to a default for a bad one', () => {
    expect(buildAdapter({ overwriteWindowMs: 5 }).instance.overwriteWindowMs).toBe(5);
    expect(buildAdapter({ overwriteWindowMs: 'x' }).instance.overwriteWindowMs).toBe(60000);
    expect(buildAdapter({}).instance.overwriteWindowMs).toBe(60000);
  });

  it('treats a save with no usable file name as an ordinary save, never an overwrite', async () => {
    const { instance: adapter } = buildAdapter({ wrappedConfig: BACKENDS['local disk'] });
    await adapter.delete('thumb.png', 'dir');
    const file = await writeTempFile(NEW_BYTES, '');

    await adapter.save(file, 'dir');

    expect(adapter.wrapped.saved).toHaveLength(1);
    expect(adapter.wrapped.savedRaw).toEqual([]);
    expect(adapter.pendingOverwrites.size).toBe(1);
  });

  it('handles a name with no directory', async () => {
    const { instance: adapter } = buildAdapter({ wrappedConfig: BACKENDS['local disk'] });
    await adapter.wrapped.saveRaw(CLEAN_BYTES, 'thumb.png');

    await adapter.delete('thumb.png');
    await adapter.save(await writeTempFile(NEW_BYTES, 'thumb.png'));

    expect([...adapter.wrapped.files.keys()]).toEqual(['thumb.png']);
  });
});

// Ghost's real sequence for an image upload (the images endpoint): trim a
// trailing `_o` from the user's name, save the processed image with no
// directory, then save the original as `<stored basename>_o<ext>` into the
// stored directory. Ghost later asks for `<stored name>_o<ext>`.
async function ghostImageUpload(adapter, name, bytes = CLEAN_BYTES) {
  const trimmed = name.replace(/_o(\.\w+?)$/, '$1');
  const processedUrl = await adapter.save(await writeTempFile(bytes, trimmed));
  const stored = path.posix.parse(adapter.urlToPath(processedUrl));
  const originalUrl = await adapter.save(
    await writeTempFile(bytes, `${stored.name}_o${stored.ext}`),
    stored.dir
  );
  const wanted = `${stored.dir}/${stored.name}_o${stored.ext}`;
  return {
    processedUrl,
    originalUrl,
    stored: `${stored.dir}/${stored.base}`,
    wanted,
    originalFound: adapter.wrapped.files.has(wanted),
  };
}

describe('a clean upload', () => {
  it('writes through to the wrapped adapter and returns its URL', async () => {
    const { instance: adapter } = buildAdapter();
    const file = await writeTempFile(CLEAN_BYTES, 'good.png');
    const url = await adapter.save(file);
    expect(url).toMatch(/good-[a-z2-7]{22}\.png$/);
    expect(adapter.wrapped.saved).toHaveLength(1);
  });

  it('hashes and allows a clean saveRaw derivative too', async () => {
    const { instance: adapter } = buildAdapter();
    const url = await adapter.saveRaw(CLEAN_BYTES, '2026/09/derivative.png');
    expect(url).toContain('derivative.png');
    expect(adapter.wrapped.savedRaw).toHaveLength(1);
  });

  it("stores the original where Ghost's lookup asks for it, under the processed name's one component", async () => {
    const { instance: adapter } = buildAdapter({
      wrappedConfig: { storagePath: 'wrapped', defaultTargetDir: '2026/10' },
    });
    const result = await ghostImageUpload(adapter, 'good.png');
    expect(result.stored).toMatch(/^2026\/10\/good-[a-z2-7]{22}\.png$/);
    expect(result.originalFound).toBe(true);
    expect(result.wanted).toMatch(/^2026\/10\/good-[a-z2-7]{22}_o\.png$/);
    expect(adapter.wrapped.files.size).toBe(2);
  });
});

describe('random upload names', () => {
  const nameOf = (adapter, i) => adapter.wrapped.saved[i].file.name;
  const randomOf = (adapter, i) => /-([a-z2-7]{22})/.exec(nameOf(adapter, i))[1];
  const saveAs = async (adapter, name, dir = '2026/10', bytes = CLEAN_BYTES) =>
    adapter.save(await writeTempFile(bytes, name), dir);
  const dated = () =>
    buildAdapter({ wrappedConfig: { storagePath: 'wrapped', defaultTargetDir: '2026/10' } });

  it('gives every new upload a 22-character base32 component and keeps the extension', async () => {
    const { instance: adapter } = buildAdapter();
    await saveAs(adapter, 'members-report.pdf');
    expect(nameOf(adapter, 0)).toMatch(/^members-report-[a-z2-7]{22}\.pdf$/);
  });

  it('does not repeat a component across uploads of the same filename in different directories', async () => {
    const { instance: adapter } = buildAdapter();
    await saveAs(adapter, 'same.png', '2026/10');
    await saveAs(adapter, 'same.png', '2026/11');
    expect(nameOf(adapter, 0)).not.toBe(nameOf(adapter, 1));
  });

  it('gives a second upload of the same filename in the same directory its own component', async () => {
    const { instance: adapter } = buildAdapter({
      wrappedConfig: { storagePath: 'wrapped', uniqueNames: true },
    });
    await saveAs(adapter, 'report.pdf');
    await saveAs(adapter, 'report.pdf');
    expect(randomOf(adapter, 0)).not.toBe(randomOf(adapter, 1));
    // What the first public URL gives away must not locate the second object,
    // even through the wrapped adapter's own `-1` step for a taken name.
    const [first, second] = [...adapter.wrapped.files.keys()];
    expect(second).not.toBe(first.replace(/\.pdf$/, '-1.pdf'));
  });

  it('draws every component from crypto.randomBytes, one base32 symbol per byte', async () => {
    const { instance: adapter } = buildAdapter();
    const file = await writeTempFile(CLEAN_BYTES, 'src.png');
    const nodeCrypto = require('node:crypto');
    const spy = vi
      .spyOn(nodeCrypto, 'randomBytes')
      .mockReturnValueOnce(Buffer.from(Array.from({ length: 22 }, (_, i) => i)));
    try {
      await adapter.save(file, '2026/10');
      expect(spy).toHaveBeenCalledWith(22);
    } finally {
      spy.mockRestore();
    }
    expect(nameOf(adapter, 0)).toBe('src-abcdefghijklmnopqrstuv.png');
  });

  it('draws components of 22 base32 characters that do not repeat', async () => {
    const { instance: adapter } = buildAdapter();
    const file = await writeTempFile(CLEAN_BYTES, 'many.png');
    for (let i = 0; i < 100; i += 1) {
      await adapter.save(file, '2026/10');
    }
    const components = adapter.wrapped.saved.map((s) => /^many-(.*)\.png$/.exec(s.file.name)[1]);
    expect(components.every((c) => /^[a-z2-7]{22}$/.test(c))).toBe(true);
    expect(new Set(components).size).toBe(100);
  });

  it('names nothing before the safety gate has allowed the upload', async () => {
    const { instance: adapter } = buildAdapter({
      refuse: new Map([
        [BAD_DIGEST, { classification: 'harmful-abusive-material', matchType: 'exact' }],
      ]),
    });
    const file = await writeTempFile(BAD_BYTES, 'bad.png');
    await expect(adapter.save(file, '2026/10')).rejects.toBeInstanceOf(
      GhostErrors.UnsupportedMediaTypeError
    );
    expect(adapter.storedNames.size).toBe(0);
  });

  it('names a file with no extension', async () => {
    const { instance: adapter } = buildAdapter();
    await saveAs(adapter, 'noext');
    expect(nameOf(adapter, 0)).toMatch(/^noext-[a-z2-7]{22}$/);
  });

  it('treats a name that is only an extension as an extension', async () => {
    const { instance: adapter } = buildAdapter();
    await saveAs(adapter, '.jpg');
    expect(nameOf(adapter, 0)).toMatch(/^upload-[a-z2-7]{22}\.jpg$/);
  });

  it('cuts a long stem so the stored name, and the `_o` Ghost adds, fit 255 bytes', async () => {
    const { instance: adapter } = buildAdapter();
    await saveAs(adapter, `${'a'.repeat(300)}.jpg`);
    const name = nameOf(adapter, 0);
    expect(name).toMatch(/^a+-[a-z2-7]{22}\.jpg$/);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(240);
    expect(Buffer.byteLength(`${name.slice(0, -4)}_o.jpg`)).toBeLessThanOrEqual(255);
  });

  it('never splits a multi-byte character when it cuts a stem', async () => {
    const { instance: adapter } = buildAdapter();
    await saveAs(adapter, `${'€'.repeat(100)}.png`);
    const name = nameOf(adapter, 0);
    expect(name).not.toContain('�');
    expect(name).toMatch(/^€+-[a-z2-7]{22}\.png$/);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(240);
  });

  it('does not mutate the file object Ghost passed in', async () => {
    const { instance: adapter } = buildAdapter();
    const file = await writeTempFile(CLEAN_BYTES, 'keep.png');
    await adapter.save(file, '2026/10');
    expect(file.name).toBe('keep.png');
  });

  it('leaves a file with no usable name to the wrapped adapter unchanged', async () => {
    const { instance: adapter } = buildAdapter();
    const file = await writeTempFile(CLEAN_BYTES, 'x.png');
    file.name = '';
    await adapter.save(file, '2026/10');
    expect(nameOf(adapter, 0)).toBe('');
  });

  it('passes a file with no name at all through unchanged', async () => {
    const { instance: adapter } = buildAdapter();
    const file = await writeTempFile(CLEAN_BYTES, 'x.png');
    delete file.name;
    await adapter.save(file, '2026/10');
    expect(adapter.wrapped.saved[0].file.name).toBeUndefined();
  });

  it('falls back to the name it gave when the wrapped adapter returns no URL', async () => {
    const { instance: adapter } = buildAdapter();
    adapter.wrapped.save = async () => undefined;
    await saveAs(adapter, 'quiet.png');
    const [remembered] = [...adapter.storedNames.keys()];
    expect(remembered).toMatch(/^quiet-[a-z2-7]{22}\.png$/);
  });

  it('keeps saveRaw paths exactly as given', async () => {
    const { instance: adapter } = buildAdapter();
    await adapter.saveRaw(CLEAN_BYTES, '2026/10/resized-w600.png');
    expect(adapter.wrapped.savedRaw[0].targetPath).toBe('2026/10/resized-w600.png');
  });

  describe("an original saved the way Ghost's images endpoint saves it", () => {
    it('is stored at exactly the stored name plus `_o`, with no second component', async () => {
      const { instance: adapter } = dated();
      const result = await ghostImageUpload(adapter, 'photo.jpg');
      expect(result.originalFound).toBe(true);
      expect(adapter.wrapped.saved[1].file.name).toMatch(/^photo-[a-z2-7]{22}_o\.jpg$/);
    });

    it('finds each original when several uploads of one name interleave', async () => {
      const { instance: adapter } = dated();
      const a = await saveAs(adapter, 'photo.jpg', null);
      const b = await saveAs(adapter, 'photo.jpg', null);
      const aName = path.posix.basename(a);
      const bName = path.posix.basename(b);
      const stem = (n) => n.replace(/\.jpg$/, '');
      await saveAs(adapter, `${stem(bName)}_o.jpg`, '2026/10');
      await saveAs(adapter, `${stem(aName)}_o.jpg`, '2026/10');
      const keys = [...adapter.wrapped.files.keys()];
      expect(keys).toContain(`2026/10/${stem(aName)}_o.jpg`);
      expect(keys).toContain(`2026/10/${stem(bName)}_o.jpg`);
      expect(keys).toHaveLength(4);
    });

    it('keeps its name only once: a replay of the same original gets its own component', async () => {
      const { instance: adapter } = dated();
      const { wanted } = await ghostImageUpload(adapter, 'photo.jpg');
      const again = await saveAs(adapter, path.posix.basename(wanted), '2026/10');
      expect(path.posix.basename(again)).toMatch(/^photo-[a-z2-7]{22}_o-[a-z2-7]{22}\.jpg$/);
    });

    it('is not kept once the window has passed', async () => {
      vi.useFakeTimers();
      try {
        const { instance: adapter } = dated();
        const processed = await saveAs(adapter, 'late.jpg', null);
        vi.advanceTimersByTime(61000);
        const name = path.posix.basename(processed).replace(/\.jpg$/, '_o.jpg');
        const original = await saveAs(adapter, name, '2026/10');
        expect(path.posix.basename(original)).not.toBe(name);
        expect(adapter.storedNames.size).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('an upload whose own name ends `_o` (files and media do not trim it)', () => {
    const derive = (url) => url.replace('_o', '');

    it('gets its own component when it follows no stored name', async () => {
      const { instance: adapter } = buildAdapter();
      await saveAs(adapter, 'report_o.pdf');
      expect(nameOf(adapter, 0)).toMatch(/^report_o-[a-z2-7]{22}\.pdf$/);
    });

    it("cannot be turned into a victim's URL, victim first", async () => {
      const { instance: adapter } = buildAdapter();
      const victim = await saveAs(adapter, 'x.pdf');
      const attacker = await saveAs(adapter, 'x_o.pdf');
      expect(derive(attacker)).not.toBe(victim);
      expect(randomOf(adapter, 1)).not.toBe(randomOf(adapter, 0));
    });

    it("cannot be turned into a victim's URL, attacker first", async () => {
      const { instance: adapter } = buildAdapter();
      const attacker = await saveAs(adapter, 'x_o.pdf');
      const victim = await saveAs(adapter, 'x.pdf');
      expect(derive(attacker)).not.toBe(victim);
      expect(randomOf(adapter, 0)).not.toBe(randomOf(adapter, 1));
    });

    it('does not link two uploads of the same `_o` name', async () => {
      const { instance: adapter } = buildAdapter();
      await saveAs(adapter, 'c_o.png');
      await saveAs(adapter, 'c_o.png');
      expect(randomOf(adapter, 0)).not.toBe(randomOf(adapter, 1));
    });

    it('cannot claim a stored name it has not been given', async () => {
      const { instance: adapter } = buildAdapter();
      await saveAs(adapter, 'x.pdf');
      const guess = `x-${'a'.repeat(22)}_o.pdf`;
      await saveAs(adapter, guess);
      expect(nameOf(adapter, 1)).not.toBe(guess);
      expect(nameOf(adapter, 1)).toMatch(/_o-[a-z2-7]{22}\.pdf$/);
    });
  });

  it('forgets a stored name after the window and keeps only the live ones', async () => {
    vi.useFakeTimers();
    try {
      const { instance: adapter } = buildAdapter();
      await saveAs(adapter, 'p.png');
      vi.advanceTimersByTime(61000);
      await saveAs(adapter, 'q.png');
      expect(adapter.storedNames.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the oldest entry once the table is full', async () => {
    const { instance: adapter } = buildAdapter();
    for (let i = 0; i < 1000; i += 1) {
      adapter.storedNames.set(`seed${i}.png`, { expiresAt: Date.now() + 60000 });
    }
    await saveAs(adapter, 'fresh.png', 'd');
    expect(adapter.storedNames.size).toBe(1000);
    expect(adapter.storedNames.has('seed0.png')).toBe(false);
    expect(adapter.storedNames.has('seed1.png')).toBe(true);
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

// The hold branch, on both backends. The verdict client answers
// `unavailable` rather than hanging: checks.js's own tests prove the timeout.
// The backends differ only in URL shape, so the cases are parametrised.
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
      await vi.waitFor(() => expect(adapter.hold.isPending(BAD_DIGEST)).toBe(false), WAIT);

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
      await vi.waitFor(() => expect(adapter.hold.isPending(BAD_DIGEST)).toBe(false), WAIT);

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
      await vi.waitFor(() => expect(adapter.hold.isPending(BAD_DIGEST)).toBe(false), WAIT);

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

    it('stores a held upload under its digest plus a random component, never the bare digest', async () => {
      const { instance: adapter, verdictClient } = buildBackendAdapter({
        unavailable: [BAD_DIGEST],
      });
      adapter.wrapped.getTargetDir = () => '2026/10';
      const url = await adapter.save(await writeTempFile(BAD_BYTES, 'members-report.png'));

      verdictClient.deliverVerdict(BAD_DIGEST, { classification: 'no-known-match' });
      await vi.waitFor(() => expect(adapter.hold.isPending(BAD_DIGEST)).toBe(false), WAIT);

      const [{ targetPath }] = adapter.wrapped.savedRaw;
      expect(targetPath).toMatch(new RegExp(`^2026/10/${BAD_DIGEST}-[a-z2-7]{22}\\.png$`));
      expect(targetPath).not.toBe(`2026/10/${BAD_DIGEST}.png`);
      // The URL the author was given is the key the bytes land at.
      expect(url.endsWith(targetPath)).toBe(true);
    });

    it('stores a held original at its held processed name plus `_o`, so Ghost finds it', async () => {
      const originalBytes = Buffer.from('a held original, different bytes');
      const originalDigest = digestBytes(originalBytes);
      const { instance: adapter, verdictClient } = buildBackendAdapter({
        unavailable: [BAD_DIGEST, originalDigest],
      });
      adapter.wrapped.getTargetDir = () => '2026/10';
      const url = await adapter.save(await writeTempFile(BAD_BYTES, 'held.png'));
      const base = path.posix.basename(url).replace(/\.png$/, '');
      await adapter.save(await writeTempFile(originalBytes, `${base}_o.png`), '2026/10');

      for (const digest of [BAD_DIGEST, originalDigest]) {
        verdictClient.deliverVerdict(digest, { classification: 'no-known-match' });
        await vi.waitFor(() => expect(adapter.hold.isPending(digest)).toBe(false), WAIT);
      }

      const paths = adapter.wrapped.savedRaw.map((s) => s.targetPath);
      expect(paths).toContain(`2026/10/${base}.png`);
      expect(paths).toContain(`2026/10/${base}_o.png`);
    });

    it('gives the same held bytes uploaded twice two different keys', async () => {
      const { instance: adapter, verdictClient } = buildBackendAdapter({
        unavailable: [BAD_DIGEST],
      });
      adapter.wrapped.getTargetDir = () => '2026/10';
      await adapter.save(await writeTempFile(BAD_BYTES, 'twice.png'));
      await adapter.save(await writeTempFile(BAD_BYTES, 'twice.png'));

      verdictClient.deliverVerdict(BAD_DIGEST, { classification: 'no-known-match' });
      await vi.waitFor(() => expect(adapter.hold.isPending(BAD_DIGEST)).toBe(false), WAIT);

      const paths = adapter.wrapped.savedRaw.map((s) => s.targetPath);
      expect(paths).toHaveLength(2);
      expect(paths[0]).not.toBe(paths[1]);
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
      await vi.waitFor(() => expect(secondAdapter.hold.isPending(BAD_DIGEST)).toBe(false), WAIT);

      expect(secondAdapter.wrapped.savedRaw).toHaveLength(1);
      expect(secondAdapter.wrapped.savedRaw[0].buffer.equals(BAD_BYTES)).toBe(true);
    });

    it('a resumed hold promotes to the random-component key its upload was told about', async () => {
      const { instance: firstAdapter, quarantinePath } = buildAdapter({
        unavailable: [BAD_DIGEST],
        wrappedConfig: { storagePath: 'wrapped' },
      });
      firstAdapter.wrapped.getTargetDir = () => '2026/10';
      const url = await firstAdapter.save(await writeTempFile(BAD_BYTES, 'held.png'));

      const { instance: secondAdapter, verdictClient } = buildAdapter({
        quarantinePath,
        unavailable: [BAD_DIGEST],
        wrappedConfig: { storagePath: 'wrapped' },
      });
      verdictClient.deliverVerdict(BAD_DIGEST, { classification: 'no-known-match' });
      await vi.waitFor(() => expect(secondAdapter.hold.isPending(BAD_DIGEST)).toBe(false), WAIT);

      const { targetPath } = secondAdapter.wrapped.savedRaw[0];
      expect(targetPath).toMatch(new RegExp(`-[a-z2-7]{22}\\.png$`));
      expect(url.endsWith(targetPath)).toBe(true);
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

      expect(url).toMatch(
        new RegExp(
          `^https://cdn\\.example\\.test/test-bucket/2026/09/${BAD_DIGEST}-[a-z2-7]{22}\\.png$`
        )
      );
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
      expect(url).toMatch(
        new RegExp(`^https://s3\\.example\\.test/test-bucket/${BAD_DIGEST}-[a-z2-7]{22}\\.png$`)
      );
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
      expect(url).toMatch(new RegExp(`^/content/wrapped/${BAD_DIGEST}-[a-z2-7]{22}\\.png$`));
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

describe('stale aside copies at start-up', () => {
  it('the adapter restores one whose digest is refused and deletes one whose digest is not', async () => {
    const quarantinePath = path.join(tmpDir, 'quarantine');
    await fs.mkdir(quarantinePath);
    await fs.writeFile(path.join(quarantinePath, `${BAD_DIGEST}.releasing.1.aaa`), BAD_BYTES);
    await fs.writeFile(path.join(quarantinePath, `${BAD_DIGEST}.refused.json`), '{}');
    const cleanDigest = digestBytes(CLEAN_BYTES);
    await fs.writeFile(path.join(quarantinePath, `${cleanDigest}.releasing.1.bbb`), CLEAN_BYTES);

    buildAdapter({ quarantinePath });

    expect((await fs.readdir(quarantinePath)).sort()).toEqual(
      [BAD_DIGEST, `${BAD_DIGEST}.refused.json`].sort()
    );
    await expect(fs.readFile(path.join(quarantinePath, BAD_DIGEST))).resolves.toEqual(BAD_BYTES);
  });
});

describe('a refusal sealed while an upload waits for its verdict', () => {
  it('still refuses the upload after a clean verdict', async () => {
    const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
      loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
      GhostErrors,
    });
    const quarantinePath = path.join(tmpDir, 'quarantine');
    const slowCleanCheck = {
      kind: 'media',
      blocking: true,
      async run({ buffer }) {
        // Another feature refuses the same bytes while this verdict is pending.
        await sealRefusal(
          quarantinePath,
          digestBytes(buffer),
          buffer,
          { classification: 'csam' },
          digestBytes
        );
        return { classification: 'no-known-match', evidence: digestBytes(buffer), source: 'test' };
      },
    };
    const adapter = new Adapter({
      wraps: 'FakeAdapter',
      wrappedConfig: { storagePath: 'wrapped' },
      quarantinePath,
      checks: [slowCleanCheck],
      policy: new SafetyPolicy(),
      computeDigest: digestBytes,
      holdLogger: SILENT_LOGGER,
    });

    await expect(adapter.save(await writeTempFile(BAD_BYTES, 'a.png'))).rejects.toBeInstanceOf(
      GhostErrors.UnsupportedMediaTypeError
    );
    expect(adapter.wrapped.saved).toHaveLength(0);
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
    await vi.waitFor(() => expect(instance.hold.isPending(BAD_DIGEST)).toBe(false), WAIT);
    expect(instance.wrapped.savedRaw).toHaveLength(0);
    expect(instance.hold.isStuck(BAD_DIGEST)).toBe(true);
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
    await vi.waitFor(() => expect(instance.hold.isStuck(BAD_DIGEST)).toBe(true), SHORT_WAIT);
    await settle();
    expect(attempts).toBe(3);
    expect(instance.hold.isStuck(BAD_DIGEST)).toBe(true);
    expect(instance.hold.isPending(BAD_DIGEST)).toBe(false);
  });
});

// With no verdict source the decorator declines every upload before reading,
// hashing, sealing or writing anything. This is a different state from an
// outage, which is held: see the describe block after this one.
describe('refuseUploadsReason (no verdict source)', () => {
  function unscannableAdapter(logged = [], reason = 'SCANNER_UNCONFIGURED') {
    const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
      loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
      GhostErrors,
    });
    return new Adapter({
      wraps: 'FakeAdapter',
      wrappedConfig: { storagePath: 'wrapped' },
      quarantinePath: path.join(tmpDir, 'quarantine'),
      checks: [],
      policy: new SafetyPolicy(),
      computeDigest: digestBytes,
      refuseUploadsReason: reason,
      holdLogger: { error: (line) => logged.push(line) },
    });
  }

  it('refuses saveRaw with a typed 503 and never reaches the wrapped adapter', async () => {
    const adapter = unscannableAdapter();
    const err = await adapter.saveRaw(CLEAN_BYTES, '2026/10/a.png').catch((e) => e);
    expect(err).toBeInstanceOf(GhostErrors.MaintenanceError);
    expect(err.statusCode).toBe(503);
    expect(adapter.wrapped.savedRaw).toEqual([]);
  });

  it('refuses save() before it reads the file, and seals nothing', async () => {
    const adapter = unscannableAdapter();
    const missing = { name: 'a.png', path: path.join(tmpDir, 'no-such-file') };
    await expect(adapter.save(missing)).rejects.toMatchObject({ statusCode: 503 });
    expect(adapter.wrapped.saved).toEqual([]);
    const sealed = await fs.readdir(path.join(tmpDir, 'quarantine')).catch(() => []);
    expect(sealed).toEqual([]);
  });

  it('logs one alertable line per refusal', async () => {
    const logged = [];
    const adapter = unscannableAdapter(logged);
    const boot = logged.length;
    await adapter.saveRaw(CLEAN_BYTES, '2026/10/a.png').catch(() => {});
    expect(logged).toHaveLength(boot + 1);
    expect(logged.at(-1)).toBe(
      'ScanningStorageAdapter: UPLOAD_REFUSED_SCANNER_UNCONFIGURED wraps=FakeAdapter'
    );
  });

  it.each(['', null, true, 5])(
    'treats the reason %j as the switch being off (an unset reason is the default)',
    async (reason) => {
      const adapter = unscannableAdapter([], reason);
      expect(adapter.refuseUploadsReason).toBeNull();
    }
  );

  it('keeps answering reads for what is already stored', async () => {
    const adapter = unscannableAdapter();
    adapter.wrapped.files.set('2026/10/old.png', Buffer.from('old'));
    await expect(adapter.exists('old.png', '2026/10')).resolves.toBe(true);
  });
});

// Control: the other closed state. A channel that is configured but slow is
// accepted and held, never refused and never allowed.
describe('a configured channel that does not answer in time', () => {
  it('accepts the upload and holds it unserved', async () => {
    const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
      loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
      GhostErrors,
    });
    const slowClient = { getVerdict: () => new Promise(() => {}) };
    const instance = new Adapter({
      wraps: 'FakeAdapter',
      wrappedConfig: { storagePath: 'wrapped' },
      quarantinePath: path.join(tmpDir, 'quarantine'),
      checks: [
        createPdqKnownMaterialCheck(slowClient, { computeDigest: digestBytes, timeoutMs: 10 }),
      ],
      policy: new SafetyPolicy(),
      computeDigest: digestBytes,
      holdRetryMs: RETRY_MS,
      holdLogger: SILENT_LOGGER,
    });
    const url = await instance.saveRaw(CLEAN_BYTES, '2026/10/slow.png');
    expect(url).toMatch(/slow\.png$/);
    expect(instance.wrapped.savedRaw).toEqual([]);
    expect(instance.hold.isPending(digestBytes(CLEAN_BYTES))).toBe(true);
  });
});
