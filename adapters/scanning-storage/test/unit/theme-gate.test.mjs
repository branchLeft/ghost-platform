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

// A theme store on a real directory, shaped like Ghost's ThemeStorage: a move
// that refuses an existing destination, a copy into `<root>/<name>`, and a
// remove. `faults` makes the copy stop after some files or a move fail.
class DiskThemeStorage {
  static root = null;
  static faults = {};
  static events = [];

  async exists(name) {
    return fs.stat(path.join(DiskThemeStorage.root, name)).then(
      () => true,
      () => false
    );
  }

  async rename(src, dest) {
    DiskThemeStorage.events.push(`rename:${src}>${dest}`);
    if (DiskThemeStorage.faults.failRename?.(src, dest)) {
      throw new Error('move refused');
    }
    const target = path.join(DiskThemeStorage.root, dest);
    if (await this.exists(dest)) {
      throw new Error('destination exists');
    }
    await fs.rename(path.join(DiskThemeStorage.root, src), target);
  }

  async save(file) {
    DiskThemeStorage.events.push(`save:${file.name}`);
    const target = path.join(DiskThemeStorage.root, file.name);
    const { copyFilesBeforeFailing } = DiskThemeStorage.faults;
    const files = (await fs.readdir(file.path, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name))
      .sort();
    if (copyFilesBeforeFailing === 0) {
      throw new Error('no space left on device');
    }
    await fs.mkdir(target, { recursive: true });
    let copied = 0;
    for (const source of files) {
      if (copied === copyFilesBeforeFailing) {
        throw new Error('no space left on device');
      }
      const dest = path.join(target, path.relative(file.path, source));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(source, dest);
      copied += 1;
    }
    return `/content/themes/${file.name}`;
  }

  async delete(fileName) {
    DiskThemeStorage.events.push(`delete:${fileName}`);
    await fs.rm(path.join(DiskThemeStorage.root, fileName), { recursive: true, force: true });
  }
}

// Ghost's setFromZip once the zip has passed its own checks, in the order
// services/themes/storage.js runs it: the existing theme is moved aside, the
// copy is made, a failure restores without awaiting the restore before the
// backup is deleted. Only the calls on the theme store are kept.
async function ghostSetFromZip(storage, { name, backupName, extracted }, background) {
  let renamedExisting = false;
  try {
    if (await storage.exists(name)) {
      renamedExisting = true;
      await storage.rename(name, backupName);
    }
    await storage.save({ name, path: extracted });
    return undefined;
  } catch (error) {
    if (renamedExisting) {
      return storage.exists(name).then((themeExists) => {
        if (!themeExists) {
          return storage.rename(backupName, name).then(() => {
            throw error;
          });
        }
        throw error;
      });
    }
    throw error;
  } finally {
    background.push(storage.delete(backupName).catch((err) => err));
  }
}

describe('a copy that fails after a clean screen', () => {
  const BACKUP = 'mine_6acae7f2a177e600014e46bf';
  const INSTALLED = {
    'default.hbs': '{{{body}}} INSTALLED',
    'package.json': '{"name":"mine","version":"1.0.0"}',
    'partials/nav.hbs': 'NAV',
    'assets/css/site.css': 'body{}',
    'assets/images/logo.png': 'LOGO-BYTES',
  };
  const REPLACEMENT = {
    'default.hbs': '{{{body}}} REPLACEMENT',
    'package.json': '{"name":"mine","version":"2.0.0"}',
    'partials/nav.hbs': 'NAV-2',
    'assets/css/site.css': 'body{margin:0}',
    'assets/images/other.png': 'OTHER-BYTES',
  };
  let themesRoot;
  let extracted;

  async function writeTree(dir, files) {
    for (const [rel, body] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), body);
    }
  }

  async function readTree(dir) {
    const out = {};
    const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const full = path.join(entry.parentPath, entry.name);
        out[path.relative(dir, full)] = await fs.readFile(full, 'utf8');
      }
    }
    return out;
  }

  function gatedOnDisk() {
    const Gated = defineGatedThemeStorage(DiskThemeStorage, {
      adapterManager: { getAdapter: () => ({ screenTree: async () => {} }) },
      GhostErrors,
    });
    return new Gated();
  }

  // Ghost's own call order reaches the gated class as rename() then save():
  // the gate takes the held move itself, so the stock setFromZip is replayed
  // on the gated class exactly as it would be on the plain one.
  async function upload(storage, background = []) {
    const outcome = await ghostSetFromZip(
      storage,
      { name: 'mine', backupName: BACKUP, extracted },
      background
    ).catch((err) => err);
    await Promise.allSettled(background);
    return outcome;
  }

  beforeEach(async () => {
    themesRoot = path.join(tmpDir, 'themes');
    extracted = path.join(tmpDir, 'extracted');
    await writeTree(path.join(themesRoot, 'mine'), INSTALLED);
    await writeTree(extracted, REPLACEMENT);
    DiskThemeStorage.root = themesRoot;
    DiskThemeStorage.faults = {};
    DiskThemeStorage.events = [];
  });

  it('control: Ghost alone loses the installed theme when the copy stops part way', async () => {
    DiskThemeStorage.faults = { copyFilesBeforeFailing: 2 };
    const outcome = await upload(new DiskThemeStorage());
    expect(outcome.message).toBe('no space left on device');
    const left = await readTree(path.join(themesRoot, 'mine'));
    expect(left).not.toEqual(INSTALLED);
    expect(left['assets/images/logo.png']).toBeUndefined();
    expect(await fs.readdir(themesRoot)).toEqual(['mine']);
  });

  it.each([
    ['part way through the copy', 2],
    ['before any file is copied', 0],
    ['on the last file', Object.keys(REPLACEMENT).length - 1],
  ])('leaves the installed theme byte for byte as it was, failing %s', async (_label, after) => {
    for (let run = 0; run < 40; run += 1) {
      DiskThemeStorage.faults = { copyFilesBeforeFailing: after };
      DiskThemeStorage.events = [];
      const outcome = await upload(gatedOnDisk());
      expect(outcome.message).toBe('no space left on device');
      expect(await readTree(path.join(themesRoot, 'mine'))).toEqual(INSTALLED);
      expect(await fs.readdir(themesRoot)).toEqual(['mine']);
    }
  });

  it.each([0, 1])(
    'puts the theme back before the failure leaves save() (%i files copied)',
    async (copied) => {
      DiskThemeStorage.faults = { copyFilesBeforeFailing: copied };
      const storage = gatedOnDisk();
      await storage.rename('mine', BACKUP);
      const failure = await storage.save({ name: 'mine', path: extracted }).catch((err) => err);
      expect(failure.message).toBe('no space left on device');
      expect(DiskThemeStorage.events).toEqual([
        `rename:mine>${BACKUP}`,
        'save:mine',
        'delete:mine',
        `rename:${BACKUP}>mine`,
      ]);
      expect(await readTree(path.join(themesRoot, 'mine'))).toEqual(INSTALLED);
    }
  );

  it('keeps the backup, and declines Ghost deleting it, when the theme cannot be put back', async () => {
    DiskThemeStorage.faults = {
      copyFilesBeforeFailing: 1,
      failRename: (src, dest) => src === BACKUP && dest === 'mine',
    };
    const storage = gatedOnDisk();
    const background = [];
    const outcome = await upload(storage, background);
    const [deleted] = await Promise.all(background);
    expect(outcome).toBeInstanceOf(Error);
    expect(deleted.message).toMatch(/could not be put back/);
    expect(await readTree(path.join(themesRoot, BACKUP))).toEqual(INSTALLED);
  });

  it('declines only the one delete, and passes every other delete through', async () => {
    DiskThemeStorage.faults = {
      copyFilesBeforeFailing: 1,
      failRename: (src) => src === BACKUP,
    };
    const storage = gatedOnDisk();
    await storage.rename('mine', BACKUP);
    await storage.save({ name: 'mine', path: extracted }).catch(() => {});
    await expect(storage.delete(BACKUP)).rejects.toThrow(/could not be put back/);
    await storage.delete(BACKUP);
    expect(await fs.readdir(themesRoot)).toEqual([]);
  });

  it('removes the backup as Ghost asks when the copy succeeds, and keeps the new theme', async () => {
    const outcome = await upload(gatedOnDisk());
    expect(outcome).toBeUndefined();
    expect(await readTree(path.join(themesRoot, 'mine'))).toEqual(REPLACEMENT);
    expect(await fs.readdir(themesRoot)).toEqual(['mine']);
  });

  it('moves nothing and removes nothing when there was no installed theme to replace', async () => {
    await fs.rm(path.join(themesRoot, 'mine'), { recursive: true });
    DiskThemeStorage.faults = { copyFilesBeforeFailing: 1 };
    const storage = gatedOnDisk();
    await storage.rename('mine', BACKUP);
    const failure = await storage.save({ name: 'mine', path: extracted }).catch((err) => err);
    expect(failure.message).toBe('no space left on device');
    expect(DiskThemeStorage.events).toEqual(['save:mine']);
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
