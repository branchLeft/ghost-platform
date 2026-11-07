import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeStorageBase } from '../helpers/fake-storage-base.mjs';
import { makeLoadWrappedAdapterClass } from '../helpers/fake-wrapped-adapter.mjs';
import { FakeS3Storage, FakePutObjectCommand } from '../helpers/fake-s3-storage.mjs';

const require = createRequire(import.meta.url);
const { defineScanningStorageAdapter } = require('../../src/scanning-storage.js');
const { sniffImageContentType, stampImageContentType } = require('../../src/content-type.js');
const { FakeVerdictClient } = require('../../src/verdict-client.js');
const { SafetyPolicy } = require('../../src/policy.js');
const { createPdqKnownMaterialCheck } = require('../../src/checks.js');
const { digestBytes } = require('../../src/pdq.js');
const GhostErrors = require('@tryghost/errors');

const PAD = Buffer.alloc(24, 0x11);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), PAD]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), PAD]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), PAD]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x20, 0, 0, 0]),
  Buffer.from('WEBPVP8 ', 'latin1'),
  PAD,
]);
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif', 'latin1'), PAD]);
// Two directory entries of sixteen bytes after the six-byte header.
const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0, 2, 0]), Buffer.alloc(32, 0x22)]);

describe('sniffImageContentType', () => {
  it.each([
    ['a JPEG', JPEG, 'image/jpeg'],
    ['a PNG', PNG, 'image/png'],
    ['a GIF', GIF, 'image/gif'],
    ['a WebP', WEBP, 'image/webp'],
    ['an AVIF', AVIF, 'image/avif'],
    ['an ICO', ICO, 'image/x-icon'],
  ])('names %s from its bytes', (_label, bytes, expected) => {
    expect(sniffImageContentType(bytes)).toBe(expected);
  });

  it('reads a Uint8Array and a sliced view as well as a Buffer', () => {
    expect(sniffImageContentType(new Uint8Array(JPEG))).toBe('image/jpeg');
    const padded = Buffer.concat([Buffer.from('xx'), PNG]);
    expect(sniffImageContentType(padded.subarray(2))).toBe('image/png');
  });

  it.each([
    ['SVG, which can carry script', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['HTML', Buffer.from('<!doctype html><script>alert(1)</script>')],
    ['a RIFF that is not WebP', Buffer.concat([Buffer.from('RIFF....WAVEfmt '), PAD])],
    [
      'an ISO file whose brand is not an image brand',
      Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypisom'), PAD]),
    ],
    ['an ICO header with no entries', Buffer.concat([Buffer.from([0, 0, 1, 0, 0, 0]), PAD])],
    ['an ICO header whose directory does not fit', Buffer.from([0, 0, 1, 0, 9, 0, 1, 2])],
    ['a truncated PNG signature', PNG.subarray(0, 5)],
    ['the empty buffer', Buffer.alloc(0)],
    ['a string', 'GIF89a'],
    ['undefined', undefined],
  ])('answers null for %s', (_label, bytes) => {
    expect(sniffImageContentType(bytes)).toBeNull();
  });
});

describe('stampImageContentType', () => {
  it('answers false and changes nothing when the wrapped adapter has no S3 client', () => {
    expect(stampImageContentType({})).toBe(false);
    expect(stampImageContentType({ client: {} })).toBe(false);
    expect(stampImageContentType(undefined)).toBe(false);
  });

  it('is applied once, however many times it is asked', async () => {
    const sent = [];
    const wrapped = { client: { send: async (command) => sent.push(command) } };
    expect(stampImageContentType(wrapped)).toBe(true);
    const stamped = wrapped.client.send;
    expect(stampImageContentType(wrapped)).toBe(true);
    expect(wrapped.client.send).toBe(stamped);
    await wrapped.client.send(new FakePutObjectCommand({ Key: 'k', Body: JPEG }));
    expect(sent).toHaveLength(1);
    expect(sent[0].input.ContentType).toBe('image/jpeg');
  });

  async function sendThrough(input) {
    const sent = [];
    const wrapped = { client: { send: async (command) => sent.push(command) } };
    stampImageContentType(wrapped);
    await wrapped.client.send(new FakePutObjectCommand(input));
    return sent[0].input;
  }

  it('leaves a type the request already names, and passes every argument through', async () => {
    expect(
      (await sendThrough({ Key: 'k', Body: JPEG, ContentType: 'image/png' })).ContentType
    ).toBe('image/png');
    const seen = [];
    const wrapped = {
      client: {
        send: async function recorder(...args) {
          seen.push({ self: this, args });
        },
      },
    };
    stampImageContentType(wrapped);
    const command = new FakePutObjectCommand({ Key: 'k', Body: PNG });
    await wrapped.client.send(command, { abortSignal: 1 });
    expect(seen[0].self).toBe(wrapped.client);
    expect(seen[0].args).toEqual([command, { abortSignal: 1 }]);
  });

  it('leaves bytes it cannot place, a non-buffer body and a multipart part alone', async () => {
    expect((await sendThrough({ Key: 'k', Body: Buffer.from('plain text') })).ContentType).toBe(
      undefined
    );
    expect((await sendThrough({ Key: 'k', Body: 'GIF89a....' })).ContentType).toBe(undefined);
    expect(
      (await sendThrough({ Key: 'k', Body: JPEG, UploadId: 'u', PartNumber: 1 })).ContentType
    ).toBe(undefined);
    expect((await sendThrough({ Body: JPEG })).ContentType).toBe(undefined);
  });

  it('passes a command with no input, and a delete, straight through', async () => {
    const sent = [];
    const wrapped = { client: { send: async (command) => sent.push(command) } };
    stampImageContentType(wrapped);
    await wrapped.client.send({});
    await wrapped.client.send(new FakePutObjectCommand({ Bucket: 'b', Key: 'k' }));
    expect(sent).toHaveLength(2);
  });
});

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'content-type-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function buildS3Adapter({ unavailable = [], wrappedConfig = {}, logger } = {}) {
  const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
    loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ S3Storage: FakeS3Storage }),
    GhostErrors,
  });
  const verdictClient = new FakeVerdictClient({ unavailable });
  const instance = new Adapter({
    wraps: 'S3Storage',
    // A bucket config makes a held upload's URL absolute, as it is on S3.
    wrappedConfig: { bucket: 'bucket', cdnUrl: 'https://cdn.example.test', ...wrappedConfig },
    quarantinePath: path.join(tmpDir, 'quarantine'),
    checks: [createPdqKnownMaterialCheck(verdictClient, { computeDigest: digestBytes })],
    policy: new SafetyPolicy(),
    computeDigest: digestBytes,
    holdRetryMs: 20,
    holdLogger: logger ?? { error: () => {} },
  });
  return { instance, verdictClient };
}

async function uploadFile(bytes, name, type) {
  const filePath = path.join(tmpDir, `src-${crypto.randomBytes(4).toString('hex')}`);
  await fs.writeFile(filePath, bytes);
  return { name, path: filePath, type };
}

// The control case for #1626: the bytes of a JPEG go in by every route the
// decorator has, and the object a visitor is sent must be typed image/jpeg,
// not the bucket's application/octet-stream default.
describe('an S3 object written by the decorator is served with its image type', () => {
  it('serves a resized derivative written by saveRaw as image/jpeg', async () => {
    const { instance } = buildS3Adapter();
    const key = 'content/images/size/w256h256/format/jpeg/2026/09/favicon.jpg';
    await instance.saveRaw(JPEG, key);
    expect(instance.wrapped.bucket.servedContentType(key)).toBe('image/jpeg');
  });

  it('serves a held upload, once its verdict clears and it is promoted, as image/png', async () => {
    const digest = digestBytes(PNG);
    const { instance, verdictClient } = buildS3Adapter({ unavailable: [digest] });
    const file = await uploadFile(PNG, 'logo.png', undefined);
    const url = await instance.save(file, 'content/images/2026/09');
    const key = instance.wrapped.urlToPath(url);
    expect(instance.wrapped.bucket.objects.has(key)).toBe(false);

    verdictClient.deliverVerdict(digest, { classification: 'no-known-match' });
    await vi.waitFor(() => expect(instance.hold.isPending(digest)).toBe(false), {
      timeout: 5000,
      interval: 10,
    });
    expect(instance.wrapped.bucket.servedContentType(key)).toBe('image/png');
  });

  it('serves a plain save() that names no type from its bytes', async () => {
    const { instance } = buildS3Adapter();
    const file = await uploadFile(JPEG, 'photo.jpg', undefined);
    const url = await instance.save(file, 'content/images/2026/09');
    expect(instance.wrapped.bucket.servedContentType(instance.wrapped.urlToPath(url))).toBe(
      'image/jpeg'
    );
  });

  it('keeps the type a save() already names', async () => {
    const { instance } = buildS3Adapter();
    const file = await uploadFile(JPEG, 'photo.jpg', 'image/jpeg');
    const url = await instance.save(file, 'content/images/2026/09');
    expect(instance.wrapped.bucket.servedContentType(instance.wrapped.urlToPath(url))).toBe(
      'image/jpeg'
    );
  });

  it('does not type bytes it cannot place as an image', async () => {
    const { instance } = buildS3Adapter();
    const key = 'content/images/2026/09/notes.png';
    await instance.saveRaw(Buffer.from('<script>alert(1)</script>'), key);
    expect(instance.wrapped.bucket.servedContentType(key)).toBe('application/octet-stream');
  });

  it('says so at boot when the S3 tier exposes no client to type', () => {
    const logger = { error: vi.fn() };
    buildS3Adapter({ wrappedConfig: { withoutClient: true }, logger });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('CONTENT_TYPE_STAMP_UNAVAILABLE')
    );
  });

  it('says nothing at boot when the S3 client is typed', () => {
    const logger = { error: vi.fn() };
    buildS3Adapter({ logger });
    expect(logger.error).not.toHaveBeenCalled();
  });
});
