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

async function tempFile(name, dir = tmpDir) {
  const filePath = path.join(dir, `src-${crypto.randomBytes(4).toString('hex')}`);
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

// Ghost's ImageHandler.loadFile: every file's name is asked for in one
// Promise.all, so nobody's name exists when the others ask; the files are
// saved afterwards. `dir` is the per-import temp directory the zip was
// extracted to.
async function ghostImport(adapter, names, dir = tmpDir) {
  const files = [];
  for (const name of names) {
    const file = await tempFile(name, dir);
    file.targetDir = path.posix.join('content/images', path.posix.dirname(name));
    files.push(file);
  }
  const promised = await Promise.all(files.map((f) => adapter.getUniqueFileName(f, f.targetDir)));
  return { files, promised };
}

async function importDir(label) {
  const dir = path.join(tmpDir, label);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe("an imported processed image and its '_o' original, asked for as Ghost's importer asks", () => {
  const stored = (p) => path.basename(p);
  const pairedName = (processed) => stored(processed).replace(/\.png$/, '_o.png');

  it('are promised one component whichever is asked for first, and stored where promised', async () => {
    for (const order of [
      ['2019/01/photo.png', '2019/01/photo_o.png'],
      ['2019/01/photo_o.png', '2019/01/photo.png'],
    ]) {
      const adapter = buildAdapter();
      const { files, promised } = await ghostImport(adapter, order);
      const processed = promised[order.indexOf('2019/01/photo.png')];
      const original = promised[order.indexOf('2019/01/photo_o.png')];
      // Ghost looks for <stored basename>_o<ext> of the processed image.
      expect(stored(original)).toBe(pairedName(processed));
      await Promise.all(files.map((f) => adapter.save(f, f.targetDir)));
      expect(adapter.wrapped.files.has(processed)).toBe(true);
      expect(adapter.wrapped.files.has(original)).toBe(true);
      expect(adapter.wrapped.files.size).toBe(2);
    }
  });

  it('pairs every pair of a larger batch, and shares no name between them', async () => {
    const adapter = buildAdapter();
    const names = [];
    for (let n = 0; n < 6; n += 1) {
      names.push(`2019/01/p${n}.png`, `2019/01/p${n}_o.png`);
    }
    const { files, promised } = await ghostImport(adapter, names);
    for (let n = 0; n < 6; n += 1) {
      expect(stored(promised[names.indexOf(`2019/01/p${n}_o.png`)])).toBe(
        pairedName(promised[names.indexOf(`2019/01/p${n}.png`)])
      );
    }
    expect(new Set(promised).size).toBe(12);
    await Promise.all(files.map((f) => adapter.save(f, f.targetDir)));
    expect(adapter.wrapped.files.size).toBe(12);
  });

  it("does not pair an original with another import's processed image of the same name", async () => {
    const adapter = buildAdapter();
    const a = await ghostImport(adapter, ['2019/01/photo.png'], await importDir('import-a'));
    const b = await ghostImport(adapter, ['2019/01/photo_o.png'], await importDir('import-b'));
    expect(stored(b.promised[0])).not.toBe(pairedName(a.promised[0]));
    expect(stored(b.promised[0])).toMatch(/^photo-[a-z2-7]{22}_o\.png$/);
    expect(stored(b.promised[0])).not.toContain(stored(a.promised[0]).slice(0, -4));
  });

  it('keeps two overlapping imports of the same names each paired within itself', async () => {
    const adapter = buildAdapter();
    const names = ['2019/01/photo_o.png', '2019/01/photo.png'];
    const [a, b] = await Promise.all([
      ghostImport(adapter, names, await importDir('import-a')),
      ghostImport(adapter, names, await importDir('import-b')),
    ]);
    for (const run of [a, b]) {
      expect(stored(run.promised[0])).toBe(pairedName(run.promised[1]));
    }
    expect(new Set([...a.promised, ...b.promised]).size).toBe(4);
  });

  it('pairs only inside one target directory', async () => {
    const adapter = buildAdapter();
    const dir = await importDir('one-import');
    const processed = await tempFile('photo.png', dir);
    const original = await tempFile('photo_o.png', dir);
    const [p, o] = await Promise.all([
      adapter.getUniqueFileName(processed, DIR),
      adapter.getUniqueFileName(original, 'content/images/2019/02'),
    ]);
    expect(stored(o)).not.toBe(pairedName(p));
  });

  it('pairs an original once: a second one of the same name is not paired with the same image', async () => {
    const adapter = buildAdapter();
    const dir = await importDir('one-import');
    const processed = await adapter.getUniqueFileName(await tempFile('photo.png', dir), DIR);
    const first = await adapter.getUniqueFileName(await tempFile('photo_o.png', dir), DIR);
    // The pair is complete, so the second starts a record of its own.
    const second = await adapter.getUniqueFileName(await tempFile('photo_o.png', dir), DIR);
    expect(stored(first)).toBe(pairedName(processed));
    expect(stored(second)).not.toBe(pairedName(processed));
    expect(stored(second)).toMatch(/^photo-[a-z2-7]{22}_o\.png$/);
    expect(stored(second)).not.toBe(stored(first));
  });

  it('does not pair across a lapse of the window', async () => {
    const adapter = buildAdapter();
    const dir = await importDir('one-import');
    const start = Date.now();
    const processed = await adapter.getUniqueFileName(await tempFile('photo.png', dir), DIR);
    vi.spyOn(Date, 'now').mockReturnValue(start + 2 * 60 * 60 * 1000);
    const original = await adapter.getUniqueFileName(await tempFile('photo_o.png', dir), DIR);
    expect(stored(original)).not.toBe(pairedName(processed));
  });

  it('leaves a lone original with a name of its own and nothing waiting', async () => {
    const adapter = buildAdapter();
    const { promised } = await ghostImport(adapter, ['2019/01/solo_o.png']);
    expect(stored(promised[0])).toMatch(/^solo-[a-z2-7]{22}_o\.png$/);
  });

  it('hands the role back when the ask fails, so a retry still pairs', async () => {
    const adapter = buildAdapter();
    const dir = await importDir('one-import');
    const processed = await tempFile('photo.png', dir);
    const original = await tempFile('photo_o.png', dir);
    const exists = vi.spyOn(adapter.wrapped, 'exists').mockRejectedValueOnce(new Error('down'));
    await expect(adapter.getUniqueFileName(original, DIR)).rejects.toThrow('down');
    exists.mockRestore();
    const [o, p] = await Promise.all([
      adapter.getUniqueFileName(original, DIR),
      adapter.getUniqueFileName(processed, DIR),
    ]);
    expect(stored(o)).toBe(pairedName(p));
  });

  it('bounds its records: a full family table leaves new files unpaired, not refused', async () => {
    const adapter = buildAdapter({ reservationMaxEntries: 3 });
    const dir = await importDir('one-import');
    const files = [];
    for (let n = 0; n < 3; n += 1) {
      files.push(await tempFile(`f${n}.png`, dir));
      await adapter.getUniqueFileName(files[n], DIR);
    }
    expect(adapter.nameFamilies.size).toBe(3);
    // Spend one promise to make room in the reservation table.
    await adapter.save(files[0], DIR);
    const original = await adapter.getUniqueFileName(await tempFile('g_o.png', dir), DIR);
    // Room for the promise, none for a record: named, just not paired.
    expect(path.basename(original)).toMatch(/^g_o-[a-z2-7]{22}\.png$/);
    expect(adapter.nameFamilies.size).toBe(3);
  });

  it('never pairs a name that is only an extension', async () => {
    const adapter = buildAdapter();
    const { promised } = await ghostImport(adapter, ['.png', '_o.png']);
    expect(stored(promised[1])).toMatch(/^_o-[a-z2-7]{22}\.png$/);
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
