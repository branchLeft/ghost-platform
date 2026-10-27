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
const RETRY_MS = 20;

class PrefixedFakeWrappedAdapter extends FakeWrappedAdapter {
  constructor(config) {
    super(config);
    this.staticFileURLPrefix = config.staticFileURLPrefix;
  }
}

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'static-file-url-prefix-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function build(wrappedConfig) {
  const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
    loadWrappedAdapterClass: makeLoadWrappedAdapterClass({
      FakeAdapter: PrefixedFakeWrappedAdapter,
    }),
    GhostErrors,
  });
  const verdictClient = new FakeVerdictClient({ refuse: new Map(), unavailable: [] });
  return new Adapter({
    wraps: 'FakeAdapter',
    wrappedConfig,
    quarantinePath: path.join(tmpDir, 'quarantine'),
    checks: [createPdqKnownMaterialCheck(verdictClient, { computeDigest: digestBytes })],
    policy: new SafetyPolicy(),
    computeDigest: digestBytes,
    holdRetryMs: RETRY_MS,
    holdLogger: { error: () => {} },
  });
}

async function writeTempFile(name) {
  const filePath = path.join(tmpDir, `src-${crypto.randomBytes(4).toString('hex')}`);
  await fs.writeFile(filePath, CLEAN_BYTES);
  return { name, path: filePath, type: 'image/png' };
}

// Ghost's importer strips each segment of the prefix from the entry name.
function stripStaticFileURLPrefix(store, name) {
  const folderRegexes = store.staticFileURLPrefix.split('/').map((dir) => new RegExp(`^${dir}/`));
  return folderRegexes.reduce((rest, regex) => rest.replace(regex, ''), name);
}

// Mirrors ghost/core/core/server/data/importer/handlers/image.js
async function imageHandlerPort(store, file) {
  const contentPath = 'content/images';
  file.name = stripStaticFileURLPrefix(store, file.name);
  file.targetDir = path.join(contentPath, path.dirname(file.name));
  const targetFilename = await store.getUniqueFileName(file, file.targetDir);
  file.newPath = `/${store.staticFileURLPrefix}/${path.relative(contentPath, targetFilename)}`;
  return targetFilename;
}

// Mirrors ghost/core/core/server/data/importer/handlers/importer-content-file-handler.js
async function contentFileHandlerPort(store, file) {
  file.name = stripStaticFileURLPrefix(store, file.name);
  file.targetDir = path.dirname(file.name);
  const targetFilename = await store.getUniqueFileName(file, file.targetDir);
  file.newPath = `/${store.staticFileURLPrefix}/${targetFilename}`;
  return targetFilename;
}

describe('staticFileURLPrefix', () => {
  it("exposes the wrapped adapter's prefix for images, media and files", () => {
    for (const prefix of ['content/images', 'content/media', 'content/files']) {
      const adapter = build({ storagePath: 'wrapped', staticFileURLPrefix: prefix });
      expect(adapter.staticFileURLPrefix).toBe(adapter.wrapped.staticFileURLPrefix);
      expect(typeof adapter.staticFileURLPrefix).toBe('string');
      expect(adapter.staticFileURLPrefix).toBe(prefix);
    }
  });

  it('does not invent a prefix when the wrapped adapter sets none', () => {
    const adapter = build({ storagePath: 'wrapped' });
    expect(adapter.staticFileURLPrefix).toBeUndefined();
  });

  it("lets a port of Ghost's image importer handler name and store a file", async () => {
    const adapter = build({ storagePath: 'wrapped', staticFileURLPrefix: 'content/images' });
    const file = await writeTempFile('content/images/2019/01/photo.png');

    const targetFilename = await imageHandlerPort(adapter, file);
    await adapter.save(file, file.targetDir);

    expect(file.newPath).toMatch(/^\/content\/images\/2019\/01\/photo-[a-z2-7]{22}\.png$/);
    expect(adapter.wrapped.files.size).toBe(1);
    expect(adapter.wrapped.files.has(targetFilename)).toBe(true);
  });

  it("lets a port of Ghost's content-file importer handler name and store a media file and a file", async () => {
    const cases = [
      {
        prefix: 'content/media',
        entry: 'content/media/2019/01/clip.mp4',
        newPathPattern: /^\/content\/media\/2019\/01\/clip-[a-z2-7]{22}\.mp4$/,
      },
      {
        prefix: 'content/files',
        entry: 'content/files/2019/01/report.pdf',
        newPathPattern: /^\/content\/files\/2019\/01\/report-[a-z2-7]{22}\.pdf$/,
      },
    ];
    for (const { prefix, entry, newPathPattern } of cases) {
      const adapter = build({ storagePath: 'wrapped', staticFileURLPrefix: prefix });
      const file = await writeTempFile(entry);

      const targetFilename = await contentFileHandlerPort(adapter, file);
      await adapter.save(file, file.targetDir);

      expect(file.newPath).toMatch(newPathPattern);
      expect(adapter.wrapped.files.size).toBe(1);
      expect(adapter.wrapped.files.has(targetFilename)).toBe(true);
    }
  });
});
