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
import * as bytes from '../helpers/media-bytes.mjs';

const require = createRequire(import.meta.url);
const { defineScanningStorageAdapter } = require('../../src/scanning-storage.js');
const { FakeVerdictClient } = require('../../src/verdict-client.js');
const { SafetyPolicy } = require('../../src/policy.js');
const { createPdqKnownMaterialCheck } = require('../../src/checks.js');
const { digestBytes } = require('../../src/pdq.js');
const { ScannerMetrics } = require('../../src/metrics.js');
const GhostErrors = require('@tryghost/errors');

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scanning-media-kind-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const FEATURES = ['images', 'media', 'files'];
// The decorator is told one fact about the tier: whether video and audio
// are accepted. Demo and hobbyist (entry) are told false, Professional true.
const TIER_CLASSES = [
  ['demo', false],
  ['hobbyist (entry)', false],
  ['Professional', true],
];
const REFUSING_TIER_CLASSES = TIER_CLASSES.filter(([, allowVideoAudio]) => !allowVideoAudio);

// The families the acceptance criteria name, one fixture each.
const REQUIRED_FAMILIES = [
  ['MP4', () => bytes.mp4Bytes()],
  ['QuickTime MOV', () => bytes.quickTimeBytes()],
  ['WebM', () => bytes.webmBytes()],
  ['Matroska', () => bytes.matroskaBytes()],
  ['Ogg', () => bytes.oggBytes()],
  ['MP3 without a tag', () => bytes.mp3Bytes()],
  ['MP3 with an ID3 tag', () => bytes.mp3WithId3Bytes()],
  ['WAV', () => bytes.wavBytes()],
  ['FLAC', () => bytes.flacBytes()],
];

// A verdict source that records every question asked of it.
class RecordingVerdictClient extends FakeVerdictClient {
  constructor(options) {
    super(options);
    this.asked = [];
  }

  async getVerdict(digest) {
    this.asked.push(digest);
    return super.getVerdict(digest);
  }
}

function recordingMetrics() {
  const calls = [];
  const real = new ScannerMetrics();
  return {
    calls,
    real,
    recordRefusal: (reason) => calls.push(['refusal', reason]),
    recordVerdict: (classification) => calls.push(['verdict', classification]),
    recordVerdictError: (kind) => calls.push(['verdictError', kind]),
    observeVerdictSeconds: (seconds) => calls.push(['seconds', seconds]),
    recordUnconfiguredInstance: () => calls.push(['unconfigured']),
    addHeldSource: (source) => real.addHeldSource(source),
  };
}

function buildAdapter({
  feature = 'media',
  allowVideoAudio,
  refuse = {},
  unavailable = [],
  quarantinePath = path.join(tmpDir, 'quarantine'),
  refuseUploadsReason,
} = {}) {
  const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
    loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
    GhostErrors,
  });
  const verdictClient = new RecordingVerdictClient({ refuse, unavailable });
  const metrics = recordingMetrics();
  const logged = [];
  const computeDigest = vi.fn(digestBytes);
  const options = {
    wraps: 'FakeAdapter',
    wrappedConfig: { storagePath: feature },
    quarantinePath,
    checks: [createPdqKnownMaterialCheck(verdictClient, { computeDigest, metrics })],
    policy: new SafetyPolicy(),
    computeDigest,
    metrics,
    holdRetryMs: 20,
    holdLogger: { error: (...args) => logged.push(args.map(String).join(' ')) },
    refuseUploadsReason,
  };
  if (allowVideoAudio !== undefined) {
    options.allowVideoAudio = allowVideoAudio;
  }
  const instance = new Adapter(options);
  return { instance, verdictClient, metrics, logged, computeDigest, quarantinePath };
}

async function tempUpload(buffer, { name = 'upload.png', type = 'image/png' } = {}) {
  const filePath = path.join(tmpDir, `src-${crypto.randomBytes(4).toString('hex')}`);
  await fs.writeFile(filePath, buffer);
  return { name, path: filePath, type };
}

const ENTRY_POINTS = [
  ['saveRaw', (instance, buffer) => instance.saveRaw(buffer, '2026/10/upload.bin')],
  ['save', async (instance, buffer) => instance.save(await tempUpload(buffer), '2026/10')],
];

async function quarantineEntries(quarantinePath) {
  return fs.readdir(quarantinePath).catch(() => []);
}

function storedCount(instance) {
  return instance.wrapped.savedRaw.length + instance.wrapped.saved.length;
}

function refusalReasons(metrics) {
  return metrics.calls.filter(([kind]) => kind === 'refusal').map(([, reason]) => reason);
}

async function expectRefusedAsVideoAudio(promise) {
  const error = await promise.then(
    () => null,
    (caught) => caught
  );
  expect(error).toBeInstanceOf(GhostErrors.UnsupportedMediaTypeError);
  expect(error.statusCode).toBe(415);
  expect(error.errorType).toBe('UnsupportedMediaTypeError');
}

// Reviewer reproductions: an image brand in front of a real video track. Each
// one pushes the movie box past one of the detector's bounded walks.
function imageBrandFileType() {
  return bytes.box('ftyp', Buffer.concat([Buffer.from('mif1', 'latin1'), Buffer.alloc(4)]));
}

const VIDEO_HANDLER_BOX = bytes.box(
  'hdlr',
  Buffer.concat([Buffer.alloc(8), Buffer.from('vide', 'latin1'), Buffer.alloc(12)])
);
const VIDEO_TRACK = bytes.box('trak', bytes.box('mdia', VIDEO_HANDLER_BOX));

// Seventy free boxes before the movie box: the top-level walk stops at 64.
function imageBrandWithMovieBoxBeyondTopLevelWalk() {
  const freeBoxes = Array.from({ length: 70 }, () => bytes.box('free'));
  return Buffer.concat([
    imageBrandFileType(),
    ...freeBoxes,
    bytes.box('moov', VIDEO_TRACK),
    bytes.box('mdat', Buffer.alloc(32, 0x5a)),
  ]);
}

// A movie box whose first 300 'hdlr' strings are decoys: the handler search
// runs out of its 256 steps before it reaches the real track.
function imageBrandWithHandlerSearchExhausted() {
  const decoys = Buffer.concat(
    Array.from({ length: 300 }, () =>
      Buffer.concat([Buffer.from('hdlr', 'latin1'), Buffer.alloc(12)])
    )
  );
  return Buffer.concat([
    imageBrandFileType(),
    bytes.box('moov', Buffer.concat([bytes.box('free', decoys), VIDEO_TRACK])),
    bytes.box('mdat', Buffer.alloc(32, 0x5a)),
  ]);
}

// An eight-byte box whose type bytes are not printable, ahead of the movie
// box: the top-level walk stops there, so no movie box is found.
function imageBrandWithUnprintableBoxBeforeMovieBox() {
  const unprintableBox = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x01, 0x02, 0x03, 0x04]);
  return Buffer.concat([
    imageBrandFileType(),
    unprintableBox,
    bytes.box('moov', VIDEO_TRACK),
    bytes.box('mdat', Buffer.alloc(32, 0x5a)),
  ]);
}

describe('video and audio on a tier that refuses them', () => {
  describe.each(REFUSING_TIER_CLASSES)('%s', (_tierName, allowVideoAudio) => {
    describe.each(FEATURES)('storage:%s', (feature) => {
      describe.each(ENTRY_POINTS)('through %s', (_entryName, upload) => {
        it.each(REQUIRED_FAMILIES)(
          'refuses %s with a typed 415 on every attempt, asking no verdict and storing and holding nothing',
          async (_family, build) => {
            const { instance, verdictClient, metrics, computeDigest, quarantinePath } =
              buildAdapter({ feature, allowVideoAudio });
            for (let attempt = 0; attempt < 3; attempt += 1) {
              await expectRefusedAsVideoAudio(upload(instance, build()));
            }
            expect(verdictClient.asked).toEqual([]);
            expect(computeDigest).not.toHaveBeenCalled();
            expect(storedCount(instance)).toBe(0);
            expect(await quarantineEntries(quarantinePath)).toEqual([]);
            expect(instance.hold.heldSummary().count).toBe(0);
            expect(refusalReasons(metrics)).toEqual(['video-audio', 'video-audio', 'video-audio']);
            expect(metrics.calls.some(([kind]) => kind === 'verdict')).toBe(false);
          }
        );
      });
    });
  });

  it('refuses every other family the detector knows, through saveRaw', async () => {
    const { instance, verdictClient } = buildAdapter();
    const others = [
      bytes.aviBytes(),
      bytes.m4aBytes(),
      bytes.threeGpBytes(),
      bytes.quickTimeWithoutFileTypeBytes(),
      bytes.aiffBytes(),
      bytes.adtsBytes(),
      bytes.flvBytes(),
      bytes.asfBytes(),
      bytes.midiBytes(),
      bytes.mpegProgramStreamBytes(),
      bytes.transportStreamBytes(),
      bytes.mp3WithId3Bytes({ hasFooter: true }),
      bytes.videoWithImageBrandBytes('avif'),
    ];
    for (const buffer of others) {
      await expectRefusedAsVideoAudio(instance.saveRaw(buffer, '2026/10/other.bin'));
    }
    expect(verdictClient.asked).toEqual([]);
    expect(storedCount(instance)).toBe(0);
  });

  it('refuses an image-brand video whose movie box lies beyond the top-level walk, on the demo tier', async () => {
    const { instance, verdictClient } = buildAdapter({ allowVideoAudio: false });
    await expectRefusedAsVideoAudio(
      instance.saveRaw(imageBrandWithMovieBoxBeyondTopLevelWalk(), '2026/10/x.avif')
    );
    expect(verdictClient.asked).toEqual([]);
    expect(storedCount(instance)).toBe(0);
  });

  it('refuses an image-brand video whose handler search runs out of steps, on the demo tier', async () => {
    const { instance, verdictClient } = buildAdapter({ allowVideoAudio: false });
    await expectRefusedAsVideoAudio(
      instance.saveRaw(imageBrandWithHandlerSearchExhausted(), '2026/10/x.avif')
    );
    expect(verdictClient.asked).toEqual([]);
    expect(storedCount(instance)).toBe(0);
  });

  it('refuses an image-brand video with an unprintable box before its movie box, on the demo tier', async () => {
    const { instance, verdictClient } = buildAdapter({ allowVideoAudio: false });
    await expectRefusedAsVideoAudio(
      instance.saveRaw(imageBrandWithUnprintableBoxBeforeMovieBox(), '2026/10/x.avif')
    );
    expect(verdictClient.asked).toEqual([]);
    expect(storedCount(instance)).toBe(0);
  });

  it('refuses when the tier is not told to the decorator at all', async () => {
    const { instance } = buildAdapter({ allowVideoAudio: undefined });
    await expectRefusedAsVideoAudio(instance.saveRaw(bytes.mp4Bytes(), '2026/10/x.mp4'));
  });

  it.each(['professional', 'true', 1, {}, null, 'yes'])(
    'refuses when the option is %j: only the boolean true opens the gate',
    async (allowVideoAudio) => {
      const { instance } = buildAdapter({ allowVideoAudio });
      await expectRefusedAsVideoAudio(instance.saveRaw(bytes.mp4Bytes(), '2026/10/x.mp4'));
    }
  );

  it('says why on the error stream, with a stable token and no byte content', async () => {
    const { instance, logged } = buildAdapter();
    await expect(instance.saveRaw(bytes.mp4Bytes(), '2026/10/x.mp4')).rejects.toBeDefined();
    const line = logged.find((entry) => entry.includes('UPLOAD_REFUSED_VIDEO_AUDIO'));
    expect(line).toBeDefined();
    expect(line).toContain('wraps=FakeAdapter');
    expect(line).toContain('family=iso-base-media');
    expect(line).not.toContain('isom');
  });

  it('still answers 503 first when no verdict source exists, so the order of gates is unchanged', async () => {
    const { instance } = buildAdapter({ refuseUploadsReason: 'SCANNER_UNCONFIGURED' });
    await expect(instance.saveRaw(bytes.mp4Bytes(), '2026/10/x.mp4')).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it('is decided from the bytes: video named x.png with an image type is refused, through save()', async () => {
    const { instance, verdictClient } = buildAdapter();
    const file = await tempUpload(bytes.mp4Bytes(), { name: 'x.png', type: 'image/png' });
    await expectRefusedAsVideoAudio(instance.save(file, '2026/10'));
    expect(verdictClient.asked).toEqual([]);
    expect(storedCount(instance)).toBe(0);
  });

  it('is decided from the bytes: video targeted at x.png is refused, through saveRaw()', async () => {
    const { instance } = buildAdapter();
    await expectRefusedAsVideoAudio(instance.saveRaw(bytes.webmBytes(), '2026/10/x.png'));
    expect(storedCount(instance)).toBe(0);
  });

  it('is decided from the bytes: an image named x.mp4 with a video type is checked and stored, through save()', async () => {
    const { instance, verdictClient } = buildAdapter();
    const file = await tempUpload(bytes.pngBytes(), { name: 'x.mp4', type: 'video/mp4' });
    await expect(instance.save(file, '2026/10')).resolves.toBeDefined();
    expect(verdictClient.asked).toHaveLength(1);
    expect(instance.wrapped.saved).toHaveLength(1);
  });

  it('is decided from the bytes: an image targeted at x.mp4 is checked and stored, through saveRaw()', async () => {
    const { instance, verdictClient } = buildAdapter();
    await expect(instance.saveRaw(bytes.jpegBytes(), '2026/10/x.mp4')).resolves.toBeDefined();
    expect(verdictClient.asked).toHaveLength(1);
    expect(instance.wrapped.savedRaw).toHaveLength(1);
  });

  it('does not hold a video whose verdict would have been unavailable, and promotes nothing after a restart', async () => {
    const video = bytes.mp4Bytes();
    const digest = digestBytes(video);
    const first = buildAdapter({ unavailable: [digest] });
    await expectRefusedAsVideoAudio(first.instance.saveRaw(video, '2026/10/x.mp4'));
    expect(first.instance.hold.heldSummary().count).toBe(0);
    expect(await quarantineEntries(first.quarantinePath)).toEqual([]);

    const restarted = buildAdapter({ quarantinePath: first.quarantinePath });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(storedCount(restarted.instance)).toBe(0);
    expect(restarted.instance.hold.heldSummary().count).toBe(0);
  });
});

describe('video and audio on Professional', () => {
  describe.each(FEATURES)('storage:%s', (feature) => {
    describe.each(ENTRY_POINTS)('through %s', (_entryName, upload) => {
      it.each(REQUIRED_FAMILIES)(
        'accepts and stores %s without a check, and counts it as neither scanned nor clean',
        async (_family, build) => {
          const { instance, verdictClient, metrics, logged, quarantinePath } = buildAdapter({
            feature,
            allowVideoAudio: true,
          });
          await expect(upload(instance, build())).resolves.toEqual(expect.any(String));
          expect(storedCount(instance)).toBe(1);
          expect(verdictClient.asked).toEqual([]);
          expect(metrics.calls).toEqual([]);
          expect(logged).toEqual([]);
          expect(await quarantineEntries(quarantinePath)).toEqual([]);
          expect(instance.hold.heldSummary().count).toBe(0);
        }
      );
    });
  });

  it('stores the video bytes unchanged', async () => {
    const { instance } = buildAdapter({ allowVideoAudio: true });
    const video = bytes.mp4Bytes();
    await instance.saveRaw(video, '2026/10/x.mp4');
    expect(instance.wrapped.savedRaw[0].buffer.equals(video)).toBe(true);
  });

  it('still checks an image, so the tier opens nothing but video and audio', async () => {
    const { instance, verdictClient } = buildAdapter({ allowVideoAudio: true });
    await instance.saveRaw(bytes.pngBytes(), '2026/10/x.png');
    expect(verdictClient.asked).toHaveLength(1);
  });
});

describe('everything that is not video or audio, on every tier and feature', () => {
  const NON_VIDEO_FIXTURES = [
    ['an image', () => bytes.pngBytes()],
    ['a video poster image', () => bytes.jpegBytes()],
    ['a PDF', () => bytes.pdfBytes()],
    ['a zip', () => bytes.zipBytes()],
    ['plain text', () => bytes.textBytes()],
    ['a still AVIF', () => bytes.stillImageBytes('avif')],
    ['bytes no detector recognises', () => Buffer.from('not-any-known-container-0123456789')],
  ];

  describe.each(TIER_CLASSES)('%s', (_tierName, allowVideoAudio) => {
    describe.each(FEATURES)('storage:%s', (feature) => {
      describe.each(ENTRY_POINTS)('through %s', (_entryName, upload) => {
        it.each(NON_VIDEO_FIXTURES)(
          'stores %s only after the check allows it',
          async (_label, build) => {
            const { instance, verdictClient, metrics } = buildAdapter({ feature, allowVideoAudio });
            const buffer = build();
            await expect(upload(instance, buffer)).resolves.toEqual(expect.any(String));
            expect(verdictClient.asked).toEqual([digestBytes(buffer)]);
            expect(storedCount(instance)).toBe(1);
            expect(metrics.calls).toContainEqual(['verdict', 'no-known-match']);
          }
        );

        it('refuses known material, seals it, and stores nothing', async () => {
          const buffer = bytes.pdfBytes();
          const { instance, metrics, quarantinePath } = buildAdapter({
            feature,
            allowVideoAudio,
            refuse: { [digestBytes(buffer)]: { classification: 'csam', matchType: 'exact' } },
          });
          await expect(upload(instance, buffer)).rejects.toMatchObject({ statusCode: 415 });
          expect(storedCount(instance)).toBe(0);
          expect(await quarantineEntries(quarantinePath)).toContain(digestBytes(buffer));
          expect(refusalReasons(metrics)).toEqual(['verdict']);
          await expect(upload(instance, buffer)).rejects.toMatchObject({ statusCode: 415 });
          expect(refusalReasons(metrics)).toEqual(['verdict', 'sealed']);
          expect(storedCount(instance)).toBe(0);
        });

        it('holds, without writing to storage, while the verdict is unavailable', async () => {
          const buffer = bytes.zipBytes();
          const { instance } = buildAdapter({
            feature,
            allowVideoAudio,
            unavailable: [digestBytes(buffer)],
          });
          await expect(upload(instance, buffer)).resolves.toEqual(expect.any(String));
          expect(storedCount(instance)).toBe(0);
          expect(instance.hold.heldSummary().count).toBe(1);
        });
      });
    });
  });
});

describe('a theme tree', () => {
  it('is screened file by file exactly as before: an audio file in a theme is not a media upload', async () => {
    const { instance, verdictClient } = buildAdapter();
    const root = path.join(tmpDir, 'theme');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'sound.mp3'), bytes.mp3Bytes());
    await fs.writeFile(path.join(root, 'index.hbs'), '<html></html>');
    await expect(instance.screenTree(root)).resolves.toBeUndefined();
    expect(verdictClient.asked).toHaveLength(2);
  });
});
