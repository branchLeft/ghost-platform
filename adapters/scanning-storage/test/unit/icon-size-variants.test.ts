// Ghost core asks the bucket for resized icons directly.
//
// With an object-storage adapter every stored image has an absolute bucket
// URL. Ghost core then rewrites that URL in place to
// `<bucket>/content/images/size/w256h256/<file>` (the settings output
// serializer, for Ghost admin and the Content API; blog-icon.js, for the
// site's favicon link). The browser fetches that URL from the bucket, so
// Ghost's resize middleware, the only thing that ever writes a variant,
// never runs, and the bucket answers 403 for the missing key. Saving the
// Publication Icon in Ghost admin fails on it.
//
// The decorator therefore writes the variants itself when it stores an
// image. These tests drive it as Ghost does: save() an upload, then look for
// the keys Ghost core will ask the bucket for.
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

interface ResizeOptions {
  width: number;
  height: number;
  format: string | null;
  withoutEnlargement: boolean;
  timeout: number;
}

interface StoredCall {
  buffer: Buffer;
  targetPath: string;
}

interface FakeWrapped {
  files: Map<string, Buffer>;
  savedRaw: StoredCall[];
}

interface VerdictControl {
  deliverVerdict(digest: string, verdict: { classification: string }): void;
}

interface Adapter {
  save(file: { name: string; path: string; type: string }, targetDir?: string): Promise<string>;
  saveRaw(buffer: Buffer, targetPath: string): Promise<string>;
  wrapped: FakeWrapped & { urlToPath(url: string): string };
  hold: { isPending(digest: string): boolean };
}

const UPLOAD_BYTES = Buffer.from('uploaded-image-bytes');
const UPLOAD_DIGEST: string = digestBytes(UPLOAD_BYTES);
const DAY_DIR = '2026/11';
const WAIT = { timeout: 1500, interval: 10 };

// The same predicates and the same transform Ghost's resize middleware asks
// of @tryghost/image-transform; the bytes it returns name what was asked.
const RESIZABLE = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const TRANSFORMABLE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg']);
const FORMATS = new Set(['png', 'jpeg']);

function makeImageTransform(calls: ResizeOptions[]) {
  return {
    canTransformFileExtension: (ext: string) => TRANSFORMABLE.has(ext),
    shouldResizeFileExtension: (ext: string) => RESIZABLE.has(ext),
    canTransformToFormat: (format: string) => FORMATS.has(format),
    async resizeFromBuffer(_buffer: Buffer, options: ResizeOptions) {
      calls.push(options);
      return Buffer.from(`resized:${options.width}x${options.height}:${options.format}`);
    },
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'icon-size-variants-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

interface BuildOptions {
  storagePath?: string;
  wrappedConfig?: Record<string, unknown>;
  imageTransform?: unknown;
  unavailable?: string[];
  logger?: { error: (...args: unknown[]) => void };
}

function build(options: BuildOptions = {}): { adapter: Adapter; verdictClient: VerdictControl } {
  const storagePath = options.storagePath ?? 'content/images';
  const wrappedConfig = options.wrappedConfig ?? {
    bucket: 'media-bucket',
    cdnUrl: 'https://media.example.test/media-bucket',
  };
  const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
    loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
    GhostErrors,
  });
  const verdictClient = new FakeVerdictClient({
    refuse: new Map(),
    unavailable: options.unavailable ?? [],
  });
  const adapter = new Adapter({
    wraps: 'FakeAdapter',
    wrappedConfig: { ...wrappedConfig, storagePath, defaultTargetDir: DAY_DIR },
    quarantinePath: path.join(tmpDir, 'quarantine'),
    checks: [createPdqKnownMaterialCheck(verdictClient, { computeDigest: digestBytes })],
    policy: new SafetyPolicy(),
    computeDigest: digestBytes,
    holdRetryMs: 10,
    holdLogger: options.logger ?? { error: () => {} },
    imageTransform: options.imageTransform,
  }) as Adapter;
  return { adapter, verdictClient };
}

async function upload(adapter: Adapter, name: string): Promise<string> {
  const filePath = path.join(tmpDir, `src-${name}`);
  await fs.writeFile(filePath, UPLOAD_BYTES);
  const url = await adapter.save({ name, path: filePath, type: 'image/png' }, DAY_DIR);
  return adapter.wrapped.urlToPath(url);
}

function storedKeys(adapter: Adapter): string[] {
  return [...adapter.wrapped.files.keys()].sort();
}

describe('the image a Ghost admin icon save asks the bucket for', () => {
  it('stores the 256x256 variant next to a png upload, at the key Ghost core asks for', async () => {
    const calls: ResizeOptions[] = [];
    const { adapter } = build({ imageTransform: makeImageTransform(calls) });

    const stored = await upload(adapter, 'logo.png');

    expect(stored.startsWith(`${DAY_DIR}/logo`)).toBe(true);
    expect(storedKeys(adapter)).toEqual(
      [`size/w256h256/${stored}`, `${DAY_DIR}/${path.posix.basename(stored)}`].sort()
    );
    // The variant is the resized bytes, not a copy of the upload.
    expect(adapter.wrapped.files.get(`size/w256h256/${stored}`)?.toString()).toBe(
      'resized:256x256:null'
    );
    // The resize is asked for exactly as Ghost's own middleware asks.
    expect(calls).toEqual([
      { width: 256, height: 256, format: null, withoutEnlargement: true, timeout: 10 },
    ]);
  });

  it('also stores the format variant the site favicon link asks for, when the type differs', async () => {
    const { adapter } = build({ imageTransform: makeImageTransform([]) });

    const jpg = await upload(adapter, 'icon.jpg');
    const webp = await upload(adapter, 'icon.webp');
    const svg = await upload(adapter, 'icon.svg');
    const jpeg = await upload(adapter, 'icon.jpeg');
    const png = await upload(adapter, 'icon.png');

    const variants = storedKeys(adapter).filter((key) => key.startsWith('size/'));
    expect(variants).toEqual(
      [
        // blog-icon.js asks for a jpeg of a .jpg, a png of a webp or an svg.
        `size/w256h256/${jpg}`,
        `size/w256h256/format/jpeg/${jpg}`,
        `size/w256h256/${webp}`,
        `size/w256h256/format/png/${webp}`,
        // Ghost's middleware redirects a plain svg to the original, so it
        // never has a plain variant: only the formatted one is asked for.
        `size/w256h256/format/png/${svg}`,
        `size/w256h256/${jpeg}`,
        `size/w256h256/${png}`,
      ].sort()
    );
  });

  it('writes nothing for a type Ghost cannot transform (an .ico icon is served as it is)', async () => {
    const { adapter } = build({ imageTransform: makeImageTransform([]) });
    await upload(adapter, 'favicon.ico');
    expect(storedKeys(adapter).filter((key) => key.startsWith('size/'))).toEqual([]);
  });

  it('does not make a variant of the _o original Ghost saves beside a processed upload', async () => {
    const { adapter } = build({ imageTransform: makeImageTransform([]) });
    const processed = await upload(adapter, 'photo.png');
    const original = `${processed.replace(/\.png$/, '')}_o.png`;

    await upload(adapter, path.posix.basename(original));

    expect(storedKeys(adapter)).toContain(original);
    expect(storedKeys(adapter).filter((key) => key.startsWith('size/'))).toEqual([
      `size/w256h256/${processed}`,
    ]);
  });

  it('does not make a variant of a variant: Ghost writes size keys through saveRaw', async () => {
    const calls: ResizeOptions[] = [];
    const { adapter } = build({ imageTransform: makeImageTransform(calls) });
    await adapter.saveRaw(Buffer.from('a resized body'), '/size/w600/2026/11/photo.png');
    expect(calls).toEqual([]);
    expect(storedKeys(adapter)).toEqual(['size/w600/2026/11/photo.png']);
  });

  it('leaves the other features and the local adapters alone', async () => {
    const calls: ResizeOptions[] = [];
    const media = build({
      storagePath: 'content/media',
      imageTransform: makeImageTransform(calls),
    });
    await upload(media.adapter, 'clip.png');
    // Local adapters serve /content/images/size/... through Ghost itself.
    const local = build({ wrappedConfig: {}, imageTransform: makeImageTransform(calls) });
    await upload(local.adapter, 'logo.png');

    expect(calls).toEqual([]);
    expect(storedKeys(media.adapter).some((key) => key.startsWith('size/'))).toBe(false);
    expect(storedKeys(local.adapter).some((key) => key.startsWith('size/'))).toBe(false);
  });

  it('keeps the upload when the resize fails, and says so on the error stream', async () => {
    const logger = { error: vi.fn() };
    const imageTransform = {
      ...makeImageTransform([]),
      resizeFromBuffer: async () => {
        throw new Error('sharp is unhappy');
      },
    };
    const { adapter } = build({ imageTransform, logger });

    const stored = await upload(adapter, 'logo.png');

    expect(storedKeys(adapter)).toEqual([`${DAY_DIR}/${path.posix.basename(stored)}`]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('ICON_VARIANT_FAILED'),
      expect.anything()
    );
  });

  it('says so at boot when the object-storage tier has no image transform to use', () => {
    const logger = { error: vi.fn() };
    build({ imageTransform: undefined, logger });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('ICON_VARIANTS_UNAVAILABLE'));
  });

  it('stores the variant when a held upload is released, not before', async () => {
    const { adapter, verdictClient } = build({
      imageTransform: makeImageTransform([]),
      unavailable: [UPLOAD_DIGEST],
    });

    await upload(adapter, 'held-logo.png');
    expect(storedKeys(adapter)).toEqual([]);

    verdictClient.deliverVerdict(UPLOAD_DIGEST, { classification: 'no-known-match' });
    await vi.waitFor(() => expect(adapter.hold.isPending(UPLOAD_DIGEST)).toBe(false), WAIT);
    await vi.waitFor(
      () =>
        expect(storedKeys(adapter).filter((key) => key.startsWith('size/w256h256/'))).toHaveLength(
          1
        ),
      WAIT
    );
    const keys = storedKeys(adapter);
    expect(keys).toHaveLength(2);
    expect(keys.some((key) => key.startsWith(`size/w256h256/${DAY_DIR}/`))).toBe(true);
  });
});
