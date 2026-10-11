import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeStorageBase } from '../helpers/fake-storage-base.mjs';
import {
  FakeWrappedAdapter,
  makeLoadWrappedAdapterClass,
} from '../helpers/fake-wrapped-adapter.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(HERE, '../../src');
const OVERLAY_DIR = path.resolve(HERE, '../../ghost-core-overlay');
const REPO_ROOT = path.resolve(HERE, '../../../..');

const { defineScanningStorageAdapter } = require('../../src/scanning-storage.js');
const { defineGatedThemeStorage } = require('../../src/theme-gate.js');
const { FakeVerdictClient } = require('../../src/verdict-client.js');
const { SafetyPolicy } = require('../../src/policy.js');
const { createPdqKnownMaterialCheck } = require('../../src/checks.js');
const { digestBytes } = require('../../src/pdq.js');
const { sealRefusal } = require('../../src/quarantine.js');
const GhostErrors = require('@tryghost/errors');

// The entry file and the overlay are the two files Ghost loads by name. Both
// require modules only Ghost's own image carries, answered here by doubles
// for the life of this file.
const NodeModule = require('node:module');
const originalLoad = NodeModule._load;
const WRAPPED_PATH = path.join(SRC_DIR, 'FakeAdapter');
const UPSTREAM_PATH = path.join(OVERLAY_DIR, 'theme-storage.upstream');
const fakeAdapterManager = { getAdapter: () => null };
class FakeUpstreamThemeStorage {
  static instances = [];

  constructor() {
    this.saved = [];
    this.renames = [];
    this.events = [];
    this.present = new Set(['mine']);
    FakeUpstreamThemeStorage.instances.push(this);
  }

  async exists(name) {
    return this.present.has(name);
  }

  async rename(src, dest) {
    this.renames.push([src, dest]);
    this.events.push(`rename:${src}>${dest}`);
    this.present.delete(src);
    this.present.add(dest);
  }

  async save(file, targetDir) {
    this.saved.push({ file, targetDir });
    this.events.push(`save:${file.name}`);
    return `/content/themes/${file.name}`;
  }

  async saveRaw() {
    this.savedRaw = true;
    return 'raw';
  }
}
NodeModule._load = function patchedLoad(request, ...rest) {
  if (request === 'ghost-storage-base') {
    return { StorageBase: FakeStorageBase };
  }
  if (request === WRAPPED_PATH) {
    return FakeWrappedAdapter;
  }
  if (request === './theme-storage.upstream') {
    return FakeUpstreamThemeStorage;
  }
  if (request === '../adapter-manager') {
    return { default: fakeAdapterManager };
  }
  if (request === '../../adapters/storage/theme-gate') {
    return require(path.join(SRC_DIR, 'theme-gate.js'));
  }
  return originalLoad.call(this, request, ...rest);
};
afterAll(() => {
  NodeModule._load = originalLoad;
});

const EntryAdapter = require('../../src/ScanningStorageAdapter.js');

const CLEAN_BYTES = Buffer.from('clean-image-bytes');
const BAD_BYTES = Buffer.from('known-bad-image-bytes');
const BAD_DIGEST = digestBytes(BAD_BYTES);
const SILENT_LOGGER = { error: () => {} };

let tmpDir;
let themeDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'theme-gate-test-'));
  themeDir = path.join(tmpDir, 'theme');
  await fs.mkdir(path.join(themeDir, 'assets', 'images'), { recursive: true });
  await fs.writeFile(path.join(themeDir, 'default.hbs'), '{{{body}}}');
  await fs.writeFile(path.join(themeDir, 'assets', 'images', 'logo.png'), CLEAN_BYTES);
  FakeUpstreamThemeStorage.instances = [];
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function decorator({
  refuse = new Map(),
  unavailable = [],
  refuseUploadsReason,
  verdictClient = new FakeVerdictClient({ refuse, unavailable }),
  treeMaxEntries,
  treeDeadlineMs,
} = {}) {
  const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
    loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
    GhostErrors,
  });
  return new Adapter({
    treeMaxEntries,
    treeDeadlineMs,
    wraps: 'FakeAdapter',
    wrappedConfig: { storagePath: 'wrapped' },
    quarantinePath: path.join(tmpDir, 'quarantine'),
    checks: [createPdqKnownMaterialCheck(verdictClient, { computeDigest: digestBytes })],
    policy: new SafetyPolicy(),
    computeDigest: digestBytes,
    refuseUploadsReason,
    holdRetryMs: 20,
    holdLogger: SILENT_LOGGER,
  });
}

async function quarantineListing() {
  return fs.readdir(path.join(tmpDir, 'quarantine')).catch(() => []);
}

describe('the decorator screens a directory tree on the same terms as an upload', () => {
  it('declines a tree with a typed 503 before reading anything when there is no verdict source', async () => {
    const adapter = decorator({ refuseUploadsReason: 'SCANNER_UNCONFIGURED' });
    const err = await adapter.screenTree(path.join(tmpDir, 'no-such-dir')).catch((e) => e);
    expect(err).toBeInstanceOf(GhostErrors.MaintenanceError);
    expect(err.statusCode).toBe(503);
    expect(await quarantineListing()).toEqual([]);
    expect(adapter.wrapped.saved).toEqual([]);
    expect(adapter.wrapped.savedRaw).toEqual([]);
  });

  it('returns for a tree whose every file is clean, and writes nothing to the wrapped adapter', async () => {
    const adapter = decorator();
    await expect(adapter.screenTree(themeDir)).resolves.toBeUndefined();
    expect(adapter.wrapped.saved).toEqual([]);
    expect(adapter.wrapped.savedRaw).toEqual([]);
  });

  it('refuses the whole tree with a 415 when a nested file matches, and seals that file', async () => {
    await fs.mkdir(path.join(themeDir, 'assets', 'deep'), { recursive: true });
    await fs.writeFile(path.join(themeDir, 'assets', 'deep', 'banner.png'), BAD_BYTES);
    const adapter = decorator({
      refuse: new Map([[BAD_DIGEST, { classification: 'csam', matchType: 'exact' }]]),
    });
    const err = await adapter.screenTree(themeDir).catch((e) => e);
    expect(err).toBeInstanceOf(GhostErrors.UnsupportedMediaTypeError);
    expect(err.statusCode).toBe(415);
    expect(err.context).not.toMatch(/csam/);
    const sealed = await quarantineListing();
    expect(sealed).toContain(BAD_DIGEST);
    expect(adapter.wrapped.savedRaw).toEqual([]);
  });

  it('screens a file that is not named like an image', async () => {
    await fs.writeFile(path.join(themeDir, 'assets', 'notes.txt'), BAD_BYTES);
    const adapter = decorator({
      refuse: new Map([
        [BAD_DIGEST, { classification: 'harmful-abusive-material', matchType: 'exact' }],
      ]),
    });
    await expect(adapter.screenTree(themeDir)).rejects.toMatchObject({ statusCode: 415 });
  });

  it('refuses bytes another feature already sealed, whatever the verdict now says', async () => {
    const adapter = decorator();
    await fs.writeFile(path.join(themeDir, 'assets', 'sealed.png'), BAD_BYTES);
    await sealRefusal(
      path.join(tmpDir, 'quarantine'),
      BAD_DIGEST,
      BAD_BYTES,
      { classification: 'harmful-abusive-material', matchType: 'exact', evidence: BAD_DIGEST },
      digestBytes
    );
    await expect(adapter.screenTree(themeDir)).rejects.toMatchObject({ statusCode: 415 });
  });

  it('declines with a 503 and keeps nothing when a verdict is unavailable', async () => {
    const unclearedDigest = digestBytes(CLEAN_BYTES);
    const adapter = decorator({ unavailable: [unclearedDigest] });
    const err = await adapter.screenTree(themeDir).catch((e) => e);
    expect(err).toBeInstanceOf(GhostErrors.MaintenanceError);
    expect(err.statusCode).toBe(503);
    expect(err.message).toMatch(/not answered/);
    expect(await quarantineListing()).toEqual([]);
    expect(adapter.hold.isPending(unclearedDigest)).toBe(false);
  });

  it('declines a tree holding a symbolic link, which a copy would follow', async () => {
    await fs.symlink('/etc/hostname', path.join(themeDir, 'assets', 'link.png'));
    const adapter = decorator();
    const err = await adapter.screenTree(themeDir).catch((e) => e);
    expect(err).toBeInstanceOf(GhostErrors.UnsupportedMediaTypeError);
    expect(err.statusCode).toBe(415);
  });

  it('declines a tree with more entries than the cap, before reading or asking anything', async () => {
    const asked = [];
    const verdictClient = {
      getVerdict: async (digest) => {
        asked.push(digest);
        return { classification: 'no-known-match', source: 'test' };
      },
    };
    // The beforeEach tree has 2 directories and 2 files: 4 entries.
    const capped = decorator({ verdictClient, treeMaxEntries: 3 });
    const err = await capped.screenTree(themeDir).catch((e) => e);
    expect(err).toBeInstanceOf(GhostErrors.UnsupportedMediaTypeError);
    expect(err.statusCode).toBe(415);
    expect(asked).toEqual([]);

    const roomy = decorator({ verdictClient, treeMaxEntries: 4 });
    await expect(roomy.screenTree(themeDir)).resolves.toBeUndefined();
    expect(asked).toHaveLength(2);
  });

  it('declines a tree whose verdicts run past the whole-tree deadline, and keeps nothing', async () => {
    for (let i = 0; i < 12; i += 1) {
      await fs.writeFile(path.join(themeDir, `extra-${i}.txt`), `extra-${i}`);
    }
    const slow = {
      getVerdict: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { classification: 'no-known-match', source: 'slow' };
      },
    };
    const adapter = decorator({ verdictClient: slow, treeDeadlineMs: 60 });
    const err = await adapter.screenTree(themeDir).catch((e) => e);
    expect(err).toBeInstanceOf(GhostErrors.MaintenanceError);
    expect(err.statusCode).toBe(503);
    expect(err.message).toMatch(/not answered/);
    expect(await quarantineListing()).toEqual([]);

    const patient = decorator({ verdictClient: slow, treeDeadlineMs: 60_000 });
    await expect(patient.screenTree(themeDir)).resolves.toBeUndefined();
  });

  it('reads both bounds from config, falling back to its defaults for anything unusable', () => {
    expect(decorator().treeMaxEntries).toBe(5000);
    expect(decorator().treeDeadlineMs).toBe(30000);
    expect(decorator({ treeMaxEntries: '7', treeDeadlineMs: '900' }).treeMaxEntries).toBe(7);
    expect(decorator({ treeMaxEntries: '7', treeDeadlineMs: '900' }).treeDeadlineMs).toBe(900);
    expect(decorator({ treeMaxEntries: 'many', treeDeadlineMs: -1 }).treeMaxEntries).toBe(5000);
    expect(decorator({ treeMaxEntries: 'many', treeDeadlineMs: -1 }).treeDeadlineMs).toBe(30000);
  });

  it.each([undefined, null, '', 42])('declines a root that is not a path (%j)', async (root) => {
    const adapter = decorator();
    await expect(adapter.screenTree(root)).rejects.toMatchObject({ statusCode: 415 });
  });
});

describe('the gated theme storage', () => {
  function gated(getAdapter) {
    const Gated = defineGatedThemeStorage(FakeUpstreamThemeStorage, {
      adapterManager: { getAdapter },
      GhostErrors,
    });
    return new Gated();
  }

  it('screens the extracted tree first and only then lets the upstream save run', async () => {
    let savedWhenScreened = null;
    const storage = gated(() => ({
      screenTree: async () => {
        savedWhenScreened = FakeUpstreamThemeStorage.instances[0].saved.length;
      },
    }));
    const url = await storage.save({ name: 'mine', path: themeDir }, undefined);
    expect(url).toBe('/content/themes/mine');
    expect(savedWhenScreened).toBe(0);
    expect(FakeUpstreamThemeStorage.instances[0].saved).toHaveLength(1);
  });

  it('never reaches the upstream save when the screen refuses', async () => {
    const refusal = new GhostErrors.UnsupportedMediaTypeError({ message: 'no' });
    const storage = gated(() => ({
      screenTree: async () => {
        throw refusal;
      },
    }));
    await expect(storage.save({ name: 'mine', path: themeDir })).rejects.toBe(refusal);
    expect(FakeUpstreamThemeStorage.instances[0].saved).toEqual([]);
  });

  it.each([
    ['no storage:images adapter', () => null],
    ['an adapter that cannot screen a tree', () => ({ save: async () => {} })],
    [
      'an adapter lookup that throws',
      () => {
        throw new Error('not configured');
      },
    ],
  ])('declines with the unconfigured 503 when there is %s', async (_label, getAdapter) => {
    const storage = gated(getAdapter);
    const err = await storage.save({ name: 'mine', path: themeDir }).catch((e) => e);
    expect(err).toBeInstanceOf(GhostErrors.MaintenanceError);
    expect(err.statusCode).toBe(503);
    expect(err.message).toMatch(/not configured/);
    expect(FakeUpstreamThemeStorage.instances[0].saved).toEqual([]);
  });

  it('declines a write from a buffer and never reaches the upstream saveRaw', async () => {
    const storage = gated(() => ({ screenTree: async () => {} }));
    const err = await storage.saveRaw(Buffer.from('x'), 'a.png').catch((e) => e);
    expect(err).toBeInstanceOf(GhostErrors.UnsupportedMediaTypeError);
    expect(FakeUpstreamThemeStorage.instances[0].savedRaw).toBeUndefined();
  });

  it('screens through a real decorator end to end: no source declines, a clean source lets it save', async () => {
    const closed = decorator({ refuseUploadsReason: 'SCANNER_UNCONFIGURED' });
    await expect(gated(() => closed).save({ name: 'mine', path: themeDir })).rejects.toMatchObject({
      statusCode: 503,
    });

    const open = decorator();
    await expect(gated(() => open).save({ name: 'mine', path: themeDir })).resolves.toBe(
      '/content/themes/mine'
    );
  });

  it('asks the images feature specifically', async () => {
    const asked = [];
    const storage = gated((name) => {
      asked.push(name);
      return { screenTree: async () => {} };
    });
    await storage.save({ name: 'mine', path: themeDir });
    expect(asked).toEqual(['storage:images']);
  });
});

// Ghost moves an existing theme to `<name>_<24 hex>` before it calls save(),
// and its own restore of a refused one is not awaited, so a refusal must find
// nothing moved. These replay Ghost's call order against a recording upstream.
describe('a refused re-upload of an installed theme name', () => {
  const BACKUP = 'mine_6acae7f2a177e600014e46bf';

  function gated(getAdapter) {
    const Gated = defineGatedThemeStorage(FakeUpstreamThemeStorage, {
      adapterManager: { getAdapter },
      GhostErrors,
    });
    return new Gated();
  }

  const refusing = () => ({
    screenTree: async () => {
      throw new GhostErrors.UnsupportedMediaTypeError({ message: 'no' });
    },
  });
  const clean = () => ({ screenTree: async () => {} });

  it('never moves the installed theme: the backup move is held and then dropped', async () => {
    const storage = gated(refusing);
    await storage.rename('mine', BACKUP);
    await expect(storage.save({ name: 'mine', path: themeDir })).rejects.toMatchObject({
      statusCode: 415,
    });
    const upstream = FakeUpstreamThemeStorage.instances[0];
    expect(upstream.renames).toEqual([]);
    expect(upstream.saved).toEqual([]);
    expect(upstream.present.has('mine')).toBe(true);
    expect(storage.deferredMoves.size).toBe(0);
  });

  it('declines the same way for every attempt, never touching the theme', async () => {
    const storage = gated(() => {
      throw new Error('not configured');
    });
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await storage.rename('mine', BACKUP);
      await expect(storage.save({ name: 'mine', path: themeDir })).rejects.toMatchObject({
        statusCode: 503,
      });
    }
    expect(FakeUpstreamThemeStorage.instances[0].renames).toEqual([]);
  });

  it('on a clean verdict moves the old theme aside first and then saves, in that order', async () => {
    const storage = gated(clean);
    await storage.rename('mine', BACKUP);
    expect(FakeUpstreamThemeStorage.instances[0].renames).toEqual([]);
    await storage.save({ name: 'mine', path: themeDir });
    expect(FakeUpstreamThemeStorage.instances[0].events).toEqual([
      `rename:mine>${BACKUP}`,
      'save:mine',
    ]);
  });

  it("passes Ghost's restore (backup back to the name) straight through", async () => {
    const storage = gated(clean);
    await storage.rename(BACKUP, 'mine');
    expect(FakeUpstreamThemeStorage.instances[0].renames).toEqual([[BACKUP, 'mine']]);
  });

  it.each([
    ['a destination that is not a backup name', 'mine', 'elsewhere'],
    ['a destination with a short suffix', 'mine', 'mine_abc'],
    ['a destination with a non-hex suffix', 'mine', `mine_${'g'.repeat(24)}`],
    ["another theme's backup name", 'mine', 'other_6acae7f2a177e600014e46bf'],
  ])('passes %s straight through', async (_label, src, dest) => {
    const storage = gated(clean);
    await storage.rename(src, dest);
    expect(FakeUpstreamThemeStorage.instances[0].renames).toEqual([[src, dest]]);
  });

  it('treats a name with regular-expression characters as a plain name', async () => {
    const storage = gated(clean);
    await storage.rename('a.b', 'aXb_6acae7f2a177e600014e46bf');
    expect(FakeUpstreamThemeStorage.instances[0].renames).toHaveLength(1);
    await storage.rename('a.b', 'a.b_6acae7f2a177e600014e46bf');
    expect(FakeUpstreamThemeStorage.instances[0].renames).toHaveLength(1);
  });

  it('does not move a theme that is no longer there when a held move is finally taken', async () => {
    const storage = gated(clean);
    FakeUpstreamThemeStorage.instances[0].present.clear();
    await storage.rename('mine', BACKUP);
    await storage.save({ name: 'mine', path: themeDir });
    expect(FakeUpstreamThemeStorage.instances[0].renames).toEqual([]);
    expect(FakeUpstreamThemeStorage.instances[0].saved).toHaveLength(1);
  });

  it('forgets a held move once it is taken, so a later save moves nothing', async () => {
    const storage = gated(clean);
    await storage.rename('mine', BACKUP);
    await storage.save({ name: 'mine', path: themeDir });
    FakeUpstreamThemeStorage.instances[0].present.add('mine');
    await storage.save({ name: 'mine', path: themeDir });
    expect(FakeUpstreamThemeStorage.instances[0].renames).toHaveLength(1);
  });

  it('declines through a real decorator with no verdict source and moves nothing', async () => {
    const closed = decorator({ refuseUploadsReason: 'SCANNER_UNCONFIGURED' });
    const storage = gated(() => closed);
    await storage.rename('mine', BACKUP);
    await expect(storage.save({ name: 'mine', path: themeDir })).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(FakeUpstreamThemeStorage.instances[0].renames).toEqual([]);
  });
});

describe('defineGatedThemeStorage dependency guards', () => {
  const adapterManager = { getAdapter: () => null };

  it('requires the upstream class', () => {
    expect(() => defineGatedThemeStorage(undefined, { adapterManager, GhostErrors })).toThrow(
      /upstream ThemeStorage/
    );
  });

  it('requires an adapter manager', () => {
    expect(() => defineGatedThemeStorage(FakeUpstreamThemeStorage, { GhostErrors })).toThrow(
      /adapterManager/
    );
  });

  it('requires the two error classes it throws', () => {
    expect(() =>
      defineGatedThemeStorage(FakeUpstreamThemeStorage, { adapterManager, GhostErrors: {} })
    ).toThrow(/GhostErrors/);
  });
});

describe('the entry file wires screenTree to the same verdict source as an upload', () => {
  function entry(extra = {}) {
    return new EntryAdapter({
      wraps: 'FakeAdapter',
      wrappedConfig: { storagePath: 'wrapped' },
      quarantinePath: path.join(tmpDir, 'quarantine'),
      holdLogger: SILENT_LOGGER,
      ...extra,
    });
  }

  it('declines a theme tree with the default config, as it declines an upload', async () => {
    const adapter = entry();
    const treeErr = await adapter.screenTree(themeDir).catch((e) => e);
    const uploadErr = await adapter
      .save({ name: 'a.png', path: path.join(themeDir, 'assets', 'images', 'logo.png') })
      .catch((e) => e);
    expect(treeErr.statusCode).toBe(503);
    expect(treeErr.message).toBe(uploadErr.message);
    expect(treeErr.context).toBe(uploadErr.context);
    expect(treeErr.message).toMatch(/not configured/);
  });

  it('declines a typo of the verdict source value too', async () => {
    const adapter = entry({ verdictSource: 'In-Process-Fake' });
    await expect(adapter.screenTree(themeDir)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('screens a tree against the seeded refusals once the fake is selected outright', async () => {
    await fs.writeFile(path.join(themeDir, 'assets', 'banner.png'), BAD_BYTES);
    const adapter = entry({
      verdictSource: 'in-process-fake',
      refuse: { [BAD_DIGEST]: { classification: 'harmful-abusive-material', matchType: 'exact' } },
    });
    await expect(adapter.screenTree(themeDir)).rejects.toMatchObject({ statusCode: 415 });
  });
});

describe('the overlay and the image build', () => {
  it('wraps the upstream file it is placed beside, through the shared gate', () => {
    const overlay = require(path.join(OVERLAY_DIR, 'theme-storage.js'));
    const storage = new overlay();
    expect(storage).toBeInstanceOf(FakeUpstreamThemeStorage);
    return expect(storage.save({ name: 'mine', path: themeDir })).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it('pins a hash for the file the Dockerfile moves aside', async () => {
    const pin = await fs.readFile(path.join(OVERLAY_DIR, 'theme-storage.upstream.sha256'), 'utf8');
    expect(pin).toMatch(/^[0-9a-f]{64} {2}theme-storage\.js\n$/);
  });

  it('checks the pin, then moves the upstream file aside, then copies the overlay over it', async () => {
    const dockerfile = await fs.readFile(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
    const check = dockerfile.indexOf('sha256sum -c /tmp/theme-storage.upstream.sha256');
    const move = dockerfile.indexOf('mv theme-storage.js theme-storage.upstream.js');
    const copy = dockerfile.indexOf(
      'adapters/scanning-storage/ghost-core-overlay/theme-storage.js /var/lib/ghost/current/core/server/services/themes/theme-storage.js'
    );
    expect(check).toBeGreaterThan(-1);
    expect(move).toBeGreaterThan(check);
    expect(copy).toBeGreaterThan(move);
  });
});
